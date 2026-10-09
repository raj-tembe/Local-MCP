import { describe, it, expect, afterEach } from 'vitest';
import { ProcessManager } from './manager.js';

const sleepUntil = async (predicate: () => boolean, timeoutMs = 5000) => {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await new Promise((r) => setTimeout(r, 25));
};

describe('ProcessManager', () => {
  const manager = new ProcessManager();
  afterEach(() => manager.killAll());

  it('starts a process and captures logs and exit status', async () => {
    const p = manager.start(`${JSON.stringify(process.execPath)} -e "console.log('ready'); console.error('oops')"`);
    await sleepUntil(() => manager.get(p.id)!.status !== 'running');
    const done = manager.get(p.id)!;
    expect(done.status).toBe('exited');
    expect(done.exitCode).toBe(0);
    expect(manager.logs(p.id)).toContain('ready');
    expect(manager.logs(p.id)).toContain('oops');
  });

  it('stops long-running processes including children', async () => {
    const p = manager.start('sleep 60 & sleep 60; wait');
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.get(p.id)!.status).toBe('running');
    const stopped = await manager.stop(p.id, 1000);
    expect(stopped!.status).not.toBe('running');
  });

  it('reports failures for non-zero exits', async () => {
    const p = manager.start('exit 7');
    await sleepUntil(() => manager.get(p.id)!.status !== 'running');
    expect(manager.get(p.id)!.exitCode).toBe(7);
  });

  it('tails logs and prunes finished processes', async () => {
    const p = manager.start(`${JSON.stringify(process.execPath)} -e "process.stdout.write('0123456789')"`);
    await sleepUntil(() => manager.get(p.id)!.status !== 'running');
    expect(manager.logs(p.id, 4)).toBe('6789');
    expect(manager.prune()).toBeGreaterThanOrEqual(1);
    expect(manager.get(p.id)).toBeUndefined();
  });

  it('returns undefined for unknown ids', async () => {
    expect(manager.logs('nope')).toBeUndefined();
    expect(await manager.stop('nope')).toBeUndefined();
  });
});
