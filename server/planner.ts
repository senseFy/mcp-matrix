import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

import type { AgentId, ApplyResult, AuthUpdate, ChangePlan, UndoResult } from '../src/types';
import {
  addServerToContent,
  loadNativeSnapshot,
  nativeSpecWithAuthUpdate,
  serializeForAgent,
  updateAuthInContent,
} from './adapters';
import { looksLikeLiteralSecret, maskSecretPatterns, sha256 } from './domain';
import { piAgentDirectory, type NativeConfigSource } from './discovery';

interface InternalPlan extends ChangePlan {
  originalContent: string;
  proposedContent: string;
  originalExists: boolean;
  workspace: string;
  sourceAgentId: AgentId;
  sourceName: string;
  sourceIdentityFingerprint: string;
  sourceConfigFingerprint: string;
  sourceRevisions: Array<{ path: string; hash: string }>;
  createdAt: number;
}

interface UndoManifest {
  version: 1;
  undoToken: string;
  targetPath: string;
  appliedHash: string;
  originalHash: string;
  originalExists: boolean;
  backupPath?: string;
  createdAt: string;
}

const plans = new Map<string, InternalPlan>();
const PLAN_LIFETIME_MS = 10 * 60 * 1_000;

function publicPlan(plan: InternalPlan): ChangePlan {
  const {
    originalContent: _original,
    proposedContent: _proposed,
    originalExists: _exists,
    workspace: _workspace,
    sourceAgentId: _sourceAgentId,
    sourceName: _sourceName,
    sourceIdentityFingerprint: _sourceIdentityFingerprint,
    sourceConfigFingerprint: _sourceConfigFingerprint,
    sourceRevisions: _sourceRevisions,
    createdAt: _createdAt,
    ...response
  } = plan;
  return response;
}

function clearExpiredPlans(): void {
  const oldestAllowed = Date.now() - PLAN_LIFETIME_MS;
  for (const [id, plan] of plans) {
    if (plan.createdAt < oldestAllowed) plans.delete(id);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveWritePath(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink() ? realpath(path) : path;
  } catch {
    return path;
  }
}

function defaultTargetPath(agentId: AgentId): string {
  const home = process.env.MCP_MATRIX_HOME ?? homedir();
  switch (agentId) {
    case 'claude':
      return join(home, '.claude.json');
    case 'codex':
      return join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml');
    case 'droid':
      return join(home, '.factory', 'mcp.json');
    case 'amp':
      return join(home, '.config', 'amp', 'settings.json');
    case 'opencode':
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode', 'opencode.json');
    case 'pi':
      return join(piAgentDirectory(), 'mcp.json');
  }
}

function chooseTargetSource(agentId: AgentId, sources: NativeConfigSource[]): string {
  const userSources = sources.filter((source) => source.agentId === agentId && source.scope === 'user');
  if (agentId === 'pi') {
    return userSources.find((source) => source.selector === 'pi-owned')?.path ?? defaultTargetPath(agentId);
  }
  return userSources[0]?.path ?? defaultTargetPath(agentId);
}

function redactNativeSpec(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactNativeSpec(entry, parentKey));
  if (value && typeof value === 'object') {
    const sensitiveContainer = /^(env|environment|headers|http_headers)$/i.test(parentKey);
    const environmentHeaderContainer = /^env_http_headers$/i.test(parentKey);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        if (
          (environmentHeaderContainer || key === 'bearer_token_env_var' || key === 'bearerTokenEnv') &&
          typeof entry === 'string' &&
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)
        ) {
          return [key, entry];
        }
        if (sensitiveContainer) {
          const reference = typeof entry === 'string'
            ? entry.match(/^([^{}$\r\n]{0,64})(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$env:[A-Za-z_][A-Za-z0-9_]*|\{env:[A-Za-z_][A-Za-z0-9_]*\})$/)
            : undefined;
          const isReference = Boolean(reference && !looksLikeLiteralSecret('', reference[1]));
          return [key, isReference ? entry : '••••••••'];
        }
        if (key === 'url' && typeof entry === 'string') {
          try {
            const url = new URL(entry);
            return [key, `${url.protocol}//${url.host}${url.pathname}${url.search ? '?••••••••' : ''}`];
          } catch {
            return [key, '••••••••'];
          }
        }
        if (/token|secret|password|authorization|cookie|api.?key/i.test(key)) {
          const preservedReference = typeof entry === 'string' && /^(?:\$\{|\$env:|\{env:)/.test(entry);
          return [key, preservedReference ? entry : '••••••••'];
        }
        return [key, redactNativeSpec(entry, key)];
      }),
    );
  }
  if (typeof value === 'string' && parentKey === 'args' && /token|secret|password|api.?key|credential/i.test(value)) {
    return '••••••••';
  }
  return typeof value === 'string' ? maskSecretPatterns(value) : value;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function previewTomlValue(value: unknown): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(previewTomlValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${tomlString(key)} = ${previewTomlValue(entry)}`)
      .join(', ')} }`;
  }
  return '"••••••••"';
}

