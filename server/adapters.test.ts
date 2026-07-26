import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import {
  addServerToContent,
  serializeForAgent,
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
    enabled: true,
    ...buildFingerprints(transport, { transport, enabled: true }),
    source: {
      scope: 'user',
      path: '/tmp/source',
      hash: 'hash',
      effective: true,
      precedence: 100,
    },
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

    expect(serializeForAgent('opencode', source)).toEqual({
      spec: {
        type: 'remote',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer {env:MCP_TOKEN}' },
      },
      warnings: [],
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
});
