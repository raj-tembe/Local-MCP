#!/usr/bin/env node
// Smoke test for a built binary:   node scripts/smoke-binary.mjs dist-bin/local-mcp-linux-x64
// Starts the binary as an HTTP MCP server and talks to it with a real MCP client.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const binary = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(binary)) {
  console.error('usage: node scripts/smoke-binary.mjs <path-to-binary>');
  process.exit(2);
}

let failed = false;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` -- ${detail}` : ''}`);
  if (!ok) failed = true;
};

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
  server.on('error', reject);
});

// Isolated HOME so the test never touches a real ~/.local-mcp
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mcp-smoke-'));
const env = { ...process.env, HOME: home, USERPROFILE: home };

const help = spawnSync(binary, ['--help'], { encoding: 'utf8', env, timeout: 30_000 });
check('--help runs and exits 0', help.status === 0 && /local-mcp/i.test(help.stdout), `${help.status} ${help.stderr}`);

const port = await freePort();
const server = spawn(binary, ['start', '--transport', 'http', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

try {
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      healthy = res.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  check('server answers /health', healthy, log.slice(-500));

  if (healthy) {
    const client = new Client({ name: 'smoke', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

    const tools = (await client.listTools()).tools.map((t) => t.name);
    check('lists tools over MCP', tools.length >= 25 && tools.includes('code.run') && tools.includes('system.info'), `${tools.length} tools`);

    const info = await client.callTool({ name: 'system.info', arguments: {} });
    check('system.info works', !info.isError && info.structuredContent?.platform === process.platform);

    const detect = await client.callTool({ name: 'runtime.detect', arguments: {} });
    check('runtime.detect works and reports PTY availability', !detect.isError && typeof detect.structuredContent?.ptyAvailable === 'boolean');

    if (detect.structuredContent?.ptyAvailable === false) {
      const pty = await client.callTool({ name: 'terminal.create', arguments: {} });
      check('terminal.create explains PTY is unavailable', pty.isError === true && /not available/i.test(pty.content?.[0]?.text ?? ''));
    }
    await client.close();
  }
} catch (error) {
  check('MCP session', false, String(error));
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(failed ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
process.exit(failed ? 1 : 0);
