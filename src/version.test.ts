import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VERSION } from './version.js';
import { createLocalMcpServer } from './mcp/server.js';
import { loadConfig } from './config/config.js';

const packageJson = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
) as { version: string };

describe('version', () => {
  it('src/version.ts matches package.json (run `node scripts/sync-version.mjs` if this fails)', () => {
    expect(VERSION).toBe(packageJson.version);
  });

  it('is what MCP clients see in serverInfo', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createLocalMcpServer(loadConfig({ transport: 'stdio' }));
    await server.connect(serverTransport);
    const client = new Client({ name: 'version-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    expect(client.getServerVersion()?.version).toBe(VERSION);
    await client.close();
    await server.close();
  });
});
