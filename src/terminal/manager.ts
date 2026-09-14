import { randomUUID } from 'node:crypto';
import { spawn, type IPty } from 'node-pty';

export type TerminalSession = {
  id: string;
  shell: string;
  cwd?: string;
  pty: IPty;
  buffer: string;
  createdAt: number;
  lastActivity: number;
};

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  createSession(shell = 'bash', options: { cwd?: string; env?: Record<string, string> } = {}): TerminalSession {
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
