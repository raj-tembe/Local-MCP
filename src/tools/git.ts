import { runProcess, clampTimeout } from '../exec/run.js';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_MAX_BYTES = 256 * 1024;

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

async function findGitRoot(cwd: string): Promise<string | null> {
  let current = cwd;
  while (current !== path.parse(current).root) {
    try {
      const stat = await import('node:fs/promises').then(m => m.stat(path.join(current, '.git')));
      if (stat.isDirectory() || stat.isFile()) return current;
    } catch {
      // not a git repo, continue up
    }
    current = path.dirname(current);
  }
  return null;
}

export interface GitStatusResult {
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: Array<{ path: string; status: string }>;
  unstaged: Array<{ path: string; status: string }>;
  untracked: string[];
  conflicts: string[];
  repoRoot: string;
  [key: string]: unknown;
}

export interface GitDiffResult {
  diff: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
  truncated: boolean;
  [key: string]: unknown;
}

export interface GitLogCommit {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  [key: string]: unknown;
}

export interface GitLogResult {
  commits: GitLogCommit[];
  [key: string]: unknown;
}

export interface GitShowResult {
  meta: { sha: string; author: string; date: string; subject: string; parents: string[] };
  patch: string;
  truncated: boolean;
  [key: string]: unknown;
}

export interface GitBlameLine {
  lineNo: number;
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  content: string;
  [key: string]: unknown;
}

export interface GitBlameResult {
  lines: GitBlameLine[];
  truncated: boolean;
  [key: string]: unknown;
}

async function runGit(args: string[], cwd: string, maxBytes: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; truncated: boolean }> {
  const result = await runProcess({
    file: 'git',
    args,
    cwd,
    maxOutputBytes: maxBytes,
    timeoutMs: 30000
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, truncated: result.truncated };
}

export async function runGitStatus(
  config: { cwd?: string },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<GitStatusResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();

  const decision = await security.authorize('git.status', { cwd });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    throw new Error('NOT_A_REPO');
  }

  const result = await runGit(['status', '--porcelain=v2', '--branch'], repoRoot, DEFAULT_MAX_BYTES);

  if (result.exitCode !== 0) {
    throw new Error(`git status failed: ${result.stderr}`);
  }

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  let branch = '';
  let detached = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const staged: Array<{ path: string; status: string }> = [];
  const unstaged: Array<{ path: string; status: string }> = [];
  const untracked: string[] = [];
  const conflicts: string[] = [];

  for (const line of lines) {
    if (line.startsWith('# branch.head ')) {
      branch = line.slice(14).trim();
      detached = branch === '(detached)';
      if (detached) branch = '';
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice(18).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const parts = line.slice(12).trim().split(' ');
      ahead = parseInt(parts[0] || '0', 10);
      behind = parseInt(parts[1] || '0', 10);
    } else if (line.startsWith('1 ')) {
      // staged
      const parts = line.split(' ');
      const status = parts[1] + parts[2];
      const filePath = parts.slice(8).join(' ');
      staged.push({ path: filePath, status });
    } else if (line.startsWith('2 ')) {
      // unstaged
      const parts = line.split(' ');
      const status = parts[1] + parts[2];
      const filePath = parts.slice(8).join(' ');
      unstaged.push({ path: filePath, status });
    } else if (line.startsWith('? ')) {
      untracked.push(line.slice(2));
    } else if (line.startsWith('u ')) {
      conflicts.push(line.slice(2));
    }
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'git.status',
    decision: 'allow',
    result: `branch=${branch || 'detached'} staged=${staged.length} unstaged=${unstaged.length} untracked=${untracked.length} argsHash=${argsHash}`
  });

  return { branch, detached, upstream, ahead, behind, staged, unstaged, untracked, conflicts, repoRoot };
}

export async function runGitDiff(
  config: {
    cwd?: string;
    staged?: boolean;
    paths?: string[];
    contextLines?: number;
    from?: string;
    to?: string;
    statOnly?: boolean;
    maxBytes?: number;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<GitDiffResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();

  const decision = await security.authorize('git.diff', { cwd, staged: config.staged, paths: config.paths });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    throw new Error('NOT_A_REPO');
  }

  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const args = ['diff'];

  if (config.staged) {
    args.push('--staged');
  } else if (config.from && config.to) {
    args.push(`${config.from}..${config.to}`);
  } else if (config.from) {
    args.push(`${config.from}..HEAD`);
  }

  if (config.contextLines !== undefined) {
    args.push(`-U${config.contextLines}`);
  }

  if (config.statOnly) {
    args.push('--stat');
  }

  if (config.paths && config.paths.length > 0) {
    args.push('--', ...config.paths);
  }

  const result = await runGit(args, repoRoot, maxBytes);

  if (result.exitCode !== 0) {
    throw new Error(`git diff failed: ${result.stderr}`);
  }

  let filesChanged = 0;
  let additions = 0;
  let deletions = 0;
  const files: Array<{ path: string; status: string; additions: number; deletions: number }> = [];

  if (config.statOnly) {
    const statResult = await runGit([...args, '--numstat'], repoRoot, maxBytes);
    for (const line of statResult.stdout.trim().split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const add = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
        const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
        filesChanged++;
        additions += add;
        deletions += del;
        files.push({ path: parts[2], status: 'modified', additions: add, deletions: del });
      }
    }
  } else {
    const numstatArgs = args.filter(a => a !== '--stat');
    const numstatResult = await runGit([...numstatArgs, '--numstat'], repoRoot, maxBytes);
    for (const line of numstatResult.stdout.trim().split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const add = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
        const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
        filesChanged++;
        additions += add;
        deletions += del;
        files.push({ path: parts[2], status: 'modified', additions: add, deletions: del });
      }
    }
  }

  const diff = config.statOnly ? '' : result.stdout;
  const truncated = result.truncated;

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'git.diff',
    decision: 'allow',
    result: `filesChanged=${filesChanged} additions=${additions} deletions=${deletions} truncated=${truncated} argsHash=${argsHash}`
  });

  return { diff, filesChanged, additions, deletions, files, truncated };
}

