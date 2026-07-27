export const AGENT_IDS = ['claude', 'codex', 'droid', 'amp', 'opencode'] as const;

export type AgentId = (typeof AGENT_IDS)[number];
export type TransportKind = 'stdio' | 'http' | 'sse' | 'websocket' | 'unknown';
export type ConfigScope = 'user' | 'local' | 'project' | 'folder' | 'workspace';
export type AuthKind =
  | 'not-applicable'
  | 'automatic-oauth'
  | 'oauth-disabled'
  | 'oauth-client'
  | 'bearer-environment'
  | 'header-environment'
  | 'static-headers'
  | 'client-managed';

export interface PublicAuth {
  kind: AuthKind;
  oauthMode: 'not-applicable' | 'automatic' | 'disabled' | 'pre-registered' | 'client-managed';
  oauthFields: string[];
  environmentVariables: string[];
  requiresTargetLogin: boolean;
  hasClientSecret: boolean;
}

export interface AgentAuthCapabilities {
  automaticOAuth: boolean;
  oauthDisabled: boolean;
  preRegisteredOAuth: 'native-config' | 'external-cli' | 'unsupported';
  bearerEnvironment: boolean;
  customHeaderEnvironment: boolean;
}

export type AuthUpdate =
  | { kind: 'automatic-oauth'; scopes?: string[]; resource?: string }
  | { kind: 'oauth-disabled' }
  | { kind: 'bearer-environment'; environmentVariable: string }
  | {
      kind: 'header-environment';
      headerName: string;
      environmentVariable: string;
      prefix?: string;
    }
  | {
      kind: 'oauth-client';
      authorizationServerIssuer?: string;
      clientId: string;
      clientSecretEnvironmentVariable?: string;
      scopes?: string[];
      callbackPort?: number;
    };

export interface PublicTransport {
  kind: TransportKind;
  commandPreview?: string;
  endpointOrigin?: string;
  endpointPath?: string;
  queryKeys: string[];
  queryValueFingerprint?: string;
  envKeys: string[];
  headerKeys: string[];
}

export interface ConfigSource {
  scope: ConfigScope;
  path: string;
  hash: string;
  effective: boolean;
  precedence: number;
}

export interface PublicMcpOccurrence {
  occurrenceId: string;
  agentId: AgentId;
  name: string;
  transport: PublicTransport;
  auth: PublicAuth;
  enabled: boolean;
  timeoutMs?: number;
  includeTools?: string[];
  excludeTools?: string[];
  familyFingerprint: string;
  identityFingerprint: string;
  configFingerprint: string;
  source: ConfigSource;
  warnings: string[];
  hasSecrets: boolean;
}

export interface AgentDefinition {
  id: AgentId;
  name: string;
  shortName: string;
  configKey: string;
  transports: TransportKind[];
  authCapabilities: AgentAuthCapabilities;
}

export interface AgentSnapshot extends AgentDefinition {
  detected: boolean;
  configPaths: string[];
  occurrenceCount: number;
  installed?: boolean;
  version?: string;
  executable?: string;
}

export interface SnapshotIssue {
  agentId: AgentId;
  path: string;
  message: string;
}

export interface SnapshotResponse {
  workspace: string;
  generatedAt: string;
  mutationToken: string;
  agents: AgentSnapshot[];
  occurrences: PublicMcpOccurrence[];
  issues: SnapshotIssue[];
}

export interface ChangePlan {
  planId: string;
  operation: 'add' | 'configure-auth';
  occurrenceId: string;
  targetAgentId: AgentId;
  targetName: string;
  targetPath: string;
  expectedHash: string;
  resultHash: string;
  warnings: string[];
  unifiedDiff: string;
}

export interface ApplyResult {
  targetPath: string;
  appliedHash: string;
  undoToken: string;
}

export interface UndoResult {
  targetPath: string;
  restoredHash: string;
}
