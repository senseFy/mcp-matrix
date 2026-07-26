# Security policy

MCP Matrix reads and writes local coding-agent configuration files. Security reports involving credential exposure, path handling, unsafe writes, request forgery, or configuration corruption are especially important.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/senseFy/mcp-matrix/security/advisories/new). Do not include secrets, private configuration, or an unpatched exploit in a public issue.

Include the affected version, operating system, reproduction steps, impact, and any suggested mitigation. You should receive an acknowledgement within seven days. Please allow time for a fix before public disclosure.

## Supported versions

Security fixes are applied to the latest release on the default branch. This project is currently pre-1.0; older snapshots may not receive patches.

## Security boundary

MCP Matrix is not an MCP proxy or runtime. It never starts MCP servers, handles MCP traffic, reads keychains, or manages OAuth sessions. Native agent configuration remains the source of truth.
