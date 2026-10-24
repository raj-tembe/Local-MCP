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

export interface GitAddResult {
  staged: string[];
  dryRun: boolean;
  [key: string]: unknown;
}

export interface GitCommitResult {
  sha: string;
  shortSha: string;
  message: string;
  filesChanged: number;
  [key: string]: unknown;
}

export interface GitStashResult {
  action: string;
  ok: boolean;
  detail?: string;
  stashes?: Array<{ index: number; message: string; sha: string }>;
  [key: string]: unknown;
}

export interface GitCheckoutResult {
  branch?: string;
  sha?: string;
  detached: boolean;
  previousRef: string;
  switchedFiles: string[];
  [key: string]: unknown;
}

export interface GitBranchResult {
  branches?: Array<{ name: string; current: boolean; sha?: string; upstream?: string }>;
  action?: string;
  ok?: boolean;
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

export async function runGitAdd(
  config: { paths: string[]; cwd?: string; dryRun?: boolean },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<GitAddResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const isDryRun = config.dryRun ?? false;

  if (!isDryRun) {
    const decision = await security.authorize('git.add', { paths: config.paths, cwd });
    if (!decision.allowed) {
      throw new Error(decision.reason ?? 'Permission denied');
    }
  } else {
    const toolCheck = security.checkToolAllowed('git.add');
    if (!toolCheck.allowed) {
      throw new Error(toolCheck.reason ?? 'Permission denied');
    }
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    throw new Error('NOT_A_REPO');
  }

  if (!isDryRun) {
    const result = await runGit(['add', ...config.paths], repoRoot, DEFAULT_MAX_BYTES);
    if (result.exitCode !== 0) {
      throw new Error(`git add failed: ${result.stderr}`);
    }
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'git.add',
    decision: isDryRun ? 'allow' : 'allow',
    result: `dryRun=${isDryRun} paths=${config.paths.length} argsHash=${argsHash}`
  });

  return { staged: config.paths, dryRun: isDryRun };
}

