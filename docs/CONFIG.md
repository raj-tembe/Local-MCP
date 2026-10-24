# Configuration reference

Local-MCP reads configuration from multiple sources in priority order:

1. `local-mcp.config.json` in the project directory
2. `.local-mcp/config.json` in the project directory
3. `~/.local-mcp/config.json`
4. environment variables
5. explicit runtime overrides

## Example config (full)

```json
{
  "transport": "stdio",
  "port": 3000,
  "security": {
    "defaultMode": "ask",
    "allowedCommands": [
      "ls", "cat", "git", "npm", "node", "echo",
      "bash", "pnpm", "python3", "pip", "docker",
      "prettier", "eslint", "ruff", "gofmt",
      "golangci-lint", "cargo", "clippy-driver", "make"
    ],
    "deniedCommands": ["rm", "sudo", "dd", "mkfs", "shutdown", "reboot"],
    "allowedPaths": ["~", "/tmp", "/var/tmp"],
    "deniedPaths": ["/etc", "/root", "~/.ssh", "/proc", "/sys"],
    "requireApproval": [
      "fs.write", "shell.execute", "code.run", "package.install", "process.start",
      "fs.edit", "fs.applyPatch", "fs.move", "fs.copy", "fs.remove",
      "git.add", "git.commit", "git.stash", "git.checkout", "git.branch",
      "task.run", "code.format", "code.lint"
    ],
    "maxCommandLength": 4096,
    "sessionTimeoutMs": 300000,
    "approvalTimeoutMs": 60000,
    "rateLimitPerMinute": 60
  },
  "logging": {
    "level": "info",
    "auditFile": "~/.local-mcp/audit.jsonl"
  },
  "cloud": {
    "relayUrl": "",
    "token": ""
  },
  "auth": {
    "apiKeys": [],
    "requireAuth": false,
    "oauth": {
      "enabled": false,
      "clientId": "",
      "clientSecret": "",
      "issuerUrl": "",
      "audience": ""
    }
  },
  "toolFilter": {
    "allowedTools": [],
    "deniedTools": [
      "shell.execute", "terminal.write", "fs.write", "fs.mkdir", "user.clipboard.write",
      "repl.start", "repl.eval", "http.request", "docker.exec", "docker.compose", "db.query", "db.tables"
    ]
  },
  "http": {
    "allowPrivateNetworks": false
  },
  "lsp": {
    "enabled": false,
    "servers": {}
  },
  "db": {
    "connections": {}
  }
}
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `LOCAL_MCP_TRANSPORT` | `stdio`, `sse`, or `http` |
| `LOCAL_MCP_PORT` | Port number (default 3000) |
| `LOCAL_MCP_DEFAULT_MODE` | `ask`, `allow`, or `deny` |
| `LOCAL_MCP_APPROVAL_TIMEOUT_MS` | Approval prompt timeout (default 60000, 0 = disabled) |
| `LOCAL_MCP_AUDIT_FILE` | Audit log path |
| `LOCAL_MCP_RELAY_URL` | Cloud relay URL |
| `LOCAL_MCP_TOKEN` | Cloud relay token |
| `LOCAL_MCP_API_KEYS` | Comma-separated API keys (enables auth) |
| `LOCAL_MCP_REQUIRE_AUTH` | `true`/`false` |
| `LOCAL_MCP_ALLOWED_TOOLS` | Comma-separated tool names (allowlist) |
| `LOCAL_MCP_DENIED_TOOLS` | Comma-separated tool names (denylist) |

## Security config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultMode` | `ask\|allow\|deny` | `ask` | Approval behavior when no cached decision |
| `allowedCommands` | `string[]` | `[ls, cat, git, npm, node, echo, ...]` | Commands allowed to spawn |
| `deniedCommands` | `string[]` | `[rm, sudo, dd, mkfs, shutdown, reboot]` | Commands explicitly denied |
| `allowedPaths` | `string[]` | `["~", "/tmp", "/var/tmp"]` | Filesystem allowlist (supports `~`) |
| `deniedPaths` | `string[]` | `["/etc", "/root", "~/.ssh", "/proc", "/sys"]` | Filesystem denylist |
| `requireApproval` | `string[]` | Phase 1+2 mutation tools | Tools requiring interactive approval |
| `maxCommandLength` | `number` | `4096` | Max command string length |
| `sessionTimeoutMs` | `number` | `300000` | MCP session timeout |
| `approvalTimeoutMs` | `number` | `60000` | Approval prompt timeout (0 = no timeout) |
| `rateLimitPerMinute` | `number` | `60` | Requests per minute per session |

## Tool filtering

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowedTools` | `string[]` | `[]` | If non-empty, only these tools are available |
| `deniedTools` | `string[]` | Phase 3 + destructive tools | Tools blocked (Phase 3: repl.*, http.request, docker.exec, docker.compose, db.*) |

**Note:** `allowedTools` takes precedence over `deniedTools`. Both use exact tool name matching (e.g., `fs.edit`, `git.status`).

## HTTP config (Phase 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowPrivateNetworks` | `boolean` | `false` | Allow `http.request` to localhost/RFC1918 (SSRF guard) |

## LSP config (Phase 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable `lsp.diagnostics` |
| `servers` | `object` | `{}` | LSP server config per language |

## Database config (Phase 3)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `connections` | `object` | `{}` | Pre-declared DB connections (no DSN from caller) |

## Initialization

```bash
node dist/cli.js init
```

Creates `~/.local-mcp/config.json` with the full default configuration.