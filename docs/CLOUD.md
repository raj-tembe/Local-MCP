# Cloud connection guide

Local-MCP can expose a remote endpoint in two ways:

1. Direct SSE or HTTP exposure through a tunnel service such as Cloudflare, ngrok, or a reverse proxy.
2. Reverse WebSocket or relay connection from the local machine to a hosted relay.

## SSE example

```bash
node dist/cli.js start --transport sse --port 3000
```

Then allow the external tunnel to forward `http://localhost:3000`.

## Reverse relay

Set the relay URL and token in config or environment variables:

```bash
export LOCAL_MCP_RELAY_URL=https://relay.example.com
export LOCAL_MCP_TOKEN=replace-me
```

The local process can then connect to the relay with the configured token, and the relay forwards messages to the MCP client.
