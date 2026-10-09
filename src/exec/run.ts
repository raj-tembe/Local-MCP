import { spawn } from 'node:child_process';

export type RunOptions = {
  file: string;
  args?: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
};

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  spawnError?: string;
};

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

export function clampTimeout(timeoutMs: number | undefined, fallback = DEFAULT_TIMEOUT_MS): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return fallback;
  return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS);
}

/** Kill a child and everything it spawned (the child is started in its own process group). */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Run an executable directly (no shell) and collect its output.
 * Never throws: failures are reported in the result.
 */
export function runProcess(options: RunOptions): Promise<RunResult> {
  const timeoutMs = clampTimeout(options.timeoutMs);
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(options.file, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });

    const finish = (result: Partial<RunResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
        ...result
      });
    };

    const collect = (which: 'out' | 'err') => (chunk: Buffer) => {
      if (truncated) return;
      const remaining = maxBytes - outBytes;
      const text = chunk.toString('utf8');
      if (chunk.length > remaining) {
        const part = chunk.subarray(0, Math.max(remaining, 0)).toString('utf8');
        if (which === 'out') stdout += part; else stderr += part;
        outBytes = maxBytes;
        truncated = true;
        killTree(child.pid, 'SIGTERM');
        return;
      }
      outBytes += chunk.length;
      if (which === 'out') stdout += text; else stderr += text;
    };

    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, 'SIGTERM');
      setTimeout(() => killTree(child.pid, 'SIGKILL'), 2000).unref();
    }, timeoutMs);

    child.on('error', (error) => {
      finish({ spawnError: error.message });
    });

    child.on('close', (code, signal) => {
      finish({ exitCode: code, signal });
    });

    child.stdin.on('error', () => { /* process may exit before reading stdin */ });
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}
