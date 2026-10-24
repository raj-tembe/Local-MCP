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

These tools modify files or git state and require approval by default. Approval is scoped to the exact payload hash. Use `dryRun: true` to preview without approval.

---

### fs.edit

Edit a file by replacing `oldString` with `newString`. Requires `oldString` to be unique unless `replaceAll` is set. Returns unified diff.

**Input:**
```json
{
  "path": "string (required) - File path",
  "oldString": "string (required) - Text to replace (must be unique unless replaceAll=true)",
  "newString": "string (required) - Replacement text",
  "replaceAll": "boolean (default: false) - Replace all occurrences",
  "expectedReplacements": "number (optional) - Expected count (fails if mismatch)",
  "dryRun": "boolean (default: false) - Preview only, no write",
  "maxBytes": "number (default: 262144) - Output byte cap",
  "cwd": "string (optional) - Working directory for relative paths"
}
```

**Output:**
```json
{
  "applied": "boolean - Whether write occurred (false if dryRun)",
  "replacements": "number - Number of replacements made",
  "diff": "string - Unified diff of the change",
  "diffTruncated": "boolean",
  "error": "{ code, message, detail? } - If failed"
}
```

**Error codes:** `ENOENT`, `NOT_FOUND`, `AMBIGUOUS_MATCH`, `EXPECTED_MISMATCH`

**Example:**
```json
{
  "path": "src/main.ts",
  "oldString": "const x = 1;",
  "newString": "const x = 2;",
  "dryRun": true
}
```

---

### fs.applyPatch

Apply a unified diff patch. Validates paths before writing (rejects path traversal). Atomic per-file with temp file + rename.

**Input:**
```json
{
  "patch": "string (required) - Unified diff patch",
  "cwd": "string (optional) - Working directory",
  "strip": "number (default: 1) - Strip leading path components",
  "dryRun": "boolean (default: false) - Preview only",
  "reverse": "boolean (default: false) - Apply in reverse",
  "maxBytes": "number (default: 262144) - Output byte cap"
}
```

**Output:**
```json
{
  "applied": "boolean - True if all hunks applied",
  "files": [{ "path": "string", "status": "string", "additions": "number", "deletions": "number" }],
  "rejected": [{ "path": "string", "reason": "string" }],
  "diff": "string - Applied diff"
}
```

**Example:**
```json
{
  "patch": "@@ -1,3 +1,3 @@\n line1\n-line2\n+line2 modified\n line3\n",
  "strip": 1
}
```

---

### fs.diff

Generate a unified diff between two file versions. Pure preview, never writes.

**Input:**
```json
{
  "path": "string (optional) - File path (with oldContent+newContent)",
  "oldContent": "string (optional) - Original content",
  "newContent": "string (optional) - New content",
  "pathA": "string (optional) - First file path (with pathB)",
  "pathB": "string (optional) - Second file path (with pathA)",
  "contextLines": "number (default: 3) - Lines of context",
  "maxBytes": "number (default: 262144) - Output byte cap",
  "cwd": "string (optional) - Working directory for relative paths"
}
```

**Output:**
```json
{
  "diff": "string - Unified diff",
  "additions": "number",
  "deletions": "number",
  "truncated": "boolean"
}
```

**Example:**
```json
{ "pathA": "src/old.ts", "pathB": "src/new.ts" }
```

---

### fs.move

Move or rename a file or directory. Fails with `EEXIST` unless `overwrite=true`.

**Input:**
```json
{
  "from": "string (required) - Source path",
  "to": "string (required) - Destination path",
  "overwrite": "boolean (default: false) - Overwrite if exists",
  "dryRun": "boolean (default: false) - Preview only",
  "cwd": "string (optional) - Working directory for relative paths"
}
```

**Output:**
```json
{ "moved": "boolean", "from": "string", "to": "string" }
```

---

### fs.copy

Copy a file or directory. Supports recursive copy. Fails with `EEXIST` unless `overwrite=true`.

