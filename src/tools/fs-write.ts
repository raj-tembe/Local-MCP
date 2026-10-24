import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { runProcess } from '../exec/run.js';

const DEFAULT_MAX_BYTES = 256 * 1024;

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

function normalizeLineEndings(text: string): { text: string; eol: string } {
  if (text.includes('\r\n')) return { text: text.replace(/\r\n/g, '\n'), eol: '\r\n' };
  if (text.includes('\n')) return { text: text.replace(/\n/g, '\n'), eol: '\n' };
  return { text, eol: '\n' };
}

function ensureTrailingNewline(text: string, eol: string): string {
  return text.endsWith(eol) ? text : text + eol;
}

export interface FSEditResult {
  applied: boolean;
  replacements: number;
  diff: string;
  diffTruncated: boolean;
  error?: { code: string; message: string; detail?: string };
  [key: string]: unknown;
}

export interface FSApplyPatchResult {
  applied: boolean;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
  rejected: Array<{ path: string; reason: string }>;
  diff: string;
  [key: string]: unknown;
}

export interface FSDiffResult {
  diff: string;
  additions: number;
  deletions: number;
  truncated: boolean;
  [key: string]: unknown;
}

export interface FSMoveResult {
  moved: boolean;
  from: string;
  to: string;
  [key: string]: unknown;
}

export interface FSCopyResult {
  copied: boolean;
  from: string;
  to: string;
  entries: number;
  [key: string]: unknown;
}

export interface FSRemoveResult {
  removed: boolean;
  path: string;
  method: 'trash' | 'delete';
  [key: string]: unknown;
}

function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
  contextLines = 3
): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  
  const diffLines: string[] = [];
  diffLines.push(`--- a/${filePath}`);
  diffLines.push(`+++ b/${filePath}`);
  
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++; j++;
      continue;
    }
    
    const oldStart = i + 1;
    let oldCount = 0;
    const newStart = j + 1;
    let newCount = 0;
    
    const chunkOld: string[] = [];
    const chunkNew: string[] = [];
    
    while (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
      chunkOld.push('-' + oldLines[i]);
      i++; oldCount++;
    }
    while (j < newLines.length && (i >= oldLines.length || oldLines[i] !== newLines[j])) {
      chunkNew.push('+' + newLines[j]);
      j++; newCount++;
    }
    
    if (oldCount > 0 || newCount > 0) {
      diffLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
      diffLines.push(...chunkOld, ...chunkNew);
    }
  }
  
  return diffLines.join('\n') + '\n';
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

function truncateDiff(diff: string, maxBytes: number): { diff: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(diff);
  if (encoded.length <= maxBytes) return { diff, truncated: false };
  
  const truncated = encoded.subarray(0, maxBytes);
  let decoded = new TextDecoder('utf8', { fatal: false }).decode(truncated);
  const lastNewline = decoded.lastIndexOf('\n');
  if (lastNewline > maxBytes * 0.5) {
    decoded = decoded.slice(0, lastNewline + 1);
  }
  return { diff: decoded + '\n[diff truncated]', truncated: true };
}

