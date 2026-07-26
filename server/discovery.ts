import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import type { AgentId, AgentSnapshot, ConfigScope } from '../src/types';
import { AGENTS } from './domain';

const execFileAsync = promisify(execFile);

export interface NativeConfigSource {
  agentId: AgentId;
  path: string;
  scope: ConfigScope;
  precedence: number;
  selector?: string;
  projectKey?: string;
}

function homeDirectory(): string {
  return process.env.MCP_MATRIX_HOME ?? homedir();
}

const definitions: Record<AgentId, { label: string; command: string; userPath: () => string }> = {
  claude: {
    label: 'Claude Code',
    command: 'claude',
    userPath: () => join(homeDirectory(), '.claude.json'),
  },
  codex: {
    label: 'Codex',
    command: 'codex',
    userPath: () => join(process.env.CODEX_HOME || join(homeDirectory(), '.codex'), 'config.toml'),
  },
  droid: {
    label: 'Factory Droid',
    command: 'droid',
    userPath: () => join(homeDirectory(), '.factory', 'mcp.json'),
  },
  amp: {
    label: 'Amp',
    command: 'amp',
    userPath: () => join(homeDirectory(), '.config', 'amp', 'settings.json'),
  },
  opencode: {
    label: 'OpenCode',
    command: 'opencode',
    userPath: () => join(homeDirectory(), '.config', 'opencode', 'opencode.json'),
  },
};

export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function ancestors(from: string, stopAt?: string): string[] {
  const output: string[] = [];
  let cursor = resolve(from);
  const stop = stopAt ? resolve(stopAt) : undefined;
  while (true) {
    output.push(cursor);
    if (cursor === stop) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return output;
}

export async function findRepositoryRoot(workspace: string): Promise<string> {
  for (const path of ancestors(workspace)) {
    if (await directoryExists(join(path, '.git'))) return path;
    if (await fileExists(join(path, '.git'))) return path;
  }
  return resolve(workspace);
}

async function firstExisting(paths: string[], fallback: string): Promise<string> {
  for (const path of paths) {
    if (await fileExists(path)) return path;
  }
  return fallback;
}

async function discoverExecutable(command: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return undefined;
}

async function detectAgent(id: AgentId): Promise<AgentSnapshot> {
  const definition = definitions[id];
  const executable = await discoverExecutable(definition.command);
  let version: string | undefined;
  if (executable) {
    try {
      const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
        timeout: 3_000,
      });
      version = `${stdout}${stderr}`.trim().split('\n')[0].replace(/\s+/g, ' ');
    } catch {
      version = undefined;
    }
  }
  const metadata = AGENTS.find((agent) => agent.id === id)!;
  return {
    ...metadata,
    detected: false,
    configPaths: [],
    occurrenceCount: 0,
    installed: Boolean(executable),
    version,
    executable,
  };
}

let detectedAgents: Promise<AgentSnapshot[]> | undefined;

export async function detectAgents(): Promise<AgentSnapshot[]> {
  detectedAgents ??= Promise.all((Object.keys(definitions) as AgentId[]).map(detectAgent));
  return detectedAgents;
}

export async function userTargetPath(agentId: AgentId): Promise<string> {
  const definition = definitions[agentId];
  if (agentId === 'amp') {
    return firstExisting(
      [
        join(homeDirectory(), '.config', 'amp', 'settings.jsonc'),
        join(homeDirectory(), '.config', 'amp', 'settings.json'),
      ],
      definition.userPath(),
    );
  }
  if (agentId === 'opencode') {
    const configRoot = process.env.XDG_CONFIG_HOME ?? join(homeDirectory(), '.config');
    return firstExisting(
      [
        join(configRoot, 'opencode', 'opencode.jsonc'),
        join(configRoot, 'opencode', 'opencode.json'),
      ],
      join(configRoot, 'opencode', 'opencode.json'),
    );
  }
  return definition.userPath();
}