function focusedDiff(agentId: AgentId, targetPath: string, name: string, spec: Record<string, unknown>): string {
  const redacted = redactNativeSpec(spec) as Record<string, unknown>;
  const lines =
    agentId === 'codex'
      ? [`[mcp_servers.${tomlString(name)}]`, ...Object.entries(redacted).map(([key, value]) => `${key} = ${previewTomlValue(value)}`)]
      : JSON.stringify(redacted, null, 2).split('\n');
  return [
    `--- ${targetPath}`,
    `+++ ${targetPath}`,
    `@@ add MCP server "${name}" (${agentId}) @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

function authPreviewSpec(agentId: AgentId, spec: Record<string, unknown>): Record<string, unknown> {
  const keys = agentId === 'codex'
    ? ['bearer_token_env_var', 'http_headers', 'env_http_headers', 'auth', 'scopes', 'oauth_resource']
    : agentId === 'pi'
      ? ['headers', 'auth', 'bearerToken', 'bearerTokenEnv', 'oauth']
      : ['headers', 'oauth'];
  return Object.fromEntries(keys.flatMap((key) => spec[key] === undefined ? [] : [[key, spec[key]]]));
}

function focusedAuthDiff(
  agentId: AgentId,
  targetPath: string,
  name: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  const previous = redactNativeSpec(authPreviewSpec(agentId, before)) as Record<string, unknown>;
  const next = redactNativeSpec(authPreviewSpec(agentId, after)) as Record<string, unknown>;
  const render = (value: Record<string, unknown>): string[] =>
    agentId === 'codex'
      ? Object.entries(value).map(([key, entry]) => `${key} = ${previewTomlValue(entry)}`)
      : JSON.stringify(value, null, 2).split('\n');
  return [
    `--- ${targetPath}`,
    `+++ ${targetPath}`,
    `@@ configure authentication for MCP server "${name}" (${agentId}) @@`,
    ...render(previous).map((line) => `-${line}`),
    ...render(next).map((line) => `+${line}`),
  ].join('\n');
}

function assertTargetName(name: string): void {
  if (!name.trim()) throw new Error('Target server name is required.');
  if (name !== name.trim()) throw new Error('Target server name cannot start or end with whitespace.');
  if (name.length > 128) throw new Error('Target server name is too long.');
  if (/[\u0000-\u001F\u007F]/.test(name)) throw new Error('Target server name contains control characters.');
}

export async function createCopyPlan(input: {
  workspace: string;
  occurrenceId: string;
  targetAgentId: AgentId;
  targetName?: string;
}): Promise<ChangePlan> {
  clearExpiredPlans();
  const snapshot = await loadNativeSnapshot(input.workspace);
  const source = snapshot.occurrences.find((occurrence) => occurrence.occurrenceId === input.occurrenceId);
  if (!source) throw new Error('The source MCP entry no longer exists. Refresh and try again.');
  const targetName = input.targetName ?? source.name;
  assertTargetName(targetName);
  const identicalEntry = snapshot.occurrences.find(
    (occurrence) =>
      occurrence.source.effective &&
      occurrence.agentId === input.targetAgentId &&
      occurrence.identityFingerprint === source.identityFingerprint,
  );
  if (identicalEntry) {
    throw new Error(
      `The target agent already configures this MCP identity as "${identicalEntry.name}" in ${identicalEntry.source.path}.`,
    );
  }
  const conflictingEntry = snapshot.occurrences.find(
    (occurrence) =>
      occurrence.source.effective &&
      occurrence.agentId === input.targetAgentId &&
      occurrence.name === targetName,
  );
  if (conflictingEntry) {
    throw new Error(`The target agent already defines "${targetName}" in ${conflictingEntry.source.path}.`);
  }

  const serialized = serializeForAgent(input.targetAgentId, source);
  if (!serialized.spec || serialized.errors.length) {
    throw new Error(serialized.errors.join(' ') || 'This MCP entry cannot be represented by the target agent.');
  }

  const configuredTarget = chooseTargetSource(input.targetAgentId, snapshot.sources);
  const targetPath = await resolveWritePath(configuredTarget);
  const originalExists = await pathExists(targetPath);
  const originalContent = originalExists ? await readFile(targetPath, 'utf8') : '';
  const expectedHash = sha256(originalContent);
  const proposedContent = addServerToContent(
    input.targetAgentId,
    originalContent,
    targetName,
    serialized.spec,
  );
  const resultHash = sha256(proposedContent);
  const planId = randomUUID();
  const plan: InternalPlan = {
    planId,
    operation: 'add',
    occurrenceId: source.occurrenceId,
    targetAgentId: input.targetAgentId,
    targetName,
    targetPath,
    expectedHash,
    resultHash,
    warnings: [...new Set([...source.warnings, ...serialized.warnings])],
    unifiedDiff: focusedDiff(input.targetAgentId, targetPath, targetName, serialized.spec),
    originalContent,
    proposedContent,
    originalExists,
    workspace: input.workspace,
    sourceAgentId: source.agentId,
    sourceName: source.name,
    sourceIdentityFingerprint: source.identityFingerprint,
    sourceConfigFingerprint: source.configFingerprint,
    sourceRevisions: source.sourceRevisions,
    createdAt: Date.now(),
  };
  plans.set(planId, plan);
  return publicPlan(plan);
}

export async function createAuthPlan(input: {
  workspace: string;
  occurrenceId: string;
  auth: AuthUpdate;
}): Promise<ChangePlan> {
  clearExpiredPlans();
  const snapshot = await loadNativeSnapshot(input.workspace);
  const occurrence = snapshot.occurrences.find(
    (entry) => entry.occurrenceId === input.occurrenceId && entry.source.effective,
  );
  if (!occurrence) throw new Error('The effective MCP entry no longer exists. Refresh and try again.');
  const serialized = nativeSpecWithAuthUpdate(occurrence, input.auth);
  if (!serialized.spec || serialized.errors.length) {
    throw new Error(serialized.errors.join(' ') || 'This authentication strategy cannot be represented by the target agent.');
  }
  const targetPath = await resolveWritePath(occurrence.source.path);
  const originalContent = await readFile(targetPath, 'utf8');
  const proposedContent = updateAuthInContent(
    occurrence.agentId,
    originalContent,
    occurrence,
    serialized.spec,
  );
  if (proposedContent === originalContent) throw new Error('The requested authentication configuration is already present.');
  const planId = randomUUID();
  const plan: InternalPlan = {
    planId,
    operation: 'configure-auth',
    occurrenceId: occurrence.occurrenceId,
    targetAgentId: occurrence.agentId,
    targetName: occurrence.name,
    targetPath,
    expectedHash: sha256(originalContent),
    resultHash: sha256(proposedContent),
    warnings: [...new Set([...occurrence.warnings, ...serialized.warnings])],
    unifiedDiff: focusedAuthDiff(
      occurrence.agentId,
      targetPath,
      occurrence.name,
      occurrence.native,
      serialized.spec,
    ),
    originalContent,
    proposedContent,
    originalExists: true,
    workspace: input.workspace,
    sourceAgentId: occurrence.agentId,
    sourceName: occurrence.name,
    sourceIdentityFingerprint: occurrence.identityFingerprint,
    sourceConfigFingerprint: occurrence.configFingerprint,
    sourceRevisions: occurrence.sourceRevisions,
    createdAt: Date.now(),
  };
  plans.set(planId, plan);
  return publicPlan(plan);
}

async function readHash(path: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, content: string, mode = 0o600): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(path)}.mcp-matrix-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const directoryHandle = await open(directory, 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function durableCreate(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function backupsRoot(): string {
  return join(process.env.MCP_MATRIX_HOME ?? homedir(), '.mcp-matrix', 'backups');
}

async function createUndoManifest(plan: InternalPlan): Promise<UndoManifest> {
  const undoToken = randomUUID();
  const directory = join(backupsRoot(), undoToken);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let backupPath: string | undefined;
  if (plan.originalExists) {
    backupPath = join(directory, `${createHash('sha256').update(plan.targetPath).digest('hex').slice(0, 12)}-${basename(plan.targetPath)}.bak`);
    await durableCreate(backupPath, plan.originalContent);
  }
  const manifest: UndoManifest = {
    version: 1,
    undoToken,
    targetPath: plan.targetPath,
    appliedHash: plan.resultHash,
    originalHash: plan.expectedHash,
    originalExists: plan.originalExists,
    backupPath,
    createdAt: new Date().toISOString(),
  };
  await durableCreate(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function applyPlan(planId: string): Promise<ApplyResult> {
  clearExpiredPlans();
  const plan = plans.get(planId);
  if (!plan) throw new Error('This change plan is missing or expired. Create a new preview.');

  const currentTargetHash = await readHash(plan.targetPath);
  const expectedTargetHash = plan.originalExists ? plan.expectedHash : undefined;
  if (currentTargetHash !== expectedTargetHash) {
    throw new Error('The target configuration changed after this preview. Refresh before applying.');
  }
  for (const revision of plan.sourceRevisions) {
    if ((await readHash(revision.path)) !== revision.hash) {
      throw new Error('The source configuration changed after this preview. Refresh before applying.');
    }
  }
  const currentSnapshot = await loadNativeSnapshot(plan.workspace);
  if (plan.operation === 'add') {
    const identicalTarget = currentSnapshot.occurrences.find(
      (occurrence) =>
        occurrence.source.effective &&
        occurrence.agentId === plan.targetAgentId &&
        occurrence.identityFingerprint === plan.sourceIdentityFingerprint,
    );
    if (identicalTarget) {
      throw new Error('The target effective configuration gained this MCP identity after the preview. Refresh before applying.');
    }
    const conflictingTarget = currentSnapshot.occurrences.find(
      (occurrence) =>
        occurrence.source.effective &&
        occurrence.agentId === plan.targetAgentId &&
        occurrence.name === plan.targetName,
    );
    if (conflictingTarget) {
      throw new Error(`The target effective configuration gained "${plan.targetName}" after the preview. Refresh before applying.`);
    }
  }
  const currentSource = currentSnapshot.occurrences.find(
    (occurrence) =>
      occurrence.source.effective &&
      occurrence.agentId === plan.sourceAgentId &&
      occurrence.name === plan.sourceName,
  );
  if (!currentSource || currentSource.configFingerprint !== plan.sourceConfigFingerprint) {
    throw new Error('The effective source configuration changed after this preview. Refresh before applying.');
  }

  const manifest = await createUndoManifest(plan);
  let mode = 0o600;
  if (plan.originalExists) mode = (await stat(plan.targetPath)).mode & 0o777;
  await atomicWrite(plan.targetPath, plan.proposedContent, mode);
  await chmod(plan.targetPath, mode);
  const verificationHash = await readHash(plan.targetPath);
  if (verificationHash !== plan.resultHash) {
    throw new Error('The configuration write could not be verified. Use Undo before continuing.');
  }
  plans.delete(planId);
  return {
    targetPath: plan.targetPath,
    appliedHash: plan.resultHash,
    undoToken: manifest.undoToken,
  };
}

function validateUndoToken(token: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    throw new Error('Invalid undo token.');
  }
}

export async function undoApply(undoToken: string): Promise<UndoResult> {
  validateUndoToken(undoToken);
  const manifestPath = join(backupsRoot(), undoToken, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as UndoManifest;
  if (manifest.version !== 1 || manifest.undoToken !== undoToken) throw new Error('Invalid undo manifest.');
  const currentHash = await readHash(manifest.targetPath);
  if (currentHash !== manifest.appliedHash) {
    throw new Error('The target configuration changed after apply. Undo was stopped to protect newer edits.');
  }

  if (manifest.originalExists) {
    if (!manifest.backupPath) throw new Error('The backup file is missing from the undo manifest.');
    const originalContent = await readFile(manifest.backupPath, 'utf8');
    if (sha256(originalContent) !== manifest.originalHash) throw new Error('The backup integrity check failed.');
    const mode = (await stat(manifest.targetPath)).mode & 0o777;
    await atomicWrite(manifest.targetPath, originalContent, mode);
  } else {
    await unlink(manifest.targetPath);
  }
  return { targetPath: manifest.targetPath, restoredHash: manifest.originalHash };
}
