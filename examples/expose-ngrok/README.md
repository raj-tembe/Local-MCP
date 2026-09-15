Expose Local-MCP via ngrok (example)

This folder shows a small example for exposing the SSE/HTTP MCP server publicly using ngrok so Claude (or other remote MCP clients) can connect to your local server.

Prerequisites
- Install Local-MCP and build (or run dev):

```bash
# build
npm run build

# run (production)
node dist/cli.js start --transport sse --port 8080

# or in dev (requires tsx)
npm run dev -- start --transport sse --port 8080
```

- Install and authenticate ngrok (https://ngrok.com). Make sure `ngrok` is on your PATH.

Expose the server

1. Start the Local-MCP SSE server (port 8080 above).

2. Start an ngrok HTTP tunnel on the same port:

```bash
ngrok http 8080
```

3. ngrok will show a forwarding HTTPS URL, for example `https://abcd1234.ngrok.io`.

4. In Claude's "Add custom connector" flow, enter the MCP URL as:

```
https://abcd1234.ngrok.io/mcp
```

Verify connectivity

- Health endpoint:

```bash
curl -s https://abcd1234.ngrok.io/health
# should return: { "ok": true, "transport": "sse", "port": 8080 }
```

- If you prefer to automate retrieval of the ngrok public URL (ngrok v2 local web UI), use the helper script below which queries the local ngrok API (127.0.0.1:4040):

```bash
./get-ngrok-url.sh
# prints the HTTPS forwarding URL, or instructions if not available
```

Notes and caveats
- ngrok provides TLS termination; use the HTTPS URL in the Claude connector UI.
- If ngrok uses a different local API port (or v3), consult ngrok docs — you can also copy the forwarding URL from the ngrok UI.
- Running a public endpoint exposes your tools — ensure `security.requireApproval` and `security.allowedPaths` are configured safely.
