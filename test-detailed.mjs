import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Monkey-patch to log requests
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  console.log('FETCH:', url, options?.method || 'GET');
  if (options?.body) {
    console.log('BODY:', options.body);
  }
  const response = await originalFetch(url, options);
  const text = await response.text();
  console.log('RESPONSE:', response.status, text.substring(0, 200));
  return new Response(text, { status: response.status, headers: response.headers });
};

async function main() {
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  const transport = new SSEClientTransport(new URL('http://localhost:8080/mcp'));
  
  try {
    await client.connect(transport);
    console.log('Connected!');
    
    const tools = await client.listTools();
    console.log('Tools count:', tools.tools.length);
    
    await client.close();
    console.log('Closed successfully');
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
