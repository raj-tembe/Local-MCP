## Connecting Local-MCP to Claude

### Overview
Local-MCP exposes an MCP-compatible SSE endpoint at `/mcp` that can be connected to Claude via **Custom Connectors** (UI) or **MCP Connector API** (programmatic).

### Quick Start: Connect to Claude UI

```bash
# 1. Build and start Local-MCP with SSE transport
npm run build
node dist/cli.js start --transport sse --port 3000

# 2. Expose publicly via tunnel (new terminal)
npx localtunnel --port 3000
# → https://abc123.loca.lt

# 3. In Claude: Customize → Connectors → Add custom connector
#    Enter: https://abc123.loca.lt/mcp
#    Authentication: "No sign-in" + add API key in Request Headers (optional)
```

### Authentication

#### Option 1: API Key (Recommended for tunnels)
```bash
# Set API key via environment
export LOCAL_MCP_API_KEYS="your-secret-key-1,your-secret-key-2"
export LOCAL_MCP_REQUIRE_AUTH=true
node dist/cli.js start --transport sse --port 3000
```

In Claude's "Add custom connector" dialog:
- **Authentication**: Select "No sign-in"
- **Request headers**: Add `Authorization` = `Bearer your-secret-key-1`

#### Option 2: No Authentication (Development Only)
```bash
# Default: no auth required
node dist/cli.js start --transport sse --port 3000
```

In Claude: Select "No sign-in" with no headers.

#### Option 3: Config File
Create `~/.local-mcp/config.json`:
```json
{
  "transport": "sse",
  "port": 3000,
  "auth": {
    "requireAuth": true,
    "apiKeys": ["your-secret-key-1", "your-secret-key-2"]
  }
}
```

### Tunnel Options

| Tool | Command | Notes |
|------|---------|-------|
| **localtunnel** | `npx localtunnel --port 3000` | Free, random subdomain |
| **ngrok** | `ngrok http 3000` | Free tier, fixed domain on paid |
| **Cloudflare Tunnel** | `cloudflared tunnel --url http://localhost:3000` | Free, custom domains |
| **VS Code Port Forward** | Built-in | Only works in Codespaces |

### Tool Filtering (Allowlist/Denylist)

Restrict which tools Claude can access:

```bash
# Allow only read-only tools
export LOCAL_MCP_ALLOWED_TOOLS="fs.read,fs.list,fs.stat,system.info,terminal.read,terminal.list"
node dist/cli.js start --transport sse --port 3000
```

Or in config:
```json
{
  "toolFilter": {
    "allowedTools": ["fs.read", "fs.list", "fs.stat", "system.info"],
    "deniedTools": ["shell.execute", "fs.write", "fs.mkdir", "terminal.write"]
  }
}
```

**Default denied tools**: `shell.execute`, `terminal.write`, `fs.write`, `fs.mkdir`, `user.clipboard.write`

### Programmatic Access (Claude API)

Use the Messages API with `mcp_servers` and `mcp_toolset`:

```bash
curl https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: mcp-client-2025-11-20" \
  -d '{
    "model": "claude-opus-5",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "List files in my home directory"}],
    "mcp_servers": [{
      "type": "url",
      "url": "https://abc123.loca.lt/mcp",
      "name": "local-mcp",
      "authorization_token": "your-secret-key-1"
    }],
    "tools": [{
      "type": "mcp_toolset",
      "mcp_server_name": "local-mcp",
      "configs": {
        "shell.execute": {"enabled": false},
        "fs.write": {"enabled": false}
      }
    }]
  }'
```

### Managing Connectors Locally

```bash
# List configured connectors
local-mcp connectors list

# Add a connector (stored in ~/.local-mcp/connectors.json)
local-mcp connectors:add my-server https://my-mcp.example.com/mcp "My MCP Server"

# Remove a connector
local-mcp connectors:remove my-server
```

### Security Best Practices

1. **Always use authentication** when exposing via public tunnels
2. **Use tool filtering** to deny destructive tools (`shell.execute`, `fs.write`)
3. **Monitor audit logs** at `~/.local-mcp/audit.jsonl`
4. **Use approval mode** (default) for interactive confirmation
5. **Remove test connectors** when done

---

## Add custom connector (Legacy)

Add custom connectors (Claude)
# Local-MCP

Local-MCP is a secure local bridge for cloud AI clients using the Model Context Protocol (MCP). It enables an MCP-compatible client to talk to the user's local terminal, filesystem, and user-level I/O with configurable safety controls.

## Features

- MCP server with stdio, SSE/HTTP, and tunnel-ready infrastructure
- Terminal execution via node-pty concepts and shell commands
- User approval prompts before sensitive actions
- Audit logging and config-based enforcement
- Cross-platform Node.js CLI

