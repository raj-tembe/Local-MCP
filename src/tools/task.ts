import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SecurityEngine } from '../security/security.js';
import { AuditLogger } from '../audit/audit.js';
import { runProcess, clampTimeout } from '../exec/run.js';

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

interface ScriptInfo {
  command: string;
  manager: string;
  args: string[];
}

async function detectScript(cwd: string, scriptName: string): Promise<ScriptInfo | null> {
  const packageJsonPath = path.join(cwd, 'package.json');
  try {
    const content = await fsp.readFile(packageJsonPath, 'utf8');
    const pkg = JSON.parse(content);
    if (pkg.scripts && pkg.scripts[scriptName]) {
      return { command: pkg.scripts[scriptName], manager: 'npm', args: [] };
    }
  } catch {}

  const makefilePath = path.join(cwd, 'Makefile');
  if (fs.existsSync(makefilePath)) {
    try {
      const content = await fsp.readFile(makefilePath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const match = line.match(`^${scriptName}\\s*:`);
        if (match) {
          return { command: 'make', manager: 'make', args: [scriptName] };
        }
      }
    } catch {}
  }

  const justfilePath = path.join(cwd, 'justfile');
  if (fs.existsSync(justfilePath)) {
    try {
      const content = await fsp.readFile(justfilePath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const match = line.match(`^${scriptName}\\s*:`);
        if (match) {
          return { command: 'just', manager: 'just', args: [scriptName] };
        }
      }
    } catch {}
  }

  const pyprojectPath = path.join(cwd, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const content = await fsp.readFile(pyprojectPath, 'utf8');
      const toolMatch = content.match(new RegExp(`\\[tool\\.poetry\\.scripts\\]([\\s\\S]*?)(?=\\n\\[|\\n*$)`));
      if (toolMatch) {
        const scriptMatch = toolMatch[1].match(new RegExp(`^${scriptName}\\s*=\\s*["'](.+)["']`, 'm'));
        if (scriptMatch) {
          return { command: scriptMatch[1], manager: 'poetry', args: ['run', scriptName] };
        }
      }
    } catch {}
  }

  const cargoPath = path.join(cwd, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    try {
      const content = await fsp.readFile(cargoPath, 'utf8');
      if (content.includes(`name = "${scriptName}"`) || content.includes(`name = '${scriptName}'`)) {
        return { command: 'cargo', manager: 'cargo', args: ['run', '--bin', scriptName] };
      }
    } catch {}
  }

  return null;
}

function parseTestOutput(output: string, framework: string): { total: number; passed: number; failed: number; skipped: number; failingTests: Array<{ name: string; file?: string; line?: number; message: string }> } | null {
  const failingTests: Array<{ name: string; file?: string; line?: number; message: string }> = [];
  let total = 0, passed = 0, failed = 0, skipped = 0;

  try {
    if (framework === 'vitest' || framework === 'jest') {
      const testMatch = output.match(/Test Files\s+(\d+)\s+\|\s+(\d+)\s+passed\s+\|\s+(\d+)\s+failed/);
      if (testMatch) {
        passed = parseInt(testMatch[2], 10);
        failed = parseInt(testMatch[3], 10);
        total = passed + failed;
      }
      const failLines = output.split('\n').filter(l => l.includes('FAIL') || l.includes('✗') || l.includes('❌'));
      for (const line of failLines.slice(0, 20)) {
        failingTests.push({ name: line.trim(), message: line.trim() });
      }
    } else if (framework === 'pytest') {
      const match = output.match(/(\d+) passed,?\s*(\d+)?\s*failed,?\s*(\d+)?\s*skipped/);
      if (match) {
        passed = parseInt(match[1], 10);
        failed = parseInt(match[2] || '0', 10);
        skipped = parseInt(match[3] || '0', 10);
        total = passed + failed + skipped;
      }
      const failLines = output.split('\n').filter(l => l.includes('FAILED') || l.includes('AssertionError'));
      for (const line of failLines.slice(0, 20)) {
        const fileMatch = line.match(/([\w\/\\.-]+\.py)::(\w+)/);
        failingTests.push({ 
          name: fileMatch ? fileMatch[2] : line.trim(), 
          file: fileMatch ? fileMatch[1] : undefined,
          message: line.trim() 
        });
      }
    } else if (framework === 'cargo test') {
      const match = output.match(/test result: (\w+)\. (\d+) passed; (\d+) failed/);
      if (match) {
        passed = parseInt(match[2], 10);
        failed = parseInt(match[3], 10);
        total = passed + failed;
      }
      const failLines = output.split('\n').filter(l => l.includes('FAILED') || l.includes('thread.*panicked'));
      for (const line of failLines.slice(0, 20)) {
        failingTests.push({ name: line.trim(), message: line.trim() });
      }
    } else if (framework === 'go test') {
      const match = output.match(/--- (PASS|FAIL): (\S+)/g);
      if (match) {
        for (const m of match) {
          if (m.includes('PASS')) passed++;
          if (m.includes('FAIL')) failed++;
        }
        total = passed + failed;
      }
    }
  } catch {}

  if (total === 0 && failed === 0 && passed === 0) return null;

  return { total, passed, failed, skipped, failingTests };
}