**Input:**
```json
{
  "from": "string (required) - Source path",
  "to": "string (required) - Destination path",
  "recursive": "boolean (default: false) - Copy directories recursively",
  "overwrite": "boolean (default: false) - Overwrite if exists",
  "dryRun": "boolean (default: false) - Preview only",
  "cwd": "string (optional) - Working directory for relative paths"
}
```

**Output:**
```json
{ "copied": "boolean", "from": "string", "to": "string", "entries": "number" }
```

---

### fs.remove

Remove a file or directory. Defaults to OS trash (recycle bin on Windows, `~/.Trash` on macOS, XDG on Linux). Use `useTrash:false` for permanent deletion. Refuses unsafe paths (home, root, git repo root).

**Input:**
```json
{
  "path": "string (required) - Path to remove",
  "recursive": "boolean (default: false) - Remove directories recursively",
  "useTrash": "boolean (default: true) - Use OS trash instead of permanent deletion",
  "dryRun": "boolean (default: false) - Preview only",
  "cwd": "string (optional) - Working directory for relative paths"
}
```

**Output:**
```json
{ "removed": "boolean", "path": "string", "method": "\"trash\" | \"delete\"" }
```

**Error code:** `REFUSED_UNSAFE_PATH` for protected paths

---

### git.add

Stage files for commit.

**Input:**
```json
{
  "paths": "string[] (required) - Paths to stage",
  "cwd": "string (optional) - Repository directory",
  "dryRun": "boolean (default: false) - Preview only"
}
```

**Output:**
```json
{ "staged": "string[]", "dryRun": "boolean" }
```

---

### git.commit

Create a commit with staged changes. Refuses empty staged set (`NOTHING_TO_COMMIT`). Does not use `--no-verify` — hooks run normally.

**Input:**
```json
{
  "message": "string (required) - Commit message",
  "paths": "string[] (optional) - Specific paths to commit (implies add)",
  "cwd": "string (optional) - Repository directory",
  "amend": "boolean (default: false) - Amend previous commit",
  "signoff": "boolean (default: false) - Add Signed-off-by trailer",
  "dryRun": "boolean (default: false) - Preview only"
}
```

**Output:**
```json
{
  "sha": "string - Full commit SHA",
  "shortSha": "string - Abbreviated SHA",
  "message": "string",
  "filesChanged": "number"
}
```

---

### git.stash

Stash operations: push, pop, list, drop, apply.

**Input:**
```json
{
  "action": "string (required) - push | pop | list | drop | apply",
  "message": "string (optional) - Stash message (for push)",
  "index": "number (optional) - Stash index (for pop/drop/apply)",
  "includeUntracked": "boolean (default: false) - Include untracked files (for push)",
  "cwd": "string (optional) - Repository directory"
}
```

**Output (list):**
```json
{
  "action": "list",
  "ok": "boolean",
  "stashes": [{ "index": "number", "message": "string", "sha": "string" }]
}
```

**Output (other):**
```json
{ "action": "string", "ok": "boolean", "detail": "string" }
```

---

### git.checkout

Switch branches or restore files. `force:true` requires second confirmation for discarding local changes.

**Input:**
```json
{
  "target": "string (required) - Branch, tag, or commit",
  "create": "boolean (default: false) - Create new branch",
  "paths": "string[] (optional) - Specific paths to restore",
  "force": "boolean (default: false) - Discard local changes (needs second confirmation)",
  "cwd": "string (optional) - Repository directory",
  "dryRun": "boolean (default: false) - Preview only"
}
```

**Output:**
```json
{
  "branch": "string|null",
  "sha": "string|null",
  "detached": "boolean",
  "previousRef": "string",
  "switchedFiles": "string[]"
}
```

---

### git.branch

List, create, delete, or rename branches.

**Input:**
```json
{
  "action": "string (required) - list | create | delete | rename",
  "name": "string (optional) - Branch name (for create/delete/rename)",
  "from": "string (optional) - Source branch (for create/rename)",
  "force": "boolean (default: false) - Force delete/rename",
  "cwd": "string (optional) - Repository directory"
}
```

