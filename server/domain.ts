import { createHash } from 'node:crypto';

import type {
  AgentDefinition,
  AgentId,
  ConfigScope,
  PublicMcpOccurrence,
  PublicTransport,
  TransportKind,
} from '../src/types';

export const AGENTS: AgentDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    shortName: 'Claude',
    configKey: 'mcpServers',
    transports: ['stdio', 'http', 'sse', 'websocket'],
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    shortName: 'Codex',
    configKey: 'mcp_servers',
    transports: ['stdio', 'http'],
  },
  {
    id: 'droid',
    name: 'Factory Droid',
    shortName: 'Droid',
    configKey: 'mcpServers',
    transports: ['stdio', 'http', 'sse'],
  },
  {
    id: 'amp',
    name: 'Amp',
    shortName: 'Amp',
    configKey: 'amp.mcpServers',
    transports: ['stdio', 'http', 'sse'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    shortName: 'OpenCode',
    configKey: 'mcp',
    transports: ['stdio', 'http'],
  },
];

export interface RawTransport {
  kind: TransportKind;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface RawMcpOccurrence {
  occurrenceId: string;
  agentId: AgentId;
  name: string;
  transport: RawTransport;
  enabled: boolean;
  timeoutMs?: number;
  includeTools?: string[];
  excludeTools?: string[];
  identityFingerprint: string;
  configFingerprint: string;
  source: {
    scope: ConfigScope;
    path: string;
    hash: string;
    effective: boolean;
    precedence: number;
  };
  warnings: string[];
  native: Record<string, unknown>;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableObject(entry)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableObject(value));
}

export function buildFingerprints(transport: RawTransport, portable: unknown) {
  const identity =
    transport.kind === 'stdio'
      ? {
          kind: transport.kind,
          command: transport.command,
          args: transport.args ?? [],
        }
      : {
          kind: transport.kind,
          url: transport.url,
        };

  return {
    identityFingerprint: sha256(stableStringify(canonicalizeReferences(identity))).slice(0, 20),
    configFingerprint: sha256(stableStringify(canonicalizeReferences(portable))).slice(0, 20),
  };
}

function canonicalizeReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeReferences);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        canonicalizeReferences(entry),
      ]),
    );
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_match, name: string, defaultValue: string | undefined) =>
        defaultValue === undefined ? `{env:${name}}` : `{env:${name}|default:${defaultValue}}`,
    );
}

export function buildOccurrenceId(
  agentId: AgentId,
  path: string,
  scope: ConfigScope,
  name: string,
): string {
  return sha256(`${agentId}\0${path}\0${scope}\0${name}`).slice(0, 24);
}

const referencePatterns = [
  /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/,
  /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/,
];

const sensitiveKeyPattern =
  /(?:^|[_-])(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)(?:$|[_-])/i;

export interface EnvironmentReference {
  name: string;
  defaultValue?: string;
}

export function parsePureEnvironmentReference(value: string): EnvironmentReference | undefined {
  for (const pattern of referencePatterns) {
    const match = value.match(pattern);
    if (match) return { name: match[1], defaultValue: match[2] };
  }
  return undefined;
}

function looksSensitiveValue(value: string): boolean {
  return (
    /(?:bearer\s+|basic\s+)[A-Za-z0-9._~+/=-]{8,}/i.test(value) ||
    /(?:^|["'=\s])(sk-|xai-|gh[pousr]_|glpat-|npm_)[A-Za-z0-9._-]{8,}/i.test(value) ||
    /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value)
  );
}

export function looksLikeLiteralSecret(key: string, value: string): boolean {
  return sensitiveKeyPattern.test(`_${key}_`) || looksSensitiveValue(value);
}

function redactArgs(args: string[]): { args: string[]; sensitive: boolean } {
  let sensitive = false;
  const redacted = args.map((arg, index) => {
    const previous = args[index - 1] ?? '';
    const flagCarriesSecret = /(?:token|secret|password|passwd|api[_-]?key|credential)/i.test(previous);
    if (
      flagCarriesSecret ||
      looksSensitiveValue(arg) ||
      /(?:token|secret|password|passwd|api[_-]?key|credential)\s*=/i.test(arg)
    ) {
      sensitive = true;
      return '••••••••';
    }
    return arg;
  });
  return { args: redacted, sensitive };
}

export function toPublicOccurrence(occurrence: RawMcpOccurrence): PublicMcpOccurrence {
  const args = redactArgs(occurrence.transport.args ?? []);
  const commandPreview = occurrence.transport.command
    ? [occurrence.transport.command, ...args.args].join(' ')
    : undefined;
  let endpointHost: string | undefined;
  if (occurrence.transport.url) {
    try {
      const endpoint = new URL(occurrence.transport.url);
      endpointHost = `${endpoint.protocol}//${endpoint.host}`;
    } catch {
      endpointHost = /\$\{|\{env:|\{file:/.test(occurrence.transport.url)
        ? 'Templated endpoint'
        : 'Invalid endpoint';
    }
  }

  const transport: PublicTransport = {
    kind: occurrence.transport.kind,
    commandPreview,
    endpointHost,
    envKeys: Object.keys(occurrence.transport.env ?? {}).sort(),
    headerKeys: Object.keys(occurrence.transport.headers ?? {}).sort(),
  };

  return {
    occurrenceId: occurrence.occurrenceId,
    agentId: occurrence.agentId,
    name: occurrence.name,
    transport,
    enabled: occurrence.enabled,
    timeoutMs: occurrence.timeoutMs,
    includeTools: occurrence.includeTools,
    excludeTools: occurrence.excludeTools,
    identityFingerprint: occurrence.identityFingerprint,
    configFingerprint: occurrence.configFingerprint,
    source: occurrence.source,
    warnings: occurrence.warnings,
    hasSecrets:
      Object.keys(occurrence.transport.env ?? {}).length > 0 ||
      Object.keys(occurrence.transport.headers ?? {}).length > 0 ||
      args.sensitive,
  };
}

export function maskSecretPatterns(value: string): string {
  return redactConfigContent(value);
}

export function redactConfigContent(content: string): string {
  return content
    .replace(
      /((?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)[^\n:=]{0,40}["']?\s*[:=]\s*["'])([^"'\n]*)(["'])/gi,
      '$1••••••••$3',
    )
    .replace(
      /((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
      '$1••••••••',
    )
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s@]+(@)/gi,
      '$1••••••••$2',
    )
    .replace(/\b(?:sk-|xai-|gh[pousr]_|glpat-|npm_)[A-Za-z0-9._-]{8,}\b/gi, '••••••••');
}
