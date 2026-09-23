import { loadConfig } from './dist/config/config.js';
import { createSseHttpServer } from './dist/mcp/server.js';

const config = loadConfig({ transport: 'sse', port: 8080 });
console.log('auth:', JSON.stringify(config.auth, null, 2));

const { app, server } = await createSseHttpServer(config);

import http from 'http';
const req = http.request({
  hostname: 'localhost',
  port: 8080,
  path: '/mcp',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Response:', data);
    server.close();
    process.exit(0);
  });
});

req.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
req.end();
