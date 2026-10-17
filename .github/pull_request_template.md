## Summary

<!-- What does this change and why? -->

Fixes #<!-- issue number, or delete this line -->

## Type of change

- [ ] Bug fix
- [ ] New feature or tool
- [ ] Documentation
- [ ] Refactor or maintenance
- [ ] CI or release

## How was it tested?

<!-- The commands you ran and the platforms you tried, for example `npm test` on Linux. -->

## Security and consent

Local-MCP lets an AI act on a real machine, so please check these. Tick "not applicable" for changes that do not affect behaviour, such as docs.

- [ ] This does not weaken a default (default mode `ask`, command allowlist, path restrictions, approval requirements)
- [ ] Any new tool that runs commands, changes files or opens network access goes through `security.authorize(...)` and is listed in `security.requireApproval`
- [ ] No secrets, tokens or private paths are logged or written to the audit log
- [ ] Not applicable

## Checklist

- [ ] `npm run build` and `npm test` pass locally
- [ ] I added or updated tests for the change
- [ ] I updated the docs (README or `docs/`) if behaviour or configuration changed
- [ ] I have read [CONTRIBUTING.md](https://github.com/raj-tembe/Local-MCP/blob/main/CONTRIBUTING.md) and agree to follow the [Code of Conduct](https://github.com/raj-tembe/Local-MCP/blob/main/CODE_OF_CONDUCT.md)
