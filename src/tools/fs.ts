import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
const DEFAULT_MAX_DEPTH = 3;
const MAX_MAX_DEPTH = 10;
const DEFAULT_MAX_BYTES = 256 * 1024;

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
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

function shouldIgnoreDir(dirName: string, respectGitignore: boolean, gitignorePatterns: Set<string>, ignorePatterns: string[]): boolean {
  if (IGNORED_DIRS.has(dirName)) return true;
  if (ignorePatterns.includes(dirName)) return true;
  if (respectGitignore && gitignorePatterns.has(dirName)) return true;
  return false;
}

interface TreeEntry {
  name: string;
  isDir: boolean;
  children?: TreeEntry[];
}

async function buildTree(
  dir: string,
  depth: number,
  maxDepth: number,
  includeFiles: boolean,
  includeDirs: boolean,
  respectGitignore: boolean,
  gitignorePatterns: Set<string>,
  ignorePatterns: string[],
  baseDir: string,
  byteCounter: { count: number },
  maxBytes: number
): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
  if (depth >= maxDepth) return { tree: [], truncated: false };

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { tree: [], truncated: false };
  }

  const tree: TreeEntry[] = [];
  let truncated = false;

  for (const entry of entries) {
    if (byteCounter.count >= maxBytes) {
      truncated = true;
      break;
    }

    if (!includeFiles && !entry.isDirectory()) continue;
    if (!includeDirs && entry.isDirectory()) continue;

    if (shouldIgnoreDir(entry.name, respectGitignore, gitignorePatterns, ignorePatterns)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);
    const entrySize = Buffer.byteLength(relPath) + 2;

    if (byteCounter.count + entrySize > maxBytes) {
      truncated = true;
      break;
    }

    byteCounter.count += entrySize;

    const treeEntry: TreeEntry = { name: entry.name, isDir: entry.isDirectory() };

    if (entry.isDirectory()) {
      const childResult = await buildTree(
        fullPath,
        depth + 1,
        maxDepth,
        includeFiles,
        includeDirs,
        respectGitignore,
        gitignorePatterns,
        ignorePatterns,
        baseDir,
        byteCounter,
        maxBytes
      );
      if (childResult.tree.length > 0) {
        treeEntry.children = childResult.tree;
      }
      if (childResult.truncated) {
        truncated = true;
      }
    }

    tree.push(treeEntry);
  }

  return { tree, truncated };
}

function renderTree(entries: TreeEntry[], prefix = ''): string {
  let output = '';
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const name = entry.isDir ? `${entry.name}/` : entry.name;
    output += `${prefix}${connector}${name}\n`;

    if (entry.children && entry.children.length > 0) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      output += renderTree(entry.children, childPrefix);
    }
  }
  return output;
}

export interface TreeResult {
  tree: string;
  entries: number;
  truncated: boolean;
  [key: string]: unknown;
}

export async function runTree(
  config: {
    path?: string;
    depth?: number;
    includeFiles?: boolean;
    includeDirs?: boolean;
    ignore?: string[];
    respectGitignore?: boolean;
    maxBytes?: number;
    cwd?: string;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<TreeResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const root = config.path ? expandPath(config.path) : cwd;

  const decision = await security.authorize('fs.tree', { path: root });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const maxDepth = Math.min(config.depth ?? DEFAULT_MAX_DEPTH, MAX_MAX_DEPTH);
  const includeFiles = config.includeFiles ?? true;
  const includeDirs = config.includeDirs ?? true;
  const respectGitignore = config.respectGitignore ?? true;
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const ignorePatterns = config.ignore ?? [];

  const gitignorePatterns = respectGitignore ? loadGitignorePatterns(root) : new Set<string>();
  const byteCounter = { count: 0 };

  const result = await buildTree(
    root,
    0,
    maxDepth,
    includeFiles,
    includeDirs,
    respectGitignore,
    gitignorePatterns,
    ignorePatterns,
    root,
    byteCounter,
    maxBytes
  );

  const treeString = renderTree(result.tree);
  const truncated = result.truncated || byteCounter.count >= maxBytes;

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'fs.tree',
    decision: 'allow',
    result: `entries=${result.tree.length} truncated=${truncated} argsHash=${argsHash}`
  });

  return { tree: treeString, entries: result.tree.length, truncated };
}