export async function runFSEdit(
  config: {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
    expectedReplacements?: number;
    dryRun?: boolean;
    maxBytes?: number;
    cwd?: string;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<FSEditResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const filePath = expandPath(config.path);
  const isDryRun = config.dryRun ?? false;

  if (!isDryRun) {
    const decision = await security.authorize('fs.edit', { path: filePath, oldString: config.oldString, newString: config.newString });
    if (!decision.allowed) {
      throw new Error(decision.reason ?? 'Permission denied');
    }
  } else {
    const toolCheck = security.checkToolAllowed('fs.edit');
    if (!toolCheck.allowed) {
      throw new Error(toolCheck.reason ?? 'Permission denied');
    }
  }

  try {
    const content = await fsp.readFile(filePath, 'utf8');
  } catch {
    return {
      applied: false,
      replacements: 0,
      diff: '',
      diffTruncated: false,
      error: { code: 'ENOENT', message: `File not found: ${config.path}` }
    };
  }

  const content = await fsp.readFile(filePath, 'utf8');
  const { text: normalizedContent, eol } = normalizeLineEndings(content);
  const { text: normalizedOld, eol: oldEol } = normalizeLineEndings(config.oldString);
  const { text: normalizedNew, eol: newEol } = normalizeLineEndings(config.newString);

  const useEol = oldEol || newEol || eol;
  const searchText = normalizedOld;
  const replaceText = normalizedNew;

  let count = 0;
  let result = normalizedContent;
  let index = 0;
  
  while (true) {
    const found = result.indexOf(searchText, index);
    if (found === -1) break;
    count++;
    if (!config.replaceAll && count > 1) break;
    result = result.slice(0, found) + replaceText + result.slice(found + searchText.length);
    index = found + replaceText.length;
    if (!config.replaceAll) break;
  }

  if (count === 0) {
    return {
      applied: false,
      replacements: 0,
      diff: '',
      diffTruncated: false,
      error: { code: 'NOT_FOUND', message: 'oldString not found in file' }
    };
  }

  if (!config.replaceAll && count > 1) {
    return {
      applied: false,
      replacements: count,
      diff: '',
      diffTruncated: false,
      error: { code: 'AMBIGUOUS_MATCH', message: `oldString matches ${count} locations; use replaceAll: true to replace all` }
    };
  }

  if (config.expectedReplacements !== undefined && count !== config.expectedReplacements) {
    return {
      applied: false,
      replacements: count,
      diff: '',
      diffTruncated: false,
      error: { code: 'EXPECTED_MISMATCH', message: `Expected ${config.expectedReplacements} replacements but found ${count}` }
    };
  }

  const finalContent = ensureTrailingNewline(result, useEol);
  const diff = generateUnifiedDiff(normalizedContent, finalContent, path.relative(cwd, filePath));
  const { diff: truncatedDiff, truncated } = truncateDiff(diff, config.maxBytes ?? DEFAULT_MAX_BYTES);

  if (!isDryRun) {
    await fsp.writeFile(filePath, finalContent, 'utf8');
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'fs.edit',
    decision: isDryRun ? 'allow' : 'allow',
    result: `dryRun=${isDryRun} replacements=${count} truncated=${truncated} argsHash=${argsHash}`
  });

  return {
    applied: !isDryRun,
    replacements: count,
    diff: truncatedDiff,
    diffTruncated: truncated
  };
}

