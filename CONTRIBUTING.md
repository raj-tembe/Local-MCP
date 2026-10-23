# Contributing to Local-MCP

Thanks for helping improve Local-MCP. Bug reports, ideas, documentation fixes, tests and code are all welcome, whether this is your first open source contribution or your hundredth.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security vulnerability, please do not open a public issue: follow the [security policy](SECURITY.md).

## Ways to contribute

- **Report a bug** or **suggest a feature** using the [issue templates](https://github.com/raj-tembe/Local-MCP/issues/new/choose). Good reports include your version (`local-mcp --version`), your operating system, how it is connected, and the steps to reproduce.
- **Try it on your platform.** Reports from macOS and Windows are especially welcome, as are tunnel and client setups that are not covered in the docs.
- **Improve the documentation.** The README, the `docs/` folder and the `examples/` folder are all fair game, including fixing anything that confused you.
- **Add tests.** Security-sensitive behaviour in particular is worth covering.
- **Build something.** New tools, safer defaults, better error messages and support for more package managers or languages.

Not sure where to start? Look for issues labelled `good first issue` or `help wanted`. For anything larger than a small fix, please open an issue or comment on an existing one first so we can agree on the approach before you invest time in it.

## Development setup

You need Node.js 20 or newer.

```bash
git clone https://github.com/raj-tembe/Local-MCP.git
cd Local-MCP
npm install
npm run build      # compiles TypeScript, which also type-checks the project
npm test           # runs the test suite
```

`node-pty`, which provides PTY terminal sessions, is an optional native dependency. If it cannot be built on your machine, `npm install` still succeeds and everything except the `terminal.*` tools works; the tests that need it are skipped.

Useful commands:

```bash
npm run dev -- start --transport http --port 8080   # run from source (no build needed)
npx vitest run src/exec                              # run one folder or file of tests
npm run build:binary                                 # build a standalone binary for this machine
npm run smoke:binary -- dist-bin/<your-binary>       # smoke test a built binary
```

Tests that touch `~/.local-mcp` (approvals, audit log, config) should point `HOME` at a temporary directory so they never read or change your real settings. `src/mcp/server.exec.test.ts` shows the pattern.

## Where things live

| Path | What is in it |
|------|---------------|
| `src/mcp/server.ts` | The MCP server, tool registration and the HTTP transport |
| `src/tools/` | Tool implementations (Phase 1: search, fs, git, project, env, port) |
| `src/security/` | Permission checks, approval prompts and the stored approvals |
| `src/config/` | Configuration schema, defaults, config files and environment variables |
| `src/exec/` | Running code snippets and installing dependencies |
| `src/process/` | Background processes started with `process.start` |
| `src/terminal/` | PTY terminal sessions |
| `src/audit/` | The audit log |
| `scripts/` | Binary build and smoke test scripts |
| `docs/` | Configuration, cloud and tool reference |
| `examples/` | Tunnel and client examples |

Tests live next to the code they cover, in `*.test.ts` files.

New tools should be placed in `src/tools/` (one file per namespace: `search.ts`, `fs.ts`, `git.ts`, `project.ts`, `env.ts`, `port.ts`) and imported in `server.ts`.

## Adding or changing a tool

1. Create the tool implementation in `src/tools/<namespace>.ts` (e.g. `src/tools/search.ts` for `search.grep`, `fs.glob`). Export async functions that take `(config, security, audit, sessionId)` and return structured results.
2. Register the tool in `src/mcp/server.ts` with `server.registerTool(name, { description, inputSchema }, handler)`. Describe every input with zod so MCP clients can see what is expected. Use the `namespace.verb` naming convention.
3. Call `security.authorize('<tool name>', { ...details })` before doing anything with side effects, and return a denial result if not allowed. Put the command, path, or other details in the call so allowlists and the approval prompt can see them.
4. If the tool runs commands, changes files, or opens network access, add it to the default `security.requireApproval` list in `src/config/config.ts`. Phase 1 read-only tools do not need approval.
5. Write to the audit log via `audit.log({ timestamp, sessionId, tool, decision, result })`. Never log file contents, env values, request bodies, SQL parameters, or clipboard contents — log hashes and byte counts only.
6. Respect output caps: support `maxBytes` parameter (default 256 KB), truncate at safe boundaries (line/record), set `truncated: true` when capped.
7. Use `runProcess` from `src/exec/run.ts` for spawning — it handles timeout, output capping, and process-tree kill.
8. Expand `~` in paths using `expandPath` helper; accept `cwd` for relative resolution.
9. For search/list/tree tools: respect `.gitignore` by default, expose `respectGitignore?: boolean` (default `true`).
10. For tools that could write: accept `dryRun?: boolean` (default `false`) and return the diff it would apply.
11. Return structured JSON results (objects, not raw strings). Human-readable text goes in a `text`/`diff`/`stdout` field inside the object.
12. Errors: return `{ error: { code, message, detail? } }` with stable codes (`ENOENT`, `EACCES`, `NOT_A_REPO`, `TIMEOUT`, `UNAVAILABLE`, `REJECTED_BY_POLICY`, `APPROVAL_DENIED`, `APPROVAL_TIMEOUT`). Do not throw across the MCP boundary.
13. Add tests: happy path, error paths (`ENOENT`, `NOT_A_REPO`, `UNAVAILABLE`, `REJECTED_BY_POLICY`), truncation test, policy test (denied tool, approval-gated tool with hash-scoped approval).
14. Document it in `tools.md` and update the README tools table.

## Code quality

- Keep TypeScript strict and explicit
- Prefer small, testable modules
- Never reduce the default safety posture
- Add tests for security-sensitive behaviour

## Commits and pull requests

- Commit messages in the style `feat: ...`, `fix: ...`, `docs: ...` or `chore: ...` are preferred, but not required
- Keep each pull request focused on one change
- Fill in the pull request template, including the security and consent section
- Make sure `npm run build` and `npm test` pass; CI runs the same commands
- Mention the security or user-consent implications of the change
- Be patient and kind in review, in both directions. Maintainers are volunteers.

## Releasing

Releases are built by `.github/workflows/release.yml` when a version tag is pushed:

```bash
npm version patch          # or minor / major: updates package.json and creates the version tag
git push --follow-tags
```

`npm version` also regenerates `src/version.ts` (the version reported to MCP clients and by `local-mcp --version`) and includes it in the release commit; a test fails if the two ever differ. The workflow checks that the tag matches `package.json`, runs the tests, builds and smoke-tests a standalone binary for each supported platform, and attaches the archives plus `SHA256SUMS.txt` to a GitHub Release (tags containing a `-`, such as `v0.3.0-rc.1`, are marked as pre-releases). Use "Run workflow" on the Actions page to build binaries without publishing a release.
