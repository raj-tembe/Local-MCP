import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { killTree } from '../exec/run.js';

export type ManagedProcessStatus = 'running' | 'exited' | 'killed' | 'failed';

export type ManagedProcess = {
  id: string;
  name?: string;
  command: string;
  cwd?: string;
  pid?: number;
  status: ManagedProcessStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt?: number;
  /** Rolling combined stdout+stderr, capped. */
  log: string;
  /** Total bytes ever written to the log (so callers can tail incrementally). */
  totalBytes: number;
  error?: string;
  child?: ChildProcess;
};

const MAX_LOG_CHARS = 200_000;
const MAX_PROCESSES = 20;

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();

  start(command: string, options: { cwd?: string; name?: string; env?: Record<string, string> } = {}): ManagedProcess {
    const running = [...this.processes.values()].filter((p) => p.status === 'running').length;
    if (running >= MAX_PROCESSES) {
      throw new Error(`Too many running background processes (max ${MAX_PROCESSES}). Stop one first.`);
    }

    if (this.processes.size >= 100) this.prune();

    const entry: ManagedProcess = {
      id: randomUUID().slice(0, 8),
      name: options.name,
      command,
      cwd: options.cwd,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      log: '',
      totalBytes: 0
    };

    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    entry.child = child;
    entry.pid = child.pid;

    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      entry.totalBytes += chunk.length;
      entry.log += text;
      if (entry.log.length > MAX_LOG_CHARS) {
        entry.log = entry.log.slice(entry.log.length - MAX_LOG_CHARS);
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    child.on('error', (error) => {
      entry.status = 'failed';
      entry.error = error.message;
      entry.endedAt = Date.now();
    });
    child.on('close', (code, signal) => {
      entry.exitCode = code;
      entry.signal = signal;
      entry.endedAt = Date.now();
      if (entry.status === 'running') {
        entry.status = signal ? 'killed' : 'exited';
      }
    });

    this.processes.set(entry.id, entry);
    return entry;
  }

  get(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  list(): ManagedProcess[] {
    return [...this.processes.values()];
  }

  /** Last `tailChars` characters of the log. */
  logs(id: string, tailChars = 8000): string | undefined {
    const entry = this.processes.get(id);
    if (!entry) return undefined;
    return tailChars >= entry.log.length ? entry.log : entry.log.slice(entry.log.length - tailChars);
  }

  async stop(id: string, graceMs = 3000): Promise<ManagedProcess | undefined> {
    const entry = this.processes.get(id);
    if (!entry) return undefined;
    if (entry.status !== 'running' || !entry.child) return entry;

    killTree(entry.pid, 'SIGTERM');
    const exited = await this.waitForExit(entry, graceMs);
    if (!exited) {
      killTree(entry.pid, 'SIGKILL');
      await this.waitForExit(entry, 2000);
    }
    if (entry.status === 'running') entry.status = 'killed';
    return entry;
  }

  /** Drop finished processes from the table. */
  prune(): number {
    let removed = 0;
    for (const [id, entry] of this.processes) {
      if (entry.status !== 'running') {
        this.processes.delete(id);
        removed++;
      }
    }
    return removed;
  }

  killAll(): void {
    for (const entry of this.processes.values()) {
      if (entry.status === 'running') killTree(entry.pid, 'SIGKILL');
    }
  }

  private waitForExit(entry: ManagedProcess, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (entry.status !== 'running') return resolve(true);
      const started = Date.now();
      const poll = setInterval(() => {
        if (entry.status !== 'running') {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(poll);
          resolve(false);
        }
      }, 25);
    });
  }
}

export function summarize(entry: ManagedProcess) {
  return {
    id: entry.id,
    name: entry.name,
    command: entry.command,
    cwd: entry.cwd,
    pid: entry.pid,
    status: entry.status,
    exitCode: entry.exitCode,
    signal: entry.signal,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    logBytes: entry.totalBytes,
    error: entry.error
  };
}

/** Shared across MCP sessions so background processes survive client reconnects. */
export const sharedProcessManager = new ProcessManager();

let exitHookInstalled = false;
export function installExitCleanup(manager: ProcessManager = sharedProcessManager): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => manager.killAll());
  // Node's default SIGINT/SIGTERM behaviour skips 'exit' handlers, so clean up explicitly.
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.once(signal, () => {
      manager.killAll();
      process.exit(code);
    });
  }
}