export async function runFSApplyPatch(
  config: {
    patch: string;
    cwd?: string;
    strip?: number;
    dryRun?: boolean;
    reverse?: boolean;
    maxBytes?: number;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<FSApplyPatchResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const isDryRun = config.dryRun ?? false;
  const strip = config.strip ?? 1;

  if (!isDryRun) {
    const decision = await security.authorize('fs.applyPatch', { patch: config.patch.substring(0, 100), cwd, strip, reverse: config.reverse });
    if (!decision.allowed) {
      throw new Error(decision.reason ?? 'Permission denied');
    }
  } else {
    const toolCheck = security.checkToolAllowed('fs.applyPatch');
    if (!toolCheck.allowed) {
      throw new Error(toolCheck.reason ?? 'Permission denied');
    }
  }

  const lines = config.patch.split('\n');
  const files: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  const allDiffs: string[] = [];
  let currentFile: { oldPath: string; newPath: string; content: string[] } | null = null;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      if (currentFile) {
        const patchContent = currentFile.content.join('\n');
        const targetPath = path.join(cwd, ...currentFile.newPath.split('/').slice(strip));
        if (path.isAbsolute(targetPath) || targetPath.includes('..')) {
          rejected.push({ path: currentFile.newPath, reason: 'Path traversal not allowed' });
        } else {
          try {
            const oldContent = await fsp.readFile(targetPath, 'utf8');
            const result = await runProcess({
              file: 'patch',
              args: ['-p' + strip, '--dry-run', '-i', '-'],
              cwd,
              stdin: patchContent,
              maxOutputBytes: 10000
            });
            if (result.exitCode === 0) {
              if (!isDryRun) {
                const applyResult = await runProcess({
                  file: 'patch',
                  args: ['-p' + strip, '-i', '-'],
                  cwd,
                  stdin: patchContent,
                  maxOutputBytes: 10000
                });
              }
              files.push({ path: targetPath, status: 'patched', additions: 0, deletions: 0 });
            } else {
              rejected.push({ path: targetPath, reason: result.stderr || 'Patch apply failed' });
            }
          } catch {
            rejected.push({ path: targetPath, reason: 'File not found or not writable' });
          }
        }
        allDiffs.push(patchContent);
      }
      currentFile = { oldPath: '', newPath: line.slice(4).trim(), content: [line] };
      inHunk = false;
    } else if (line.startsWith('+++ ')) {
      if (currentFile) {
        currentFile.newPath = line.slice(4).trim();
        currentFile.content.push(line);
      }
    } else if (line.startsWith('@@ ')) {
      inHunk = true;
      if (currentFile) currentFile.content.push(line);
    } else if (inHunk && currentFile) {
      currentFile.content.push(line);
    }
  }

  if (currentFile) {
    const patchContent = currentFile.content.join('\n');
    const targetPath = path.join(cwd, ...currentFile.newPath.split('/').slice(strip));
    if (path.isAbsolute(targetPath) || targetPath.includes('..')) {
      rejected.push({ path: currentFile.newPath, reason: 'Path traversal not allowed' });
    } else {
      try {
        const result = await runProcess({
          file: 'patch',
          args: ['-p' + strip, '--dry-run', '-i', '-'],
          cwd,
          stdin: patchContent,
          maxOutputBytes: 10000
        });
        if (result.exitCode === 0) {
          if (!isDryRun) {
            await runProcess({
              file: 'patch',
              args: ['-p' + strip, '-i', '-'],
              cwd,
              stdin: patchContent,
              maxOutputBytes: 10000
            });
          }
          files.push({ path: targetPath, status: 'patched', additions: 0, deletions: 0 });
        } else {
          rejected.push({ path: targetPath, reason: result.stderr || 'Patch apply failed' });
        }
      } catch {
        rejected.push({ path: targetPath, reason: 'File not found or not writable' });
      }
    }
    allDiffs.push(patchContent);
  }

  const fullDiff = allDiffs.join('\n');
  const { diff: truncatedDiff, truncated } = truncateDiff(fullDiff, config.maxBytes ?? DEFAULT_MAX_BYTES);

  const applied = rejected.length === 0 && files.length > 0;

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'fs.applyPatch',
    decision: isDryRun ? 'allow' : 'allow',
    result: `dryRun=${isDryRun} applied=${applied} files=${files.length} rejected=${rejected.length} argsHash=${argsHash}`
  });

  return { applied, files, rejected, diff: truncatedDiff };
}

export async function runFSDiff(
  config: {
    path?: string;
    oldContent?: string;
    newContent?: string;
    pathA?: string;
    pathB?: string;
    contextLines?: number;
    maxBytes?: number;
    cwd?: string;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<FSDiffResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();

  const decision = await security.authorize('fs.diff', { path: config.path || config.pathA || config.pathB });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  let oldContent: string, newContent: string, filePath: string;

  if (config.path && config.oldContent !== undefined && config.newContent !== undefined) {
    filePath = config.path;
    oldContent = config.oldContent;
    newContent = config.newContent;
  } else if (config.pathA && config.pathB) {
    filePath = config.pathA;
    const pathA = expandPath(config.pathA);
    const pathB = expandPath(config.pathB);
    oldContent = await fsp.readFile(pathA, 'utf8');
    newContent = await fsp.readFile(pathB, 'utf8');
  } else {
    throw new Error('Either provide path+oldContent+newContent, or pathA+pathB');
  }

  const { text: normOld } = normalizeLineEndings(oldContent);
  const { text: normNew } = normalizeLineEndings(newContent);
  const diff = generateUnifiedDiff(normOld, normNew, path.relative(cwd, expandPath(filePath)), config.contextLines ?? 3);
  const { additions, deletions } = countDiffLines(diff);
  const { diff: truncatedDiff, truncated } = truncateDiff(diff, config.maxBytes ?? DEFAULT_MAX_BYTES);

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'fs.diff',
    decision: 'allow',
    result: `additions=${additions} deletions=${deletions} truncated=${truncated} argsHash=${argsHash}`
  });

  return { diff: truncatedDiff, additions, deletions, truncated };
}

