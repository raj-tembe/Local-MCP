import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLocalMcpServer } from './server.js';
import { loadConfig } from '../config/config.js';

let tempHome: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  saved.HOME = process.env.HOME;
  saved.LOCAL_MCP_DISABLE_PTY = process.env.LOCAL_MCP_DISABLE_PTY;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mcp-pty-home-'));
  process.env.HOME = tempHome;
  process.env.LOCAL_MCP_DISABLE_PTY = '1';
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function connect() {
  const config = loadConfig({ transport: 'stdio' });
  config.security.defaultMode = 'allow';
  config.security.allowedCommands = [];
  config.toolFilter.deniedTools = [];
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createLocalMcpServer(config);
  await server.connect(serverTransport);
  const client = new Client({ name: 'pty-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe('server without PTY support', () => {
  it('starts and serves every other tool', async () => {
    const { client, close } = await connect();
    const info: any = await client.callTool({ name: 'system.info', arguments: {} });
    expect(info.isError).toBeFalsy();
    const run: any = await client.callTool({ name: 'code.run', arguments: { language: 'javascript', code: 'console.log(40 + 2)' } });
    expect(run.content[0].text).toContain('42');
    await close();
  });

  it('terminal.create explains that PTY is unavailable instead of crashing', async () => {
    const { client, close } = await connect();
    const result: any = await client.callTool({ name: 'terminal.create', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/PTY terminal sessions are not available/);
    expect(result.content[0].text).toMatch(/shell\.execute/);
    await close();
  });

  it('runtime.detect reports ptyAvailable=false', async () => {
    const { client, close } = await connect();
    const result: any = await client.callTool({ name: 'runtime.detect', arguments: {} });
    expect(result.structuredContent.ptyAvailable).toBe(false);
    await close();
  });
});
