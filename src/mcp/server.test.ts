import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLocalMcpServer } from './server.js';
import { loadConfig } from '../config/config.js';

describe('mcp server', () => {
  it('lists the registered tools', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createLocalMcpServer(loadConfig({ transport: 'stdio' }));
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(Array.isArray(tools.tools)).toBe(true);
    expect(tools.tools.some((tool) => tool.name === 'shell.execute')).toBe(true);

    await client.close();
    await server.close();
  });

  it('supports shell.execute with a simple command', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createLocalMcpServer(loadConfig({ transport: 'stdio' }));
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'shell.execute', arguments: { command: 'echo hello' } });
    expect(result.content).toBeTruthy();

    await client.close();
    await server.close();
  });

  it('supports terminal lifecycle and file metadata tools', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createLocalMcpServer(loadConfig({ transport: 'stdio' }));
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const created = await client.callTool({ name: 'terminal.create', arguments: { shell: 'bash', cwd: process.cwd() } }) as any;
    const text = created.content?.[0]?.text ?? JSON.stringify(created.content?.[0] ?? {});
    const sessionId = JSON.parse(text).id;
    await client.callTool({ name: 'terminal.resize', arguments: { sessionId, cols: 80, rows: 24 } });
    await client.callTool({ name: 'terminal.kill', arguments: { sessionId } });

    const statResult = await client.callTool({ name: 'fs.stat', arguments: { path: process.cwd() } });
    expect(statResult.content).toBeTruthy();

    await client.close();
    await server.close();
  });
});
