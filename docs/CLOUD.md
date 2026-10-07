# Cloud connection guide

Local-MCP can expose a remote endpoint in two ways:

1. Direct SSE or HTTP exposure through a tunnel service such as Cloudflare, ngrok, or a reverse proxy.
2. Reverse WebSocket or relay connection from the local machine to a hosted relay.

## SSE example

```bash
node dist/cli.js start --transport sse --port 3000
```

Then allow the external tunnel to forward `http://localhost:3000`.

### Which tunnel to use

Use **Cloudflare Tunnel** (`cloudflared`) as the default — see
`examples/expose-cloudflared/`. It's free, needs no account for a quick
tunnel, and doesn't get in the way of the MCP handshake.

Avoid ngrok's free tier for this specifically: it serves an HTML
browser-warning interstitial in front of every request unless the caller
sends an `ngrok-skip-browser-warning` header, which Claude's connector
client does not send. The result is that the connector "connects" but
Claude reports it can't load any tools, because it's receiving ngrok's
warning page instead of a JSON-RPC response — not because of anything
wrong with the local server. Removing the interstitial requires a paid
ngrok plan (see `examples/expose-ngrok/README.md` for the full explanation).
This is a tunnel-layer issue, not a Local-MCP bug, but it's common enough
when getting started that it's worth calling out here.

## Reverse relay

Set the relay URL and token in config or environment variables:

```bash
export LOCAL_MCP_RELAY_URL=https://relay.example.com
export LOCAL_MCP_TOKEN=replace-me
```

The local process can then connect to the relay with the configured token, and the relay forwards messages to the MCP client.
