# Official MCP client compatibility notes

Researched against official documentation and locally installed CLIs on **2026-07-26**. These notes are implementation inputs, not a substitute for each vendor's current documentation.

Local versions used for CLI cross-checking:

| Client | Version |
| --- | --- |
| Claude Code | 2.1.210 |
| Codex CLI | 0.145.0 |
| Factory Droid | 0.180.0 |
| Amp | 0.0.1785055505-g9690ae |
| OpenCode | 1.15.10 |

## Compatibility matrix

| Client | Native config and scopes | MCP key / shape | Transports | Disable semantics | Notable portable fields |
| --- | --- | --- | --- | --- | --- |
| Claude Code | User and private local scope in `~/.claude.json`; shared project scope in `.mcp.json`. Precedence: local → project → user → plugins → claude.ai connectors. | `mcpServers.<name>` JSON. Stdio uses `command`, `args`, `env`; remote requires `type` plus `url`. | stdio, Streamable HTTP (`http` / `streamable-http`), legacy SSE, WebSocket | Per-project `disabledMcpServers` in `~/.claude.json`; `.mcp.json` approval is tracked separately. | `headers`, `headersHelper`, `timeout` (ms), `alwaysLoad`, OAuth metadata. `${VAR}` and `${VAR:-default}` expansion. |
| Codex | User `~/.codex/config.toml`; trusted project layers in `.codex/config.toml`, from repo root down to cwd. CLI/overrides → closest project → profile → user → system. | `[mcp_servers.<name>]` TOML. | stdio, Streamable HTTP | `enabled = false` in the server table. | `cwd`, `env`, `env_vars`, `http_headers`, `env_http_headers`, `bearer_token_env_var`, startup/tool timeouts in seconds, required, tool allow/deny lists and approval modes. |
| Factory Droid | User `~/.factory/mcp.json`; `.factory/mcp.json` at folder and project levels. User → folder → project. | `mcpServers.<name>` JSON. | stdio, Streamable HTTP, legacy SSE | `disabled: true`. A project toggle writes a user-level override rather than changing the shared file. | `enabledTools`, `disabledTools`, `timeoutMs`, `oauth`. `${VAR}` and `${VAR:-default}` expansion. Automatically reloads changed config. |
| Amp | User `~/.config/amp/settings.json[c]`; nearest workspace `.amp/settings.json[c]`. Workspace overrides user. CLI MCP config → settings → skill-provided MCP. | Literal JSON/JSONC key `"amp.mcpServers"`; entries use `command` or `url`. | stdio and remote URL with transport auto-detection | No documented per-server disabled field. Tool exposure can be reduced with `includeTools` or global tool-disable settings. | `args`, `env`, `headers`, `includeTools`. `${VAR}` expansion. Workspace servers require `amp mcp approve`. |
| OpenCode | Global `~/.config/opencode/opencode.json`; project `opencode.json`, plus custom, remote and managed layers. Config objects are merged; later layers override conflicting keys. | `mcp.<name>` JSON/JSONC. Local command is one array; remote uses `type: "remote"`. | local stdio and remote Streamable HTTP | `enabled: false`. | `cwd`, `environment`, `headers`, `timeout` (tool discovery, ms), `oauth`. `{env:VAR}` and `{file:path}` substitution. |

## Translation rules used by MCP Matrix

1. **Never copy native nodes directly.** Native data is normalized to command/URL, transport, args, cwd, env, headers, enabled state, timeout, and tool filters.
2. **Identity is separate from display name.** The UI groups equivalent endpoint/command identities even when clients use different names, and separately flags a reused name that points to different identities.
3. **Unknown fields stay untouched in existing target files.** Adding a server changes only that client's MCP subtree/table. Native-only source fields are reported instead of being silently invented on another client.
4. **Secrets stay server-side.** All environment/header values, URL credentials and query strings, and token-like arguments are redacted before data reaches the browser. OAuth token stores are out of scope.
5. **Environment references are syntax-aware.** Dollar references are converted to OpenCode's `{env:VAR}` form. Codex uses its explicit forwarding/header fields; unsupported aliases or templated strings block the plan rather than creating a config with different semantics.
6. **Timeout units and meanings are not assumed equivalent.** Claude and Droid tool-call milliseconds can map to Codex tool-call seconds. OpenCode's documented timeout is for fetching tools and Amp has no equivalent server field, so those copies warn and omit it.
7. **Legacy SSE is not upgraded by guessing.** A legacy SSE endpoint remains SSE where the target supports it. Codex and OpenCode targets are blocked.

## Official sources

- Claude Code: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- Codex: [Model Context Protocol](https://developers.openai.com/codex/mcp/) and [Config basics](https://developers.openai.com/codex/config-basic/)
- Factory Droid: [Model Context Protocol](https://docs.factory.ai/cli/configuration/mcp)
- Amp: [Owner's Manual — MCP and Configuration](https://ampcode.com/manual)
- OpenCode: [MCP servers](https://opencode.ai/docs/mcp-servers/) and [Config](https://opencode.ai/docs/config/)
- LobeHub Icons: [icon catalog](https://icons.lobehub.com/) and [`@lobehub/icons-static-svg`](https://www.npmjs.com/package/@lobehub/icons-static-svg)
- Visual reference: [Zed](https://zed.dev/)
