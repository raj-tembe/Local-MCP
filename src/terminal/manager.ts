import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

/** The small part of node-pty's API that Local-MCP uses, so node-pty's types are not required. */
export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string | undefined>; cols?: number; rows?: number; name?: string }
  ): PtyProcess;
}

export class PtyUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `PTY terminal sessions are not available: ${reason}. ` +
      'Everything else works. For commands use shell.execute, code.run or process.start. ' +
      "To enable PTY sessions, install node-pty's build prerequisites (Python 3, make and a C++ compiler on Linux) and run 'npm install node-pty' next to Local-MCP."
    );
    this.name = 'PtyUnavailableError';
  }
}

let cachedPty: PtyModule | undefined;

/**
 * node-pty is a native addon and an optional dependency: it is loaded on first use so that a
 * machine where it could not be built can still run every other tool. Set LOCAL_MCP_DISABLE_PTY=1
 * to turn PTY sessions off explicitly.
 */
export function loadPty(): PtyModule {
  if (process.env.LOCAL_MCP_DISABLE_PTY === '1') {
    throw new PtyUnavailableError('disabled by LOCAL_MCP_DISABLE_PTY=1');
  }
  if (cachedPty) return cachedPty;

  // import.meta.url is not defined in the single-file binary build; treat that as "not bundled".
  const base: unknown = import.meta.url;
  if (typeof base !== 'string') {
    throw new PtyUnavailableError('this build does not include the node-pty native module');
  }
  try {
    cachedPty = createRequire(base)('node-pty') as PtyModule;
    return cachedPty;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new PtyUnavailableError(`the optional node-pty module could not be loaded (${reason})`);
  }
}

export function isPtyAvailable(): boolean {
  try {
    loadPty();
    return true;
  } catch {
    return false;
  }
}

export type TerminalSession = {
  id: string;
  shell: string;
  cwd?: string;
  pty: PtyProcess;
  buffer: string;
  createdAt: number;
  lastActivity: number;
};

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(private readonly loader: () => PtyModule = loadPty) {}

  createSession(shell = 'bash', options: { cwd?: string; env?: Record<string, string> } = {}): TerminalSession {
    const { spawn } = this.loader();
    const id = randomUUID();
    const pty = spawn(shell, [], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      cols: 120,
      rows: 30,
      name: 'xterm-color'
    });

    const session: TerminalSession = {
      id,
      shell,
      cwd: options.cwd ?? process.cwd(),
      pty,
      buffer: '',
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    pty.onData((data) => {
      session.buffer += data;
      session.lastActivity = Date.now();
    });

    this.sessions.set(id, session);
    return session;
  }

  write(sessionId: string, input: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    session.pty.write(input);
    session.lastActivity = Date.now();
  }

  read(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session.buffer;
  }

  async waitForOutput(sessionId: string, predicate: (output: string) => boolean, timeoutMs = 1000): Promise<string> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const output = this.read(sessionId);
      if (predicate(output)) {
        return output;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return this.read(sessionId);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    session.pty.resize(cols, rows);
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.pty.kill();
    this.sessions.delete(sessionId);
  }

  listSessions(): Array<{ id: string; shell: string; cwd?: string; createdAt: number; lastActivity: number }> {
    return [...this.sessions.values()].map(({ id, shell, cwd, createdAt, lastActivity }) => ({
      id,
      shell,
      cwd,
      createdAt,
      lastActivity
    }));
  }

  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }
}
