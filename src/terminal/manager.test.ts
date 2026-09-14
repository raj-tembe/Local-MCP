import { describe, it, expect } from 'vitest';
import { TerminalManager } from './manager.js';

describe('terminal manager', () => {
  it('creates and lists PTY sessions', () => {
    const manager = new TerminalManager();
    const session = manager.createSession('bash', { cwd: process.cwd() });

    expect(session.id).toBeTruthy();
    expect(manager.listSessions().length).toBe(1);
    expect(manager.getSession(session.id)).toBeDefined();
  });

  it('accepts writes and reads output buffers', async () => {
    const manager = new TerminalManager();
    const session = manager.createSession('bash', { cwd: process.cwd() });

    manager.write(session.id, 'echo hello\n');
    const output = await manager.waitForOutput(session.id, (text) => text.includes('hello'), 2000);
    expect(output).toContain('hello');
  });
});
