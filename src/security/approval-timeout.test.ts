import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecurityEngine } from './security.js';
import { loadConfig } from '../config/config.js';
import type { PromptFn, PromptResult } from './prompt.js';

let tempHome: string;
let originalHome: string | undefined;

beforeAll(() => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mcp-approval-home-'));
  process.env.HOME = tempHome;
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function interactiveConfig(approvalTimeoutMs: number) {
  const config = loadConfig({ transport: 'stdio' });
  config.security.defaultMode = 'ask';
  config.security.allowedCommands = [];
  config.security.requireApproval = ['code.run'];
  config.security.approvalTimeoutMs = approvalTimeoutMs;
  config.toolFilter.deniedTools = [];
  return config;
}

const neverAnswers: PromptFn = (_q, timeoutMs) =>
  new Promise<PromptResult>((resolve) => setTimeout(() => resolve({ status: 'timeout' }), timeoutMs ?? 60_000));

describe('approval timeout', () => {
  it('denies with a clear reason when nobody answers, and does not save the denial', async () => {
    const config = interactiveConfig(150);
    const unattended = new SecurityEngine(config, { prompt: neverAnswers, isInteractive: () => true });
    const denied = await unattended.authorize('code.run', { command: 'node', fingerprint: 'same-script' });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/timed out/i);

    // Same script, but now someone is at the terminal: the earlier timeout must not stick.
    const attended = new SecurityEngine(config, { prompt: async () => ({ status: 'answered', answer: 'y' }), isInteractive: () => true });
    const allowed = await attended.authorize('code.run', { command: 'node', fingerprint: 'same-script' });
    expect(allowed.allowed).toBe(true);
  });

  it('treats closed terminal input as a non-persistent denial', async () => {
    const config = interactiveConfig(5000);
    const engine = new SecurityEngine(config, { prompt: async () => ({ status: 'closed' }), isInteractive: () => true });
    const result = await engine.authorize('code.run', { command: 'node', fingerprint: 'closed-script' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/closed/i);

    const retry = new SecurityEngine(config, { prompt: async () => ({ status: 'answered', answer: 'yes' }), isInteractive: () => true });
    expect((await retry.authorize('code.run', { command: 'node', fingerprint: 'closed-script' })).allowed).toBe(true);
  });

  it('honours an explicit answer', async () => {
    const config = interactiveConfig(5000);
    const engine = new SecurityEngine(config, { prompt: async () => ({ status: 'answered', answer: 'n' }), isInteractive: () => true });
    const result = await engine.authorize('code.run', { command: 'node', fingerprint: 'declined-script' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('User denied the operation.');
  });

  it('does not prompt for requests whose deadline passed while queued behind another prompt', async () => {
    const config = interactiveConfig(200);
    let prompts = 0;
    const counting: PromptFn = (q, t) => { prompts++; return neverAnswers(q, t); };
    const engine = new SecurityEngine(config, { prompt: counting, isInteractive: () => true });

    const [first, second] = await Promise.all([
      engine.authorize('code.run', { command: 'node', fingerprint: 'queued-1' }),
      engine.authorize('code.run', { command: 'node', fingerprint: 'queued-2' })
    ]);
    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/timed out/i);
    expect(prompts).toBe(1);
  });

  it('a timeout of 0 disables the deadline', async () => {
    const config = interactiveConfig(0);
    let receivedTimeout: number | undefined = -1;
    const engine = new SecurityEngine(config, {
      prompt: async (_q, timeoutMs) => { receivedTimeout = timeoutMs; return { status: 'answered', answer: 'y' }; },
      isInteractive: () => true
    });
    expect((await engine.authorize('code.run', { command: 'node', fingerprint: 'no-deadline' })).allowed).toBe(true);
    expect(receivedTimeout).toBeUndefined();
  });

  it('keeps denying without a TTY', async () => {
    const engine = new SecurityEngine(interactiveConfig(1000), { isInteractive: () => false });
    const result = await engine.authorize('code.run', { command: 'node', fingerprint: 'no-tty' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no TTY/i);
  });
});
