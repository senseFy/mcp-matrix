# MCP Matrix

A local-first MCP configuration manager for coding agents.

MCP Matrix reads each supported agent's native configuration, normalizes portable MCP and authentication fields, and lets you preview a native diff before copying a server or changing its authentication policy.

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

## Install

Requires Node.js 20.19 or newer.

```bash
npm install --global @sensef/mcp-matrix
mcp-matrix
```

Open <http://127.0.0.1:4318>. Run the command from the project whose scoped MCP configuration you want to inspect. Use `mcp-matrix --port 4400` when the default port is occupied.

You can also run it without a global install:

```bash
npx @sensef/mcp-matrix
```

## Develop from source

```bash
git clone https://github.com/senseFy/mcp-matrix.git
cd mcp-matrix
npm install
npm run dev
```

The workspace field controls which project-scoped config layers are discovered. User-level config is always included.

## How MCP identities are grouped

MCP Matrix keeps three deliberately separate fingerprints:

- **Family** groups related definitions for navigation, such as GitKraken client-specific launch arguments or Supabase project endpoints.
- **Exact identity** represents the complete command plus arguments, or the complete remote URL. Copy, duplicate, and name-conflict checks always use this level.
- **Config** also includes portable options such as authentication policy, environment keys, headers, enabled state, timeouts, and tool filters.

A family can therefore contain multiple exact variants. MCP Matrix shows them together so the relationship is visible, but never assumes that variants are interchangeable and never overwrites one with another. Remote query values remain hidden; only parameter names and a process-local equality fingerprint are shown.

## Authentication management

For remote servers, the inspector shows the authentication policy represented by the native config. It does **not** claim that the agent is currently authenticated: login sessions, access tokens, refresh tokens, keychains, and agent credential stores remain private to each agent.

Depending on the target agent's native schema, MCP Matrix can preview and apply:

- automatic OAuth, which still requires a separate login in each agent;
- a Bearer token sourced from a named environment variable;
- a custom credential header sourced from a named environment variable;
- explicit `oauth: false` where the agent supports it; and
- safe pre-registered OAuth client metadata where it is natively configurable.

There are no token or client-secret value inputs. MCP Matrix writes environment-variable references only where the agent documents a native representation. The variable itself must be available in the environment that launches the coding agent.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

## Current safety constraints

- Distribution currently targets **user scope** only. Project, folder, and workspace layers are read and explained, but are not write targets yet.
- Existing target entries are never overwritten by distribution. Authentication reconciliation changes only the selected entry's native authentication fields after a separate diff preview.
- Literal token-like environment values, authorization headers, credential-bearing URLs, and token arguments are read-only: copy plans require a portable environment/file reference instead of duplicating the credential.
- Legacy SSE cannot be copied to Codex or OpenCode because neither current native schema exposes an explicit legacy SSE transport.
- An environment reference is copied to Codex only when its native `env_vars`, `env_http_headers`, or `bearer_token_env_var` representation preserves the same meaning.
- Factory Droid currently has no dedicated LobeHub icon. The UI uses LobeHub's neutral `MCP` icon as an explicit fallback rather than importing a logo from another source.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) before changing an adapter or write path. Please report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/senseFy/mcp-matrix/security/advisories/new), not a public issue; details are in [SECURITY.md](SECURITY.md).

## License and trademarks

MCP Matrix is released under the [MIT License](LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

MCP Matrix is an independent project and is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, Factory, Sourcegraph, OpenCode, or LobeHub. Product names, logos, and trademarks belong to their respective owners.