## Quick start

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js start --transport stdio
```

## CLI commands

```bash
local-mcp init
local-mcp start --transport stdio
local-mcp start --transport sse --port 3000
local-mcp config list
local-mcp doctor
```

## Security defaults

The default policy is intentionally safe:

- `defaultMode` is `ask`
- restricted command allowlist plus explicitly denied commands
- writes and shell operations require approval by default
- audit logs are written to `~/.local-mcp/audit.jsonl`

## Project status

This repository contains the initial scaffold and a working core config/security foundation for the Local-MCP package. The next stage is to expand the tool registry, transport support, and documentation for the full production feature set.

│                                     │
│ Allow this operation?               │
│                                     │
│ [Y] Allow       [N] Deny            │
└─────────────────────────────────────┘

---

Installation

Install Local-MCP globally:

npm install -g local-mcp

Then verify the installation:

local-mcp --version

---

Quick Start

Start Local-MCP:

local-mcp

or:

local-mcp start

Example output:

╭──────────────────────────────────╮
│          Local-MCP               │
╰──────────────────────────────────╯

✓ MCP server started
✓ Local environment detected
✓ Terminal access enabled
✓ User I/O enabled

Waiting for MCP client...

Once started, an MCP-compatible cloud AI can connect to Local-MCP.

---

Example Workflow

Imagine you are working on a JavaScript project.

You ask the AI:

«Run the tests and fix any failures.»

The AI could perform the following workflow:

1. Inspect project
       ↓
2. Read package.json
       ↓
3. Run npm test
       ↓
4. Receive test output
       ↓
5. Analyze failure
       ↓
6. Read relevant source files
       ↓
7. Modify code
       ↓
8. Run tests again
       ↓
9. Verify result

All commands are executed on the user's local machine through Local-MCP.

---

MCP Tools

Local-MCP can expose tools such as:

Tool| Purpose
"terminal.exec"| Execute a terminal command
"terminal.read"| Read terminal output
"terminal.write"| Write to an interactive terminal
"fs.read"| Read a file
"fs.write"| Write a file
"fs.list"| List files
"fs.mkdir"| Create a directory
"process.list"| List user processes
"user.input"| Request input from the user
"user.confirm"| Request confirmation

The available tools may vary depending on the configuration.

---

Architecture

                         CLOUD
                           │
                           │
                    ┌──────▼──────┐
                    │   AI Agent  │
                    └──────┬──────┘
                           │
                           │ MCP
                           ▼
                 ┌──────────────────┐
                 │    Local-MCP     │
                 │                  │
                 │   MCP Server     │
                 │        │         │
                 │   Tool Router    │
                 │        │         │
                 │ Permission Layer │
                 └────────┬─────────┘
                          │
             ┌────────────┼────────────┐
             │            │            │
             ▼            ▼            ▼
         Terminal      User I/O     Filesystem
             │            │            │
             └────────────┼────────────┘
                          ▼
                   Local Machine

---

Security

Giving a cloud AI access to a local machine is powerful.

It also introduces security risks.

Local-MCP therefore follows a least-privilege approach.

Default principles

- Run with user-level permissions.
- Do not require root by default.
- Require approval for sensitive operations.
- Allow tools to be enabled/disabled.
- Restrict filesystem access where possible.
- Allow command policies.
- Never expose the local server publicly without authentication.
- Do not expose credentials or secrets unnecessarily.
- Provide visibility into AI-requested operations.

Important

Do not connect Local-MCP to an untrusted AI agent.

A connected AI may potentially be able to:

Read files
     │
     ├── Modify files
     │
     ├── Execute commands
     │
     ├── Start processes
     │
     └── Interact with the user

Use appropriate permissions and security policies.

---

Configuration

Local-MCP can be configured to control which capabilities are available.

Example:

{
  "permissions": {
    "terminal": true,
    "filesystem": true,
    "userIO": true
  },

  "terminal": {
    "requireApproval": true
  },

  "filesystem": {
    "allowedPaths": [
      "~/projects"
    ]
  }
}

This allows users to define the boundaries within which the AI can operate.

---

Use Cases

AI Coding Agents

Local-MCP can turn a cloud AI into a local development assistant.

AI
 │
 ├── Inspect repository
 ├── Read source code
 ├── Modify files
 ├── Run commands
 ├── Run tests
 ├── Analyze errors
 └── Fix problems

---

Local Development

Use cloud AI to interact with local development environments.

Examples:

npm install
npm run build
npm test
git status
git diff
docker compose up

---

Automation

AI agents can perform repetitive development tasks using the user's local environment.

---

Interactive AI Workflows

Local-MCP can allow the AI to request information or confirmation from the user.

AI
 │
 ├── Execute operation
 │
 ├── Ask user
 │       │
 │       ▼
 │     Input
 │       │
 │       ▼
 └── Continue workflow

---

Project Structure

A possible project structure:

Local-MCP/
│
├── src/
│   ├── server/
│   │   └── mcp-server
│   │
│   ├── tools/
│   │   ├── terminal
│   │   ├── filesystem
│   │   └── user-io
│   │
│   ├── permissions/
│   │   └── permission-manager
│   │
│   └── cli/
│       └── index
│
├── tests/
│
├── package.json
├── README.md
├── LICENSE
└── tsconfig.json

---

Development

Clone the repository:

git clone https://github.com/<username>/Local-MCP.git
cd Local-MCP

Install dependencies:

npm install

Run in development mode:

npm run dev

Build:

npm run build

Run tests:

npm test

---

Roadmap

- [ ] MCP server
- [ ] Terminal execution
- [ ] Interactive terminal sessions
- [ ] stdin/stdout/stderr support
- [ ] User input and confirmation
- [ ] Filesystem tools
- [ ] Permission system
- [ ] Command allowlists/denylists
- [ ] Filesystem sandboxing
- [ ] Process management
- [ ] Authentication
- [ ] Secure remote connections
- [ ] Audit logging
- [ ] Cross-platform support
- [ ] Windows support
- [ ] Linux support
- [ ] macOS support

---

Philosophy

Local-MCP follows a simple architecture:

Cloud AI = Intelligence
Local-MCP = Bridge
Local Machine = Execution
User = Authority

The AI should be able to reason and request actions.

Local-MCP should translate those requests into controlled local operations.

The user should ultimately control what the AI is allowed to do.

---

⚠️ Status

Local-MCP is currently under development.

The MCP tools, APIs, configuration format, security model, and transport mechanisms may change as the project evolves.

---

License

MIT License

See ""LICENSE"" (LICENSE) for details.

---

Local-MCP

Cloud AI → MCP → Local Machine

«Give AI access to your machine — without giving up control.»