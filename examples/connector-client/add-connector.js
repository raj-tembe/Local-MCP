import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import WebSocket from 'ws';

// Ensure global WebSocket is available for the SDK in Node
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket;
}

async function main() {
  const relayUrl = process.env.RELAY_URL || 'ws://localhost:8080/?token=demo-token';
  const name = process.argv[2] || 'example-connector';
  const url = process.argv[3] || 'https://curly-dancers-hide.loca.lt/mcp';
  const description = process.argv[4] || 'Programmatic connector add example';

  const client = new Client({ name: 'connector-client', version: '0.1.0' }, { capabilities: {} });
  const transport = new WebSocketClientTransport(relayUrl);

  await client.connect(transport);
  console.log('Connected to relay at', relayUrl);

  const result = await client.callTool({ name: 'connectors.add', arguments: { name, url, description } });
  console.log('connectors.add =>', result.structuredContent || result.content);

  await client.close();
}

main().catch((err) => {
  console.error('failed:', err);
  process.exitCode = 1;
});