export async function runGitCommit(
  config: {
    message: string;
    paths?: string[];
    cwd?: string;
    amend?: boolean;
    signoff?: boolean;
    dryRun?: boolean;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<GitCommitResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const isDryRun = config.dryRun ?? false;

  if (!isDryRun) {
    const decision = await security.authorize('git.commit', { message: config.message, paths: config.paths, cwd, amend: config.amend });
    if (!decision.allowed) {
      throw new Error(decision.reason ?? 'Permission denied');
    }
  } else {
    const toolCheck = security.checkToolAllowed('git.commit');
    if (!toolCheck.allowed) {
      throw new Error(toolCheck.reason ?? 'Permission denied');
    }
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    throw new Error('NOT_A_REPO');
  }

  if (!isDryRun) {
    const statusResult = await runGit(['status', '--porcelain'], repoRoot, DEFAULT_MAX_BYTES);
    if (!statusResult.stdout.trim()) {
      throw new Error('NOTHING_TO_COMMIT');
    }

    const args = ['commit'];
    if (config.amend) args.push('--amend');
    if (config.signoff) args.push('--signoff');
    args.push('-m', config.message);
    if (config.paths && config.paths.length > 0) {
      args.push('--', ...config.paths);
    }

    const result = await runGit(args, repoRoot, DEFAULT_MAX_BYTES);
    if (result.exitCode !== 0) {
      throw new Error(`git commit failed: ${result.stderr}`);
    }

    const logResult = await runGit(['log', '-1', '--format=%H%x00%h'], repoRoot, DEFAULT_MAX_BYTES);
    const [sha, shortSha] = logResult.stdout.trim().split('\x00');

    const diffResult = await runGit(['diff', '--stat', 'HEAD~1..HEAD'], repoRoot, DEFAULT_MAX_BYTES);
    const filesChanged = diffResult.stdout.trim().split('\n').filter(Boolean).length;

    const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
    audit.log({
      timestamp: new Date().toISOString(),
      sessionId,
      tool: 'git.commit',
      decision: 'allow',
      result: `sha=${sha?.slice(0, 8)} message="${config.message.slice(0, 50)}" filesChanged=${filesChanged} argsHash=${argsHash}`
    });

    return { sha: sha ?? '', shortSha: shortSha ?? '', message: config.message, filesChanged };
  }

  return { sha: '', shortSha: '', message: config.message, filesChanged: 0 };
}

export async function runGitStash(
  config: {
    action: 'push' | 'pop' | 'list' | 'drop' | 'apply';
    message?: string;
    index?: number;
    includeUntracked?: boolean;
    cwd?: string;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<GitStashResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();

  const decision = await security.authorize('git.stash', { action: config.action, cwd });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    throw new Error('NOT_A_REPO');
  }

  let result: { stdout: string; stderr: string; exitCode: number | null; truncated: boolean };
  let detail = '';

  switch (config.action) {
    case 'push': {
      const args = ['stash', 'push'];
      if (config.message) args.push('-m', config.message);
      if (config.includeUntracked) args.push('-u');
      result = await runGit(args, repoRoot, DEFAULT_MAX_BYTES);
      detail = result.stdout;
      break;
    }
    case 'pop': {
      const args = ['stash', 'pop'];
      if (config.index !== undefined) args.push(`stash@{${config.index}}`);
      result = await runGit(args, repoRoot, DEFAULT_MAX_BYTES);
      detail = result.stdout;
      break;
    }
    case 'apply': {
      const args = ['stash', 'apply'];
      if (config.index !== undefined) args.push(`stash@{${config.index}}`);
      result = await runGit(args, repoRoot, DEFAULT_MAX_BYTES);
      detail = result.stdout;
      break;
    }
    case 'drop': {
      const args = ['stash', 'drop'];
      if (config.index !== undefined) args.push(`stash@{${config.index}}`);
      result = await runGit(args, repoRoot, DEFAULT_MAX_BYTES);
      detail = result.stdout;
      break;
    }
    case 'list': {
      result = await runGit(['stash', 'list', '--format=%gd%x00%gs%x00%H'], repoRoot, DEFAULT_MAX_BYTES);
      const stashes = result.stdout.trim().split('\n').filter(Boolean).map(line => {
        const [index, message, sha] = line.split('\x00');
        return { index: parseInt(index.replace('stash@{', '').replace('}', ''), 10), message, sha };
      });
      return { action: 'list', ok: true, stashes };
    }
    default:
      throw new Error(`Unknown stash action: ${config.action}`);
  }

  const ok = result.exitCode === 0;

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'git.stash',
    decision: 'allow',
    result: `action=${config.action} ok=${ok} argsHash=${argsHash}`
  });

  return { action: config.action, ok, detail: ok ? detail : result.stderr };
}

