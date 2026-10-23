# Local-MCP Tool Reference

This document provides detailed reference for all MCP tools exposed by Local-MCP.

## Phase 1 — Read-only Intelligence Tools

These tools provide read-only access to code intelligence, git history, project structure, and system information. They do not modify files or execute code, and do not require approval by default.

---

### search.grep

Regex content search across a file tree.

**Input:**
```json
{
  "pattern": "string (required) - Regex pattern to search for",
  "path": "string (optional) - Root directory to search (default: cwd)",
  "glob": "string (optional) - Glob pattern to filter files (e.g. **/*.ts)",
  "caseSensitive": "boolean (default: true) - Case-sensitive search",
  "fixedStrings": "boolean (default: false) - Treat pattern as literal string",
  "contextLines": "number (default: 0, max: 10) - Lines of context before/after each match",
  "maxResults": "number (default: 200, max: 2000) - Maximum total matches",
  "respectGitignore": "boolean (default: true) - Respect .gitignore rules",
  "includeIgnored": "boolean (default: false) - Include ignored dirs (node_modules, .git, etc.)",
  "maxBytes": "number (default: 262144) - Output byte cap",
  "cwd": "string (optional) - Working directory for relative paths"
}
```

**Output:**
```json
{
  "matches": [
    {
      "file": "string - Relative file path",
      "line": "number - Line number (1-indexed)",
      "column": "number - Column number (1-indexed)",
      "text": "string - Matching line text",
      "contextBefore": "string[] - Lines before match",
      "contextAfter": "string[] - Lines after match"
    }
  ],
  "totalMatches": "number",
  "truncated": "boolean"
}
```

**Example:**
```json
{
  "pattern": "TODO|FIXME",
  "path": "~/projects/myapp",
  "glob": "**/*.ts",
  "contextLines": 2,
  "maxResults": 50
}
```

---

### fs.glob

Find files matching a glob pattern.

**Input:**
```json
{
  "pattern": "string (required) - Glob pattern (e.g. **/*.ts)",
  "cwd": "string (optional) - Working directory (default: server cwd)",
  "ignore": "string[] (optional) - Additional ignore patterns",
  "maxResults": "number (default: 1000, max: 10000) - Maximum results",
  "includeDirs": "boolean (default: false) - Include directories in results",
  "respectGitignore": "boolean (default: true) - Respect .gitignore rules"
}
```

**Output:**
```json
{
  "paths": "string[] - POSIX-style relative paths",
  "truncated": "boolean"
}
```

**Example:**
```json
{
  "pattern": "src/**/*.test.ts",
  "maxResults": 50
}
```

---

### fs.tree

Render an ASCII tree of a directory.

**Input:**
```json
{
  "path": "string (optional) - Root directory (default: cwd)",
  "depth": "number (default: 3, max: 10) - Maximum depth to traverse",
  "includeFiles": "boolean (default: true) - Include files in output",
  "includeDirs": "boolean (default: true) - Include directories in output",
  "ignore": "string[] (optional) - Additional ignore patterns",
  "respectGitignore": "boolean (default: true) - Respect .gitignore rules",
  "maxBytes": "number (default: 262144) - Output byte cap",
  "cwd": "string (optional) - Working directory for relative paths"
}
```

**Output:**
```json
{
  "tree": "string - ASCII tree with dirs suffixed /, truncated dirs show \"… (N more)\"",
  "entries": "number - Total entries rendered",
  "truncated": "boolean"
}
```

**Example:**
```json
{
  "path": "~/projects/myapp",
  "depth": 2,
  "respectGitignore": true
}
```

---

### git.status

Get git repository status.

**Input:**
```json
{
  "cwd": "string (optional) - Repository directory (walks up to find repo root)"
}
```

**Output:**
```json
{
  "branch": "string - Current branch name",
  "detached": "boolean - True if HEAD is detached",
  "upstream": "string|null - Upstream branch name",
  "ahead": "number - Commits ahead of upstream",
  "behind": "number - Commits behind upstream",
  "staged": [
    { "path": "string", "status": "string" }
  ],
  "unstaged": [
    { "path": "string", "status": "string" }
  ],
  "untracked": "string[]",
  "conflicts": "string[]",
  "repoRoot": "string - Absolute path to repository root"
}
```

