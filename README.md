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