export async function runGitCheckout(
  config: {
    target: string;
    create?: boolean;
    paths?: string[];
    force?: boolean;
    cwd?: string;
    dryRun?: boolean;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<GitCheckoutResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const isDryRun = config.dryRun ?? false;

  if (!isDryRun) {
    const decision = await security.authorize('git.checkout', { target: config.target, create: config.create, paths: config.paths, force: config.force, cwd });
    if (!decision.allowed) {
      throw new Error(decision.reason ?? 'Permission denied');
    }
  } else {
    const toolCheck = security.checkToolAllowed('git.checkout');
    if (!toolCheck.allowed) {
      throw new Error(toolCheck.reason ?? 'Permission denied');
    }
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    throw new Error('NOT_A_REPO');
  }

  if (config.force && !isDryRun) {
    const statusResult = await runGit(['status', '--porcelain'], repoRoot, DEFAULT_MAX_BYTES);
    if (statusResult.stdout.trim()) {
      const forceConfirm = await security.authorize('git.checkout', { 
        target: config.target, 
        create: config.create, 
        paths: config.paths, 
        force: true, 
        cwd,
        forceConfirm: true 
      });
      if (!forceConfirm.allowed) {
        throw new Error(forceConfirm.reason ?? 'Force checkout denied - requires second confirmation');
      }
    }
  }

  const beforeResult = await runGit(['rev-parse', 'HEAD'], repoRoot, DEFAULT_MAX_BYTES);
  const previousRef = beforeResult.stdout.trim();

  if (!isDryRun) {
    const args = ['checkout'];
    if (config.create) args.push('-b');
    args.push(config.target);
    if (config.paths && config.paths.length > 0) {
      args.push('--', ...config.paths);
    }
    if (config.force) args.push('-f');

    const result = await runGit(args, repoRoot, DEFAULT_MAX_BYTES);
    if (result.exitCode !== 0) {
      throw new Error(`git checkout failed: ${result.stderr}`);
    }
  }

  const afterResult = await runGit(['rev-parse', 'HEAD'], repoRoot, DEFAULT_MAX_BYTES);
  const currentSha = afterResult.stdout.trim();
  const detached = !currentSha.startsWith('refs/');

  let branch = '';
  let sha = '';
  if (detached) {
    sha = currentSha;
  } else {
    branch = currentSha.replace('refs/heads/', '');
  }

  let switchedFiles: string[] = [];
  if (config.paths && config.paths.length > 0) {
    const diffResult = await runGit(['diff', '--name-only', previousRef, 'HEAD', '--', ...config.paths], repoRoot, DEFAULT_MAX_BYTES);
    switchedFiles = diffResult.stdout.trim().split('\n').filter(Boolean);
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'git.checkout',
    decision: isDryRun ? 'allow' : 'allow',
    result: `dryRun=${isDryRun} target=${config.target} branch=${branch} detached=${detached} argsHash=${argsHash}`
  });

  return { branch: branch || undefined, sha: sha || undefined, detached, previousRef, switchedFiles };
}

export async function runGitBranch(
  config: {
    action: 'list' | 'create' | 'delete' | 'rename';
    name?: string;
    from?: string;
    force?: boolean;
    cwd?: string;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<GitBranchResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();

  const decision = await security.authorize('git.branch', { action: config.action, name: config.name, from: config.from, force: config.force, cwd });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    throw new Error('NOT_A_REPO');
  }

  if (config.action === 'list') {
    const result = await runGit(['branch', '-a', '-v'], repoRoot, DEFAULT_MAX_BYTES);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const branches = lines.map(line => {
      const match = line.match(/^(\*?)\s+(\S+)\s+(\S+)?\s*(.*)/);
      if (!match) return null;
      const [, star, name, sha, rest] = match;
      const current = star === '*';
      const upstreamMatch = rest.match(/\[([^\]]+)\]/);
      const upstream = upstreamMatch ? upstreamMatch[1] : undefined;
      return { name, current, sha: sha || undefined, upstream };
    }).filter(Boolean) as Array<{ name: string; current: boolean; sha: string | undefined; upstream: string | undefined }>;
    return { branches };
  }

  if (config.action === 'create') {
    if (!config.name) throw new Error('Branch name required for create');
    const args = ['branch'];
    if (config.force) args.push('-f');
    args.push(config.name);
    if (config.from) args.push(config.from);
    const result = await runGit(args, repoRoot, DEFAULT_MAX_BYTES);
    if (result.exitCode !== 0) throw new Error(`git branch create failed: ${result.stderr}`);
  } else if (config.action === 'delete') {
    if (!config.name) throw new Error('Branch name required for delete');
    const args = ['branch', config.force ? '-D' : '-d', config.name];
    const result = await runGit(args, repoRoot, DEFAULT_MAX_BYTES);
    if (result.exitCode !== 0) throw new Error(`git branch delete failed: ${result.stderr}`);
  } else if (config.action === 'rename') {
    if (!config.name || !config.from) throw new Error('Both name (new) and from (old) required for rename');
    const args = ['branch', '-m', config.from, config.name];
    if (config.force) args.unshift('-M');
    const result = await runGit(args, repoRoot, DEFAULT_MAX_BYTES);
    if (result.exitCode !== 0) throw new Error(`git branch rename failed: ${result.stderr}`);
  }

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'git.branch',
    decision: 'allow',
    result: `action=${config.action} name=${config.name} argsHash=${argsHash}`
  });

  return { action: config.action, ok: true };
}