**Status codes** (porcelain v2 two-letter codes):
- `M` = modified, `A` = added, `D` = deleted, `R` = renamed, `C` = copied, `U` = unmerged, `?` = untracked

---

### git.diff

Show git diff.

**Input:**
```json
{
  "cwd": "string (optional) - Repository directory",
  "staged": "boolean (default: false) - Diff staged changes",
  "paths": "string[] (optional) - Limit to specific paths",
  "contextLines": "number (default: 3) - Lines of context",
  "from": "string (optional) - Source ref (e.g. HEAD~1)",
  "to": "string (optional) - Target ref (e.g. HEAD)",
  "statOnly": "boolean (default: false) - Only show file stats",
  "maxBytes": "number (default: 262144) - Output byte cap"
}
```

**Output:**
```json
{
  "diff": "string - Unified diff (empty if statOnly)",
  "filesChanged": "number",
  "additions": "number",
  "deletions": "number",
  "files": [
    { "path": "string", "status": "string", "additions": "number", "deletions": "number" }
  ],
  "truncated": "boolean"
}
```

**Examples:**
```json
{ "cwd": "~/projects/myapp", "staged": true }
{ "cwd": "~/projects/myapp", "from": "HEAD~3", "to": "HEAD", "statOnly": true }
```

---

### git.log

Show git commit history.

**Input:**
```json
{
  "cwd": "string (optional) - Repository directory",
  "limit": "number (default: 20, max: 200) - Maximum commits",
  "path": "string (optional) - Limit to commits touching this path",
  "author": "string (optional) - Filter by author name/email",
  "since": "string (optional) - Filter commits after ISO 8601 date",
  "grep": "string (optional) - Filter by commit message regex"
}
```

**Output:**
```json
{
  "commits": [
    {
      "sha": "string - Full SHA",
      "shortSha": "string - Abbreviated SHA",
      "author": "string - Author name",
      "authorEmail": "string - Author email",
      "date": "string - ISO 8601 date",
      "subject": "string - Commit subject",
      "body": "string - Commit body"
    }
  ]
}
```

**Example:**
```json
{
  "cwd": "~/projects/myapp",
  "limit": 10,
  "author": "john",
  "since": "2024-01-01"
}
```

---

### git.show

Show a commit (metadata + patch) or a file at a specific revision.

**Input:**
```json
{
  "ref": "string (required) - Commit ref (SHA, tag, branch, HEAD~1, etc.)",
  "path": "string (optional) - File path to show at that revision",
  "cwd": "string (optional) - Repository directory",
  "maxBytes": "number (default: 262144) - Output byte cap"
}
```

**Output:**
```json
{
  "meta": {
    "sha": "string",
    "author": "string",
    "date": "string",
    "subject": "string",
    "parents": "string[]"
  },
  "patch": "string - Unified diff (empty if path specified)",
  "truncated": "boolean"
}
```

**Example:**
```json
{ "ref": "HEAD~1", "path": "src/main.ts" }
```

---

### git.blame

Show line-by-line blame for a file.

**Input:**
```json
{
  "path": "string (required) - File path (relative to repo root or absolute)",
  "cwd": "string (optional) - Repository directory",
  "startLine": "number (optional) - Start line (1-indexed)",
  "endLine": "number (optional) - End line (inclusive)",
  "maxBytes": "number (default: 262144) - Output byte cap"
}
```

**Output:**
```json
{
  "lines": [
    {
      "lineNo": "number",
      "sha": "string - Full commit SHA",
      "shortSha": "string - Abbreviated SHA",
      "author": "string",
      "date": "string - ISO 8601 date",
      "content": "string - Line content"
    }
  ],
  "truncated": "boolean"
}
```

**Example:**
```json
{
  "path": "src/main.ts",
  "startLine": 10,
  "endLine": 50
}
```

---

### project.detect

Detect project type, languages, frameworks, package manager, scripts, and entry points from manifest files and file census.

**Input:**
```json
{
  "cwd": "string (optional) - Project root directory (default: cwd)",
  "depth": "number (default: 3, max: 10) - Directory depth to scan for manifests"
}
```

