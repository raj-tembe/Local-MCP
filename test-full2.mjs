import { loadConfig } from './dist/config/config.js';
import { createSseHttpServer } from './dist/mcp/server.js';
import fs from 'fs';

const config = loadConfig({ transport: 'sse', port: 8080 });

// Override the middleware to add debug
const originalVerify = (await import('./dist/mcp/server.js')).verifyApiKey;
console.log('verifyApiKey function:', originalVerify);

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
    console.log('Debug log exists:', fs.existsSync('/tmp/server-debug.log'));
    if (fs.existsSync('/tmp/server-debug.log')) {
      console.log('Debug log content:', fs.readFileSync('/tmp/server-debug.log', 'utf8'));
    }
    server.close();
    process.exit(0);
  });
});

req.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
req.end();
