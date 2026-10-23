## Connecting Local-MCP to Claude

### Overview
Local-MCP exposes an MCP-compatible SSE endpoint at `/mcp` that can be connected to Claude via **Custom Connectors** (UI) or **MCP Connector API** (programmatic).

### Quick Start: Connect to Claude UI

```bash
# 1. Build and start Local-MCP with SSE transport
npm run build
node dist/cli.js start --transport sse --port 3000

# 2. Expose publicly via tunnel (new terminal)
PORT=3000 node examples/expose-cloudflared/run-cloudflared.js
# → https://random-words-here.trycloudflare.com

# 3. In Claude: Customize → Connectors → Add custom connector
#    Enter: https://random-words-here.trycloudflare.com/mcp
#    Authentication: "No sign-in" + add API key in Request Headers (optional)
```

> Use Cloudflare Tunnel (`cloudflared`), not ngrok's free tier, for this step.
> ngrok's free domains inject a browser-warning interstitial page in front of
> every request unless the caller sends a special header, and Claude's
> connector doesn't send it — the interstitial silently breaks the MCP
> handshake and Claude reports "Couldn't reload tools from the server."
> Cloudflare Tunnel has no such interstitial and needs no account or paid
> plan, which also makes it the right default for an open-source project.
> See `examples/expose-cloudflared/README.md` for details.

### Standalone Binary (no Node.js required)

Every tagged release publishes ready-to-run binaries on the GitHub Releases page, so you can use Local-MCP without installing Node.js or npm:

| Platform | File |
|----------|------|
| Linux x64 / arm64 | `local-mcp-<version>-linux-x64.tar.gz`, `...-linux-arm64.tar.gz` |
| macOS Apple Silicon / Intel | `local-mcp-<version>-darwin-arm64.tar.gz`, `...-darwin-x64.tar.gz` |
| Windows x64 | `local-mcp-<version>-win32-x64.zip` |

```bash
# verify, extract and run (Linux/macOS)
sha256sum -c --ignore-missing SHA256SUMS.txt        # macOS: shasum -a 256 -c SHA256SUMS.txt
tar -xzf local-mcp-<version>-linux-x64.tar.gz
./local-mcp-<version>-linux-x64/local-mcp start --transport http --port 8080
```

A binary only runs on the OS and CPU it was built for, so pick the file that matches your machine. Notes:

- **Unsigned builds.** On macOS, a browser-downloaded binary is quarantined by Gatekeeper; run `xattr -d com.apple.quarantine ./local-mcp` once (downloading with `curl` avoids this). On Windows, SmartScreen may ask you to choose "More info" then "Run anyway".
- **What is not included.** PTY terminal sessions (`terminal.create`, `terminal.write`, ...) need the native `node-pty` module, which cannot live inside a single executable, so they report "not available" (`runtime.detect` shows `ptyAvailable: false`). Everything else works, including `shell.execute`, `code.run` and `process.start`.
- **Interpreters are not bundled.** `code.run` and `package.install` use the tools already on your machine (for example `python3`, `node`, `npm`), so install what you want Claude to use.
- **Build it yourself.** `npm install && npm run build:binary` writes `dist-bin/local-mcp-<platform>-<arch>`, and `npm run smoke:binary -- dist-bin/<file>` runs a quick end-to-end check against it. Each release binary corresponds to the source at its git tag.

`node-pty` is also an optional dependency of the npm package: if it cannot be built on your machine, installation still succeeds and only the PTY terminal tools are unavailable. Set `LOCAL_MCP_DISABLE_PTY=1` to turn them off explicitly.

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
| **Cloudflare Tunnel** (recommended) | `cloudflared tunnel --url http://localhost:3000` | Free, no account needed, no warning interstitial — see `examples/expose-cloudflared/` |
| **localtunnel** | `npx localtunnel --port 3000` | Free, random subdomain |
| **ngrok** | `ngrok http 3000` | Free tier injects a browser-warning interstitial that breaks Claude's connector handshake (see `examples/expose-ngrok/README.md`); fixed domain and interstitial removal require a paid plan |
| **VS Code Port Forward** | Built-in | Only works in Codespaces |

### Tool Filtering (Allowlist/Denylist)

Restrict which tools Claude can access:

