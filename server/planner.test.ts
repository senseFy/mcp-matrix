import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadNativeSnapshot } from './adapters';
import { applyPlan, createAuthPlan, createCopyPlan, undoApply } from './planner';

let root: string;
let home: string;
let workspace: string;
let sourcePath: string;
let targetPath: string;
let targetBefore: string;
const originalEnvironment: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-matrix-plan-'));
  home = join(root, 'home');
  workspace = join(root, 'workspace');
  sourcePath = join(home, '.factory', 'mcp.json');
  targetPath = join(home, '.config', 'amp', 'settings.json');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(join(sourcePath, '..'), { recursive: true });
  await mkdir(join(targetPath, '..'), { recursive: true });
  await writeFile(
    sourcePath,
    `${JSON.stringify({
      mcpServers: {
        portable: {
          command: 'npx',
          args: ['-y', '@example/server'],
          env: { SERVICE_MODE: 'literal-private-setting-that-must-not-leak' },
        },
        revenuecat: {
          type: 'http',
          url: 'https://mcp.revenuecat.ai/mcp',
        },
        unsafe: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'sk-live-literal-credential${TOKEN_SUFFIX}' },
        },
      },
    }, null, 2)}\n`,
  );
  targetBefore = `{
  // unrelated settings and comments must survive
  "amp.showCosts": false,
  "amp.mcpServers": {}
}
`;
  await writeFile(targetPath, targetBefore);
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

async function sourceOccurrenceId(): Promise<string> {
  const snapshot = await loadNativeSnapshot(workspace);
  return snapshot.occurrences.find((entry) => entry.agentId === 'droid' && entry.name === 'portable')!
    .occurrenceId;
}

