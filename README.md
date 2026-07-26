# MCP Matrix

A local-first MCP configuration manager for coding agents.

MCP Matrix reads each supported agent's native configuration, normalizes only the portable MCP fields, and lets you preview a native diff before copying a server to another agent.

> Configuration, not connection. MCP Matrix does not proxy or run MCP traffic.

## Product boundary

MCP Matrix is deliberately **not** an MCP proxy, gateway, registry, or runtime.

- Agent-owned config files remain the source of truth.
- MCP traffic never passes through this app.
- MCP servers are never started by this app.
- OAuth credentials and keychains are never read or copied.
- Config values that look sensitive are redacted in the browser and diffs.
- The local HTTP server binds only to `127.0.0.1`; mutation requests require a per-process token.
- Writes use stale-file checks, adjacent atomic renames, local backups, and one-step undo.

## Supported agents

- Claude Code
- OpenAI Codex
- Factory Droid
- Amp
- OpenCode

See [the official-client compatibility notes](docs/official-client-matrix.md) for the exact native formats and documented limitations.

## Run locally

Requires Node.js 20.19 or newer.

```bash
git clone https://github.com/senseFy/mcp-matrix.git
cd mcp-matrix
npm install
npm run dev
```

Open <http://127.0.0.1:4318>. The workspace field controls which project-scoped config layers are discovered. User-level config is always included.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

## Current safety constraints

- Distribution currently targets **user scope** only. Project, folder, and workspace layers are read and explained, but are not write targets yet.
- Existing target entries are never overwritten. Remove or reconcile them explicitly before distributing another definition.
- Literal token-like environment values, authorization headers, credential-bearing URLs, and token arguments are read-only: copy plans require a portable environment/file reference instead of duplicating the credential.
- Legacy SSE cannot be copied to Codex or OpenCode because neither current native schema exposes an explicit legacy SSE transport.
- An environment reference is copied to Codex only when its native `env_vars`, `env_http_headers`, or `bearer_token_env_var` representation preserves the same meaning.
- Factory Droid currently has no dedicated LobeHub icon. The UI uses LobeHub's neutral `MCP` icon as an explicit fallback rather than importing a logo from another source.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) before changing an adapter or write path. Please report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/senseFy/mcp-matrix/security/advisories/new), not a public issue; details are in [SECURITY.md](SECURITY.md).

## License and trademarks

MCP Matrix is released under the [MIT License](LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

MCP Matrix is an independent project and is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, Factory, Sourcegraph, OpenCode, or LobeHub. Product names, logos, and trademarks belong to their respective owners.