function detectFramework(cwd: string, command: string): string | undefined {
  if (command.includes('vitest')) return 'vitest';
  if (command.includes('jest')) return 'jest';
  if (command.includes('pytest')) return 'pytest';
  if (command.includes('cargo test')) return 'cargo test';
  if (command.includes('go test')) return 'go test';
  if (command.includes('mocha')) return 'mocha';
  return undefined;
}

export interface TaskRunResult {
  script: string;
  command: string;
  exitCode: number | null;
  status: 'passed' | 'failed' | 'timeout' | 'error';
  durationMs: number;
  framework?: string;
  summary?: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    failingTests: Array<{ name: string; file?: string; line?: number; message: string }>;
  };
  stdout: string;
  stderr: string;
  truncated: boolean;
  [key: string]: unknown;
}

export async function runTaskRun(
  config: {
    script: string;
    cwd?: string;
    args?: string[];
    timeoutMs?: number;
    env?: Record<string, string>;
    maxBytes?: number;
  },
  security: SecurityEngine,
  audit: AuditLogger,
  sessionId: string
): Promise<TaskRunResult> {
  const cwd = config.cwd ? expandPath(config.cwd) : process.cwd();
  const isDryRun = false;

  const scriptInfo = await detectScript(cwd, config.script);
  if (!scriptInfo) {
    throw new Error(`Script "${config.script}" not found in package.json, Makefile, justfile, pyproject.toml, or Cargo.toml`);
  }

  const manager = scriptInfo.manager;
  const baseArgs = [...scriptInfo.args];
  const extraArgs = config.args ?? [];
  
  let fullCommand: string;
  let file: string;
  let args: string[];

  if (manager === 'npm' || manager === 'pnpm' || manager === 'yarn' || manager === 'bun') {
    file = manager;
    args = ['run', config.script, ...extraArgs];
    fullCommand = `${manager} run ${config.script} ${extraArgs.join(' ')}`.trim();
  } else if (manager === 'make') {
    file = 'make';
    args = [config.script, ...extraArgs];
    fullCommand = `make ${config.script} ${extraArgs.join(' ')}`.trim();
  } else if (manager === 'just') {
    file = 'just';
    args = [config.script, ...extraArgs];
    fullCommand = `just ${config.script} ${extraArgs.join(' ')}`.trim();
  } else if (manager === 'poetry') {
    file = 'poetry';
    args = ['run', config.script, ...extraArgs];
    fullCommand = `poetry run ${config.script} ${extraArgs.join(' ')}`.trim();
  } else if (manager === 'cargo') {
    file = 'cargo';
    args = ['run', '--bin', config.script, ...extraArgs];
    fullCommand = `cargo run --bin ${config.script} ${extraArgs.join(' ')}`.trim();
  } else {
    file = scriptInfo.command.split(' ')[0];
    args = scriptInfo.command.split(' ').slice(1).concat(extraArgs);
    fullCommand = `${scriptInfo.command} ${extraArgs.join(' ')}`.trim();
  }

  if (!file.includes(path.sep)) {
    const found = await import('node:fs/promises').then(m => m.access(file, fs.constants.X_OK).then(() => true).catch(() => false));
    if (!found) {
      const whichResult = await runProcess({ file: 'which', args: [file], timeoutMs: 5000 });
      if (whichResult.exitCode !== 0) {
        throw new Error(`Command '${file}' not found on PATH`);
      }
    }
  }

  const decision = await security.authorize('task.run', { script: config.script, command: fullCommand, cwd, args: extraArgs });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? 'Permission denied');
  }

  const framework = detectFramework(cwd, fullCommand);
  const timeoutMs = clampTimeout(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;

  const startTime = Date.now();
  const env = config.env ? { ...process.env, ...config.env } : process.env;
  const result = await runProcess({
    file,
    args,
    cwd,
    env: env as Record<string, string>,
    timeoutMs,
    maxOutputBytes: maxBytes
  });
  const durationMs = Date.now() - startTime;

  let status: 'passed' | 'failed' | 'timeout' | 'error';
  if (result.timedOut) status = 'timeout';
  else if (result.spawnError) status = 'error';
  else if (result.exitCode === 0) status = 'passed';
  else status = 'failed';

  let summary: TaskRunResult['summary'] | undefined;
  if (framework) {
    summary = parseTestOutput(result.stdout + '\n' + result.stderr, framework) || undefined;
  }

  const { stdout, stderr, truncated } = result;

  const argsHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
  audit.log({
    timestamp: new Date().toISOString(),
    sessionId,
    tool: 'task.run',
    decision: 'allow',
    result: `script=${config.script} status=${status} duration=${durationMs}ms framework=${framework || 'none'} truncated=${truncated} argsHash=${argsHash}`
  });

  return {
    script: config.script,
    command: fullCommand,
    exitCode: result.exitCode,
    status,
    durationMs,
    framework,
    summary,
    stdout,
    stderr,
    truncated
  };
}