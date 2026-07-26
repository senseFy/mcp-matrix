export const AGENT_IDS = ['claude', 'codex', 'droid', 'amp', 'opencode'] as const;

export type AgentId = (typeof AGENT_IDS)[number];
export type TransportKind = 'stdio' | 'http' | 'sse' | 'websocket' | 'unknown';
export type ConfigScope = 'user' | 'local' | 'project' | 'folder' | 'workspace';

export interface PublicTransport {
  kind: TransportKind;
  commandPreview?: string;
  endpointHost?: string;
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
  enabled: boolean;
  timeoutMs?: number;
  includeTools?: string[];
  excludeTools?: string[];
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