export async function runGitLog(
  config: {
    cwd?: string;
    limit?: number;
    path?: string;
    author?: string;
    since?: string;
    grep?: string;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<GitLogResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();

  const decision = await security.authorize('git.log', { cwd, limit: config.limit });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    throw new Error('NOT_A_REPO');
  }

  const limit = Math.min(config.limit ?? 20, 200);
  const args = [
    'log',
    `--format=%H%x00%h%x00%an%x00%ae%x00%ad%x00%s%x00%b`,
    `--date=iso`,
    `-${limit}`
  ];

  if (config.author) args.push(`--author=${config.author}`);
  if (config.since) args.push(`--since=${config.since}`);
  if (config.grep) args.push(`--grep=${config.grep}`);
  if (config.path) args.push('--', config.path);

  const result = await runGit(args, repoRoot, DEFAULT_MAX_BYTES);

  if (result.exitCode !== 0) {
    throw new Error(`git log failed: ${result.stderr}`);
  }

  const commits: GitLogCommit[] = [];
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    const parts = line.split('\x00');
    if (parts.length >= 7) {
      commits.push({
        sha: parts[0],
        shortSha: parts[1],
        author: parts[2],
        authorEmail: parts[3],
        date: parts[4],
        subject: parts[5],
        body: parts[6] || ''
      });
    }
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'git.log',
    decision: 'allow',
    result: `commits=${commits.length} argsHash=${argsHash}`
  });

  return { commits };
}

export async function runGitShow(
  config: { ref: string; path?: string; cwd?: string; maxBytes?: number },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<GitShowResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();

  const decision = await security.authorize('git.show', { ref: config.ref, path: config.path, cwd });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    throw new Error('NOT_A_REPO');
  }

  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const args = ['show', '--format=%H%x00%an%x00%ad%x00%s%x00%P', '--date=iso', config.ref];
  if (config.path) args.push('--', config.path);

  const result = await runGit(args, repoRoot, maxBytes);

  if (result.exitCode !== 0) {
    throw new Error(`git show failed: ${result.stderr}`);
  }

  const lines = result.stdout.split('\n');
  const headerLine = lines[0];
  const headerParts = headerLine.split('\x00');
  let sha = '', author = '', date = '', subject = '', parents: string[] = [];
  if (headerParts.length >= 5) {
    sha = headerParts[0];
    author = headerParts[1];
    date = headerParts[2];
    subject = headerParts[3];
    parents = headerParts[4].split(' ').filter(Boolean);
  }
  const patch = lines.slice(1).join('\n');

  const truncated = result.truncated;

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'git.show',
    decision: 'allow',
    result: `ref=${config.ref} sha=${sha.slice(0, 8)} truncated=${truncated} argsHash=${argsHash}`
  });

  return { meta: { sha, author, date, subject, parents }, patch, truncated };
}

export async function runGitBlame(
  config: { path: string; cwd?: string; startLine?: number; endLine?: number; maxBytes?: number },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<GitBlameResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();

  const decision = await security.authorize('git.blame', { path: config.path, cwd });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    throw new Error('NOT_A_REPO');
  }

  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const relPath = path.relative(repoRoot, expandPath(config.path));
  const args = ['blame', '--line-porcelain'];
  if (config.startLine) args.push('-L', `${config.startLine},${config.endLine ?? config.startLine}`);
  args.push('--', relPath);

  const result = await runGit(args, repoRoot, maxBytes);

  if (result.exitCode !== 0) {
    throw new Error(`git blame failed: ${result.stderr}`);
  }

  const lines: GitBlameLine[] = [];
  let current: Partial<GitBlameLine> = {};

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('\t')) {
      if (current.lineNo !== undefined && current.sha && current.author && current.date && current.content !== undefined) {
        lines.push({
          lineNo: current.lineNo,
          sha: current.sha,
          shortSha: current.sha.slice(0, 8),
          author: current.author,
          date: current.date,
          content: current.content
        });
      }
      current = { content: line.slice(1) };
    } else if (line.startsWith('author ')) {
      current.author = line.slice(7);
    } else if (line.startsWith('author-time ')) {
      current.date = new Date(parseInt(line.slice(12), 10) * 1000).toISOString();
    } else if (/^[0-9a-f]{40} \d+ \d+/.test(line)) {
      const parts = line.split(' ');
      current.sha = parts[0];
      current.lineNo = parseInt(parts[2], 10);
    }
  }

  if (current.lineNo !== undefined && current.sha && current.author && current.date && current.content !== undefined) {
    lines.push({
      lineNo: current.lineNo,
      sha: current.sha,
      shortSha: current.sha.slice(0, 8),
      author: current.author,
      date: current.date,
      content: current.content
    });
  }

  const truncated = result.truncated;

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'git.blame',
    decision: 'allow',
    result: `path=${relPath} lines=${lines.length} truncated=${truncated} argsHash=${argsHash}`
  });

  return { lines, truncated };
}