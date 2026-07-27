import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import {
  addServerToContent,
  nativeSpecWithAuthUpdate,
  serializeForAgent,
  updateAuthInContent,
} from './adapters';
import { buildFingerprints, type RawMcpOccurrence, type RawTransport } from './domain';
import type { AgentId } from '../src/types';

function occurrence(
  agentId: AgentId,
  transport: RawTransport,
  native: Record<string, unknown> = {},
): RawMcpOccurrence {
  return {
    occurrenceId: 'source',
    agentId,
    name: 'source',
    transport,
    auth: {
      oauthMode: transport.kind === 'stdio' ? 'not-applicable' : 'automatic',
      credentialKind: 'none',
      credentialHeaderKeys: [],
      environmentVariables: [],
    },
    enabled: true,
    ...buildFingerprints(transport, { transport, enabled: true }),
    source: {
      scope: 'user',
      path: '/tmp/source',
      hash: 'hash',
      effective: true,
      precedence: 100,
    },
    sourceRevisions: [{ path: '/tmp/source', hash: 'hash' }],
    warnings: [],
    native,
  };
}

describe('target-native serialization', () => {
  it('converts environment references into OpenCode syntax', () => {
    const source = occurrence('claude', {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
    });

    expect(serializeForAgent('opencode', source)).toMatchObject({
      spec: {
        type: 'remote',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer {env:MCP_TOKEN}' },
      },
      errors: [],
    });
  });

  it('blocks reference conversions that would silently change semantics', () => {
    const fileReference = occurrence('opencode', {
      kind: 'stdio',
      command: 'node',
      env: { TOKEN: '{file:~/.secrets/token}' },
    });
    const defaultReference = occurrence('claude', {
      kind: 'stdio',
      command: 'node',
      env: { ENDPOINT: '${ENDPOINT:-https://example.com}' },
    });

    expect(serializeForAgent('droid', fileReference).spec).toBeUndefined();
    expect(serializeForAgent('droid', fileReference).errors.join(' ')).toContain('no portable equivalent');
    expect(serializeForAgent('opencode', defaultReference).spec).toBeUndefined();
    expect(serializeForAgent('opencode', defaultReference).errors.join(' ')).toContain('cannot preserve');
  });

  it('maps pure environment forwarding and bearer headers into Codex fields', () => {
    const source = occurrence('droid', {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: {
        Authorization: 'Bearer ${MCP_TOKEN}',
        'X-Tenant': '${TENANT}',
      },
    });

    expect(serializeForAgent('codex', source).spec).toEqual({
      url: 'https://mcp.example.com/mcp',
      bearer_token_env_var: 'MCP_TOKEN',
      env_http_headers: { 'X-Tenant': 'TENANT' },
    });
  });

  it('rejects legacy remote transports unsupported by Codex', () => {
    const source = occurrence('droid', {
      kind: 'sse',
      url: 'https://mcp.example.com/sse',
    });
    expect(serializeForAgent('codex', source).errors.join(' ')).toContain('Streamable HTTP');
  });

  it('does not spread literal credentials into another agent config', () => {
    const source = occurrence('droid', {
      kind: 'http',
      url: 'https://user:password@mcp.example.com/mcp?api_key=literal',
      headers: { Authorization: 'Bearer literal-token' },
      env: { API_TOKEN: 'literal-token' },
    });
    const result = serializeForAgent('claude', source);

    expect(result.spec).toBeUndefined();
    expect(result.errors.join(' ')).toContain('literal secret');
    expect(result.errors.join(' ')).toContain('literal credentials');
  });

  it.each([
    ['claude', { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } }],
    ['codex', { url: 'https://mcp.example.com/mcp', bearer_token_env_var: 'TOKEN' }],
    ['droid', { type: 'http', url: 'https://mcp.example.com/mcp', oauth: false, headers: { Authorization: 'Bearer ${TOKEN}' } }],
    ['amp', { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } }],
    ['opencode', { type: 'remote', url: 'https://mcp.example.com/mcp', oauth: false, headers: { Authorization: 'Bearer {env:TOKEN}' } }],
  ] as const)('writes environment-backed bearer authentication for %s', (agentId, expected) => {
    const source = occurrence(agentId, {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
    }, agentId === 'opencode'
      ? { type: 'remote', url: 'https://mcp.example.com/mcp' }
      : agentId === 'droid' || agentId === 'claude'
        ? { type: 'http', url: 'https://mcp.example.com/mcp' }
        : { url: 'https://mcp.example.com/mcp' });

    expect(nativeSpecWithAuthUpdate(source, {
      kind: 'bearer-environment',
      environmentVariable: 'TOKEN',
    }).spec).toEqual(expected);
  });

  it('writes safe pre-registered OAuth client metadata without a literal secret', () => {
    const source = occurrence('droid', {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
    }, { type: 'http', url: 'https://mcp.example.com/mcp' });
    const result = nativeSpecWithAuthUpdate(source, {
      kind: 'oauth-client',
      authorizationServerIssuer: 'https://auth.example.com/',
      clientId: 'public-client-id',
      scopes: ['read'],
      callbackPort: 4891,
    });

    expect(result.errors).toEqual([]);
    expect(result.spec).toMatchObject({
      oauth: {
        authorizationServerIssuer: 'https://auth.example.com/',
        clientId: 'public-client-id',
        scopes: ['read'],
        callbackPort: 4891,
      },
    });
    expect(JSON.stringify(result)).not.toContain('clientSecret');
  });

  it('rejects literal credentials disguised as custom header prefixes', () => {
    const source = occurrence('droid', {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
    }, { type: 'http', url: 'https://mcp.example.com/mcp' });

    expect(() => nativeSpecWithAuthUpdate(source, {
      kind: 'header-environment',
      headerName: 'Authorization',
      environmentVariable: 'TOKEN_SUFFIX',
      prefix: 'Bearer sk-live-credential-value',
    })).toThrow('cannot contain literal credentials');
  });
});

