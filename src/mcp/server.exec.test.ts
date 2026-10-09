import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLocalMcpServer } from './server.js';
import { loadConfig, type AppConfig } from '../config/config.js';
import { sharedProcessManager } from '../process/manager.js';

let tempHome: string;
let originalHome: string | undefined;

beforeAll(() => {
  // Keep approvals/audit logs out of the developer's real ~/.local-mcp
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mcp-test-home-'));
  process.env.HOME = tempHome;
});

afterAll(async () => {
  sharedProcessManager.killAll();
  // Approvals and audit entries are written asynchronously; let them land before deleting the directory.
  await new Promise((resolve) => setTimeout(resolve, 150));
  process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function permissiveConfig(): AppConfig {
  const config = loadConfig({ transport: 'stdio' });
  config.security.defaultMode = 'allow';
  config.security.allowedCommands = [];
  config.security.deniedCommands = [];
  config.security.allowedPaths = [];
  config.toolFilter.deniedTools = [];
  return config;
}

async function connect(config: AppConfig) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createLocalMcpServer(config);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (result: any): string => result.content?.[0]?.text ?? '';

describe('execution tools', () => {
  it('registers the new tools', async () => {
    const { client, close } = await connect(permissiveConfig());
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ['code.run', 'package.install', 'runtime.detect', 'process.start', 'process.list', 'process.logs', 'process.stop']) {
      expect(names).toContain(name);
    }
    await close();
  });

  it('runtime.detect reports node', async () => {
    const { client, close } = await connect(permissiveConfig());
    const result: any = await client.callTool({ name: 'runtime.detect', arguments: {} });
    expect(result.structuredContent.runtimes.node.installed).toBe(true);
    await close();
  });

  it('code.run executes javascript and returns output', async () => {
    const { client, close } = await connect(permissiveConfig());
    const ok: any = await client.callTool({ name: 'code.run', arguments: { language: 'javascript', code: "console.log('sum', 2 + 3)" } });
    expect(ok.isError).toBeFalsy();
    expect(textOf(ok)).toContain('sum 5');
    expect(ok.structuredContent.exitCode).toBe(0);

    const bad: any = await client.callTool({ name: 'code.run', arguments: { language: 'javascript', code: 'process.exit(2)' } });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.exitCode).toBe(2);
    await close();
  });

  it('code.run enforces timeouts', async () => {
    const { client, close } = await connect(permissiveConfig());
    const result: any = await client.callTool({ name: 'code.run', arguments: { language: 'javascript', code: 'setInterval(() => {}, 1000)', timeoutMs: 300 } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.timedOut).toBe(true);
    await close();
  });

  it('code.run is denied by default when approval cannot be given', async () => {
    const config = loadConfig({ transport: 'stdio' });
    config.security.defaultMode = 'ask';
    config.security.allowedCommands = [];
    config.toolFilter.deniedTools = [];
    const { client, close } = await connect(config);
    const result: any = await client.callTool({ name: 'code.run', arguments: { language: 'javascript', code: "console.log('should not run')" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('should not run');
    await close();
  });

  it('code.run respects the command allowlist and denylist', async () => {
    const config = permissiveConfig();
    config.security.allowedCommands = ['echo'];
    const { client, close } = await connect(config);
    const result: any = await client.callTool({ name: 'code.run', arguments: { language: 'javascript', code: "console.log('nope')" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.denied).toBe(true);
    await close();
  });

  it('package.install rejects injected package specs without running anything', async () => {
    const { client, close } = await connect(permissiveConfig());
    const result: any = await client.callTool({ name: 'package.install', arguments: { manager: 'npm', packages: ['left-pad; touch /tmp/pwned'] } });
    expect(result.isError).toBe(true);
    expect(fs.existsSync('/tmp/pwned')).toBe(false);
    await close();
  });

  it('package.install installs from a manifest in the given cwd', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mcp-pkg-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tmp-test', version: '1.0.0' }));
    const { client, close } = await connect(permissiveConfig());
    const result: any = await client.callTool({ name: 'package.install', arguments: { manager: 'npm', cwd: dir, ignoreScripts: true } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.ok).toBe(true);
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('background processes can be started, inspected and stopped', async () => {
    const { client, close } = await connect(permissiveConfig());
    const started: any = await client.callTool({
      name: 'process.start',
      arguments: { command: `${JSON.stringify(process.execPath)} -e "console.log('server up'); setInterval(() => {}, 1000)"`, waitMs: 500 }
    });
    expect(started.isError).toBeFalsy();
    const id = started.structuredContent.id;
    expect(started.structuredContent.status).toBe('running');
    expect(started.structuredContent.initialOutput).toContain('server up');

    const listed: any = await client.callTool({ name: 'process.list', arguments: {} });
    expect(listed.structuredContent.processes.some((p: any) => p.id === id)).toBe(true);

    const logs: any = await client.callTool({ name: 'process.logs', arguments: { id } });
    expect(textOf(logs)).toContain('server up');

    const stopped: any = await client.callTool({ name: 'process.stop', arguments: { id } });
    expect(stopped.structuredContent.status).not.toBe('running');

    const missing: any = await client.callTool({ name: 'process.logs', arguments: { id: 'nope' } });
    expect(missing.isError).toBe(true);
    await close();
  });
});
