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

  it('converts portable environment references into Cursor syntax', () => {
    const source = occurrence('opencode', {
      kind: 'stdio',
      command: 'node',
      args: ['{env:SERVER_SCRIPT}'],
      cwd: '$env:SERVER_ROOT',
      env: { TOKEN: '${TOKEN}' },
    });

    expect(serializeForAgent('cursor', source)).toMatchObject({
      spec: {
        type: 'stdio',
        command: 'node',
        args: ['${env:SERVER_SCRIPT}'],
        cwd: '${env:SERVER_ROOT}',
        env: { TOKEN: '${env:TOKEN}' },
      },
      errors: [],
    });
  });

  it('does not reinterpret Cursor path interpolation as another agent environment variable', () => {
    const source = occurrence('cursor', {
      kind: 'stdio',
      command: 'node',
      args: ['${workspaceFolder}/server.js'],
    }, {
      type: 'stdio',
      command: 'node',
      args: ['${workspaceFolder}/server.js'],
    });

    expect(serializeForAgent('droid', source).spec).toBeUndefined();
    expect(serializeForAgent('droid', source).errors.join(' ')).toContain('Cursor path interpolation');
  });

  it('preserves an existing agent environment variable whose name matches a Cursor built-in', () => {
    const source = occurrence('claude', {
      kind: 'stdio',
      command: 'node',
      env: { ROOT: '${workspaceFolder}' },
    });

    expect(serializeForAgent('droid', source)).toMatchObject({
      spec: {
        type: 'stdio',
        command: 'node',
        env: { ROOT: '${workspaceFolder}' },
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
    ['cursor', { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${env:TOKEN}' } }],
    ['pi', { url: 'https://mcp.example.com/mcp', auth: 'bearer', bearerTokenEnv: 'TOKEN' }],
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

  it('writes Pi OAuth metadata with an environment-backed client secret', () => {
    const source = occurrence('pi', {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
    }, { url: 'https://mcp.example.com/mcp' });
    const result = nativeSpecWithAuthUpdate(source, {
      kind: 'oauth-client',
      clientId: 'public-client-id',
      clientSecretEnvironmentVariable: 'MCP_CLIENT_SECRET',
      scopes: ['read', 'write'],
    });

    expect(result.errors).toEqual([]);
    expect(result.spec).toEqual({
      url: 'https://mcp.example.com/mcp',
      auth: 'oauth',
      oauth: {
        clientId: 'public-client-id',
        clientSecret: '${MCP_CLIENT_SECRET}',
        scope: 'read write',
      },
    });
  });

  it('writes Cursor static OAuth metadata with an environment-backed client secret', () => {
    const source = occurrence('cursor', {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
    }, { type: 'http', url: 'https://mcp.example.com/mcp' });
    const result = nativeSpecWithAuthUpdate(source, {
      kind: 'oauth-client',
      clientId: 'public-client-id',
      clientSecretEnvironmentVariable: 'MCP_CLIENT_SECRET',
      scopes: ['read', 'write'],
    });

    expect(result.errors).toEqual([]);
    expect(result.spec).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: {
        CLIENT_ID: 'public-client-id',
        CLIENT_SECRET: '${env:MCP_CLIENT_SECRET}',
        scopes: ['read', 'write'],
      },
    });
  });

  it('serializes portable options and Pi environment syntax', () => {
    const source = occurrence('opencode', {
      kind: 'stdio',
      command: 'node',
      args: ['{env:SERVER_SCRIPT}'],
      cwd: '$env:SERVER_ROOT',
      env: { TOKEN: '{env:TOKEN}' },
    });
    source.enabled = false;
    source.timeoutMs = 25_000;
    source.includeTools = ['read_*'];
    source.excludeTools = ['*_dangerous'];

    expect(serializeForAgent('pi', source)).toMatchObject({
      spec: {
        command: 'node',
        args: ['${SERVER_SCRIPT}'],
        cwd: '${SERVER_ROOT}',
        env: { TOKEN: '${TOKEN}' },
        disabled: true,
        requestTimeoutMs: 25_000,
        includeTools: ['read_*'],
        excludeTools: ['*_dangerous'],
      },
      errors: [],
    });
  });

  it('blocks Pi command-backed values and preserves escaped literal exclamation marks', () => {
    const commandBacked = occurrence('pi', {
      kind: 'stdio',
      command: 'node',
      env: { TENANT: '!security find-generic-password -w -s tenant' },
    }, {
      command: 'node',
      env: { TENANT: '!security find-generic-password -w -s tenant' },
    });
    const escapedLiteral = occurrence('pi', {
      kind: 'stdio',
      command: 'node',
      env: { MODE: '!literal-mode' },
    }, {
      command: 'node',
      env: { MODE: '!!literal-mode' },
    });

    expect(serializeForAgent('claude', commandBacked).errors.join(' ')).toContain('command-backed');
    expect(serializeForAgent('claude', commandBacked).spec).toBeUndefined();
    expect(serializeForAgent('claude', escapedLiteral)).toMatchObject({
      spec: { type: 'stdio', command: 'node', env: { MODE: '!literal-mode' } },
      errors: [],
    });
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

  it('preserves Pi legacy mcp-servers and updates only adapter auth fields', () => {
    const before = `{
  // keep Pi adapter settings
  "settings": { "autoAuth": true },
  "mcp-servers": {
    "source": {
      "url": "https://mcp.example.com/mcp",
      "auth": "bearer",
      "bearerTokenEnv": "OLD_TOKEN",
      "includeTools": ["read"]
    }
  }
}
`;
    const source = occurrence('pi', {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${OLD_TOKEN}' },
    }, {
      url: 'https://mcp.example.com/mcp',
      auth: 'bearer',
      bearerTokenEnv: 'OLD_TOKEN',
      includeTools: ['read'],
    });
    source.nativePath = ['mcp-servers', 'source'];
    const spec = nativeSpecWithAuthUpdate(source, {
      kind: 'bearer-environment',
      environmentVariable: 'NEW_TOKEN',
    }).spec!;
    const after = updateAuthInContent('pi', before, source, spec);
    const parsed = parseJsonc(after) as {
      settings: Record<string, unknown>;
      'mcp-servers': Record<string, Record<string, unknown>>;
    };

    expect(after).toContain('// keep Pi adapter settings');
    expect(parsed.settings.autoAuth).toBe(true);
    expect(parsed['mcp-servers'].source).toEqual({
      url: 'https://mcp.example.com/mcp',
      auth: 'bearer',
      bearerTokenEnv: 'NEW_TOKEN',
      includeTools: ['read'],
    });
    const withNewServer = addServerToContent('pi', after, 'new-server', { command: 'new-command' });
    expect((parseJsonc(withNewServer) as { 'mcp-servers': Record<string, unknown> })['mcp-servers']['new-server']).toEqual({
      command: 'new-command',
    });
  });

  it('preserves Cursor JSONC while replacing static OAuth with an environment header', () => {
    const before = `{
  // keep Cursor settings
  "theme": "dark",
  "mcpServers": {
    "source": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "auth": { "CLIENT_ID": "old-client", "scopes": ["read"] },
      "futureOption": true
    }
  }
}
`;
    const source = occurrence('cursor', {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
    }, {
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: { CLIENT_ID: 'old-client', scopes: ['read'] },
      futureOption: true,
    });
    const spec = nativeSpecWithAuthUpdate(source, {
      kind: 'bearer-environment',
      environmentVariable: 'NEW_TOKEN',
    }).spec!;
    const after = updateAuthInContent('cursor', before, source, spec);
    const parsed = parseJsonc(after) as {
      theme: string;
      mcpServers: Record<string, Record<string, unknown>>;
    };

    expect(after).toContain('// keep Cursor settings');
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcpServers.source).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${env:NEW_TOKEN}' },
      futureOption: true,
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
