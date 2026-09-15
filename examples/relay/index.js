import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const PORT = Number(process.env.PORT || 8080);
const EXPECTED_TOKEN = process.env.RELAY_TOKEN || '';
const server = http.createServer();
const wss = new WebSocketServer({ server });

const clients = new Map();
const connectorsFile = path.join(os.homedir(), '.local-mcp', 'connectors.json');

async function addConnectorToStore(name, url, description) {
  try {
    await fs.mkdir(path.dirname(connectorsFile), { recursive: true });
    let raw = '{}';
    try { raw = await fs.readFile(connectorsFile, 'utf8'); } catch {}
    const obj = raw ? JSON.parse(raw) : {};
    obj[name] = { name, url, description, createdAt: Date.now() };
    await fs.writeFile(connectorsFile, JSON.stringify(obj, null, 2), 'utf8');
    return obj[name];
  } catch (e) {
    throw e;
  }
}

function rejectUnauthorized(ws, reason) {
  ws.close(1008, reason);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const token = url.searchParams.get('token') || '';

  if (EXPECTED_TOKEN && token !== EXPECTED_TOKEN) {
    rejectUnauthorized(ws, 'invalid token');
    return;
  }

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  clients.set(id, ws);
  console.log('[relay] connected', id, 'clients=', clients.size);

  ws.on('message', (raw) => {
    const message = raw.toString();
    console.log('[relay] received', message.slice(0, 200));
    try {
      const obj = JSON.parse(message);
      if (obj && obj.jsonrpc === '2.0' && obj.method === 'connectors.add') {
        // perform local connector add and reply with a response envelope
        (async () => {
          const args = (obj.params && obj.params.arguments) ? obj.params.arguments : (obj.params || {});
          const added = await addConnectorToStore(args.name || 'unnamed', args.url || '', args.description || '');
          const response = { jsonrpc: '2.0', id: obj.id, result: { connector: added } };
          ws.send(JSON.stringify(response));
          return;
        })().catch((e) => {
          const response = { jsonrpc: '2.0', id: obj.id, error: { code: -32000, message: String(e) } };
          ws.send(JSON.stringify(response));
          return;
        });
        return; // do not broadcast this internal request
      }
      if (obj && obj.jsonrpc === '2.0' && obj.method === 'tools/call') {
        try {
          const params = obj.params || {};
          if (params.name === 'connectors.add') {
            const args = params.arguments || {};
            (async () => {
              const added = await addConnectorToStore(args.name || 'unnamed', args.url || '', args.description || '');
              const result = { content: [], structuredContent: { connector: added } };
              const response = { jsonrpc: '2.0', id: obj.id, result };
              console.log('[relay] replying tools/call ->', JSON.stringify(response).slice(0, 200));
              ws.send(JSON.stringify(response));
            })().catch((e) => {
              const response = { jsonrpc: '2.0', id: obj.id, error: { code: -32000, message: String(e) } };
              console.log('[relay] replying tools/call error ->', response.error.message);
              ws.send(JSON.stringify(response));
            });
            return;
          }
        }
        catch (e) {
          // ignore and fallthrough to broadcast
        }
      }
      if (obj && obj.jsonrpc === '2.0' && obj.method === 'initialize') {
        const result = {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'local-mcp-relay', version: '0.1.0' },
          instructions: 'Relay server - forwards connector registrations.'
        };
        const response = { jsonrpc: '2.0', id: obj.id, result };
        ws.send(JSON.stringify(response));
        return;
      }
    } catch (e) {
      // not JSON or not a handled envelope; fall back to broadcast
    }
    for (const [peerId, client] of clients.entries()) {
      if (client !== ws) {
        client.send(message);
      }
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    console.log('[relay] disconnected', id, 'clients=', clients.size);
  });

  ws.on('error', (error) => {
    console.error('[relay] socket error', error.message);
  });
});

server.listen(PORT, () => {
  console.log(`Local-MCP example relay listening on port ${PORT}`);
  if (EXPECTED_TOKEN) {
    console.log('Token auth enabled');
  }
});