**Output:**
```json
{
  "languages": [
    { "name": "string", "files": "number", "percentage": "number" }
  ],
  "frameworks": "string[]",
  "packageManager": "string|null",
  "runtimeHints": "string[]",
  "monorepo": {
    "isMonorepo": "boolean",
    "tool": "string|null",
    "workspaces": [{ "name": "string", "path": "string" }]
  },
  "scripts": "Record<string, string>",
  "entryPoints": "string[]",
  "testFramework": "string|null",
  "ci": "string[]",
  "configFiles": "string[]"
}
```

**Example:**
```json
{ "cwd": "~/projects/myapp", "depth": 3 }
```

---

### env.list

List environment variables. Secrets are always masked.

**Input:**
```json
{
  "filter": "string (optional) - Glob or prefix filter for variable names",
  "revealValues": "boolean (default: false) - Show non-secret values"
}
```

**Output:**
```json
{
  "vars": [
    {
      "name": "string",
      "isSet": "boolean",
      "length": "number",
      "valuePreview": "string|null - Only for non-secrets when revealValues=true"
    }
  ],
  "total": "number",
  "redacted": "boolean - True if any secrets were masked"
}
```

**Secret patterns** (always masked, even with `revealValues: true`):
- `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`, `*_PAT`, `*AUTH*`

**Example:**
```json
{ "filter": "NODE_*", "revealValues": true }
```

---

### port.check

Check if a TCP port is listening.

**Input:**
```json
{
  "port": "number (required, 1-65535) - Port number to check",
  "host": "string (default: 127.0.0.1) - Host to check"
}
```

**Output:**
```json
{
  "port": "number",
  "listening": "boolean",
  "addresses": [{ "address": "string", "family": "string" }],
  "pid": "number|null - Best effort, may be unavailable",
  "processName": "string|null - Best effort, may be unavailable"
}
```

**Example:**
```json
{ "port": 3000, "host": "127.0.0.1" }
```

---

## Phase 2 — Mutation Tools (Approval-Gated)

These tools modify files or git state and require approval by default.

*Coming in Phase 2: `fs.edit`, `fs.applyPatch`, `fs.diff`, `fs.move`, `fs.copy`, `fs.remove`, `git.add`, `git.commit`, `git.stash`, `git.checkout`, `git.branch`, `task.run`, `code.format`, `code.lint`*

---

## Phase 3 — Session and Integration Tools (Highest Security)

These tools spawn long-lived processes, make network calls, or touch databases. They are **denied by default** and require explicit opt-in.

*Coming in Phase 3: `repl.start`, `repl.eval`, `repl.list`, `repl.close`, `http.request`, `docker.ps`, `docker.logs`, `docker.compose`, `docker.exec`, `package.list`, `package.outdated`, `package.audit`, `fs.watch`, `fs.watch.poll`, `fs.unwatch`, `log.tail`, `lsp.diagnostics`, `db.tables`, `db.query`*

---

## Existing Tools

See the README for the complete list of existing tools including:
- Terminal: `terminal.create`, `terminal.write`, `terminal.read`, `terminal.list`, `terminal.exec`, `terminal.resize`, `terminal.kill`
- Filesystem: `fs.read`, `fs.write`, `fs.list`, `fs.mkdir`, `fs.stat`, `fs.search`
- Process: `process.start`, `process.list`, `process.logs`, `process.stop`
- Code execution: `code.run`, `package.install`, `runtime.detect`
- User I/O: `user.input`, `user.confirm`, `user.notify`, `user.clipboard.read`, `user.clipboard.write`, `user.open_url`, `user.stdout.write`, `user.stderr.write`
- System: `system.info`, `shell.execute`
- Connectors: `connectors.list`, `connectors.add`, `connectors.remove`

---

## Security Notes

### Tool Filtering
Every tool can be filtered by exact name using:
- `toolFilter.allowedTools` — allowlist (if non-empty, only these tools are available)
- `toolFilter.deniedTools` — denylist (tools in this list are blocked)

### Audit Logging
All tool invocations are logged to `~/.local-mcp/audit.jsonl` with:
- Tool name
- Timestamp
- SHA-256 hash of arguments
- Decision (allow/deny)
- Result summary (truncated, no secrets)
- Duration

### Approval
Tools in `security.requireApproval` prompt for approval in the terminal running Local-MCP. Approvals are scoped to the exact payload hash.

### Command Allowlist
Tools that spawn processes check the binary against `security.allowedCommands` and `security.deniedCommands`.