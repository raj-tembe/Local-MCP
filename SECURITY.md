# Security policy

Local-MCP is designed with a default-deny posture. Any operation that touches the local shell, filesystem, or user I/O must be approved by policy before it runs.

## Core rules

- Default mode is `ask`
- Disallowed commands are blocked before execution
- Filesystem access is bounded by allowlisted roots
- Remote transport requires explicit configuration and token usage
- All tool calls are written to an audit log with redaction for secrets

## Reporting

Please report vulnerabilities privately through the project maintainer or repository security reporting mechanism.

## Best practices

- Keep the default config in a user-owned home directory
- Rotate tokens when a relay or tunnel is changed
- Avoid running Local-MCP as root or administrator unless absolutely necessary
- Review `audit.jsonl` after each session
