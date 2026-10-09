import { describe, it, expect } from 'vitest';
import { runProcess, clampTimeout, MAX_TIMEOUT_MS } from './run.js';

describe('runProcess', () => {
  it('captures stdout and exit code', async () => {
    const r = await runProcess({ file: process.execPath, args: ['-e', "console.log('hi'); console.error('warn')"] });
    expect(r.stdout.trim()).toBe('hi');
    expect(r.stderr.trim()).toBe('warn');
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('reports non-zero exit codes', async () => {
    const r = await runProcess({ file: process.execPath, args: ['-e', 'process.exit(3)'] });
    expect(r.exitCode).toBe(3);
  });

  it('pipes stdin', async () => {
    const r = await runProcess({
      file: process.execPath,
      args: ['-e', "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()))"],
      stdin: 'abc'
    });
    expect(r.stdout).toBe('ABC');
  });

  it('kills the process tree on timeout', async () => {
    const r = await runProcess({ file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(5000);
  });

  it('truncates runaway output', async () => {
    const r = await runProcess({
      file: process.execPath,
      args: ['-e', "while (true) process.stdout.write('x'.repeat(10000))"],
      maxOutputBytes: 50_000,
      timeoutMs: 10_000
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(50_000);
  });

  it('reports spawn errors instead of throwing', async () => {
    const r = await runProcess({ file: 'definitely-not-a-real-binary-xyz' });
    expect(r.spawnError).toBeTruthy();
  });

  it('does not interpret arguments through a shell', async () => {
    const r = await runProcess({ file: process.execPath, args: ['-e', 'console.log(process.argv[1])', '; echo pwned'] });
    expect(r.stdout.trim()).toBe('; echo pwned');
  });
});

describe('clampTimeout', () => {
  it('applies defaults and caps', () => {
    expect(clampTimeout(undefined)).toBe(30_000);
    expect(clampTimeout(-5)).toBe(30_000);
    expect(clampTimeout(10_000_000)).toBe(MAX_TIMEOUT_MS);
    expect(clampTimeout(1500)).toBe(1500);
  });
});
