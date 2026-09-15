import { test, expect } from 'vitest';
import { spawn } from 'child_process';
import WebSocket from 'ws';

function waitForOutput(proc: any, matcher: string, timeout = 4000) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.stdout?.off('data', onData);
      reject(new Error('timeout waiting for output'));
    }, timeout);
    function onData(chunk: any) {
      const s = String(chunk);
      if (s.includes(matcher)) {
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        resolve(s);
      }
    }
    proc.stdout?.on('data', onData);
  });
}

test('relay responds to connectors.add JSON-RPC over WebSocket', async () => {
  const PORT = 9020;
  const proc = spawn(process.execPath, ['examples/relay/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForOutput(proc, `listening on port ${PORT}`, 4000);

    const ws = new WebSocket(`ws://localhost:${PORT}/?token=test`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const req = { jsonrpc: '2.0', id: 1, method: 'connectors.add', params: { arguments: { name: 'vt-test', url: 'https://example.test/mcp', description: 'vitest' } } };
    ws.send(JSON.stringify(req));

    const msg = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no reply')), 3000);
      ws.on('message', (data) => {
        clearTimeout(t);
        resolve(String(data));
      });
      ws.on('error', (err) => { clearTimeout(t); reject(err); });
    });

    const parsed = JSON.parse(msg);
    expect(parsed).toHaveProperty('jsonrpc', '2.0');
    expect(parsed).toHaveProperty('id', 1);
    expect(parsed).toHaveProperty('result');
    expect(parsed.result).toHaveProperty('connector');
    expect(parsed.result.connector).toMatchObject({ name: 'vt-test', url: 'https://example.test/mcp', description: 'vitest' });

    ws.close();
  }
  finally {
    proc.kill('SIGTERM');
  }
});