describe('minimal native edits', () => {
  it('preserves JSONC comments and unrelated settings', () => {
    const before = `{
  // keep this comment
  "theme": "dark",
  "amp.mcpServers": {
    "existing": { "command": "existing" }
  }
}
`;
    const after = addServerToContent('amp', before, 'new-server', {
      command: 'npx',
      args: ['-y', 'server'],
    });
    const parsed = parseJsonc(after) as Record<string, unknown>;

    expect(after).toContain('// keep this comment');
    expect(parsed.theme).toBe('dark');
    expect((parsed['amp.mcpServers'] as Record<string, unknown>)['existing']).toBeDefined();
    expect((parsed['amp.mcpServers'] as Record<string, unknown>)['new-server']).toEqual({
      command: 'npx',
      args: ['-y', 'server'],
    });
  });

  it('changes only JSON authentication fields and preserves comments and native options', () => {
    const before = `{
  // keep this comment
  "amp.mcpServers": {
    "source": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "X-Tenant": "tenant-one" },
      "includeTools": ["read"]
    }
  }
}
`;
    const source = occurrence('amp', {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Tenant': 'tenant-one' },
    }, {
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Tenant': 'tenant-one' },
      includeTools: ['read'],
    });
    source.nativePath = ['amp.mcpServers', 'source'];
    const spec = nativeSpecWithAuthUpdate(source, {
      kind: 'bearer-environment',
      environmentVariable: 'MCP_TOKEN',
    }).spec!;
    const after = updateAuthInContent('amp', before, source, spec);
    const parsed = parseJsonc(after) as { 'amp.mcpServers': Record<string, Record<string, unknown>> };

    expect(after).toContain('// keep this comment');
    expect(parsed['amp.mcpServers'].source).toMatchObject({
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Tenant': 'tenant-one', Authorization: 'Bearer ${MCP_TOKEN}' },
      includeTools: ['read'],
    });
  });

  it('appends a valid Codex table without reformatting existing TOML', () => {
    const before = '# keep this comment\nmodel = "gpt-5"\n';
    const after = addServerToContent('codex', before, 'docs server', {
      command: 'npx',
      args: ['-y', '@example/mcp'],
      env: { TOKEN: 'literal' },
    });
    const parsed = parseToml(after) as Record<string, unknown>;

    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('[mcp_servers."docs server"]');
    expect((parsed.mcp_servers as Record<string, unknown>)['docs server']).toBeDefined();
  });

  it('preserves comments adjacent to replaced Codex auth fields', () => {
    const source = occurrence('codex', {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
    }, {
      url: 'https://mcp.example.com/mcp',
      bearer_token_env_var: 'OLD_TOKEN',
    });
    const before = `[mcp_servers.source]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "OLD_TOKEN"
# rotate this credential quarterly
enabled = true
`;
    const spec = nativeSpecWithAuthUpdate(source, {
      kind: 'bearer-environment',
      environmentVariable: 'NEW_TOKEN',
    }).spec!;
    const after = updateAuthInContent('codex', before, source, spec);

    expect(after).toContain('# rotate this credential quarterly');
    expect(after).toContain('bearer_token_env_var = "NEW_TOKEN"');
    expect(after).not.toContain('OLD_TOKEN');
    expect(parseToml(after)).toBeDefined();
  });
});
