# MCP client compatibility notes

Researched against official documentation, upstream source, and locally installed CLIs on **2026-07-31**. These notes are implementation inputs, not a substitute for each vendor's current documentation.

Local versions used for CLI cross-checking:

| Client | Version |
| --- | --- |
| Claude Code | 2.1.210 |
| Codex CLI | 0.145.0 |
| Factory Droid | 0.180.0 |
| Amp | 0.0.1785055505-g9690ae |
| OpenCode | 1.15.10 |

Cursor was reviewed against its current official MCP and CLI documentation plus the public Cursor SDK and plugin sources; its closed-source editor runtime was not treated as an undocumented schema authority. Pi is intentionally not listed as a native MCP client: Pi core does not ship MCP. Its row below was source-reviewed against current Pi and [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) main; all MCP configuration behavior in that row belongs to the third-party extension.

## Compatibility matrix

| Client | Native config and scopes | MCP key / shape | Transports | Disable semantics | Notable portable fields |
| --- | --- | --- | --- | --- | --- |
| Claude Code | User and private local scope in `~/.claude.json`; shared project scope in `.mcp.json`. Precedence: local → project → user → plugins → claude.ai connectors. | `mcpServers.<name>` JSON. Stdio uses `command`, `args`, `env`; remote requires `type` plus `url`. | stdio, Streamable HTTP (`http` / `streamable-http`), legacy SSE, WebSocket | Per-project `disabledMcpServers` in `~/.claude.json`; `.mcp.json` approval is tracked separately. | `headers`, `headersHelper`, `timeout` (ms), `alwaysLoad`, OAuth metadata. `${VAR}` and `${VAR:-default}` expansion. |
| Codex | User `~/.codex/config.toml`; trusted project layers in `.codex/config.toml`, from repo root down to cwd. CLI/overrides → closest project → profile → user → system. | `[mcp_servers.<name>]` TOML. | stdio, Streamable HTTP | `enabled = false` in the server table. | `cwd`, `env`, `env_vars`, `http_headers`, `env_http_headers`, `bearer_token_env_var`, startup/tool timeouts in seconds, required, tool allow/deny lists and approval modes. |
| Factory Droid | User `~/.factory/mcp.json`; `.factory/mcp.json` at folder and project levels. User → folder → project. | `mcpServers.<name>` JSON. | stdio, Streamable HTTP, legacy SSE | `disabled: true`. A project toggle writes a user-level override rather than changing the shared file. | `enabledTools`, `disabledTools`, `timeoutMs`, `oauth`. `${VAR}` and `${VAR:-default}` expansion. Automatically reloads changed config. |
| Amp | User `~/.config/amp/settings.json[c]`; nearest workspace `.amp/settings.json[c]`. Workspace overrides user. CLI MCP config → settings → skill-provided MCP. | Literal JSON/JSONC key `"amp.mcpServers"`; entries use `command` or `url`. | stdio and remote URL with transport auto-detection | No documented per-server disabled field. Tool exposure can be reduced with `includeTools` or global tool-disable settings. | `args`, `env`, `headers`, `includeTools`. `${VAR}` expansion. Workspace servers require `amp mcp approve`. |
| OpenCode | Global `~/.config/opencode/opencode.json`; project `opencode.json`, plus custom, remote and managed layers. Config objects are merged; later layers override conflicting keys. | `mcp.<name>` JSON/JSONC. Local command is one array; remote uses `type: "remote"`. | local stdio and remote Streamable HTTP | `enabled: false`. | `cwd`, `environment`, `headers`, `timeout` (tool discovery, ms), `oauth`. `{env:VAR}` and `{file:path}` substitution. |
| Cursor | Global `~/.cursor/mcp.json`; nearest project `.cursor/mcp.json`. Cursor CLI documents project, global, and nested discovery but does not specify same-name field merging, so Matrix keeps layers separate and writes global only. | `mcpServers.<name>` JSON. Stdio uses `command`, `args`, `env`, and optional `envFile`; remote uses `url` and optional explicit `type`. | stdio, Streamable HTTP (`http`), legacy SSE (`sse`) | UI and `agent mcp enable/disable` manage a local approved list outside `mcp.json`; Matrix reports configuration presence only. | `cwd` in the public SDK config, `headers`, static OAuth `auth`, and `${env:VAR}` plus Cursor path interpolation. Unknown fields and `envFile` are preserved but not copied to other clients. |
| Pi via `pi-mcp-adapter` | Shared global `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`; Pi global `$PI_CODING_AGENT_DIR/mcp.json`; current workspace `.mcp.json` and `.pi/mcp.json`, in that precedence order. Same-name entries merge shallowly by field. | `mcpServers.<name>` JSON/JSONC; legacy `mcp-servers` is accepted. | stdio; remote URL probes Streamable HTTP then falls back to legacy SSE; adapter-specific `rmcp-mux` socket | `disabled: true`. | `cwd`, `env`, `headers`, `requestTimeoutMs`, `includeTools`, `excludeTools`, lifecycle/direct-tool options. `${VAR}`, `$env:VAR`, and `{env:VAR}` expansion. |

