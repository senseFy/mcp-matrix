#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const args = process.argv.slice(2);

function printHelp() {
  console.log(`MCP Matrix ${packageJson.version}

A local-first MCP configuration manager for coding agents.

Usage:
  mcp-matrix [--port <number>]

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version
  --port <number>  Listen on a custom loopback port (default: 4318)

Run this command from the workspace whose project-scoped MCP configuration
you want to inspect. MCP Matrix binds to 127.0.0.1 by default.`);
}

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--help' || argument === '-h') {
    printHelp();
    process.exit(0);
  }
  if (argument === '--version' || argument === '-v') {
    console.log(packageJson.version);
    process.exit(0);
  }
  if (argument === '--port') {
    const value = args[index + 1];
    const port = Number(value);
    if (!value || !Number.isInteger(port) || port < 1 || port > 65_535) {
      console.error('mcp-matrix: --port must be an integer from 1 through 65535.');
      process.exit(1);
    }
    process.env.PORT = value;
    index += 1;
    continue;
  }
  console.error(`mcp-matrix: unknown option ${argument}`);
  console.error('Run mcp-matrix --help for usage.');
  process.exit(1);
}

process.env.NODE_ENV = 'production';
await import('../dist-server/index.js');
