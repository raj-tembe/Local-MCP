# Contributing

Thanks for helping improve Local-MCP.

## Development setup

```bash
npm install
npm run build
npm test
```

## Code quality

- Keep TypeScript strict and explicit
- Prefer small, testable modules
- Never reduce the default safety posture
- Add tests for security-sensitive behavior

## Pull requests

- Include a focused summary
- Mention the security or user-consent implications
- Validate the relevant tests before submitting

## Releasing

Releases are built by `.github/workflows/release.yml` when a version tag is pushed:

```bash
npm version 0.2.0          # updates package.json and creates the v0.2.0 tag
git push --follow-tags
```

`npm version` also regenerates `src/version.ts` (the version reported to MCP clients and by `local-mcp --version`) and includes it in the release commit; a test fails if the two ever differ. The workflow checks that the tag matches `package.json`, runs the tests, builds and smoke-tests a standalone binary for each supported platform, and attaches the archives plus `SHA256SUMS.txt` to a GitHub Release (tags containing a `-`, such as `v0.2.0-rc.1`, are marked as pre-releases). Use "Run workflow" on the Actions page to build binaries without publishing a release.