## Authentication capability matrix

"Automatic OAuth" below describes a native configuration policy, not the presence of a valid login session. Every client owns and stores its own OAuth session outside the MCP server declaration.

| Client | Automatic / managed OAuth | Environment-backed credentials | Pre-registered OAuth client | Matrix write behavior |
| --- | --- | --- | --- | --- |
| Claude Code | Automatic OAuth with server discovery; client registration metadata is supported in `oauth`. | `${VAR}` in headers. | Client metadata is native; client secrets are handled through Claude's credential flow rather than written into JSON. | Automatic OAuth, Bearer/custom environment headers, and safe client metadata. No `oauth: false`. |
| Codex | `auth = "oauth"` (default) or the client-managed `"chatgpt"` fallback; sessions live in Codex's credential store. | `bearer_token_env_var` and `env_http_headers`. | No documented per-server client ID/secret fields in `config.toml`. | Automatic OAuth, Bearer environment variable, and custom environment header. |
| Factory Droid | Automatic registration, including Factory's client metadata discovery support. | `${VAR}` in headers. | Native `oauth` object requires `authorizationServerIssuer` and `clientId`; literal client secrets are intentionally not accepted by Matrix. | Automatic OAuth, `oauth: false`, Bearer/custom environment headers, and safe client metadata. |
| Amp | Automatic OAuth; registration and sessions are managed by `amp mcp oauth login` outside `amp.mcpServers`. | `${VAR}` in headers. | Managed by the separate Amp OAuth command/store. | Automatic OAuth and Bearer/custom environment headers. |
| OpenCode | Automatic dynamic client registration and a separate MCP auth store. | `{env:VAR}` in headers and OAuth client fields. | Native `oauth` object with `clientId`, optional `clientSecret`, and `scope`. | Automatic OAuth, `oauth: false`, Bearer/custom environment headers, and environment-backed client metadata. |
| Cursor | Automatic OAuth with sessions managed by Cursor; `agent mcp login` starts the CLI flow. | `${env:VAR}` in command, args, env, URL, headers, and documented static OAuth values. | Native `auth` object with `CLIENT_ID`, optional environment-backed `CLIENT_SECRET`, and `scopes`. | Automatic OAuth, Bearer/custom environment headers, and safe static client metadata. No documented per-server no-auth field. |
| Pi via `pi-mcp-adapter` | URL-only challenge-based OAuth or explicit `auth: "oauth"`; sessions live outside the server declaration. `auth: false` / `oauth: false` disables it. | `bearerTokenEnv`, interpolated `bearerToken`, and interpolated headers. Matrix never executes the adapter's `!command` secret providers. | `oauth` object supports `clientId`, environment-backed `clientSecret`, space-delimited `scope`, and redirect/client metadata. | Automatic OAuth, explicit no-auth, Bearer/custom environment headers, and safe client metadata. |

