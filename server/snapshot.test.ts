import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadNativeSnapshot, serializeForAgent } from './adapters';

let root: string;
let home: string;
let workspace: string;
const originalEnvironment: Record<string, string | undefined> = {};

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-matrix-snapshot-'));
  home = join(root, 'home');
  workspace = join(root, 'workspace');
  await mkdir(join(workspace, '.git'), { recursive: true });
  for (const key of ['MCP_MATRIX_HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'OPENCODE_CONFIG', 'PI_CODING_AGENT_DIR']) {
    originalEnvironment[key] = process.env[key];
  }
  process.env.MCP_MATRIX_HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  delete process.env.CODEX_HOME;
  delete process.env.OPENCODE_CONFIG;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe('native discovery and normalization', () => {
  it('reads all seven agents and merges layered MCP fields by native precedence', async () => {
    await json(join(home, '.claude.json'), {
      mcpServers: {
        'claude-user': { type: 'http', url: 'https://claude.example/mcp' },
      },
      projects: {
        [workspace]: {
          mcpServers: { 'claude-local': { command: 'local-command' } },
        },
      },
    });
    await json(join(workspace, '.mcp.json'), {
      mcpServers: { 'claude-project': { command: 'project-command' } },
    });
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'config.toml'),
      '[mcp_servers.codex]\ncommand = "codex-command"\ntool_timeout_sec = 42\n',
    );
    await mkdir(join(workspace, '.codex'), { recursive: true });
    await writeFile(
      join(workspace, '.codex', 'config.toml'),
      '[mcp_servers.codex]\nenabled = false\n',
    );
    await json(join(home, '.factory', 'mcp.json'), {
      mcpServers: { droid: { command: 'droid-command', disabled: true } },
    });
    await json(join(home, '.config', 'amp', 'settings.json'), {
      'amp.mcpServers': { amp: { url: 'https://amp.example/sse' } },
    });
    await json(join(home, '.config', 'opencode', 'opencode.json'), {
      mcp: {
        shared: {
          type: 'remote',
          url: 'https://opencode.example/mcp',
          headers: { Authorization: 'Bearer {env:TOKEN}' },
        },
      },
    });
    await json(join(workspace, 'opencode.json'), {
      mcp: { shared: { enabled: false } },
    });
    await json(join(home, '.cursor', 'mcp.json'), {
      mcpServers: {
        cursor: {
          type: 'http',
          url: 'https://cursor.example/mcp',
          headers: { Authorization: 'Bearer ${env:CURSOR_TOKEN}' },
        },
      },
    });
    await json(join(home, '.pi', 'agent', 'mcp.json'), {
      mcpServers: {
        pi: {
          url: 'https://pi-user.example/mcp',
          auth: false,
          headers: { Authorization: 'Bearer ${PI_TOKEN}' },
          includeTools: ['read_*'],
          requestTimeoutMs: 15_000,
        },
      },
    });
    await json(join(workspace, '.pi', 'mcp.json'), {
      mcpServers: { pi: { url: 'https://pi-project.example/mcp', disabled: true } },
    });

    const snapshot = await loadNativeSnapshot(workspace);
    const effective = snapshot.occurrences.filter((entry) => entry.source.effective);
    const openCode = effective.find((entry) => entry.agentId === 'opencode' && entry.name === 'shared');

    expect(snapshot.issues).toEqual([]);
    expect(new Set(effective.map((entry) => entry.agentId))).toEqual(
      new Set(['claude', 'codex', 'droid', 'amp', 'opencode', 'cursor', 'pi']),
    );
    expect(openCode).toMatchObject({
      enabled: false,
      transport: {
        kind: 'http',
        url: 'https://opencode.example/mcp',
        headers: { Authorization: 'Bearer {env:TOKEN}' },
      },
      source: { scope: 'project', path: join(workspace, 'opencode.json') },
    });
    expect(openCode?.warnings.join(' ')).toContain('merges 2');
    const codex = effective.find((entry) => entry.agentId === 'codex' && entry.name === 'codex');
    expect(codex).toMatchObject({
      enabled: false,
      timeoutMs: 42_000,
      transport: { kind: 'stdio', command: 'codex-command' },
      source: { scope: 'project', path: join(workspace, '.codex', 'config.toml') },
    });
    expect(codex?.warnings.join(' ')).toContain('merges 2 Codex TOML');
    expect(codex?.sourceRevisions).toHaveLength(2);
    const cursor = effective.find((entry) => entry.agentId === 'cursor' && entry.name === 'cursor');
    expect(cursor).toMatchObject({
      enabled: true,
      transport: {
        kind: 'http',
        url: 'https://cursor.example/mcp',
        headers: { Authorization: 'Bearer ${env:CURSOR_TOKEN}' },
      },
      auth: { credentialKind: 'bearer-environment', environmentVariables: ['CURSOR_TOKEN'] },
      source: { scope: 'user', path: join(home, '.cursor', 'mcp.json') },
    });
    expect(cursor?.warnings.join(' ')).toContain('outside mcp.json');
    const pi = effective.find((entry) => entry.agentId === 'pi' && entry.name === 'pi');
    expect(pi).toMatchObject({
      enabled: false,
      timeoutMs: 15_000,
      includeTools: ['read_*'],
      transport: { kind: 'http', url: 'https://pi-project.example/mcp', headers: undefined },
      auth: { oauthMode: 'disabled' },
      source: { scope: 'project', path: join(workspace, '.pi', 'mcp.json') },
    });
    expect(pi?.warnings.join(' ')).toContain('merges 2 pi-mcp-adapter JSON');
    expect(pi?.sourceRevisions).toHaveLength(2);
  });

  it('does not treat the Codex user file as a project layer when the workspace is HOME', async () => {
    await mkdir(join(home, '.git'), { recursive: true });
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'config.toml'),
      '[mcp_servers.codex]\ncommand = "codex-command"\n',
    );

    const snapshot = await loadNativeSnapshot(home);
    const codexSources = snapshot.sources.filter((source) => source.agentId === 'codex');
    const codex = snapshot.occurrences.find(
      (entry) => entry.agentId === 'codex' && entry.name === 'codex' && entry.source.effective,
    );

    expect(codexSources).toHaveLength(1);
    expect(codexSources[0].scope).toBe('user');
    expect(codex?.source.scope).toBe('user');
    expect(codex?.warnings.join(' ')).not.toContain('merges');
  });

  it('deduplicates Codex config layers that resolve to the same physical file', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'config.toml'),
      '[mcp_servers.codex]\ncommand = "codex-command"\n',
    );
    await mkdir(join(workspace, '.codex'), { recursive: true });
    await symlink(join(home, '.codex', 'config.toml'), join(workspace, '.codex', 'config.toml'));

    const snapshot = await loadNativeSnapshot(workspace);
    const codexSources = snapshot.sources.filter((source) => source.agentId === 'codex');

    expect(codexSources).toHaveLength(1);
    expect(codexSources[0].scope).toBe('user');
  });

  it('marks a Claude remote entry without an explicit type as invalid', async () => {
    await json(join(home, '.claude.json'), {
      mcpServers: { broken: { url: 'https://example.com/mcp' } },
    });
    const snapshot = await loadNativeSnapshot(workspace);
    const broken = snapshot.occurrences.find((entry) => entry.name === 'broken');

    expect(broken?.transport.kind).toBe('unknown');
    expect(broken?.warnings.join(' ')).toContain('require type');
  });

  it('discovers the nearest Cursor project config without merging same-name user fields', async () => {
    await json(join(home, '.cursor', 'mcp.json'), {
      mcpServers: {
        shared: {
          type: 'stdio',
          command: 'user-command',
          env: { USER_ONLY: 'value' },
        },
      },
    });
    await json(join(workspace, '.cursor', 'mcp.json'), {
      mcpServers: {
        shared: { type: 'stdio', command: 'project-command' },
      },
    });

    const snapshot = await loadNativeSnapshot(workspace);
    const cursorSources = snapshot.sources.filter((source) => source.agentId === 'cursor');
    const effective = snapshot.occurrences.find(
      (entry) => entry.agentId === 'cursor' && entry.name === 'shared' && entry.source.effective,
    );

    expect(cursorSources).toHaveLength(2);
    expect(effective).toMatchObject({
      transport: { kind: 'stdio', command: 'project-command', env: undefined },
      source: { scope: 'project', path: join(workspace, '.cursor', 'mcp.json') },
    });
  });

  it('accepts Cursor URL-only remote config but blocks transport guessing during distribution', async () => {
    await json(join(home, '.cursor', 'mcp.json'), {
      mcpServers: { remote: { url: 'https://cursor.example/mcp' } },
    });

    const snapshot = await loadNativeSnapshot(workspace);
    const remote = snapshot.occurrences.find(
      (entry) => entry.agentId === 'cursor' && entry.name === 'remote',
    );

    expect(remote?.transport.kind).toBe('http');
    expect(remote?.warnings.join(' ')).toContain('add type: http or sse');
    expect(serializeForAgent('claude', remote!).spec).toBeUndefined();
    expect(serializeForAgent('claude', remote!).errors.join(' ')).toContain('did not declare');
  });

  it('normalizes native authentication strategies without reading runtime sessions', async () => {
    await json(join(home, '.claude.json'), {
      mcpServers: {
        claude: {
          type: 'http',
          url: 'https://claude.example/mcp',
          headers: { Authorization: 'Bearer ${CLAUDE_TOKEN}' },
        },
      },
    });
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'config.toml'),
      '[mcp_servers.codex]\nurl = "https://codex.example/mcp"\nbearer_token_env_var = "CODEX_TOKEN"\n',
    );
    await json(join(home, '.factory', 'mcp.json'), {
      mcpServers: {
        droid: {
          type: 'http',
          url: 'https://droid.example/mcp',
          oauth: false,
          headers: { Authorization: 'Bearer ${DROID_TOKEN}' },
        },
      },
    });
    await json(join(home, '.config', 'amp', 'settings.json'), {
      'amp.mcpServers': {
        amp: { url: 'https://amp.example/mcp', headers: { 'X-Auth': '${AMP_KEY}' } },
      },
    });
    await json(join(home, '.config', 'opencode', 'opencode.json'), {
      mcp: {
        opencode: {
          type: 'remote',
          url: 'https://opencode.example/mcp',
          oauth: { clientId: 'public-client', scopes: ['read'] },
        },
      },
    });
    await json(join(home, '.cursor', 'mcp.json'), {
      mcpServers: {
        cursor: {
          type: 'http',
          url: 'https://cursor.example/mcp',
          auth: {
            CLIENT_ID: 'public-client',
            CLIENT_SECRET: '${env:CURSOR_CLIENT_SECRET}',
            scopes: ['read'],
          },
        },
      },
    });
    await json(join(home, '.pi', 'agent', 'mcp.json'), {
      mcpServers: {
        pi: {
          url: 'https://pi.example/mcp',
          auth: 'bearer',
          bearerTokenEnv: 'PI_TOKEN',
        },
      },
    });

    const snapshot = await loadNativeSnapshot(workspace);
    const auth = Object.fromEntries(
      snapshot.occurrences
        .filter((entry) => entry.source.effective)
        .map((entry) => [entry.agentId, entry.auth]),
    );

    expect(auth.claude).toMatchObject({ credentialKind: 'bearer-environment', environmentVariables: ['CLAUDE_TOKEN'] });
    expect(auth.codex).toMatchObject({ credentialKind: 'bearer-environment', environmentVariables: ['CODEX_TOKEN'] });
    expect(auth.droid).toMatchObject({ oauthMode: 'disabled', credentialKind: 'bearer-environment' });
    expect(auth.amp).toMatchObject({ credentialKind: 'header-environment', environmentVariables: ['AMP_KEY'] });
    expect(auth.opencode).toMatchObject({ oauthMode: 'pre-registered', credentialKind: 'none' });
    expect(auth.cursor).toMatchObject({
      oauthMode: 'pre-registered',
      credentialKind: 'none',
      environmentVariables: ['CURSOR_CLIENT_SECRET'],
      scopes: ['read'],
    });
    expect(auth.pi).toMatchObject({ credentialKind: 'bearer-environment', environmentVariables: ['PI_TOKEN'] });
  });
});
