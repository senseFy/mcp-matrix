import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadNativeSnapshot } from './adapters';

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
  for (const key of ['MCP_MATRIX_HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'OPENCODE_CONFIG']) {
    originalEnvironment[key] = process.env[key];
  }
  process.env.MCP_MATRIX_HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  delete process.env.CODEX_HOME;
  delete process.env.OPENCODE_CONFIG;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe('native discovery and normalization', () => {
  it('reads all five agents and merges OpenCode MCP fields by precedence', async () => {
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

    const snapshot = await loadNativeSnapshot(workspace);
    const effective = snapshot.occurrences.filter((entry) => entry.source.effective);
    const openCode = effective.find((entry) => entry.agentId === 'opencode' && entry.name === 'shared');

    expect(snapshot.issues).toEqual([]);
    expect(new Set(effective.map((entry) => entry.agentId))).toEqual(
      new Set(['claude', 'codex', 'droid', 'amp', 'opencode']),
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
});
