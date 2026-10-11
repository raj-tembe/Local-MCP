import { describe, it, expect, afterEach } from 'vitest';
import { TerminalManager, PtyUnavailableError, isPtyAvailable, loadPty, type PtyModule, type PtyProcess } from './manager.js';

// Real PTY tests need the optional node-pty native module; skip them where it is not built.
const realPty = isPtyAvailable();

describe.skipIf(!realPty)('terminal manager (real PTY)', () => {
  it('creates and lists PTY sessions', () => {
    const manager = new TerminalManager();
    const session = manager.createSession('bash', { cwd: process.cwd() });
    try {
      expect(session.id).toBeTruthy();
      expect(manager.listSessions().length).toBe(1);
      expect(manager.getSession(session.id)).toBeDefined();
    } finally {
      manager.kill(session.id);
    }
  });

  it('accepts writes and reads output buffers', async () => {
    const manager = new TerminalManager();
    const session = manager.createSession('bash', { cwd: process.cwd() });
    try {
      manager.write(session.id, 'echo hello\n');
      const output = await manager.waitForOutput(session.id, (text) => text.includes('hello'), 2000);
      expect(output).toContain('hello');
    } finally {
      manager.kill(session.id);
    }
  });
});

function fakePty() {
  const calls = { spawned: [] as Array<{ file: string; cwd?: string }>, written: [] as string[], resized: [] as Array<[number, number]>, killed: 0 };
  let emit: (data: string) => void = () => undefined;
  const proc: PtyProcess = {
    write: (data) => { calls.written.push(data); },
    resize: (cols, rows) => { calls.resized.push([cols, rows]); },
    kill: () => { calls.killed++; },
    onData: (listener) => { emit = listener; }
  };
  const module: PtyModule = {
    spawn: (file, _args, options) => { calls.spawned.push({ file, cwd: options.cwd }); return proc; }
  };
  return { module, calls, emit: (data: string) => emit(data) };
}

describe('terminal manager (fake PTY, no native module needed)', () => {
  it('spawns, buffers output, forwards input, resizes and kills', async () => {
    const fake = fakePty();
    const manager = new TerminalManager(() => fake.module);
    const session = manager.createSession('zsh', { cwd: '/tmp' });
    expect(fake.calls.spawned).toEqual([{ file: 'zsh', cwd: '/tmp' }]);

    fake.emit('hello ');
    fake.emit('world');
    expect(manager.read(session.id)).toBe('hello world');
    expect(await manager.waitForOutput(session.id, (t) => t.includes('world'), 200)).toBe('hello world');

    manager.write(session.id, 'ls\n');
    manager.resize(session.id, 100, 40);
    expect(fake.calls.written).toEqual(['ls\n']);
    expect(fake.calls.resized).toEqual([[100, 40]]);

    manager.kill(session.id);
    expect(fake.calls.killed).toBe(1);
    expect(manager.listSessions()).toEqual([]);
  });

  it('rejects unknown sessions', () => {
    const manager = new TerminalManager(() => fakePty().module);
    expect(() => manager.write('nope', 'x')).toThrow(/Unknown session/);
    expect(() => manager.read('nope')).toThrow(/Unknown session/);
  });
});

describe('PTY unavailable', () => {
  const original = process.env.LOCAL_MCP_DISABLE_PTY;
  afterEach(() => {
    if (original === undefined) delete process.env.LOCAL_MCP_DISABLE_PTY; else process.env.LOCAL_MCP_DISABLE_PTY = original;
  });

  it('createSession fails with a helpful error, while read-only calls still work', () => {
    const manager = new TerminalManager(() => { throw new PtyUnavailableError('test reason'); });
    expect(() => manager.createSession('bash')).toThrow(PtyUnavailableError);
    expect(() => manager.createSession('bash')).toThrow(/shell\.execute/);
    expect(manager.listSessions()).toEqual([]);
  });

  it('LOCAL_MCP_DISABLE_PTY=1 turns PTY sessions off', () => {
    process.env.LOCAL_MCP_DISABLE_PTY = '1';
    expect(isPtyAvailable()).toBe(false);
    expect(() => loadPty()).toThrow(/LOCAL_MCP_DISABLE_PTY/);
  });
});
