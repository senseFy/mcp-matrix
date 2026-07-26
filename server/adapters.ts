import { readFile } from 'node:fs/promises';

import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';

import type { AgentId, SnapshotIssue, TransportKind } from '../src/types';
import {
  buildFingerprints,
  buildOccurrenceId,
  looksLikeLiteralSecret,
  parsePureEnvironmentReference,
  sha256,
  type RawMcpOccurrence,
  type RawTransport,
} from './domain';
import { discoverConfigSources, type NativeConfigSource } from './discovery';

type UnknownRecord = Record<string, unknown>;

export interface NativeSnapshot {
  occurrences: RawMcpOccurrence[];
  issues: SnapshotIssue[];
  sources: NativeConfigSource[];
}

export interface NativeSerialization {
  spec?: UnknownRecord;
  warnings: string[];
  errors: string[];
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined;
  return value as string[];
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record).filter((entry): entry is [string, string] => {
    return typeof entry[1] === 'string';
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function parseJsonDocument(content: string): { data?: UnknownRecord; error?: string } {
  const errors: ParseError[] = [];
  const data = parseJsonc(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length) {
    return { error: `JSON/JSONC parse error at offset ${errors[0].offset}` };
  }
  const record = asRecord(data);
  return record ? { data: record } : { error: 'Top-level configuration must be an object' };
}

function transportKindFromType(
  agentId: Exclude<AgentId, 'codex' | 'opencode'>,
  type: string | undefined,
  url: string | undefined,
): TransportKind {
  if (!url) return 'stdio';
  if (type === 'sse') return 'sse';
  if (type === 'ws' || type === 'websocket') return agentId === 'claude' ? 'websocket' : 'unknown';
  if (type === 'http' || type === 'streamable-http') return 'http';
  if (agentId === 'amp' && !type) return /\/sse\/?(?:[?#].*)?$/i.test(url) ? 'sse' : 'http';
  return 'unknown';
}

function normalizeJsonSpec(
  agentId: Exclude<AgentId, 'codex' | 'opencode'>,
  source: NativeConfigSource,
  name: string,
  spec: UnknownRecord,
  fileHash: string,
  enabled: boolean,
): RawMcpOccurrence {
  const type = asString(spec.type);
  const url = asString(spec.url);
  const transport: RawTransport = {
    kind: transportKindFromType(agentId, type, url),
    command: asString(spec.command),
    args: asStringArray(spec.args),
    cwd: asString(spec.cwd),
    url,
    env: asStringRecord(spec.env),
    headers: asStringRecord(spec.headers),
  };
  const warnings: string[] = [];
  if (transport.kind === 'stdio' && !transport.command) {
    transport.kind = 'unknown';
    warnings.push('Missing command for a stdio server.');
  }
  if (url && transport.kind === 'unknown') {
    warnings.push(
      agentId === 'claude'
        ? 'Remote Claude Code servers require type: http, sse, or ws.'
        : 'Remote Droid servers require type: http or sse.',
    );
  }
  if (transport.kind !== 'stdio' && transport.kind !== 'unknown' && !transport.url) {
    transport.kind = 'unknown';
    warnings.push('Missing URL for a remote server.');
  }
  if (agentId === 'amp' && url) {
    warnings.push('Amp auto-detects the remote transport from the endpoint.');
  }

  const timeoutMs =
    agentId === 'droid' ? asNumber(spec.timeoutMs) : agentId === 'claude' ? asNumber(spec.timeout) : undefined;
  const includeTools =
    agentId === 'droid'
      ? asStringArray(spec.enabledTools)
      : agentId === 'amp'
        ? asStringArray(spec.includeTools)
        : undefined;
  const excludeTools = agentId === 'droid' ? asStringArray(spec.disabledTools) : undefined;
  const portable = { transport, enabled, timeoutMs, includeTools, excludeTools };
  const fingerprints = buildFingerprints(transport, portable);

  return {
    occurrenceId: buildOccurrenceId(agentId, source.path, source.scope, name),
    agentId,
    name,
    transport,
    enabled,
    timeoutMs,
    includeTools,
    excludeTools,
    ...fingerprints,
    source: {
      scope: source.scope,
      path: source.path,
      hash: fileHash,
      effective: false,
      precedence: source.precedence,
    },
    warnings,
    native: spec,
  };
}

function normalizeOpenCodeSpec(
  source: NativeConfigSource,
  name: string,
  spec: UnknownRecord,
  fileHash: string,
): RawMcpOccurrence {
  const type = asString(spec.type);
  const command = asStringArray(spec.command);
  const url = asString(spec.url);
  const transport: RawTransport = {
    kind: type === 'local' ? 'stdio' : type === 'remote' ? 'http' : 'unknown',
    command: command?.[0],
    args: command?.slice(1),
    cwd: asString(spec.cwd),
    url,
    env: asStringRecord(spec.environment),
    headers: asStringRecord(spec.headers),
  };
  const warnings: string[] = [];
  if (type === 'local' && !command?.length) warnings.push('Missing command array for a local server.');
  if (type === 'remote' && !url) warnings.push('Missing URL for a remote server.');
  if (!type) warnings.push('This layer is a partial OpenCode override; transport comes from a lower layer.');
  const enabled = asBoolean(spec.enabled) !== false;
  const discoveryTimeout = asNumber(spec.timeout);
  if (discoveryTimeout !== undefined) {
    warnings.push('OpenCode timeout controls initial tool discovery and is not a portable tool-call timeout.');
  }
  const portable = { transport, enabled };
  const fingerprints = buildFingerprints(transport, portable);

  return {
    occurrenceId: buildOccurrenceId('opencode', source.path, source.scope, name),
    agentId: 'opencode',
    name,
    transport,
    enabled,
    timeoutMs: undefined,
    ...fingerprints,
    source: {
      scope: source.scope,
      path: source.path,
      hash: fileHash,
      effective: false,
      precedence: source.precedence,
    },
    warnings,
    native: spec,
  };
}

function normalizeCodexSpec(
  source: NativeConfigSource,
  name: string,
  spec: UnknownRecord,
  fileHash: string,
): RawMcpOccurrence {
  const command = asString(spec.command);
  const url = asString(spec.url);
  const env = asStringRecord(spec.env) ?? {};
  const envVars = Array.isArray(spec.env_vars) ? spec.env_vars : [];
  const warnings: string[] = [];
  for (const entry of envVars) {
    if (typeof entry === 'string') env[entry] = `\${${entry}}`;
    else {
      const record = asRecord(entry);
      const name = asString(record?.name);
      const sourceName = asString(record?.source);
      if (name && (!sourceName || sourceName === 'local')) env[name] = `\${${name}}`;
      else if (name && sourceName === 'remote') {
        warnings.push(`Remote-executor environment variable ${name} is client-specific and was omitted.`);
      }
    }
  }

  const headers = asStringRecord(spec.http_headers) ?? {};
  for (const [header, environmentName] of Object.entries(asStringRecord(spec.env_http_headers) ?? {})) {
    headers[header] = `\${${environmentName}}`;
  }
  const bearer = asString(spec.bearer_token_env_var);
  if (bearer) headers.Authorization = `Bearer \${${bearer}}`;

  const transport: RawTransport = {
    kind: command ? 'stdio' : url ? 'http' : 'unknown',
    command,
    args: asStringArray(spec.args),
    cwd: asString(spec.cwd),
    url,
    env: Object.keys(env).length ? env : undefined,
    headers: Object.keys(headers).length ? headers : undefined,
  };
  if (transport.kind === 'unknown') warnings.push('Codex server needs either command or url.');
  if (source.scope === 'project') {
    warnings.push('Codex loads project-scoped MCP configuration only for trusted projects.');
  }
  const timeoutSeconds = asNumber(spec.tool_timeout_sec);
  const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1_000;
  const includeTools = asStringArray(spec.enabled_tools);
  const excludeTools = asStringArray(spec.disabled_tools);
  const enabled = asBoolean(spec.enabled) !== false;
  const portable = { transport, enabled, timeoutMs, includeTools, excludeTools };
  const fingerprints = buildFingerprints(transport, portable);

  return {
    occurrenceId: buildOccurrenceId('codex', source.path, source.scope, name),
    agentId: 'codex',
    name,
    transport,
    enabled,
    timeoutMs,
    includeTools,
    excludeTools,
    ...fingerprints,
    source: {
      scope: source.scope,
      path: source.path,
      hash: fileHash,
      effective: false,
      precedence: source.precedence,
    },
    warnings,
    native: spec,
  };
}

function jsonServersForSource(source: NativeConfigSource, data: UnknownRecord): UnknownRecord {
  if (source.agentId === 'amp') return asRecord(data['amp.mcpServers']) ?? {};
  if (source.agentId === 'opencode') return asRecord(data.mcp) ?? {};
  if (source.agentId === 'claude' && source.selector === 'claude-local') {
    const project = asRecord(asRecord(data.projects)?.[source.projectKey ?? '']);
    return asRecord(project?.mcpServers) ?? {};
  }
  return asRecord(data.mcpServers) ?? {};
}

async function parseSource(
  source: NativeConfigSource,
): Promise<{ occurrences: RawMcpOccurrence[]; issue?: SnapshotIssue }> {
  let content: string;
  try {
    content = await readFile(source.path, 'utf8');
  } catch (error) {
    return {
      occurrences: [],
      issue: {
        agentId: source.agentId,
        path: source.path,
        message: error instanceof Error ? error.message : 'Unable to read configuration.',
      },
    };
  }
  const fileHash = sha256(content);

  if (source.agentId === 'codex') {
    try {
      const data = asRecord(parseToml(content)) ?? {};
      const servers = asRecord(data.mcp_servers) ?? {};
      return {
        occurrences: Object.entries(servers)
          .filter((entry): entry is [string, UnknownRecord] => Boolean(asRecord(entry[1])))
          .map(([name, spec]) => normalizeCodexSpec(source, name, asRecord(spec)!, fileHash)),
      };
    } catch (error) {
      return {
        occurrences: [],
        issue: {
          agentId: source.agentId,
          path: source.path,
          message: error instanceof Error ? error.message : 'Unable to parse TOML configuration.',
        },
      };
    }
  }

  const parsed = parseJsonDocument(content);
  if (!parsed.data) {
    return {
      occurrences: [],
      issue: {
        agentId: source.agentId,
        path: source.path,
        message: parsed.error ?? 'Unable to parse configuration.',
      },
    };
  }

  const servers = jsonServersForSource(source, parsed.data);
  const jsonAgentId = source.agentId;
  const disabledClaudeNames =
    jsonAgentId === 'claude'
      ? new Set(
          asStringArray(
            asRecord(asRecord(parsed.data.projects)?.[source.projectKey ?? ''])?.disabledMcpServers,
          ) ?? [],
        )
      : new Set<string>();

  const occurrences = Object.entries(servers)
    .filter((entry): entry is [string, UnknownRecord] => Boolean(asRecord(entry[1])))
    .map(([name, rawSpec]) => {
      const spec = asRecord(rawSpec)!;
      if (jsonAgentId === 'opencode') return normalizeOpenCodeSpec(source, name, spec, fileHash);
      const enabled =
        jsonAgentId === 'droid'
          ? asBoolean(spec.disabled) !== true
          : jsonAgentId === 'claude'
            ? !disabledClaudeNames.has(name)
            : true;
      return normalizeJsonSpec(jsonAgentId, source, name, spec, fileHash, enabled);
    });
  return { occurrences };
}

function markEffective(occurrences: RawMcpOccurrence[]): void {
  const grouped = new Map<string, RawMcpOccurrence[]>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.agentId}:${occurrence.name}`;
    const values = grouped.get(key) ?? [];
    values.push(occurrence);
    grouped.set(key, values);
  }
  for (const values of grouped.values()) {
    values.sort((left, right) => right.source.precedence - left.source.precedence);
    values[0].source.effective = true;
  }
}

function deepMerge(left: UnknownRecord, right: UnknownRecord): UnknownRecord {
  const output: UnknownRecord = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const previous = asRecord(output[key]);
    const next = asRecord(value);
    output[key] = previous && next ? deepMerge(previous, next) : value;
  }
  return output;
}

function mergeLayeredOccurrences(occurrences: RawMcpOccurrence[]): RawMcpOccurrence[] {
  const groups = new Map<string, RawMcpOccurrence[]>();
  for (const occurrence of occurrences) {
    if (occurrence.agentId !== 'opencode' && occurrence.agentId !== 'codex') continue;
    const key = `${occurrence.agentId}\0${occurrence.name}`;
    const values = groups.get(key) ?? [];
    values.push(occurrence);
    groups.set(key, values);
  }
  const replacements = new Map<string, RawMcpOccurrence>();
  for (const values of groups.values()) {
    if (values.length < 2) continue;
    values.sort((left, right) => left.source.precedence - right.source.precedence);
    const merged = values.reduce<UnknownRecord>(
      (result, occurrence) => deepMerge(result, occurrence.native),
      {},
    );
    const highest = values.at(-1)!;
    const source: NativeConfigSource = {
      agentId: highest.agentId,
      path: highest.source.path,
      scope: highest.source.scope,
      precedence: highest.source.precedence,
    };
    const normalized =
      highest.agentId === 'opencode'
        ? normalizeOpenCodeSpec(source, highest.name, merged, highest.source.hash)
        : normalizeCodexSpec(source, highest.name, merged, highest.source.hash);
    normalized.warnings.unshift(
      `Effective entry merges ${values.length} ${
        highest.agentId === 'opencode' ? 'OpenCode JSON' : 'Codex TOML'
      } configuration layers.`,
    );
    replacements.set(highest.occurrenceId, normalized);
  }
  return occurrences.map((occurrence) => replacements.get(occurrence.occurrenceId) ?? occurrence);
}

export async function loadNativeSnapshot(workspace: string): Promise<NativeSnapshot> {
  const sources = await discoverConfigSources(workspace);
  const parsed = await Promise.all(sources.map(parseSource));
  const occurrences = mergeLayeredOccurrences(parsed.flatMap((result) => result.occurrences));
  markEffective(occurrences);
  return {
    occurrences,
    issues: parsed.flatMap((result) => (result.issue ? [result.issue] : [])),
    sources,
  };
}

function replaceReferences(
  value: string,
  target: 'dollar' | 'amp' | 'opencode',
  warnings: string[],
  errors: string[],
): string {
  if (target === 'dollar' || target === 'amp') {
    if (/\{file:[^}]+\}/.test(value)) {
      errors.push('OpenCode {file:...} references have no portable equivalent in the target agent.');
    }
    if (target === 'amp' && /\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}/.test(value)) {
      errors.push('Amp does not document support for ${VAR:-default} references.');
    }
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}');
  }
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, defaultValue: string | undefined) => {
      if (defaultValue !== undefined) {
        errors.push(`OpenCode cannot preserve the default value in \${${name}:-${defaultValue}}.`);
      }
      return `{env:${name}}`;
    },
  );
}

function mapStringRecord(
  values: Record<string, string> | undefined,
  transform: (value: string) => string,
): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, transform(value)]));
}

function applyPortableExtras(
  target: AgentId,
  source: RawMcpOccurrence,
  spec: UnknownRecord,
  warnings: string[],
): void {
  if (!source.enabled) {
    if (target === 'droid') spec.disabled = true;
    else if (target === 'codex' || target === 'opencode') spec.enabled = false;
    else warnings.push(`${target === 'claude' ? 'Claude Code' : 'Amp'} stores disable state outside this server entry; the new server will be enabled.`);
  }

  if (source.timeoutMs !== undefined) {
    if (target === 'claude') spec.timeout = source.timeoutMs;
    else if (target === 'droid') spec.timeoutMs = source.timeoutMs;
    else if (target === 'codex') spec.tool_timeout_sec = source.timeoutMs / 1_000;
    else warnings.push(`${target === 'opencode' ? 'OpenCode timeout controls tool discovery' : 'Amp has no equivalent timeout field'}; the source tool-call timeout was omitted.`);
  }

  if (source.includeTools?.length) {
    if (target === 'droid') spec.enabledTools = source.includeTools;
    else if (target === 'codex') spec.enabled_tools = source.includeTools;
    else if (target === 'amp') spec.includeTools = source.includeTools;
    else warnings.push('The source tool allowlist has no equivalent per-server field and was omitted.');
  }
  if (source.excludeTools?.length) {
    if (target === 'droid') spec.disabledTools = source.excludeTools;
    else if (target === 'codex') spec.disabled_tools = source.excludeTools;
    else warnings.push('The source tool denylist has no equivalent per-server field and was omitted.');
  }
}

const mappedNativeKeys: Record<AgentId, Set<string>> = {
  claude: new Set(['type', 'command', 'args', 'cwd', 'url', 'env', 'headers', 'timeout']),
  codex: new Set([
    'command',
    'args',
    'cwd',
    'url',
    'env',
    'env_vars',
    'bearer_token_env_var',
    'http_headers',
    'env_http_headers',
    'enabled',
    'tool_timeout_sec',
    'enabled_tools',
    'disabled_tools',
  ]),
  droid: new Set([
    'type',
    'command',
    'args',
    'url',
    'env',
    'headers',
    'disabled',
    'enabledTools',
    'disabledTools',
    'timeoutMs',
  ]),
  amp: new Set(['command', 'args', 'url', 'env', 'headers', 'includeTools']),
  opencode: new Set(['type', 'command', 'cwd', 'url', 'environment', 'headers', 'enabled']),
};

function warnAboutClientSpecificFields(source: RawMcpOccurrence, warnings: string[]): void {
  const omitted = Object.keys(source.native).filter((key) => !mappedNativeKeys[source.agentId].has(key));
  if (omitted.length) {
    warnings.push(`Client-specific fields were not copied: ${omitted.sort().join(', ')}.`);
  }
}

function isReferenceBacked(value: string): boolean {
  return /^(?:(?:Bearer|Basic|token)\s+)?(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{env:[A-Za-z_][A-Za-z0-9_]*\}|\{file:[^}]+\})$/i.test(
    value,
  );
}

function rejectLiteralSecrets(source: RawMcpOccurrence, errors: string[]): void {
  for (const [key, value] of Object.entries(source.transport.env ?? {})) {
    if (looksLikeLiteralSecret(key, value) && !isReferenceBacked(value)) {
      errors.push(`Environment value ${key} looks like a literal secret; use an environment reference before copying.`);
    }
  }
  for (const [key, value] of Object.entries(source.transport.headers ?? {})) {
    if (looksLikeLiteralSecret(key, value) && !isReferenceBacked(value)) {
      errors.push(`HTTP header ${key} looks like a literal secret; use an environment reference before copying.`);
    }
  }
  const args = source.transport.args ?? [];
  for (const [index, value] of args.entries()) {
    const previous = args[index - 1] ?? '';
    if (
      (/token|secret|password|passwd|api[_-]?key|credential/i.test(previous) ||
        /(?:token|secret|password|passwd|api[_-]?key|credential)\s*=/i.test(value) ||
        looksLikeLiteralSecret('', value)) &&
      !isReferenceBacked(value)
    ) {
      errors.push('A command argument looks like a literal secret; use an environment reference before copying.');
      break;
    }
  }
  if (source.transport.url) {
    try {
      const url = new URL(source.transport.url);
      const secretQuery = [...url.searchParams].some(
        ([key, value]) => looksLikeLiteralSecret(key, value) && !isReferenceBacked(value),
      );
      if (url.username || url.password || secretQuery) {
        errors.push('The server URL contains literal credentials or a token-like query parameter.');
      }
    } catch {
      // Templated URLs are validated by the target reference converter.
    }
  }
}

function serializeCodex(source: RawMcpOccurrence): NativeSerialization {
  const warnings: string[] = [];
  const errors: string[] = [];
  const spec: UnknownRecord = {};
  warnAboutClientSpecificFields(source, warnings);
  rejectLiteralSecrets(source, errors);
  if (source.transport.kind === 'sse' || source.transport.kind === 'websocket') {
    errors.push('Codex supports stdio and Streamable HTTP, not this legacy remote transport.');
    return { warnings, errors };
  }
  if (source.transport.kind === 'stdio') {
    if (!source.transport.command) errors.push('The source stdio server has no command.');
    if (/\$\{|\{env:|\{file:/.test(source.transport.command ?? '')) {
      errors.push('Codex cannot preserve environment substitution inside the command.');
    }
    if ((source.transport.args ?? []).some((value) => /\$\{|\{env:|\{file:/.test(value))) {
      errors.push('Codex cannot preserve environment substitution inside command arguments.');
    }
    spec.command = source.transport.command;
    if (source.transport.args?.length) spec.args = source.transport.args;
    if (source.transport.cwd) spec.cwd = source.transport.cwd;
    const literalEnv: Record<string, string> = {};
    const forwarded: string[] = [];
    for (const [key, value] of Object.entries(source.transport.env ?? {})) {
      const reference = parsePureEnvironmentReference(value);
      if (!reference) literalEnv[key] = value;
      else if (reference.name === key && reference.defaultValue === undefined) forwarded.push(key);
      else errors.push(`Codex cannot preserve env alias ${key}=${value} without materializing a secret.`);
    }
    if (Object.keys(literalEnv).length) spec.env = literalEnv;
    if (forwarded.length) spec.env_vars = forwarded;
  } else if (source.transport.kind === 'http') {
    if (/\$\{|\{env:|\{file:/.test(source.transport.url ?? '')) {
      errors.push('Codex cannot preserve environment or file substitution inside the server URL.');
    }
    spec.url = source.transport.url;
    const staticHeaders: Record<string, string> = {};
    const environmentHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(source.transport.headers ?? {})) {
      const bearer = value.match(/^Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
      const openCodeBearer = value.match(/^Bearer\s+\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
      const reference = parsePureEnvironmentReference(value);
      if (key.toLocaleLowerCase() === 'authorization' && (bearer || openCodeBearer)) {
        spec.bearer_token_env_var = (bearer ?? openCodeBearer)![1];
      } else if (reference && reference.defaultValue === undefined) {
        environmentHeaders[key] = reference.name;
      } else if (/\$\{|\{env:|\{file:/.test(value)) {
        errors.push(`Codex cannot preserve the templated value of HTTP header ${key}.`);
      } else {
        staticHeaders[key] = value;
      }
    }
    if (Object.keys(staticHeaders).length) spec.http_headers = staticHeaders;
    if (Object.keys(environmentHeaders).length) spec.env_http_headers = environmentHeaders;
  } else {
    errors.push('The source transport is invalid or unknown.');
  }
  applyPortableExtras('codex', source, spec, warnings);
  return { spec: errors.length ? undefined : spec, warnings, errors };
}

export function serializeForAgent(target: AgentId, source: RawMcpOccurrence): NativeSerialization {
  if (target === 'codex') return serializeCodex(source);
  const warnings: string[] = [];
  const errors: string[] = [];
  const spec: UnknownRecord = {};
  warnAboutClientSpecificFields(source, warnings);
  rejectLiteralSecrets(source, errors);
  const isRemote = source.transport.kind !== 'stdio';

  if (source.transport.kind === 'unknown') errors.push('The source transport is invalid or unknown.');
  if (source.transport.kind === 'websocket' && target !== 'claude') {
    errors.push(`${target} does not expose a WebSocket MCP configuration.`);
  }
  if (source.transport.kind === 'sse' && target === 'opencode') {
    errors.push('OpenCode does not expose an explicit legacy SSE transport.');
  }

  const targetSyntax = target === 'opencode' ? 'opencode' : target === 'amp' ? 'amp' : 'dollar';
  const transform = (value: string) => replaceReferences(value, targetSyntax, warnings, errors);
  if (target === 'opencode') {
    if (isRemote) {
      spec.type = 'remote';
      spec.url = source.transport.url ? transform(source.transport.url) : source.transport.url;
      const headers = mapStringRecord(source.transport.headers, transform);
      if (headers) spec.headers = headers;
    } else {
      spec.type = 'local';
      spec.command = [source.transport.command, ...(source.transport.args ?? [])]
        .filter((value): value is string => typeof value === 'string')
        .map(transform);
      if (source.transport.cwd) spec.cwd = transform(source.transport.cwd);
      const environment = mapStringRecord(source.transport.env, transform);
      if (environment) spec.environment = environment;
    }
  } else if (isRemote) {
    if (target !== 'amp') {
      spec.type = source.transport.kind === 'http' ? 'http' : source.transport.kind;
    }
    spec.url = source.transport.url ? transform(source.transport.url) : source.transport.url;
    const headers = mapStringRecord(source.transport.headers, transform);
    if (headers) spec.headers = headers;
  } else {
    if (target === 'claude' || target === 'droid') spec.type = 'stdio';
    spec.command = source.transport.command ? transform(source.transport.command) : undefined;
    if (source.transport.args?.length) spec.args = source.transport.args.map(transform);
    if (source.transport.cwd && target === 'claude') spec.cwd = transform(source.transport.cwd);
    else if (source.transport.cwd) warnings.push(`${target} has no documented portable cwd field; cwd was omitted.`);
    const env = mapStringRecord(source.transport.env, transform);
    if (env) spec.env = env;
  }

  applyPortableExtras(target, source, spec, warnings);
  return { spec: errors.length ? undefined : spec, warnings, errors };
}

function jsonPathForAgent(agentId: AgentId, name: string): (string | number)[] {
  if (agentId === 'amp') return ['amp.mcpServers', name];
  if (agentId === 'opencode') return ['mcp', name];
  return ['mcpServers', name];
}

function formattingOptions(content: string) {
  const line = content.split(/\r?\n/).find((entry) => /^\s+["'}\w]/.test(entry));
  const leading = line?.match(/^\s+/)?.[0] ?? '  ';
  return {
    insertSpaces: !leading.includes('\t'),
    tabSize: leading.includes('\t') ? 1 : Math.max(2, leading.length),
    eol: content.includes('\r\n') ? '\r\n' : '\n',
  };
}

function addJsonServer(
  agentId: Exclude<AgentId, 'codex'>,
  content: string,
  name: string,
  spec: UnknownRecord,
): string {
  const initial = content.trim() ? content : '{}\n';
  const parsed = parseJsonDocument(initial);
  if (!parsed.data) throw new Error(parsed.error ?? 'Unable to parse target JSON configuration.');
  const path = jsonPathForAgent(agentId, name);
  let cursor: unknown = parsed.data;
  for (const segment of path) {
    if (!asRecord(cursor) || !(segment in (cursor as UnknownRecord))) {
      cursor = undefined;
      break;
    }
    cursor = (cursor as UnknownRecord)[segment];
  }
  if (cursor !== undefined) throw new Error(`Target already contains an MCP server named "${name}".`);
  return applyEdits(initial, modify(initial, path, spec, { formattingOptions: formattingOptions(initial) }));
}

function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlMap(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(', ')} }`;
}

function codexTable(name: string, spec: UnknownRecord): string {
  const lines = [`[mcp_servers.${tomlString(name)}]`];
  const orderedKeys = [
    'command',
    'args',
    'cwd',
    'url',
    'env',
    'env_vars',
    'bearer_token_env_var',
    'http_headers',
    'env_http_headers',
    'enabled',
    'tool_timeout_sec',
    'enabled_tools',
    'disabled_tools',
  ];
  for (const key of orderedKeys) {
    const value = spec[key];
    if (value === undefined) continue;
    if (typeof value === 'string') lines.push(`${key} = ${tomlString(value)}`);
    else if (typeof value === 'number' || typeof value === 'boolean') lines.push(`${key} = ${value}`);
    else if (Array.isArray(value)) lines.push(`${key} = ${tomlArray(value as string[])}`);
    else if (asStringRecord(value)) lines.push(`${key} = ${tomlMap(asStringRecord(value)!)}`);
  }
  return `${lines.join('\n')}\n`;
}

function addCodexServer(content: string, name: string, spec: UnknownRecord): string {
  let parsed: UnknownRecord;
  try {
    parsed = asRecord(parseToml(content || '')) ?? {};
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Unable to parse target TOML configuration.');
  }
  if (asRecord(parsed.mcp_servers)?.[name] !== undefined) {
    throw new Error(`Target already contains an MCP server named "${name}".`);
  }
  const separator = content.length === 0 ? '' : content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  const result = `${content}${separator}${codexTable(name, spec)}`;
  parseToml(result);
  return result;
}

export function addServerToContent(
  agentId: AgentId,
  content: string,
  name: string,
  spec: UnknownRecord,
): string {
  if (/[\u0000-\u001F\u007F]/.test(name)) throw new Error('Server name contains control characters.');
  return agentId === 'codex'
    ? addCodexServer(content, name, spec)
    : addJsonServer(agentId, content, name, spec);
}
