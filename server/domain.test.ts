import { describe, expect, it } from 'vitest';

import { buildFingerprints, toPublicOccurrence, type RawMcpOccurrence } from './domain';

function occurrence(): RawMcpOccurrence {
  const transport = {
    kind: 'http' as const,
    url: 'https://user:password@example.com/private/mcp?access_token=do-not-show',
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
    warnings: [],
    native: {},
  };
}

describe('public MCP occurrence redaction', () => {
  it('exposes useful shape without environment, header, URL, or argument secrets', () => {
    const value = toPublicOccurrence(occurrence());
    const serialized = JSON.stringify(value);

    expect(value.transport.endpointHost).toBe('https://example.com');
    expect(value.transport.commandPreview).toBe('npx server --token ••••••••');
    expect(value.transport.envKeys).toEqual(['API_TOKEN', 'SAFE_NAME']);
    expect(value.transport.headerKeys).toEqual(['Authorization', 'X-Region']);
    expect(value.hasSecrets).toBe(true);
    for (const secret of [
      'password',
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
});
