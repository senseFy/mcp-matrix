import { createHash, createHmac, randomBytes } from 'node:crypto';
import { basename } from 'node:path';

import type {
  AgentDefinition,
  AgentId,
  AuthKind,
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
    authCapabilities: {
      automaticOAuth: true,
      oauthDisabled: false,
      preRegisteredOAuth: 'native-config',
      bearerEnvironment: true,
      customHeaderEnvironment: true,
    },
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    shortName: 'Codex',
    configKey: 'mcp_servers',
    transports: ['stdio', 'http'],
    authCapabilities: {
      automaticOAuth: true,
      oauthDisabled: false,
      preRegisteredOAuth: 'unsupported',
      bearerEnvironment: true,
      customHeaderEnvironment: true,
    },
  },
  {
    id: 'droid',
    name: 'Factory Droid',
    shortName: 'Droid',
    configKey: 'mcpServers',
    transports: ['stdio', 'http', 'sse'],
    authCapabilities: {
      automaticOAuth: true,
      oauthDisabled: true,
      preRegisteredOAuth: 'native-config',
      bearerEnvironment: true,
      customHeaderEnvironment: true,
    },
  },
  {
    id: 'amp',
    name: 'Amp',
    shortName: 'Amp',
    configKey: 'amp.mcpServers',
    transports: ['stdio', 'http', 'sse'],
    authCapabilities: {
      automaticOAuth: true,
      oauthDisabled: false,
      preRegisteredOAuth: 'external-cli',
      bearerEnvironment: true,
      customHeaderEnvironment: true,
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    shortName: 'OpenCode',
    configKey: 'mcp',
    transports: ['stdio', 'http'],
    authCapabilities: {
      automaticOAuth: true,
      oauthDisabled: true,
      preRegisteredOAuth: 'native-config',
      bearerEnvironment: true,
      customHeaderEnvironment: true,
    },
  },
  {
    id: 'pi',
    name: 'Pi (pi-mcp-adapter)',
    shortName: 'Pi',
    configKey: 'mcpServers',
    transports: ['stdio', 'http', 'sse'],
    authCapabilities: {
      automaticOAuth: true,
      oauthDisabled: true,
      preRegisteredOAuth: 'native-config',
      bearerEnvironment: true,
      customHeaderEnvironment: true,
    },
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

export interface RawAuth {
  oauthMode: 'not-applicable' | 'automatic' | 'disabled' | 'pre-registered' | 'client-managed';
  authorizationServerIssuer?: string;
  authServerMetadataUrl?: string;
  clientId?: string;
  clientSecret?: string;
  clientMetadataUrl?: string;
  scopes?: string[];
  resource?: string | false;
  callbackPort?: number;
  tokenEndpointAuthMethod?: string;
  credentialKind: 'none' | 'bearer-environment' | 'header-environment' | 'static-headers';
  credentialHeaderKeys: string[];
  environmentVariables: string[];
}

export interface RawMcpOccurrence {
  occurrenceId: string;
  agentId: AgentId;
  name: string;
  transport: RawTransport;
  auth: RawAuth;
  enabled: boolean;
  timeoutMs?: number;
  includeTools?: string[];
  excludeTools?: string[];
  familyFingerprint: string;
  identityFingerprint: string;
  configFingerprint: string;
  source: {
    scope: ConfigScope;
    path: string;
    hash: string;
    effective: boolean;
    precedence: number;
  };
  sourceRevisions: Array<{
    path: string;
    hash: string;
  }>;
  nativePath?: (string | number)[];
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

function packageWithoutVersion(value: string): string {
  if (value.startsWith('@')) {
    const separator = value.lastIndexOf('@');
    return separator > value.indexOf('/') ? value.slice(0, separator) : value;
  }
  const separator = value.lastIndexOf('@');
  return separator > 0 ? value.slice(0, separator) : value;
}

function firstRunnerPackage(args: string[]): string | undefined {
  const optionsWithValues = new Set([
    '--cache',
    '--call',
    '--node-options',
    '--registry',
    '--userconfig',
    '-c',
  ]);
  const optionsWithoutValues = new Set([
    '--ignore-existing',
    '--no-install',
    '--quiet',
    '--refresh',
    '--yes',
    '-q',
    '-y',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--') return args[index + 1];
    if (/^(?:--package|-p)$/.test(value)) return args[index + 1];
    const inlinePackage = value.match(/^--package=(.+)$/)?.[1];
    if (inlinePackage) return inlinePackage;
    if (optionsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (optionsWithoutValues.has(value)) continue;
    if (value.startsWith('-')) return undefined;
    return value;
  }
  return undefined;
}

function stdioFamily(transport: RawTransport): unknown {
  const command = canonicalizeReferences(transport.command ?? '');
  const args = transport.args ?? [];
  const executable = basename(transport.command ?? '').toLocaleLowerCase().replace(/\.exe$/, '');
  let packageName: string | undefined;

  if (['npx', 'bunx', 'pnpx', 'uvx'].includes(executable)) {
    packageName = firstRunnerPackage(args);
  } else if (executable === 'npm' && ['exec', 'x'].includes(args[0])) {
    packageName = firstRunnerPackage(args.slice(1));
  } else if (executable === 'yarn' && args[0] === 'dlx') {
    packageName = firstRunnerPackage(args.slice(1));
  } else if (executable === 'pipx' && args[0] === 'run') {
    packageName = firstRunnerPackage(args.slice(1));
  }

  if (packageName) {
    return {
      kind: 'stdio',
      package: packageWithoutVersion(packageName.toLocaleLowerCase()),
    };
  }

  if (['node', 'nodejs', 'python', 'python3', 'ruby'].includes(executable)) {
    return {
      kind: 'stdio',
      runtime: executable.replace(/\d+$/, ''),
      positionalArgs: args
        .filter((value) => !value.startsWith('-'))
        .map((value) => canonicalizeReferences(value)),
    };
  }

  return {
    kind: 'stdio',
    command,
    positionalArgs: args
      .filter((value) => !value.startsWith('-'))
      .map((value) => canonicalizeReferences(value)),
  };
}

function remoteFamily(transport: RawTransport): unknown {
  try {
    const endpoint = new URL(transport.url ?? '');
    return {
      kind: 'remote',
      origin: endpoint.origin.toLocaleLowerCase(),
      path: endpoint.pathname,
    };
  } catch {
    return {
      kind: 'remote',
      endpoint: canonicalizeReferences((transport.url ?? '').replace(/[?#].*$/, '')),
    };
  }
}

export function buildFingerprints(transport: RawTransport, portable: unknown, familyName?: string) {
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

  const family = transport.kind === 'stdio'
    ? stdioFamily(transport)
    : transport.url
      ? remoteFamily(transport)
      : { kind: 'unknown', name: familyName?.trim().toLocaleLowerCase() ?? '' };

  return {
    familyFingerprint: sha256(
      stableStringify(family),
    ).slice(0, 20),
    identityFingerprint: sha256(stableStringify(canonicalizeReferences(identity))).slice(0, 20),
    configFingerprint: sha256(stableStringify(canonicalizeReferences(portable))).slice(0, 20),
  };
}

export function authFingerprint(auth: RawAuth): unknown {
  const clientSecretReference = auth.clientSecret
    ? parsePureEnvironmentReference(auth.clientSecret)?.name
    : undefined;
  const oauthMode =
    auth.credentialKind !== 'none' && (auth.oauthMode === 'automatic' || auth.oauthMode === 'disabled')
      ? 'credential'
      : auth.oauthMode;
  return {
    ...auth,
    oauthMode,
    clientSecret: auth.clientSecret
      ? clientSecretReference
        ? `{env:${clientSecretReference}}`
        : 'configured'
      : undefined,
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
    )
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, '{env:$1}');
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
  /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/,
  /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/,
];

const sensitiveKeyPattern =
  /(?:^|[_-])(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)(?:$|[_-])/i;
const publicFingerprintKey = randomBytes(32);

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

function redactEndpointPath(pathname: string): string {
  const segments = pathname.split('/');
  return segments
    .map((segment, index) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Keep malformed percent encoding for the generic value check.
      }
      const previous = segments[index - 1] ?? '';
      return sensitiveKeyPattern.test(`_${previous}_`) ||
        looksSensitiveValue(decoded) ||
        looksLikeOpaqueIdentifier(decoded)
        ? '••••••••'
        : segment;
    })
    .join('/');
}

function looksLikeOpaqueIdentifier(value: string): boolean {
  return (
    value.length >= 16 &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value)
  );
}

export function toPublicOccurrence(occurrence: RawMcpOccurrence): PublicMcpOccurrence {
  const args = redactArgs(occurrence.transport.args ?? []);
  const commandPreview = occurrence.transport.command
    ? [occurrence.transport.command, ...args.args].join(' ')
    : undefined;
  let endpointOrigin: string | undefined;
  let endpointPath: string | undefined;
  let queryKeys: string[] = [];
  let queryValueFingerprint: string | undefined;
  if (occurrence.transport.url) {
    try {
      const endpoint = new URL(occurrence.transport.url);
      endpointOrigin = endpoint.origin;
      endpointPath = redactEndpointPath(endpoint.pathname);
      queryKeys = [...new Set(
        [...endpoint.searchParams.keys()].map((key) =>
          sensitiveKeyPattern.test(`_${key}_`) ||
          looksSensitiveValue(key) ||
          looksLikeOpaqueIdentifier(key)
            ? 'sensitive parameter'
            : key,
        ),
      )].sort();
      if (endpoint.search) {
        queryValueFingerprint = createHmac('sha256', publicFingerprintKey)
          .update(endpoint.search)
          .digest('hex')
          .slice(0, 16);
      }
    } catch {
      endpointOrigin = /\$\{|\$env:|\{env:|\{file:/.test(occurrence.transport.url)
        ? 'Templated endpoint'
        : 'Invalid endpoint';
    }
  }

  const transport: PublicTransport = {
    kind: occurrence.transport.kind,
    commandPreview,
    endpointOrigin,
    endpointPath,
    queryKeys,
    queryValueFingerprint,
    envKeys: Object.keys(occurrence.transport.env ?? {}).sort(),
    headerKeys: Object.keys(occurrence.transport.headers ?? {}).sort(),
  };
  const oauthFields = [
    occurrence.auth.authorizationServerIssuer && 'authorization server issuer',
    occurrence.auth.authServerMetadataUrl && 'authorization metadata',
    occurrence.auth.clientId && 'client ID',
    occurrence.auth.clientSecret && 'client secret',
    occurrence.auth.clientMetadataUrl && 'client metadata',
    occurrence.auth.scopes?.length && 'scopes',
    occurrence.auth.resource !== undefined && 'resource',
    occurrence.auth.callbackPort !== undefined && 'callback port',
    occurrence.auth.tokenEndpointAuthMethod && 'token endpoint method',
  ].filter((value): value is string => Boolean(value));
  let authKind: AuthKind;
  if (occurrence.auth.credentialKind !== 'none') authKind = occurrence.auth.credentialKind;
  else if (occurrence.auth.oauthMode === 'not-applicable') authKind = 'not-applicable';
  else if (occurrence.auth.oauthMode === 'automatic') authKind = 'automatic-oauth';
  else if (occurrence.auth.oauthMode === 'disabled') authKind = 'oauth-disabled';
  else if (occurrence.auth.oauthMode === 'pre-registered') authKind = 'oauth-client';
  else authKind = 'client-managed';

  return {
    occurrenceId: occurrence.occurrenceId,
    agentId: occurrence.agentId,
    name: occurrence.name,
    transport,
    auth: {
      kind: authKind,
      oauthMode: occurrence.auth.oauthMode,
      oauthFields,
      environmentVariables: occurrence.auth.environmentVariables,
      requiresTargetLogin:
        occurrence.auth.oauthMode === 'automatic' ||
        occurrence.auth.oauthMode === 'pre-registered' ||
        occurrence.auth.oauthMode === 'client-managed',
      hasClientSecret: Boolean(occurrence.auth.clientSecret),
    },
    enabled: occurrence.enabled,
    timeoutMs: occurrence.timeoutMs,
    includeTools: occurrence.includeTools,
    excludeTools: occurrence.excludeTools,
    familyFingerprint: occurrence.familyFingerprint,
    identityFingerprint: occurrence.identityFingerprint,
    configFingerprint: occurrence.configFingerprint,
    source: occurrence.source,
    warnings: occurrence.warnings,
    hasSecrets:
      Object.keys(occurrence.transport.env ?? {}).length > 0 ||
      Object.keys(occurrence.transport.headers ?? {}).length > 0 ||
      Boolean(occurrence.auth.clientSecret) ||
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