async function nearestConfig(
  workspace: string,
  repositoryRoot: string,
  relativePaths: string[],
): Promise<string | undefined> {
  for (const directory of ancestors(workspace, repositoryRoot)) {
    for (const relativePath of relativePaths) {
      const candidate = join(directory, relativePath);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}

async function deduplicateConfigSources(sources: NativeConfigSource[]): Promise<NativeConfigSource[]> {
  const seen = new Set<string>();
  const output: NativeConfigSource[] = [];
  for (const source of sources) {
    let physicalPath: string;
    try {
      physicalPath = await realpath(source.path);
    } catch {
      physicalPath = resolve(source.path);
    }
    const key = [source.agentId, physicalPath, source.selector ?? '', source.projectKey ?? ''].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(source);
  }
  return output;
}

export async function discoverConfigSources(workspaceInput: string): Promise<NativeConfigSource[]> {
  const workspace = resolve(workspaceInput);
  const repositoryRoot = await findRepositoryRoot(workspace);
  const sources: NativeConfigSource[] = [];
  const claudeUser = await userTargetPath('claude');

  if (await fileExists(claudeUser)) {
    sources.push({
      agentId: 'claude',
      path: claudeUser,
      scope: 'local',
      precedence: 300,
      selector: 'claude-local',
      projectKey: workspace,
    });
    if (repositoryRoot !== workspace) {
      sources.push({
        agentId: 'claude',
        path: claudeUser,
        scope: 'local',
        precedence: 299,
        selector: 'claude-local',
        projectKey: repositoryRoot,
      });
    }
    sources.push({
      agentId: 'claude',
      path: claudeUser,
      scope: 'user',
      precedence: 100,
      selector: 'claude-user',
      projectKey: workspace,
    });
  }
  const claudeProject = join(repositoryRoot, '.mcp.json');
  if (await fileExists(claudeProject)) {
    sources.push({
      agentId: 'claude',
      path: claudeProject,
      scope: 'project',
      precedence: 200,
      selector: 'mcpServers',
    });
  }

  const codexUser = await userTargetPath('codex');
  if (await fileExists(codexUser)) {
    sources.push({ agentId: 'codex', path: codexUser, scope: 'user', precedence: 100 });
  }
  const codexDirectories = ancestors(workspace, repositoryRoot).reverse();
  for (const [index, directory] of codexDirectories.entries()) {
    const path = join(directory, '.codex', 'config.toml');
    if (await fileExists(path)) {
      sources.push({
        agentId: 'codex',
        path,
        scope: 'project',
        precedence: 200 + index,
      });
    }
  }

  const droidUser = await userTargetPath('droid');
  if (await fileExists(droidUser)) {
    sources.push({ agentId: 'droid', path: droidUser, scope: 'user', precedence: 400 });
  }
  const droidAncestors = ancestors(workspace).filter((path) => path !== homeDirectory()).reverse();
  for (const [index, directory] of droidAncestors.entries()) {
    const path = join(directory, '.factory', 'mcp.json');
    if (await fileExists(path) && path !== droidUser) {
      const isProject = directory === repositoryRoot;
      sources.push({
        agentId: 'droid',
        path,
        scope: isProject ? 'project' : 'folder',
        precedence: (isProject ? 200 : 300) + index,
      });
    }
  }

  const ampUser = await userTargetPath('amp');
  if (await fileExists(ampUser)) {
    sources.push({ agentId: 'amp', path: ampUser, scope: 'user', precedence: 100 });
  }
  const ampWorkspace = await nearestConfig(workspace, repositoryRoot, [
    join('.amp', 'settings.jsonc'),
    join('.amp', 'settings.json'),
  ]);
  if (ampWorkspace) {
    sources.push({
      agentId: 'amp',
      path: ampWorkspace,
      scope: 'workspace',
      precedence: 200,
    });
  }

  const openCodeUser = await userTargetPath('opencode');
  if (await fileExists(openCodeUser)) {
    sources.push({ agentId: 'opencode', path: openCodeUser, scope: 'user', precedence: 100 });
  }
  const openCodeCustom = process.env.OPENCODE_CONFIG;
  if (openCodeCustom && (await fileExists(resolve(openCodeCustom))) && resolve(openCodeCustom) !== openCodeUser) {
    sources.push({
      agentId: 'opencode',
      path: resolve(openCodeCustom),
      scope: 'user',
      precedence: 150,
    });
  }
  const openCodeProject = await nearestConfig(workspace, repositoryRoot, [
    'opencode.jsonc',
    'opencode.json',
  ]);
  if (openCodeProject) {
    sources.push({
      agentId: 'opencode',
      path: openCodeProject,
      scope: 'project',
      precedence: 200,
    });
  }

  return deduplicateConfigSources(sources);
}
