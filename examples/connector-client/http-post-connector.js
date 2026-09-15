#!/usr/bin/env node
import { buildRequestEnvelope, postEnvelope } from './mcp-envelope.js';

const base = process.argv[2] || 'https://curly-dancers-hide.loca.lt';
const mcpUrl = `${base.replace(/\/$/, '')}/mcp`;

console.log('Connecting to SSE endpoint:', mcpUrl);

async function run() {
  // First connect to /mcp to obtain messages endpoint
  const res = await fetch(mcpUrl, { headers: { Accept: 'text/event-stream' } });
  if (!res.ok) throw new Error(`SSE connect failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const m = buffer.match(/event:\s*endpoint\s*\n\s*data:\s*([^\n\r]+)/i);
    if (m) {
      const endpoint = m[1].trim();
      const postUrl = `${base.replace(/\/$/, '')}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
      console.log('POST URL:', postUrl);
      const envelope = buildRequestEnvelope('connectors.add', { name: 'http-added', url: `${base.replace(/\/$/, '')}/mcp`, description: 'Added via HTTP POST example' });
      const result = await postEnvelope(postUrl, envelope);
      console.log('POST result:', result);
      return;
    }
  }
}

run().catch((err) => { console.error('failed:', err); process.exitCode = 1; });
