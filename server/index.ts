import { createReadStream } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentId, AuthUpdate, SnapshotResponse } from '../src/types';
import { loadNativeSnapshot } from './adapters';
import { AGENTS, toPublicOccurrence } from './domain';
import { detectAgents } from './discovery';
import { applyPlan, createAuthPlan, createCopyPlan, undoApply } from './planner';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4318);
const development = process.env.NODE_ENV !== 'production';
const agentIds = new Set<AgentId>(AGENTS.map((agent) => agent.id));
const mutationToken = randomBytes(32).toString('base64url');

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

function localOriginOnly(request: IncomingMessage): void {
  const origin = request.headers.origin;
  if (!origin) return;
  const url = new URL(origin);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('Cross-origin requests are not allowed.');
  }
  const host = request.headers.host;
  if (host && url.host !== host) throw new Error('Cross-origin requests are not allowed.');
}

function requireMutationToken(request: IncomingMessage): void {
  const supplied = request.headers['x-mcp-matrix-token'];
  if (typeof supplied !== 'string') throw new Error('Missing mutation token. Refresh the page and try again.');
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(mutationToken);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    throw new Error('Invalid mutation token. Refresh the page and try again.');
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON body must be an object.');
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value) throw new Error(`${key} is required.`);
  return value;
}

function parseAgentId(body: Record<string, unknown>, key: string): AgentId {
  const value = requiredString(body, key) as AgentId;
  if (!agentIds.has(value)) throw new Error(`Unsupported agent: ${value}`);
  return value;
}

function optionalStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function parseAuthUpdate(value: unknown): AuthUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('auth must be an object.');
  const auth = value as Record<string, unknown>;
  const kind = requiredString(auth, 'kind');
  if (kind === 'automatic-oauth') {
    return {
      kind,
      scopes: optionalStringArray(auth.scopes, 'auth.scopes'),
      resource: typeof auth.resource === 'string' && auth.resource.trim() ? auth.resource.trim() : undefined,
    };
  }
  if (kind === 'oauth-disabled') return { kind };
  if (kind === 'bearer-environment') {
    return { kind, environmentVariable: requiredString(auth, 'environmentVariable').trim() };
  }
  if (kind === 'header-environment') {
    return {
      kind,
      headerName: requiredString(auth, 'headerName').trim(),
      environmentVariable: requiredString(auth, 'environmentVariable').trim(),
      prefix: typeof auth.prefix === 'string' ? auth.prefix : undefined,
    };
  }
  if (kind === 'oauth-client') {
    return {
      kind,
      authorizationServerIssuer:
        typeof auth.authorizationServerIssuer === 'string' && auth.authorizationServerIssuer.trim()
          ? auth.authorizationServerIssuer.trim()
          : undefined,
      clientId: requiredString(auth, 'clientId').trim(),
      clientSecretEnvironmentVariable:
        typeof auth.clientSecretEnvironmentVariable === 'string' && auth.clientSecretEnvironmentVariable.trim()
          ? auth.clientSecretEnvironmentVariable.trim()
          : undefined,
      scopes: optionalStringArray(auth.scopes, 'auth.scopes'),
      callbackPort: typeof auth.callbackPort === 'number' ? auth.callbackPort : undefined,
    };
  }
  throw new Error(`Unsupported authentication strategy: ${kind}`);
}

async function validateWorkspace(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error('Workspace must be an absolute directory path.');
  const workspace = normalize(value);
  const info = await stat(workspace);
  if (!info.isDirectory()) throw new Error('Workspace must be a directory.');
  return workspace;
}

