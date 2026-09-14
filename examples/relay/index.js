const WebSocket = require('ws');
const http = require('http');

const PORT = Number(process.env.PORT || 8080);
const EXPECTED_TOKEN = process.env.RELAY_TOKEN || '';
const server = http.createServer();
const wss = new WebSocket.Server({ server });

const clients = new Map();

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
