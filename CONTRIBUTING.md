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

## Adding or changing a tool

1. Register the tool in `src/mcp/server.ts` with `server.registerTool(name, { description, inputSchema }, handler)`. Describe every input with zod so MCP clients can see what is expected.
2. Call `security.authorize('<tool name>', { ...details })` before doing anything with side effects, and return a denial result if it is not allowed. Put the command, path or other details in the call so allowlists and the approval prompt can see them.
3. If the tool runs commands, changes files or opens network access, add it to the default `security.requireApproval` list in `src/config/config.ts`.
4. Write to the audit log, and make sure secrets never reach it.
5. Add tests. Both the allowed and the denied paths matter.
6. Document it in the README or `docs/`.

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
