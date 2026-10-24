# Tool reference

## Phase 1 — Read-only Intelligence (no approval required)

### Search & Filesystem
- `search.grep` – Regex content search across file tree (context lines, gitignore, binary detection)
- `fs.glob` – Find files matching glob pattern (POSIX paths)
- `fs.tree` – ASCII directory tree (depth control, truncation markers)
- `fs.diff` – Unified diff preview between two versions (read-only)

### Git
- `git.status` – Repository status (branch, upstream, staged/unstaged/untracked/conflicts)
- `git.diff` – Diff working tree, staged, or arbitrary refs (statOnly mode)
- `git.log` – Structured commit history (filter by path/author/date/grep)
- `git.show` – Commit metadata + patch, or file at revision
- `git.blame` – Line-by-line blame (author, date, commit SHA)

### Project & System
- `project.detect` – Languages, frameworks, package manager, scripts, entry points from manifests + census
- `env.list` – Environment variables (secrets always masked: *KEY*, *TOKEN*, *SECRET*, *PASSWORD*, *CREDENTIAL*, *_PAT*, *AUTH*)
- `port.check` – TCP port connectivity (best-effort PID/process name)

---

## Phase 2 — Mutation Tools (approval required by default)

All Phase 2 tools are in `security.requireApproval` by default. Use `dryRun: true` to preview without approval.

### Filesystem (write)
- `fs.edit` – Replace oldString with newString (unique match required unless replaceAll). Returns unified diff. Errors: AMBIGUOUS_MATCH, EXPECTED_MISMATCH.
- `fs.applyPatch` – Apply unified diff patch. Validates paths (no traversal), atomic temp+rename. Reports rejected hunks.
- `fs.move` – Move/rename file or directory. Fails with EEXIST unless overwrite.
- `fs.copy` – Copy file or directory (recursive). Fails with EEXIST unless overwrite.
- `fs.remove` – Remove file/directory. Defaults to OS trash (recycle bin on Windows, ~/.Trash on macOS, XDG on Linux). useTrash:false for permanent. Refuses unsafe paths (home, root, git repo root).

### Git (write)
- `git.add` – Stage files for commit.
- `git.commit` – Create commit. Refuses empty staged set (NOTHING_TO_COMMIT). No --no-verify (hooks run).
- `git.stash` – push, pop, list, drop, apply.
- `git.checkout` – Switch branches/restore files. force:true requires second confirmation.
- `git.branch` – list, create, delete, rename.

### Task & Code Quality
- `task.run` – Run script from package.json, Makefile, justfile, pyproject.toml, Cargo.toml. Returns structured test summary for vitest/jest/pytest/cargo test/go test.
- `code.format` – Format with prettier/black/ruff/gofmt/rustfmt. Auto-detects. check=true reports only.
- `code.lint` – Lint with eslint/ruff/golangci-lint/clippy. Auto-detects. fix=true applies fixes (requires approval).

---

## Existing Tools

### Terminal
- `terminal.create` – Create shell PTY session
- `terminal.write` – Send input to PTY
- `terminal.read` – Read PTY output
- `terminal.resize` – Resize PTY
- `terminal.kill` – Kill session
- `terminal.list` – Enumerate PTY sessions
- `terminal.exec` – Alias for shell.execute
- `shell.execute` – Execute one-shot shell command (approval required)

### User I/O
- `user.prompt` / `user.input` – Wait for user input
- `user.confirm` – Yes/no confirmation
- `user.notify` – Desktop notification
- `user.clipboard.read` – Read clipboard
- `user.clipboard.write` – Write clipboard
- `user.open_url` – Open URL in browser
- `user.stdout.write` – Write to stdout
- `user.stderr.write` – Write to stderr

### Filesystem (read)
- `fs.read` – Read file contents
- `fs.write` – Write file (approval required)
- `fs.list` – List directory entries
- `fs.stat` – File metadata
- `fs.search` – Search by name or content
- `fs.mkdir` – Create directory (approval required)

### Process
- `process.start` – Start background process (approval required)
- `process.list` – List background processes
- `process.logs` – Read process output
- `process.stop` – Stop process (and children)

### Code Execution
- `code.run` – Run snippet (python, javascript, typescript, bash, sh, ruby, go). Approval required.
- `package.install` – Install deps (npm, pnpm, yarn, bun, pip, uv, cargo, go). Approval required.
- `runtime.detect` – Detect installed runtimes and package managers

### System
- `system.info` – Basic system info (platform, arch, memory, etc.)

### Connectors
- `connectors.list` – List custom MCP connectors
- `connectors.add` – Add connector
- `connectors.remove` – Remove connector

### Resources
- `terminal://sessions/{id}`
- `fs://cwd`
- `system://info`

---

## Filtering & Approval

| Config | Purpose |
|--------|---------|
| `toolFilter.allowedTools` | Allowlist (exact tool names). If non-empty, only these available. |
| `toolFilter.deniedTools` | Denylist (exact tool names). Default: Phase 3 + destructive. |
| `security.requireApproval` | Tools prompting for interactive approval (payload-hash scoped). |
| `security.allowedCommands` | Spawn allowlist (binaries). |
| `security.deniedCommands` | Spawn denylist. |

**Default denied tools:** `shell.execute`, `terminal.write`, `fs.write`, `fs.mkdir`, `user.clipboard.write`, `repl.start`, `repl.eval`, `http.request`, `docker.exec`, `docker.compose`, `db.query`, `db.tables`

**Default approval tools:** `fs.write`, `shell.execute`, `code.run`, `package.install`, `process.start`, `fs.edit`, `fs.applyPatch`, `fs.move`, `fs.copy`, `fs.remove`, `git.add`, `git.commit`, `git.stash`, `git.checkout`, `git.branch`, `task.run`, `code.format`, `code.lint`