async function getTrashPath(): Promise<string> {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Explorer');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), '.Trash');
  }
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgDataHome, 'Trash');
}

async function moveToTrash(filePath: string): Promise<void> {
  const trashRoot = await getTrashPath();
  const trashFiles = path.join(trashRoot, 'files');
  const trashInfo = path.join(trashRoot, 'info');
  await fsp.mkdir(trashFiles, { recursive: true });
  await fsp.mkdir(trashInfo, { recursive: true });
  
  const basename = path.basename(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashName = `${basename}.${timestamp}`;
  
  await fsp.rename(filePath, path.join(trashFiles, trashName));
  const infoContent = `[Trash Info]\nPath=${filePath}\nDeletionDate=${new Date().toISOString()}\n`;
  await fsp.writeFile(path.join(trashInfo, `${trashName}.trashinfo`), infoContent, 'utf8');
}

async function isUnsafePath(target: string): Promise<boolean> {
  const resolved = path.resolve(target);
  const home = os.homedir();
  const root = path.parse(resolved).root;
  
  if (resolved === home) return true;
  if (resolved === root) return true;
  if (resolved === '/') return true;
  if (process.platform === 'win32' && /^[A-Z]:\\?$/i.test(resolved)) return true;
  
  try {
    const stat = await fsp.stat(resolved);
    if (stat.isDirectory()) {
      const gitDir = path.join(resolved, '.git');
      try {
        await fsp.stat(gitDir);
        return true;
      } catch {}
    }
  } catch {}
  
  return false;
}

export async function runFSMove(
  config: {
    from: string;
    to: string;
    overwrite?: boolean;
    dryRun?: boolean;
    cwd?: string;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<FSMoveResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const from = expandPath(config.from);
  const to = expandPath(config.to);
  const isDryRun = config.dryRun ?? false;
  const overwrite = config.overwrite ?? false;

  if (!isDryRun) {
    const decision = await security.authorize('fs.move', { from, to });
    if (!decision.allowed) {
      throw new Error(decision.reason ?? 'Permission denied');
    }
  } else {
    const toolCheck = security.checkToolAllowed('fs.move');
    if (!toolCheck.allowed) {
      throw new Error(toolCheck.reason ?? 'Permission denied');
    }
  }

  try {
    await fsp.stat(from);
  } catch {
    return { moved: false, from, to, error: { code: 'ENOENT', message: `Source not found: ${config.from}` } as any };
  }

  if (!overwrite) {
    try {
      await fsp.stat(to);
      return { moved: false, from, to, error: { code: 'EEXIST', message: `Destination exists: ${config.to}` } as any };
    } catch {}
  }

  if (!isDryRun) {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'fs.move',
    decision: isDryRun ? 'allow' : 'allow',
    result: `dryRun=${isDryRun} from=${config.from} to=${config.to} argsHash=${argsHash}`
  });

  return { moved: !isDryRun, from, to };
}

export async function runFSCopy(
  config: {
    from: string;
    to: string;
    recursive?: boolean;
    overwrite?: boolean;
    dryRun?: boolean;
    cwd?: string;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<FSCopyResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const from = expandPath(config.from);
  const to = expandPath(config.to);
  const isDryRun = config.dryRun ?? false;
  const recursive = config.recursive ?? false;
  const overwrite = config.overwrite ?? false;

  if (!isDryRun) {
    const decision = await security.authorize('fs.copy', { from, to });
    if (!decision.allowed) {
      throw new Error(decision.reason ?? 'Permission denied');
    }
  } else {
    const toolCheck = security.checkToolAllowed('fs.copy');
    if (!toolCheck.allowed) {
      throw new Error(toolCheck.reason ?? 'Permission denied');
    }
  }

  const stat = await fsp.stat(from);
  if (!stat.isDirectory() && !recursive) {
    try {
      await fsp.stat(to);
      if (!overwrite) {
        return { copied: false, from, to, entries: 0, error: { code: 'EEXIST', message: `Destination exists: ${config.to}` } as any };
      }
    } catch {}
    
    if (!isDryRun) {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
    }
    return { copied: !isDryRun, from, to, entries: 1 };
  }

  if (!stat.isDirectory()) {
    return { copied: false, from, to, entries: 0, error: { code: 'NOT_DIR', message: 'Source is not a directory; use recursive: true' } as any };
  }

  let entries = 0;
  async function copyDir(src: string, dest: string) {
    await fsp.mkdir(dest, { recursive: true });
    const items = await fsp.readdir(src, { withFileTypes: true });
    for (const item of items) {
      const srcPath = path.join(src, item.name);
      const destPath = path.join(dest, item.name);
      if (item.isDirectory()) {
        await copyDir(srcPath, destPath);
        entries++;
      } else {
        try {
          await fsp.stat(destPath);
          if (!overwrite) continue;
        } catch {}
        if (!isDryRun) {
          await fsp.copyFile(srcPath, destPath);
        }
        entries++;
      }
    }
  }

  if (!isDryRun) {
    await copyDir(from, to);
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'fs.copy',
    decision: isDryRun ? 'allow' : 'allow',
    result: `dryRun=${isDryRun} from=${config.from} to=${config.to} entries=${entries} argsHash=${argsHash}`
  });

  return { copied: !isDryRun, from, to, entries };
}

export async function runFSRemove(
  config: {
    path: string;
    recursive?: boolean;
    useTrash?: boolean;
    dryRun?: boolean;
    cwd?: string;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<FSRemoveResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const target = expandPath(config.path);
  const isDryRun = config.dryRun ?? false;
  const recursive = config.recursive ?? false;
  const useTrash = config.useTrash ?? true;

  if (!isDryRun) {
    const decision = await security.authorize('fs.remove', { path: target, recursive, useTrash });
    if (!decision.allowed) {
      throw new Error(decision.reason ?? 'Permission denied');
    }
  } else {
    const toolCheck = security.checkToolAllowed('fs.remove');
    if (!toolCheck.allowed) {
      throw new Error(toolCheck.reason ?? 'Permission denied');
    }
  }

  if (await isUnsafePath(target)) {
    return { removed: false, path: config.path, method: 'trash', error: { code: 'REFUSED_UNSAFE_PATH', message: 'Refused to remove unsafe path (home, root, or git repo root)' } as any };
  }

  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory() && !recursive) {
      return { removed: false, path: config.path, method: 'trash', error: { code: 'EISDIR', message: 'Directory not empty; use recursive: true' } as any };
    }
  } catch {
    return { removed: false, path: config.path, method: 'trash', error: { code: 'ENOENT', message: `Path not found: ${config.path}` } as any };
  }

  const method = useTrash ? 'trash' : 'delete';
  
  if (!isDryRun) {
    if (useTrash && (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32')) {
      await moveToTrash(target);
    } else {
      await fsp.rm(target, { recursive, force: true });
    }
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'fs.remove',
    decision: isDryRun ? 'allow' : 'allow',
    result: `dryRun=${isDryRun} path=${config.path} method=${method} argsHash=${argsHash}`
  });

  return { removed: !isDryRun, path: config.path, method };
}