**Output (list):**
```json
{
  "branches": [
    { "name": "string", "current": "boolean", "sha": "string", "upstream": "string|null" }
  ]
}
```

**Output (other):**
```json
{ "action": "string", "ok": "boolean" }
```

---

### task.run

Run a script from `package.json`, `Makefile`, `justfile`, `pyproject.toml`, or `Cargo.toml`. Returns structured test summary for vitest/jest/pytest/cargo test/go test. **Highest-value tool in Phase 2.**

**Input:**
```json
{
  "script": "string (required) - Script name (e.g. test, build, lint)",
  "cwd": "string (optional) - Project directory",
  "args": "string[] (optional) - Additional arguments to the script",
  "timeoutMs": "number (default: 120000, max: 600000) - Timeout in ms",
  "env": "Record<string,string> (optional) - Additional environment variables",
  "maxBytes": "number (default: 262144) - Output byte cap"
}
```

**Output:**
```json
{
  "script": "string",
  "command": "string - Full command executed",
  "exitCode": "number|null",
  "status": "\"passed\" | \"failed\" | \"timeout\" | \"error\"",
  "durationMs": "number",
  "framework": "string|null - Detected test framework",
  "summary": {
    "total": "number",
    "passed": "number",
    "failed": "number",
    "skipped": "number",
    "failingTests": [{ "name": "string", "file": "string?", "line": "number?", "message": "string" }]
  },
  "stdout": "string",
  "stderr": "string",
  "truncated": "boolean"
}
```

**Supported frameworks:** vitest, jest, pytest, cargo test, go test, mocha

**Example:**
```json
{ "script": "test", "args": ["--reporter=verbose"], "cwd": "~/projects/myapp" }
```

---

### code.format

Format code with prettier, black, ruff, gofmt, or rustfmt. Auto-detects from config files. `check=true` reports instead of writing. `dryRun=true` previews without approval.

**Input:**
```json
{
  "paths": "string[] (optional) - Files or directories (default: project root)",
  "cwd": "string (optional) - Working directory",
  "formatter": "string (default: auto) - prettier | black | ruff | gofmt | rustfmt | auto",
  "check": "boolean (default: false) - Report only, do not write",
  "dryRun": "boolean (default: false) - Preview only",
  "maxBytes": "number (default: 262144) - Output byte cap"
}
```

**Output:**
```json
{
  "formatter": "string",
  "formatted": "string[] - Files that were formatted",
  "unchanged": "string[] - Files already formatted",
  "errors": [{ "path": "string", "message": "string" }]
}
```

**Error code:** `UNAVAILABLE` if formatter binary not found

---

### code.lint

Lint code with eslint, ruff, golangci-lint, or clippy. Auto-detects from config files. `fix=true` applies fixes (requires approval). Prefers JSON output format.

**Input:**
```json
{
  "paths": "string[] (optional) - Files or directories (default: project root)",
  "cwd": "string (optional) - Working directory",
  "linter": "string (default: auto) - eslint | ruff | golangci-lint | clippy | auto",
  "fix": "boolean (default: false) - Apply fixes (requires approval)",
  "dryRun": "boolean (default: false) - Preview only",
  "maxBytes": "number (default: 262144) - Output byte cap"
}
```

**Output:**
```json
{
  "linter": "string",
  "diagnostics": [
    {
      "file": "string",
      "line": "number",
      "column": "number",
      "endLine": "number?",
      "endColumn": "number?",
      "severity": "\"error\" | \"warning\" | \"info\"",
      "rule": "string?",
      "message": "string",
      "fixable": "boolean"
    }
  ],
  "counts": { "error": "number", "warning": "number", "info": "number" },
  "fixed": "string[]? - Files that were fixed (if fix=true)"
}
```

**Error code:** `UNAVAILABLE` if linter binary not found

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