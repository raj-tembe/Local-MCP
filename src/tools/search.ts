import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { glob } from 'glob';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff',
  '.mp4', '.webm', '.mov', '.avi', '.mkv',
  '.mp3', '.wav', '.flac', '.ogg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.lib',
  '.class', '.jar', '.war', '.ear',
  '.pyc', '.pyo', '.pyd',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.map', '.min.js', '.min.css'
]);

const MAX_FILE_SIZE_FOR_SEARCH = 10 * 1024 * 1024;
const MAX_CONTEXT_LINES = 10;
const DEFAULT_MAX_RESULTS = 200;
const MAX_MAX_RESULTS = 2000;
const DEFAULT_MAX_BYTES = 256 * 1024;

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  try {
    const buffer = Buffer.alloc(8192);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    fs.closeSync(fd);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  }
}

function shouldIgnoreDir(dirName: string, respectGitignore: boolean, gitignorePatterns: Set<string>): boolean {
  if (IGNORED_DIRS.has(dirName)) return true;
  if (respectGitignore && gitignorePatterns.has(dirName)) return true;
  return false;
}

function loadGitignorePatterns(root: string): Set<string> {
  const patterns = new Set<string>();
  const gitignorePath = path.join(root, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.includes('/') && !trimmed.includes('*')) {
        patterns.add(trimmed);
      }
    }
  } catch {
    // no .gitignore or unreadable
  }
  return patterns;
}

function truncateAtBoundary(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= maxBytes) return { text, truncated: false };
  const truncated = encoded.subarray(0, maxBytes);
  let decoded = new TextDecoder('utf8', { fatal: false }).decode(truncated);
  const lastNewline = decoded.lastIndexOf('\n');
  if (lastNewline > maxBytes * 0.5) {
    decoded = decoded.slice(0, lastNewline + 1);
  }
  return { text: decoded, truncated: true };
}

export interface GrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  contextBefore: string[];
  contextAfter: string[];
  [key: string]: unknown;
}

export interface GrepResult {
  matches: GrepMatch[];
  totalMatches: number;
  truncated: boolean;
  [key: string]: unknown;
}

export interface GlobResult {
  paths: string[];
  truncated: boolean;
  [key: string]: unknown;
}

async function grepFile(
  filePath: string,
  regex: RegExp,
  contextLines: number,
  relPath: string,
  maxBytes: number,
  results: GrepMatch[],
  totalMatches: { count: number },
  maxResults: number
): Promise<{ truncated: boolean }> {
  if (totalMatches.count >= maxResults) return { truncated: true };

  try {
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_FILE_SIZE_FOR_SEARCH) return { truncated: false };

    const content = await fsp.readFile(filePath, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (totalMatches.count >= maxResults) return { truncated: true };

      const line = lines[i];
      let match: RegExpExecArray | null;
      regex.lastIndex = 0;
      while ((match = regex.exec(line)) !== null) {
        if (totalMatches.count >= maxResults) return { truncated: true };

        const column = match.index + 1;
        const contextBefore: string[] = [];
        const contextAfter: string[] = [];

        for (let c = 1; c <= contextLines; c++) {
          if (i - c >= 0) contextBefore.unshift(lines[i - c]);
          if (i + c < lines.length) contextAfter.push(lines[i + c]);
        }

        results.push({
          file: relPath,
          line: i + 1,
          column,
          text: line,
          contextBefore,
          contextAfter
        });
        totalMatches.count++;

        if (!regex.global) break;
      }
    }
  } catch {
    // ignore unreadable files
  }

  return { truncated: false };
}

export async function runGrep(
  config: {
    pattern: string;
    path?: string;
    glob?: string;
    caseSensitive?: boolean;
    fixedStrings?: boolean;
    contextLines?: number;
    maxResults?: number;
    respectGitignore?: boolean;
    includeIgnored?: boolean;
    maxBytes?: number;
    cwd?: string;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<GrepResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const searchRoot = config.path ? expandPath(config.path) : cwd;

  const decision = await security.authorize('search.grep', { path: searchRoot, pattern: config.pattern });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const contextLines = Math.min(config.contextLines ?? 0, MAX_CONTEXT_LINES);
  const maxResults = Math.min(config.maxResults ?? DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS);
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const respectGitignore = config.respectGitignore ?? true;
  const includeIgnored = config.includeIgnored ?? false;

  let regex: RegExp;
  try {
    const flags = config.caseSensitive ? 'g' : 'gi';
    if (config.fixedStrings) {
      const escaped = config.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, flags);
    } else {
      regex = new RegExp(config.pattern, flags);
    }
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
  }

  const gitignorePatterns = respectGitignore ? loadGitignorePatterns(searchRoot) : new Set<string>();
  const results: GrepMatch[] = [];
  const totalMatches = { count: 0 };
  let truncated = false;

  let files: string[];
  if (config.glob) {
    files = await glob(config.glob, {
      cwd: searchRoot,
      absolute: true,
      nodir: true,
      ignore: respectGitignore && !includeIgnored ? ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'] : undefined
    });
  } else {
    files = await glob('**/*', {
      cwd: searchRoot,
      absolute: true,
      nodir: true,
      ignore: respectGitignore && !includeIgnored ? ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'] : undefined
    });
  }

  for (const file of files) {
    if (totalMatches.count >= maxResults) {
      truncated = true;
      break;
    }

    const relPath = path.relative(searchRoot, file);
    const dirParts = relPath.split(path.sep);
    let shouldSkip = false;
    for (const part of dirParts) {
      if (shouldIgnoreDir(part, respectGitignore, gitignorePatterns)) {
        shouldSkip = true;
        break;
      }
    }
    if (shouldSkip) continue;

    if (isBinaryFile(file)) continue;

    const result = await grepFile(file, regex, contextLines, relPath, maxBytes, results, totalMatches, maxResults);
    if (result.truncated) {
      truncated = true;
      break;
    }
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'search.grep',
    decision: 'allow',
    result: `matches=${totalMatches.count} truncated=${truncated} argsHash=${argsHash}`
  });

  return { matches: results, totalMatches: totalMatches.count, truncated };
}

export async function runGlob(
  config: {
    pattern: string;
    cwd?: string;
    ignore?: string[];
    maxResults?: number;
    includeDirs?: boolean;
    respectGitignore?: boolean;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<GlobResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();

  const decision = await security.authorize('fs.glob', { pattern: config.pattern, cwd });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const maxResults = Math.min(config.maxResults ?? 1000, 10000);
  const respectGitignore = config.respectGitignore ?? true;

  const files = await glob(config.pattern, {
    cwd,
    absolute: false,
    nodir: !config.includeDirs,
    ignore: config.ignore ? (respectGitignore ? [...config.ignore, '**/.git/**', '**/node_modules/**'] : config.ignore) : (respectGitignore ? ['**/.git/**', '**/node_modules/**'] : undefined),
    maxDepth: 100
  });

  const truncated = files.length > maxResults;
  const resultPaths = truncated ? files.slice(0, maxResults) : files;
  const posixPaths = resultPaths.map((p: string) => p.split(path.sep).join('/'));

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'fs.glob',
    decision: 'allow',
    result: `matches=${posixPaths.length} truncated=${truncated} argsHash=${argsHash}`
  });

  return { paths: posixPaths, truncated };
}