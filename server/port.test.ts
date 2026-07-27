import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  confirmReplaceRunningInstance,
  isMcpMatrixCommand,
  parseLsofListenPids,
  portInUseMessage,
} from './port';

describe('mcp-matrix port takeover helpers', () => {
  it('recognizes installed and local mcp-matrix command lines', () => {
    expect(isMcpMatrixCommand('/usr/local/bin/mcp-matrix')).toBe(true);
    expect(isMcpMatrixCommand('node /Users/me/projects/mcp-matrix/dist-server/index.js')).toBe(true);
    expect(isMcpMatrixCommand('node /Users/me/projects/mcp-matrix/node_modules/tsx/dist/cli.mjs watch server/index.ts')).toBe(true);
    expect(isMcpMatrixCommand('node /opt/other-app/server.js')).toBe(false);
    expect(isMcpMatrixCommand('node dist-server\\index.js')).toBe(true);
  });

  it('parses lsof pid records', () => {
    expect(parseLsofListenPids('p4318\np999\n')).toEqual([4318, 999]);
    expect(parseLsofListenPids('')).toEqual([]);
  });

  it('explains replaceable and foreign port conflicts', () => {
    expect(
      portInUseMessage(4318, 4319, {
        pid: 42,
        command: 'node /tmp/mcp-matrix/dist-server/index.js',
      }),
    ).toContain('mcp-matrix (pid 42)');
    expect(portInUseMessage(4318, 4319)).toBe('Port 4318 is already in use. Try: mcp-matrix --port 4319');
  });

  it('defaults the replace prompt to yes', async () => {
    const input = Readable.from(['\n']);
    let output = '';
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });

    await expect(
      confirmReplaceRunningInstance(4318, { pid: 77, command: 'mcp-matrix' }, { input, output: stdout }),
    ).resolves.toBe(true);
    expect(output).toContain('pid 77');
  });

  it('accepts an explicit no for keeping the running instance', async () => {
    const input = Readable.from(['n\n']);
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    await expect(
      confirmReplaceRunningInstance(4318, { pid: 77, command: 'mcp-matrix' }, { input, output: stdout }),
    ).resolves.toBe(false);
  });
});