```bash
# Allow only read-only tools
export LOCAL_MCP_ALLOWED_TOOLS="fs.read,fs.list,fs.stat,system.info,terminal.read,terminal.list,search.grep,fs.glob,fs.tree,git.status,git.diff,git.log,git.show,git.blame,project.detect,env.list,port.check"
node dist/cli.js start --transport sse --port 3000
```

Or in config:
```json
{
  "toolFilter": {
    "allowedTools": ["fs.read", "fs.list", "fs.stat", "system.info", "search.grep", "fs.glob", "fs.tree", "git.status", "git.diff", "git.log", "git.show", "git.blame", "project.detect", "env.list", "port.check"],
    "deniedTools": ["shell.execute", "fs.write", "fs.mkdir", "terminal.write", "user.clipboard.write"]
  }
}
```

**Default denied tools**: `shell.execute`, `terminal.write`, `fs.write`, `fs.mkdir`, `user.clipboard.write`, `repl.start`, `repl.eval`, `http.request`, `docker.exec`, `docker.compose`, `db.query`, `db.tables`

### Running Code, Installing Dependencies, Background Processes

These tools let Claude write and run code on your machine, set up a project's dependencies, and keep long-running things (dev servers, watchers, training jobs) going in the background.

| Tool | What it does |
|------|--------------|
| `runtime.detect` | Lists which runtimes and package managers are installed (node, python3, pip3, git, go, cargo, ...) with versions |
| `code.run` | Runs a snippet in `python`, `javascript`, `typescript`, `bash`, `sh`, `ruby` or `go`; returns stdout, stderr, exit code. Optional `args`, `stdin`, `cwd`, `timeoutMs` (default 30s, max 10 min) |
| `package.install` | Installs dependencies with `npm`, `pnpm`, `yarn`, `bun`, `pip`, `uv`, `cargo` or `go`. Pass `packages`, or omit them to install from the project manifest. pip supports `venv` (created if missing) and `requirementsFile` |
| `process.start` | Starts a command in the background and returns an id (waits briefly so startup errors show up) |
| `process.list` / `process.logs` / `process.stop` | Inspect, tail and stop background processes (stop also ends child processes) |

How they are protected:

- `code.run`, `package.install` and `process.start` are in `security.requireApproval` by default, so you are asked in the terminal running Local-MCP before each new action. With no TTY available, approval is denied.
- Approvals for these tools are scoped to the exact payload (a hash of the code or install plan), so approving one script does not approve every future script that uses the same interpreter.
- Commands run without a shell (`code.run`, `package.install`), package names are validated (no flags or shell characters), output is capped at 1 MB, and timeouts kill the whole process tree.
- `security.allowedCommands` and `deniedCommands` are checked against the interpreter or package manager (`python3`, `npm`, ...). The default allowlist only contains `ls`, `cat`, `git`, `npm`, `node`, `echo`, so add what you want Claude to use. Treat this as a permission gate, not a sandbox: once code is approved, it runs with your user's privileges.
- To switch any of these off, add the tool name to `toolFilter.deniedTools`.

Approval prompts appear in the terminal running Local-MCP and are answered there (`y`, `N`, `always`, `deny`). A `y` or `deny` answer is remembered for that exact action in `~/.local-mcp/approvals.json`, so delete the entry there to be asked again. If nobody answers within `security.approvalTimeoutMs` (default 60000 ms, `0` disables it; env `LOCAL_MCP_APPROVAL_TIMEOUT_MS`), the request is denied with an "approval timed out" message and nothing is saved, so you can simply retry. Prompts are shown one at a time, and answers typed within a fraction of a second of a prompt appearing are ignored, so text left over from an earlier prompt cannot approve a different request.

Settings live in `~/.local-mcp/config.json` (or `./.local-mcp/config.json`, or `./local-mcp.config.json`; `node dist/cli.js init` writes a starter file), can be overridden with `LOCAL_MCP_*` environment variables, and command-line flags such as `--port` win over both. Example config enabling Python and a few package managers:

```json
{
  "security": {
    "allowedCommands": ["ls", "cat", "git", "echo", "node", "npm", "pnpm", "python3", "pip", "bash"],
    "requireApproval": ["fs.write", "shell.execute", "code.run", "package.install", "process.start"]
  }
}
```