async function snapshotResponse(workspace: string): Promise<SnapshotResponse> {
  const [snapshot, detectedAgents] = await Promise.all([
    loadNativeSnapshot(workspace),
    detectAgents(),
  ]);
  const effectiveCounts = new Map<AgentId, number>();
  for (const occurrence of snapshot.occurrences) {
    if (!occurrence.source.effective) continue;
    effectiveCounts.set(occurrence.agentId, (effectiveCounts.get(occurrence.agentId) ?? 0) + 1);
  }
  return {
    workspace,
    generatedAt: new Date().toISOString(),
    mutationToken,
    agents: AGENTS.map((agent) => ({
      ...agent,
      ...detectedAgents.find((detected) => detected.id === agent.id),
      detected: snapshot.sources.some((source) => source.agentId === agent.id),
      configPaths: [...new Set(
        snapshot.sources
          .filter((source) => source.agentId === agent.id)
          .map((source) => source.path),
      )],
      occurrenceCount: effectiveCounts.get(agent.id) ?? 0,
    })),
    occurrences: snapshot.occurrences.map(toPublicOccurrence),
    issues: snapshot.issues,
  };
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) return false;
  localOriginOnly(request);

  if (request.method === 'GET' && url.pathname === '/api/snapshot') {
    const workspace = await validateWorkspace(url.searchParams.get('workspace') ?? process.cwd());
    sendJson(response, 200, await snapshotResponse(workspace));
    return true;
  }

  if (request.method === 'POST') requireMutationToken(request);

  if (request.method === 'POST' && url.pathname === '/api/plans') {
    const body = await readJsonBody(request);
    const workspace = await validateWorkspace(requiredString(body, 'workspace'));
    const plan = await createCopyPlan({
      workspace,
      occurrenceId: requiredString(body, 'occurrenceId'),
      targetAgentId: parseAgentId(body, 'targetAgentId'),
      targetName: typeof body.targetName === 'string' ? body.targetName : undefined,
    });
    sendJson(response, 200, plan);
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth-plans') {
    const body = await readJsonBody(request);
    const workspace = await validateWorkspace(requiredString(body, 'workspace'));
    const plan = await createAuthPlan({
      workspace,
      occurrenceId: requiredString(body, 'occurrenceId'),
      auth: parseAuthUpdate(body.auth),
    });
    sendJson(response, 200, plan);
    return true;
  }

  const applyMatch = request.method === 'POST' ? url.pathname.match(/^\/api\/plans\/([^/]+)\/apply$/) : undefined;
  if (applyMatch) {
    sendJson(response, 200, await applyPlan(decodeURIComponent(applyMatch[1])));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/undo') {
    const body = await readJsonBody(request);
    sendJson(response, 200, await undoApply(requiredString(body, 'undoToken')));
    return true;
  }

  sendJson(response, 404, { error: 'API route not found.' });
  return true;
}

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveProductionAsset(response: ServerResponse, pathname: string): Promise<void> {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const cleanPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = resolve(dist, cleanPath);
  const relativePath = relative(dist, filePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    sendJson(response, 403, { error: 'Invalid path.' });
    return;
  }
  try {
    if (!(await stat(filePath)).isFile()) filePath = join(dist, 'index.html');
  } catch {
    filePath = join(dist, 'index.html');
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', mimeTypes[extname(filePath)] ?? 'application/octet-stream');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  createReadStream(filePath).pipe(response);
}

async function start(): Promise<void> {
  const vite = development
    ? await import('vite').then(({ createServer: createViteServer }) =>
        createViteServer({ server: { middlewareMode: true }, appType: 'spa' }),
      )
    : undefined;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
      if (await handleApi(request, response, url)) return;
      if (vite) vite.middlewares(request, response, () => sendJson(response, 404, { error: 'Not found.' }));
      else await serveProductionAsset(response, url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected server error.';
      sendJson(response, /changed|already contains|expired/i.test(message) ? 409 : 400, { error: message });
    }
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error);
      server.once('error', onError);
      server.listen(PORT, HOST, () => {
        server.off('error', onError);
        console.log(`MCP Matrix is running at http://${HOST}:${PORT}`);
        resolveListen();
      });
    });
  } catch (error) {
    await vite?.close();
    throw error;
  }
}

void start().catch((error: NodeJS.ErrnoException) => {
  const suggestedPort = PORT < 65_535 ? PORT + 1 : 4318;
  const message =
    error.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. Try: mcp-matrix --port ${suggestedPort}`
      : error.code === 'EACCES'
        ? `Permission denied while binding to loopback port ${PORT}.`
        : error.message || 'Unable to start the local server.';
  console.error(`mcp-matrix: ${message}`);
  process.exitCode = 1;
});
