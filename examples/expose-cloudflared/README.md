Expose Local-MCP via Cloudflare Tunnel (example)

This folder shows how to expose the SSE/HTTP MCP server publicly using
`cloudflared` (Cloudflare Tunnel) so Claude (or any other remote MCP client)
can connect to your local machine.

Why Cloudflare Tunnel instead of ngrok
- No account or sign-up required for a quick tunnel.
- No paid plan needed — this matters for an open-source project, since we
  can't ask every user to buy a ngrok subscription just to get a working
  connector.
- Free ngrok domains inject an HTML "browser warning" interstitial page in
  front of every request unless the caller sends a special header. Claude's
  connector doesn't send that header, so the interstitial silently eats the
  MCP handshake and Claude reports "Couldn't reload tools from the server."
  Cloudflare's quick tunnels have no such interstitial, so this class of
  failure doesn't happen.

The one tradeoff: like ngrok's free tier, a quick tunnel's `trycloudflare.com`
URL is random and changes every time you restart it. If you want a stable
URL across restarts, see "Stable URL (named tunnel)" below.

Prerequisites

1. Install Local-MCP and build:

```bash
npm run build
```

2. Install `cloudflared`:

```bash
# macOS
brew install cloudflared

# Debian/Ubuntu
curl -LO https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb

# Windows
winget install --id Cloudflare.cloudflared
```

Expose the server

1. Start the Local-MCP SSE/HTTP server:

```bash
node dist/cli.js start --transport sse --port 8080
```

2. In a second terminal, start the tunnel:

```bash
# using the helper script (prints the connector URL for you)
PORT=8080 node examples/expose-cloudflared/run-cloudflared.js

# or run cloudflared directly
cloudflared tunnel --url http://localhost:8080
```

3. `cloudflared` prints a forwarding URL, for example
   `https://random-words-here.trycloudflare.com`.

4. In Claude's "Add custom connector" flow, enter the MCP URL as:

```
https://random-words-here.trycloudflare.com/mcp
```

Verify connectivity

```bash
curl -s https://random-words-here.trycloudflare.com/health
# should return: { "ok": true, "transport": "http", "port": 8080 }
```

Stable URL (named tunnel)

A quick tunnel's URL changes every restart. If you want one that stays the
same (useful once you're past initial testing), you can create a free named
tunnel bound to a domain you control:

```bash
cloudflared tunnel login
cloudflared tunnel create local-mcp
cloudflared tunnel route dns local-mcp mcp.yourdomain.com
cloudflared tunnel run --url http://localhost:8080 local-mcp
```

Then use `https://mcp.yourdomain.com/mcp` as the connector URL — it won't
change between restarts.

Notes and caveats
- Cloudflare terminates TLS for you; always use the `https://` URL in the
  Claude connector UI.
- Running a public endpoint exposes your tools — make sure
  `security.requireApproval` and `security.allowedPaths` are configured
  safely, and consider enabling `LOCAL_MCP_REQUIRE_AUTH` (see the main
  README's Authentication section) since anyone with the tunnel URL can
  reach your machine while the tunnel is up.