Note that `npm`/`pnpm`/`yarn` run package lifecycle scripts by default; pass `ignoreScripts: true` when installing packages you do not trust.

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

## Phase 1 — Read-only Intelligence Tools

These tools provide read-only access to code intelligence, git history, project structure, and system information. They do not modify files or execute code, and do not require approval by default.

| Tool | Description |
|------|-------------|
| `search.grep` | Regex content search across a file tree with context lines, gitignore support, binary file detection. |
| `fs.glob` | Find files matching a glob pattern, returns POSIX-style paths. |
| `fs.tree` | Render ASCII directory tree with depth control, shows `… (N more)` for truncated dirs. |
| `git.status` | Repository status: branch, upstream, ahead/behind, staged/unstaged/untracked/conflicts. |
| `git.diff` | Diff working tree, staged changes, or arbitrary refs. Supports `statOnly` mode. |
| `git.log` | Structured commit history with filtering by path, author, date, message. |
| `git.show` | Show commit metadata + patch, or file content at a specific revision. |
| `git.blame` | Line-by-line blame with author, date, and commit SHA. |
| `project.detect` | Detect languages, frameworks, package manager, scripts, entry points from manifests and file census. |
| `env.list` | List environment variables. Secrets (KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, _PAT, AUTH) are always masked. |
| `port.check` | Check if TCP port is listening, with best-effort PID/process name lookup. |

All Phase 1 tools respect `.gitignore` by default (override with `respectGitignore: false`), support `maxBytes` output cap (default 256 KB), and return structured JSON with `truncated` flag.

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

## Contributing

Contributions are welcome, from bug reports and documentation fixes to new tools. Start with [CONTRIBUTING.md](CONTRIBUTING.md), which covers the development setup, the project layout and how to add a tool. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before taking part, use the [issue templates](https://github.com/raj-tembe/Local-MCP/issues/new/choose) to report bugs or suggest features, and report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

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

1. Inspect project (`project.detect`, `git.status`, `fs.tree`)
        ↓
2. Read package.json (`fs.read`)
        ↓
3. Run npm test (`process.start` + `process.logs` or `code.run`)
        ↓
4. Receive test output
        ↓
5. Analyze failure (`search.grep` for error patterns, `git.diff` for recent changes)
        ↓
6. Read relevant source files (`fs.read`, `fs.glob`)
        ↓
7. Modify code (`fs.edit` — Phase 2, approval required)
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
"fs.stat"| Get file metadata
"fs.search"| Search files by name or content
"fs.glob"| Find files matching a glob pattern
"fs.tree"| Render ASCII directory tree
"search.grep"| Regex content search across files
"git.status"| Git repository status
"git.diff"| Git diff (working tree, staged, or refs)
"git.log"| Git commit history
"git.show"| Show commit or file at revision
"git.blame"| Line-by-line git blame
"project.detect"| Detect project type, languages, frameworks
"env.list"| List environment variables (secrets masked)
"port.check"| Check if TCP port is listening
"process.list"| List background processes started with process.start
"process.logs"| Read background process output
"process.stop"| Stop a background process
"user.input"| Request input from the user
"user.confirm"| Request confirmation
"user.notify"| Send desktop notification
"user.clipboard.read"| Read system clipboard
"user.clipboard.write"| Write to system clipboard
"user.open_url"| Open URL in browser
"user.stdout.write"| Write to stdout
"user.stderr.write"| Write to stderr
"code.run"| Run a code snippet (python, javascript, typescript, bash, ruby, go)
"package.install"| Install dependencies (npm, pnpm, yarn, bun, pip, uv, cargo, go)
"runtime.detect"| Detect installed runtimes and package managers
"process.start"| Start a background process
"connectors.list"| List custom MCP connectors
"connectors.add"| Add custom MCP connector
"connectors.remove"| Remove custom MCP connector
"system.info"| Get system information
"shell.execute"| Execute shell command (approval required)
"terminal.create"| Create PTY session
"terminal.write"| Write to PTY session
"terminal.resize"| Resize PTY session
"terminal.kill"| Kill PTY session
"terminal.read"| Read PTY output
"terminal.list"| List PTY sessions

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