describe('safe write workflow', () => {
  it('dry-runs, masks secrets, atomically applies, verifies, and undoes', async () => {
    const plan = await createCopyPlan({
      workspace,
      occurrenceId: await sourceOccurrenceId(),
      targetAgentId: 'amp',
    });

    expect(await readFile(targetPath, 'utf8')).toBe(targetBefore);
    expect(plan.unifiedDiff).toContain('SERVICE_MODE');
    expect(plan.unifiedDiff).toContain('••••••••');
    expect(plan.unifiedDiff).not.toContain('literal-private-setting-that-must-not-leak');

    const applied = await applyPlan(plan.planId);
    const targetAfter = await readFile(targetPath, 'utf8');
    expect(targetAfter).toContain('// unrelated settings and comments must survive');
    expect(targetAfter).toContain('"portable"');
    expect(applied.targetPath).toBe(targetPath);

    await undoApply(applied.undoToken);
    expect(await readFile(targetPath, 'utf8')).toBe(targetBefore);
  });

  it('refuses to overwrite a target changed after preview', async () => {
    const plan = await createCopyPlan({
      workspace,
      occurrenceId: await sourceOccurrenceId(),
      targetAgentId: 'amp',
    });
    const externalEdit = `${targetBefore}\n// edited after preview\n`;
    await writeFile(targetPath, externalEdit);

    await expect(applyPlan(plan.planId)).rejects.toThrow('changed after this preview');
    expect(await readFile(targetPath, 'utf8')).toBe(externalEdit);
  });

  it('refuses a plan when any contributing source layer changes', async () => {
    const codexUser = join(home, '.codex', 'config.toml');
    const codexProject = join(workspace, '.codex', 'config.toml');
    await mkdir(join(codexUser, '..'), { recursive: true });
    await mkdir(join(codexProject, '..'), { recursive: true });
    await writeFile(codexUser, '[mcp_servers.layered]\ncommand = "node"\nargs = ["server.js"]\n');
    await writeFile(codexProject, '[mcp_servers.layered]\nenabled = true\n');
    const snapshot = await loadNativeSnapshot(workspace);
    const source = snapshot.occurrences.find(
      (entry) => entry.agentId === 'codex' && entry.name === 'layered' && entry.source.effective,
    )!;
    const plan = await createCopyPlan({
      workspace,
      occurrenceId: source.occurrenceId,
      targetAgentId: 'claude',
    });

    await writeFile(codexUser, '[mcp_servers.layered]\ncommand = "node"\nargs = ["changed.js"]\n');

    await expect(applyPlan(plan.planId)).rejects.toThrow('source configuration changed');
  });

  it('refuses a plan when a newly discovered layer changes the effective source', async () => {
    const codexUser = join(home, '.codex', 'config.toml');
    await mkdir(join(codexUser, '..'), { recursive: true });
    await writeFile(codexUser, '[mcp_servers.layered]\ncommand = "node"\nargs = ["server.js"]\n');
    const snapshot = await loadNativeSnapshot(workspace);
    const source = snapshot.occurrences.find(
      (entry) => entry.agentId === 'codex' && entry.name === 'layered' && entry.source.effective,
    )!;
    const plan = await createCopyPlan({
      workspace,
      occurrenceId: source.occurrenceId,
      targetAgentId: 'claude',
    });
    const codexProject = join(workspace, '.codex', 'config.toml');
    await mkdir(join(codexProject, '..'), { recursive: true });
    await writeFile(codexProject, '[mcp_servers.layered]\nenabled = false\n');

    await expect(applyPlan(plan.planId)).rejects.toThrow('effective source configuration changed');
  });

  it('refuses a plan when another target layer gains a name conflict', async () => {
    const plan = await createCopyPlan({
      workspace,
      occurrenceId: await sourceOccurrenceId(),
      targetAgentId: 'amp',
    });
    const workspaceTarget = join(workspace, '.amp', 'settings.json');
    await mkdir(join(workspaceTarget, '..'), { recursive: true });
    await writeFile(
      workspaceTarget,
      `${JSON.stringify({
        'amp.mcpServers': { portable: { command: 'another-command' } },
      })}\n`,
    );

    await expect(applyPlan(plan.planId)).rejects.toThrow('target effective configuration gained');
    expect(await readFile(targetPath, 'utf8')).toBe(targetBefore);
  });

  it('reconciles a URL-only Droid server to a generic environment-backed bearer strategy', async () => {
    const snapshot = await loadNativeSnapshot(workspace);
    const revenuecat = snapshot.occurrences.find(
      (entry) => entry.agentId === 'droid' && entry.name === 'revenuecat' && entry.source.effective,
    )!;
    const before = await readFile(sourcePath, 'utf8');
    const plan = await createAuthPlan({
      workspace,
      occurrenceId: revenuecat.occurrenceId,
      auth: {
        kind: 'bearer-environment',
        environmentVariable: 'REVENUECAT_API_V2_SECRET_KEY',
      },
    });

    expect(plan.operation).toBe('configure-auth');
    expect(plan.unifiedDiff).toContain('REVENUECAT_API_V2_SECRET_KEY');
    expect(plan.unifiedDiff).toContain('Bearer ${REVENUECAT_API_V2_SECRET_KEY}');
    expect(plan.unifiedDiff).toContain('"oauth": false');
    expect(await readFile(sourcePath, 'utf8')).toBe(before);

    const applied = await applyPlan(plan.planId);
    const configured = JSON.parse(await readFile(sourcePath, 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(configured.mcpServers.revenuecat).toMatchObject({
      type: 'http',
      url: 'https://mcp.revenuecat.ai/mcp',
      oauth: false,
      headers: { Authorization: 'Bearer ${REVENUECAT_API_V2_SECRET_KEY}' },
    });
    expect(configured.mcpServers.portable).toBeDefined();

    await undoApply(applied.undoToken);
    expect(await readFile(sourcePath, 'utf8')).toBe(before);
  });

  it('masks a literal prefix even when a credential header ends in an environment reference', async () => {
    const snapshot = await loadNativeSnapshot(workspace);
    const unsafe = snapshot.occurrences.find(
      (entry) => entry.agentId === 'droid' && entry.name === 'unsafe' && entry.source.effective,
    )!;
    const plan = await createAuthPlan({
      workspace,
      occurrenceId: unsafe.occurrenceId,
      auth: { kind: 'oauth-disabled' },
    });

    expect(plan.unifiedDiff).not.toContain('sk-live-literal-credential');
    expect(plan.unifiedDiff).toContain('••••••••');
  });
});