An API-key fallback is provider-agnostic. For example, a URL-only Factory Droid entry can be reconciled to:

```json
{
  "type": "http",
  "url": "https://mcp.example.com/mcp",
  "oauth": false,
  "headers": {
    "Authorization": "Bearer ${MCP_API_TOKEN}"
  }
}
```

MCP Matrix never reads or migrates access tokens, refresh tokens, keychains, or agent session files. It also never puts a secret value in its browser payload; only field shape and environment-variable names are exposed.

## Translation rules used by MCP Matrix

1. **Never copy native nodes directly.** Native data is normalized to command/URL, transport, args, cwd, env, headers, authentication policy, enabled state, timeout, and tool filters.
2. **Identity is separate from display name.** The UI groups equivalent endpoint/command identities even when clients use different names, and separately flags a reused name that points to different identities.
3. **Unknown fields stay untouched in existing target files.** Adding a server changes only that client's MCP subtree/table; authentication reconciliation changes only auth-related fields. Native-only source fields are reported instead of being silently invented on another client.
4. **Secrets stay server-side.** All environment/header values, URL credentials and query strings, and token-like arguments are redacted before data reaches the browser. OAuth token stores are out of scope.
5. **Environment references are syntax-aware.** Dollar and Pi `$env:VAR` references are converted to OpenCode's `{env:VAR}` or Cursor's `${env:VAR}` form. Cursor-only path variables such as `${workspaceFolder}` are never reinterpreted as environment variables in another agent. Codex uses its explicit forwarding/header fields; unsupported aliases or templated strings block the plan rather than creating a config with different semantics.
6. **Timeout units and meanings are not assumed equivalent.** Claude, Droid, and Pi request milliseconds can map to Codex tool-call seconds. OpenCode's documented timeout is for fetching tools and Amp has no equivalent server field, so those copies warn and omit it.
7. **Legacy SSE is not upgraded by guessing.** A legacy SSE endpoint remains SSE where the target supports it. Codex and OpenCode targets are blocked; `pi-mcp-adapter` receives a URL and performs its documented HTTP/SSE probe.
8. **Pi extension-only features stay explicit.** Matrix reads the six standard `pi-mcp-adapter` files and their direct `mcpServers` entries. It does not expand compatibility `imports` or opt-in host discovery, execute `!command` secret providers, or distribute the adapter-specific socket transport. Pi copies always target its own global adapter file rather than shared inputs.
9. **Cursor application state stays client-owned.** Matrix reads global and nearest-project `mcp.json`, but writes only the global file. It does not synthesize enabled, approval, timeout, or tool-filter fields, inspect OAuth sessions, or manage Team, MDM, Marketplace, plugin, and cloud-agent definitions. URL-only remote entries remain usable in Cursor but need an explicit transport before cross-client distribution.

## Official sources

- Claude Code: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- Codex: [Model Context Protocol](https://developers.openai.com/codex/mcp/) and [Config basics](https://developers.openai.com/codex/config-basic/)
- Factory Droid: [Model Context Protocol](https://docs.factory.ai/cli/configuration/mcp)
- Amp: [Owner's Manual — MCP and Configuration](https://ampcode.com/manual)
- OpenCode: [MCP servers](https://opencode.ai/docs/mcp-servers/) and [Config](https://opencode.ai/docs/config/)
- Cursor: [Model Context Protocol](https://cursor.com/docs/mcp), [CLI MCP](https://cursor.com/docs/cli/mcp), [CLI installation](https://cursor.com/docs/cli/installation), and the public [`McpServerConfig`](https://github.com/cursor/plugins/blob/main/cursor-sdk/skills/cursor-sdk/references/mcp.md)
- Pi core: [coding-agent documentation](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) (documents that MCP is extension-provided)
- Pi extension: [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) configuration and OAuth documentation
- LobeHub Icons: [icon catalog](https://icons.lobehub.com/) and [`@lobehub/icons-static-svg`](https://www.npmjs.com/package/@lobehub/icons-static-svg)
- Visual reference: [Zed](https://zed.dev/)
