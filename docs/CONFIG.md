# Configuration reference

Local-MCP reads configuration from multiple sources in priority order:

1. `local-mcp.config.json` in the project directory
2. `.local-mcp/config.json` in the project directory
3. `~/.local-mcp/config.json`
4. environment variables
5. explicit runtime overrides

## Example config

```json
{
  "transport": "stdio",
  "port": 3000,
  "security": {
    "defaultMode": "ask",
    "allowedCommands": ["ls", "cat", "git", "npm", "node"],
    "deniedCommands": ["rm", "sudo", "dd", "mkfs"],
    "allowedPaths": ["~/projects", "/tmp"],
    "deniedPaths": ["/etc", "~/.ssh"],
    "requireApproval": ["fs.write", "shell.execute", "terminal.create"],
    "maxCommandLength": 4096,
    "sessionTimeoutMs": 300000,
    "rateLimitPerMinute": 60
  },
  "logging": {
    "level": "info",
    "auditFile": "~/.local-mcp/audit.jsonl"
  },
  "cloud": {
    "relayUrl": "",
    "token": ""
  }
}
```

## Environment variables

- `LOCAL_MCP_TRANSPORT`
- `LOCAL_MCP_PORT`
- `LOCAL_MCP_DEFAULT_MODE`
- `LOCAL_MCP_AUDIT_FILE`
- `LOCAL_MCP_RELAY_URL`
- `LOCAL_MCP_TOKEN`
