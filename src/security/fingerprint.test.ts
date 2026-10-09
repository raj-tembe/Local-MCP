import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecurityEngine } from './security.js';
import { loadConfig } from '../config/config.js';

let tempHome: string;
let originalHome: string | undefined;

beforeAll(() => {
  // Approvals persist under ~/.local-mcp, so isolate them from the real home directory.
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mcp-fp-home-'));
  process.env.HOME = tempHome;
});

afterAll(async () => {
  // Approvals are persisted asynchronously; let pending writes land before deleting the directory.
  await new Promise((resolve) => setTimeout(resolve, 150));
  process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('approval fingerprints', () => {
  it('scopes an approval to the exact payload', async () => {
    const config = loadConfig({ transport: 'stdio' });
    config.security.defaultMode = 'allow';
    config.security.allowedCommands = [];
    config.security.requireApproval = ['code.run'];
    const engine = new SecurityEngine(config);

    // Approve one specific script.
    const first = await engine.authorize('code.run', { command: 'python3', fingerprint: 'script-a' });
    expect(first.allowed).toBe(true);

    // From now on new approvals are denied by policy.
    config.security.defaultMode = 'deny';

    // The approved script stays approved...
    const same = await engine.authorize('code.run', { command: 'python3', fingerprint: 'script-a' });
    expect(same.allowed).toBe(true);

    // ...but a different script using the same interpreter does not inherit it.
    const other = await engine.authorize('code.run', { command: 'python3', fingerprint: 'script-b' });
    expect(other.allowed).toBe(false);
  });

  it('without a fingerprint, approvals are shared per interpreter (legacy behaviour)', async () => {
    const config = loadConfig({ transport: 'stdio' });
    config.security.defaultMode = 'allow';
    config.security.allowedCommands = [];
    config.security.requireApproval = ['shell.execute'];
    config.toolFilter.deniedTools = []; // shell.execute is denied by the default tool filter
    const engine = new SecurityEngine(config);

    await engine.authorize('shell.execute', { command: 'npm install a' });
    config.security.defaultMode = 'deny';
    const later = await engine.authorize('shell.execute', { command: 'npm install b' });
    expect(later.allowed).toBe(true);
  });
});
