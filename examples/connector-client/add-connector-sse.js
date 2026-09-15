#!/usr/bin/env node
import { setTimeout as wait } from 'node:timers/promises';

const base = process.argv[2] || 'https://curly-dancers-hide.loca.lt';
const mcpUrl = `${base.replace(/\/$/, '')}/mcp`;

console.log('Connecting to SSE endpoint:', mcpUrl);

async function getEndpoint() {
  const res = await fetch(mcpUrl, { headers: { Accept: 'text/event-stream' } });
  if (!res.ok) throw new Error(`SSE connect failed: ${res.status}`);
  const reader = res.body.getReader();
  let decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // look for endpoint event
    const m = buffer.match(/event:\s*endpoint\s*\n\s*data:\s*([^\n\r]+)/i);
    if (m) {
      const endpoint = m[1].trim();
      return endpoint;
    }
    // wait briefly before reading more
    await wait(10);
  }
  throw new Error('endpoint not found in SSE stream');
}

(async () => {
  try {
    const endpoint = await getEndpoint();
    console.log('Found messages endpoint:', endpoint);
    const postUrl = `${base.replace(/\/$/, '')}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    console.log('\nPosting MCP request to:', postUrl);

    // build a simple MCP request envelope
    const envelope = {
      type: 'request',
      id: String(Math.floor(Math.random() * 1e9)),
      name: 'connectors.add',
      arguments: {
        name: process.env.CONNECTOR_NAME || 'sse-added',
        url: `${base.replace(/\/$/, '')}/mcp`,
        description: process.env.CONNECTOR_DESC || 'Added via SSE example'
      }
    };

    console.log('Envelope:', JSON.stringify(envelope));

    // POST the envelope
    const resp = await fetch(postUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) });
    const text = await resp.text();
    console.log('Response status:', resp.status);
    console.log('Response body:', text);
    process.exit(0);
  } catch (err) {
    console.error('Failed to obtain endpoint:', err);
    process.exitCode = 1;
  }
})();
