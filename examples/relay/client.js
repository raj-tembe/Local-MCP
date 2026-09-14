const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { WebSocketClientTransport } = require('@modelcontextprotocol/sdk/client/websocket.js');

async function main() {
  const relayUrl = process.env.RELAY_URL || 'ws://localhost:8080/?token=demo-token';
  const client = new Client({ name: 'relay-client', version: '1.0.0' }, { capabilities: {} });
  const transport = new WebSocketClientTransport(relayUrl);

  await client.connect(transport);
  console.log('Connected to Local-MCP relay');

  const tools = await client.listTools();
  console.log('Tools:', tools.tools.map((tool) => tool.name));

  const result = await client.callTool({
    name: 'system.info',
    arguments: {}
  });

  console.log('system.info =>', result.content);

  await client.close();
}

main().catch((error) => {
  console.error('Relay client failed:', error);
  process.exitCode = 1;
});
