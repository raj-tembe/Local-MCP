# Cloud connection guide

Local-MCP can expose a remote endpoint in two ways:

1. **Direct SSE/HTTP exposure** through a tunnel service (Cloudflare, ngrok, localtunnel) or reverse proxy.
2. **Reverse relay connection** from the local machine to a hosted relay.

## SSE/HTTP transport

```bash
# SSE (deprecated but still works)
node dist/cli.js start --transport sse --port 3000

# HTTP (Streamable HTTP, recommended)
node dist/cli.js start --transport http --port 3000
```

Then forward `http://localhost:3000` via your tunnel.

### Which tunnel to use

| Tunnel | Notes |
|--------|-------|
| **Cloudflare Tunnel** (`cloudflared`) | **Recommended**. Free, no account needed, no interstitial. See `examples/expose-cloudflared/`. |
| **localtunnel** | Free, random subdomain. Works well. |
| **ngrok** | Free tier injects HTML browser-warning interstitial that breaks MCP handshake. Requires paid plan to remove. Not recommended for quick start. |
| **VS Code Port Forward** | Only works in Codespaces. |

> **Why not ngrok free?** ngrok serves an HTML interstitial page unless the caller sends `ngrok-skip-browser-warning` header. Claude's connector doesn't send this, so the connector "connects" but receives ngrok's warning page instead of JSON-RPC. This is a tunnel-layer issue, not a Local-MCP bug.

## Reverse relay

Set the relay URL and token in config or environment:

```bash
export LOCAL_MCP_RELAY_URL=https://relay.example.com
export LOCAL_MCP_TOKEN=replace-me
```

The local process connects to the relay with the token; the relay forwards messages to the MCP client.

## Authentication

When exposing publicly, **always enable authentication**:

```bash
export LOCAL_MCP_API_KEYS="your-secret-key-1,your-secret-key-2"
export LOCAL_MCP_REQUIRE_AUTH=true
```

In Claude's "Add custom connector" dialog:
- **Authentication**: "No sign-in"
- **Request headers**: `Authorization` = `Bearer your-secret-key-1`

Or configure in `~/.local-mcp/config.json`:
```json
{
  "auth": {
    "requireAuth": true,
    "apiKeys": ["your-secret-key-1", "your-secret-key-2"]
  }
}
```

## Tool access over cloud

All 25+ Phase 1+2 tools work over cloud connections. Use `toolFilter` to restrict:

```json
{
  "toolFilter": {
    "allowedTools": ["fs.read", "fs.list", "search.grep", "git.status", "git.log", "project.detect", "code.run"],
    "deniedTools": ["shell.execute", "fs.write", "fs.edit", "git.commit", "process.start"]
  }
}
```

### Recommended read-only toolset for cloud AI
```
search.grep, fs.glob, fs.tree, git.status, git.diff, git.log, git.show, git.blame,
project.detect, env.list, port.check, fs.read, fs.list, fs.stat, system.info, runtime.detect
```

### Mutation tools (require approval)
Phase 2 tools (`fs.edit`, `git.commit`, `task.run`, `code.format`, etc.) require interactive approval in the terminal running Local-MCP. The approval prompt appears there — the cloud AI cannot bypass it.

## Programmatic access (Claude API)

```bash
curl https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: mcp-client-2025-11-20" \
  -d '{
    "model": "claude-opus-5",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "Run tests and show failures"}],
    "mcp_servers": [{
      "type": "url",
      "url": "https://your-tunnel.trycloudflare.com/mcp",
      "name": "local-mcp",
      "authorization_token": "your-secret-key-1"
    }],
    "tools": [{
      "type": "mcp_toolset",
      "mcp_server_name": "local-mcp",
      "configs": {
        "shell.execute": {"enabled": false},
        "fs.write": {"enabled": false},
        "fs.edit": {"enabled": false},
        "git.commit": {"enabled": false}
      }
    }]
  }'
```

## Security best practices for cloud

1. **Always use authentication** when exposing via public tunnels
2. **Use tool filtering** to deny destructive tools
3. **Monitor audit logs** at `~/.local-mcp/audit.jsonl`
4. **Use approval mode** (default) for interactive confirmation
5. **Remove test connectors** when done
6. **Restrict `security.allowedCommands`** — only add binaries you trust
7. **Use `toolFilter.allowedTools`** for least-privilege tool access