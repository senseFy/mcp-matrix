import { describe, expect, it } from 'vitest';

import { buildFingerprints, toPublicOccurrence, type RawMcpOccurrence } from './domain';

function occurrence(): RawMcpOccurrence {
  const transport = {
    kind: 'http' as const,
    url: 'https://user:password@example.com/private/token/path-secret/9f8e7d6c4b2a1098?access_token=do-not-show&eyJhbGciOiJIUzI1NiJ9',
    command: 'npx',
    args: ['server', '--token', 'literal-command-secret'],
    env: { SAFE_NAME: 'still-private', API_TOKEN: 'env-secret' },
    headers: { Authorization: 'Bearer header-secret', 'X-Region': 'us-east-1' },
  };
  return {
    occurrenceId: 'example',
    agentId: 'claude',
    name: 'example',
    transport,
    enabled: true,
    ...buildFingerprints(transport, { transport, enabled: true }),
    source: {
      scope: 'user',
      path: '/tmp/config.json',
      hash: 'hash',
      effective: true,
      precedence: 100,
    },
    sourceRevisions: [{ path: '/tmp/config.json', hash: 'hash' }],
    warnings: [],
    native: {},
  };
}

describe('public MCP occurrence redaction', () => {
  it('exposes useful shape without environment, header, URL, or argument secrets', () => {
    const value = toPublicOccurrence(occurrence());
    const serialized = JSON.stringify(value);

    expect(value.transport.endpointOrigin).toBe('https://example.com');
    expect(value.transport.endpointPath).toBe('/private/token/••••••••/••••••••');
    expect(value.transport.queryKeys).toEqual(['sensitive parameter']);
    expect(value.transport.queryValueFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(value.transport.commandPreview).toBe('npx server --token ••••••••');
    expect(value.transport.envKeys).toEqual(['API_TOKEN', 'SAFE_NAME']);
    expect(value.transport.headerKeys).toEqual(['Authorization', 'X-Region']);
    expect(value.hasSecrets).toBe(true);
    for (const secret of [
      'password',
      'path-secret',
      '9f8e7d6c4b2a1098',
      'eyJhbGciOiJIUzI1NiJ9',
      'access_token',
      'do-not-show',
      'literal-command-secret',
      'still-private',
      'env-secret',
      'header-secret',
      'us-east-1',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('treats equivalent client-specific environment reference syntax as one identity', () => {
    const dollar = { kind: 'stdio' as const, command: 'node', args: ['${SCRIPT_PATH}'] };
    const openCode = { kind: 'stdio' as const, command: 'node', args: ['{env:SCRIPT_PATH}'] };

    expect(buildFingerprints(dollar, dollar)).toEqual(buildFingerprints(openCode, openCode));
  });

  it('groups exact stdio and remote variants into stable MCP families', () => {
    const gitKrakenClaude = {
      kind: 'stdio' as const,
      command: '/Applications/GitKraken CLI/gk',
      args: ['mcp', '--host=claude-cli'],
    };
    const gitKrakenCodex = {
      kind: 'stdio' as const,
      command: '/Applications/GitKraken CLI/gk',
      args: ['mcp', '--host=codex'],
    };
    const supabaseOne = {
      kind: 'http' as const,
      url: 'https://mcp.supabase.com/mcp?project_ref=one',
    };
    const supabaseTwo = {
      kind: 'http' as const,
      url: 'https://mcp.supabase.com/mcp?project_ref=two&features=database',
    };

    const gitKrakenFamilies = [gitKrakenClaude, gitKrakenCodex].map(
      (transport) => buildFingerprints(transport, transport),
    );
    const supabaseFamilies = [supabaseOne, supabaseTwo].map(
      (transport) => buildFingerprints(transport, transport),
    );

    expect(gitKrakenFamilies[0].familyFingerprint).toBe(gitKrakenFamilies[1].familyFingerprint);
    expect(gitKrakenFamilies[0].identityFingerprint).not.toBe(gitKrakenFamilies[1].identityFingerprint);
    expect(supabaseFamilies[0].familyFingerprint).toBe(supabaseFamilies[1].familyFingerprint);
    expect(supabaseFamilies[0].identityFingerprint).not.toBe(supabaseFamilies[1].identityFingerprint);
  });

  it('uses the launched package rather than a generic package runner as the family anchor', () => {
    const filesystem = { kind: 'stdio' as const, command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0'] };
    const postgres = { kind: 'stdio' as const, command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] };
    const newerFilesystem = { kind: 'stdio' as const, command: 'bunx', args: ['@modelcontextprotocol/server-filesystem@2.0.0'] };

    expect(buildFingerprints(filesystem, filesystem).familyFingerprint).toBe(
      buildFingerprints(newerFilesystem, newerFilesystem).familyFingerprint,
    );
    expect(buildFingerprints(filesystem, filesystem).familyFingerprint).not.toBe(
      buildFingerprints(postgres, postgres).familyFingerprint,
    );
  });

  it('conservatively splits generic launchers and runners with unknown options', () => {
    const github = { kind: 'stdio' as const, command: 'docker', args: ['run', '-i', 'mcp/github'] };
    const postgres = { kind: 'stdio' as const, command: 'docker', args: ['run', '-i', 'mcp/postgres'] };
    const git = { kind: 'stdio' as const, command: 'uvx', args: ['--python', '3.12', 'mcp-server-git'] };
    const fetch = { kind: 'stdio' as const, command: 'uvx', args: ['--python', '3.12', 'mcp-server-fetch'] };

    expect(buildFingerprints(github, github).familyFingerprint).not.toBe(
      buildFingerprints(postgres, postgres).familyFingerprint,
    );
    expect(buildFingerprints(git, git).familyFingerprint).not.toBe(
      buildFingerprints(fetch, fetch).familyFingerprint,
    );
  });
});
