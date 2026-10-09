import { describe, it, expect } from 'vitest';
import { resolveLanguage, runCode, findExecutable } from './code.js';

describe('code runner', () => {
  it('runs javascript snippets with args', async () => {
    const resolved = resolveLanguage('javascript');
    expect(resolved).toBeDefined();
    const r = await runCode({ resolved: resolved!, code: 'console.log(process.argv.slice(2).join(","))', args: ['a', 'b'] });
    expect(r.stdout.trim()).toBe('a,b');
    expect(r.exitCode).toBe(0);
  });

  it('surfaces runtime errors via exit code and stderr', async () => {
    const resolved = resolveLanguage('javascript')!;
    const r = await runCode({ resolved, code: "throw new Error('boom')" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('boom');
  });

  it('runs inside the requested cwd', async () => {
    const resolved = resolveLanguage('javascript')!;
    const r = await runCode({ resolved, code: 'console.log(process.cwd())', cwd: '/tmp' });
    expect(r.stdout.trim()).toMatch(/tmp$/);
  });

  it('cleans up its temp script', async () => {
    const resolved = resolveLanguage('javascript')!;
    const r = await runCode({ resolved, code: 'console.log(__filename)' });
    const { existsSync } = await import('node:fs');
    expect(existsSync(r.stdout.trim())).toBe(false);
  });

  it('runs python when installed', async () => {
    const resolved = resolveLanguage('python');
    if (!resolved) return; // interpreter not available on this machine
    const r = await runCode({ resolved, code: "print(1 + 2)" });
    expect(r.stdout.trim()).toBe('3');
  });

  it('finds executables on PATH', () => {
    expect(findExecutable('node')).toBeTruthy();
    expect(findExecutable('definitely-not-a-real-binary-xyz')).toBeUndefined();
  });
});
