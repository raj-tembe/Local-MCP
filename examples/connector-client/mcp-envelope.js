export function buildRequestEnvelope(name, args = {}) {
  // Build a JSON-RPC 2.0 tools/call request which is expected by the MCP server HTTP POST endpoint
  return {
    jsonrpc: '2.0',
    id: String(Math.floor(Math.random() * 1e9)),
    method: 'tools/call',
    params: {
      name,
      arguments: args
    }
  };
}

export async function postEnvelope(url, envelope) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch {};
  return { status: res.status, body };
}
