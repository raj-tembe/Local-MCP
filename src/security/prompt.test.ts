import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { promptWithTimeout, formatApprovalSummary, enqueueApproval } from './prompt.js';

function makeIO() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume(); // discard prompt text
  return { input, output };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('promptWithTimeout', () => {
  it('returns the trimmed, lower-cased answer', async () => {
    const io = makeIO();
    const pending = promptWithTimeout('Allow? ', 2000, io, 20);
    await sleep(80);
    io.input.write('  YES \n');
    expect(await pending).toEqual({ status: 'answered', answer: 'yes' });
  });

  it('times out when nobody answers', async () => {
    const io = makeIO();
    const started = Date.now();
    const result = await promptWithTimeout('Allow? ', 150, io, 20);
    expect(result.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports closed input instead of hanging', async () => {
    const io = makeIO();
    const pending = promptWithTimeout('Allow? ', 5000, io, 20);
    await sleep(40);
    io.input.end();
    expect((await pending).status).toBe('closed');
  });

  it('ignores stale buffered input and waits for a real answer', async () => {
    const io = makeIO();
    io.input.write('y\n'); // typed after an earlier prompt timed out
    const pending = promptWithTimeout('Allow? ', 3000, io, 100);
    await sleep(300);
    io.input.write('n\n');
    expect(await pending).toEqual({ status: 'answered', answer: 'n' });
  });

  it('still times out if only stale input was ever present', async () => {
    const io = makeIO();
    io.input.write('y\n');
    const result = await promptWithTimeout('Allow? ', 300, io, 100);
    expect(result.status).toBe('timeout');
  });
});

describe('formatApprovalSummary', () => {
  it('shows code as a readable block and redacts tokens', () => {
    const text = formatApprovalSummary({ command: 'python3', code: 'print(1)\nprint(2)', token: 'secret-value' });
    expect(text).toContain('print(1)\nprint(2)');
    expect(text).toContain('----- code -----');
    expect(text).not.toContain('secret-value');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('"code"');
  });

  it('truncates very long code', () => {
    const text = formatApprovalSummary({ code: 'x'.repeat(5000) });
    expect(text).toContain('1000 more characters');
  });
});

describe('enqueueApproval', () => {
  it('runs tasks one at a time, in order', async () => {
    const events: string[] = [];
    const a = enqueueApproval(async () => { events.push('a:start'); await sleep(60); events.push('a:end'); });
    const b = enqueueApproval(async () => { events.push('b:start'); events.push('b:end'); });
    await Promise.all([a, b]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('keeps going after a failed task', async () => {
    await expect(enqueueApproval(async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(enqueueApproval(async () => 'ok')).resolves.toBe('ok');
  });
});
