import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { idSchema } from '@paso/shared';
import { WebSocketServer, WebSocket } from 'ws';
import { assetName } from './disk.js';
import { ApiError, errorResponse } from './errors.js';
import { authorize } from './security.js';
import { Store } from './store.js';
import { HarnessRegistry, detectHarness, registryPath, type DetectionOptions } from './harnesses.js';
import { RunStore, runsDirectoryPath } from './runs.js';
import { openInFileManager, type OpenFolder } from './reveal.js';
import { join, dirname, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { handleAgentRoute } from './agent/api.js';
import { WorkspaceRegistry, createFolder, listFolders, workspacesPath, type Workspace } from './workspaces.js';
import { SessionManager } from './agent/sessions.js';
import type { AgentEvent, AgentRunHooks, AgentRunRequest, HarnessAdapter, HarnessId } from './agent/types.js';

export type { AgentEvent, AgentRunHooks, AgentRunRequest, HarnessAdapter, HarnessId };
export type { OpenFolder } from './reveal.js';

export type AgentOptions = {
  /** Neutral, empty directory the agents run in. Default: `agent-workspace` next to the projects directory. */
  workDir?: string;
  /** Where session IDs and resume tokens are kept. Must be outside `dataDir`. Default: next to the projects directory. */
  sessionsPath?: string;
  /** How to start the Paso MCP server. Default: this repository's compiled `apps/mcp/dist/cli.js` run with this Node. */
  mcp?: { command?: string; entry?: string; args?: string[]; browserExecutable?: string };
  /** Called where a run starts and ends. Restore points attach here. */
  hooks?: AgentRunHooks;
  /** Concurrent runs allowed per project (default 1) and in total (default 4). */
  maxRunsPerProject?: number; maxRuns?: number;
  /** A run with no output for this long fails (default 120 s). A run is stopped after `maxRunMs` (default 20 min). */
  idleTimeoutMs?: number; maxRunMs?: number;
  /** Replaces or adds harness adapters. Tests use it. */
  adapters?: Partial<Record<HarnessId, HarnessAdapter>>;
};

export type StartServerOptions = {
  dataDir: string; port?: number; sessionToken?: string; allowedOrigins?: string[];
  maxJsonBytes?: number; maxAssetBytes?: number; pollIntervalMs?: number;
  harnessRegistryPath?: string; harnessDetection?: DetectionOptions;
  agent?: AgentOptions;
  runsDir?: string; runRetentionLimit?: number;
  /** Where the list of workspaces is kept. Default: `workspaces.json` next to the data directory. */
  workspacesPath?: string;
  /** How «Abrir carpeta» shows a project's folder. Default: the system's file manager. A desktop host can pass its own,
   * such as Electron's shell.openPath. */
  openFolder?: OpenFolder;
};

async function body(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body exceeds the configured limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function send(response: ServerResponse, status: number, data?: unknown, revision?: string) {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (revision) response.setHeader('ETag', `"${revision}"`);
  if (data === undefined || data === null) { response.end(); return; }
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(data));
}

/** Starts an independent loopback-only service. The caller owns its lifecycle and token delivery. */
export async function startServer(options: StartServerOptions) {
  const sessionToken = options.sessionToken ?? randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(sessionToken)) throw new Error('Session token must contain 32 to 256 base64url characters.');
  const harnesses = new HarnessRegistry(registryPath(options.dataDir, options.harnessRegistryPath), options.harnessDetection ?? {});
  let port = options.port ?? 3001;
  const agent = options.agent ?? {};
  const mcpEntry = agent.mcp?.entry ?? join(import.meta.dirname, '..', '..', 'mcp', 'dist', 'cli.js');
  const dataRoot = resolve(options.dataDir);
  const defaultRuns = runsDirectoryPath(options.dataDir, options.runsDir);
  const agentWorkDir = agent.workDir ?? join(dirname(dataRoot), 'agent-workspace');
  // Restore points of the other workspaces live with the app's data, never in the person's folders.
  const runsFor = (workspace: Workspace) => workspace.path === dataRoot ? defaultRuns : join(dirname(defaultRuns), 'workspaces', workspace.id, 'runs');
  const workspaces = await WorkspaceRegistry.create(workspacesPath(options.dataDir, options.workspacesPath), dataRoot,
    [dirname(dataRoot), defaultRuns, agentWorkDir]);

  const websocket = new WebSocketServer({ noServer: true, maxPayload: 1024, handleProtocols: (protocols) => protocols.has('paso') ? 'paso' : false });
  const broadcast = (event: unknown) => {
    const message = JSON.stringify(event);
    for (const client of websocket.clients) {
      if (client.bufferedAmount > 1024 * 1024) client.terminate();
      else if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  /** The open workspace: its store, its restore points and its subscription to the event stream. */
  type Open = { workspace: Workspace; store: Store; runs: RunStore; unsubscribe: () => void };
  const open = async (workspace: Workspace): Promise<Open> => {
    // The default folder is created on first use. Another workspace must still exist: a folder the person moved or
    // deleted is reported, never quietly created again.
    if (workspace.path !== dataRoot && !(await workspaces.list()).workspaces.find((item) => item.id === workspace.id)?.available) {
      throw new ApiError(422, 'WORKSPACE_UNAVAILABLE', 'La carpeta de este workspace no existe o no se puede leer.');
    }
    const runs = await RunStore.create(workspace.path, { runsDir: runsFor(workspace), retentionLimit: options.runRetentionLimit });
    const store = await Store.create(workspace.path, options.pollIntervalMs, runs);
    return { workspace, store, runs, unsubscribe: store.subscribe(broadcast) };
  };
  let current: Open;
  try { current = await open(workspaces.active()); }
  catch {
    // The workspace open last time is gone: start in the default one.
    await workspaces.activate(workspaces.get('default').id);
    current = await open(workspaces.active());
  }
  let switching: Promise<void> | undefined;
  const switchTo = async (id: string) => {
    const workspace = workspaces.get(id);
    if (switching) throw new ApiError(409, 'WORKSPACE_SWITCHING', 'Ya se está cambiando de workspace.');
    if (sessions.busy()) throw new ApiError(409, 'AGENT_RUNNING', 'Espera a que el agente termine antes de cambiar de workspace.');
    if (workspace.id === current.workspace.id) { await workspaces.activate(id); return; }
    let done!: () => void;
    switching = new Promise<void>((resolve) => { done = resolve; });
    try {
      const next = await open(workspace);
      const previous = current;
      current = next;
      previous.unsubscribe();
      await previous.store.close();
      await workspaces.activate(id);
    } finally { switching = undefined; done(); }
    broadcast({ type: 'workspaces', activeId: current.workspace.id });
  };

  const sessions = new SessionManager({
    adapters: agent.adapters,
    detect: (id) => detectHarness(id, options.harnessDetection ?? {}),
    validateTarget: async (projectId, sceneId) => {
      if (switching) throw new ApiError(409, 'WORKSPACE_SWITCHING', 'Paso está cambiando de workspace.');
      await current.store.read(projectId, sceneId);
    },
    board: () => ({
      serviceUrl: `http://127.0.0.1:${port}`, sessionToken,
      mcp: {
        command: agent.mcp?.command ?? process.execPath, args: agent.mcp?.args ?? [mcpEntry],
        ...(agent.mcp?.browserExecutable ? { browserExecutable: agent.mcp.browserExecutable } : {}),
      },
    }),
    workDir: agentWorkDir, dataDir: dataRoot,
    sessionsPath: registryPath(options.dataDir, agent.sessionsPath ?? join(dirname(dataRoot), 'agent-sessions.json')),
    hooks: {
      beforeRun: async (context) => {
        await agent.hooks?.beforeRun?.(context);
        await current.runs.start(current.store, context.projectId, { id: context.runId, label: `${context.harness}:${context.sessionId}` });
      },
      afterRun: async (context, outcome) => {
        try {
          await current.runs.finish(current.store, context.projectId, context.runId);
        } catch (error) {
          if (!(error instanceof ApiError && error.code === 'NOT_FOUND')) throw error;
        } finally {
          await agent.hooks?.afterRun?.(context, outcome);
        }
      },
    },
    maxRunsPerProject: agent.maxRunsPerProject, maxRuns: agent.maxRuns,
    idleTimeoutMs: agent.idleTimeoutMs, maxRunMs: agent.maxRunMs,
  });
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const server = createServer((request, response) => {
    void (async () => {
      authorize(request, sessionToken, port, allowedOrigins);
      // Inspect the raw target before URL parsing can normalize dot segments.
      const rawPath = (request.url ?? '').split('?')[0];
      let parts: string[];
      try { parts = rawPath.split('/').slice(1).map(decodeURIComponent); }
      catch { throw new ApiError(400, 'INVALID_PATH', 'Invalid path encoding.'); }
      const method = request.method;
      const revision = typeof request.headers['if-match'] === 'string' ? request.headers['if-match'] : undefined;
      const actor = request.headers['x-paso-actor'] === 'mcp' ? 'mcp' : 'user';
      const json = async (allowEmpty = false) => {
        const raw = await body(request, options.maxJsonBytes ?? 10 * 1024 * 1024);
        if (allowEmpty && raw.length === 0) return {};
        if (!request.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, 'CONTENT_TYPE', 'Use application/json.');
        return JSON.parse(raw.toString('utf8')) as unknown;
      };
      if (rawPath === '/api/health' && method === 'GET') { send(response, 200, { status: 'ok' }); return; }
      if (parts[0] === 'api' && parts[1] === 'harnesses') {
        if (parts.length === 3 && parts[2] === 'detect' && method === 'GET') { send(response, 200, await harnesses.detect()); return; }
        if (parts.length === 2 && method === 'GET') { send(response, 200, await harnesses.list()); return; }
        if (parts.length === 2 && method === 'POST') { const input = await json() as { id?: unknown } | null; send(response, 201, await harnesses.add(input?.id)); return; }
        if (parts.length === 3 && method === 'DELETE') { await harnesses.remove(parts[2]); send(response, 204); return; }
        throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
      }
      if (parts[0] === 'api' && parts[1] === 'workspaces') {
        if (parts.length === 2 && method === 'GET') { send(response, 200, await workspaces.list()); return; }
        if (parts.length === 2 && method === 'POST') {
          const added = await workspaces.add(await json());
          broadcast({ type: 'workspaces', activeId: current.workspace.id });
          send(response, 201, added); return;
        }
        if (parts.length === 3 && parts[2] === 'active' && method === 'PUT') {
          const input = await json() as { id?: unknown } | null;
          if (typeof input?.id !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', 'Send the id of a workspace.');
          await switchTo(input.id);
          send(response, 200, await workspaces.list()); return;
        }
        if (parts.length === 3 && method === 'DELETE') {
          workspaces.get(parts[2]);
          if (workspaces.isDefault(parts[2])) throw new ApiError(400, 'DEFAULT_WORKSPACE', 'The default workspace cannot be removed.');
          if (current.workspace.id === parts[2]) await switchTo('default');
          await workspaces.remove(parts[2]);
          broadcast({ type: 'workspaces', activeId: current.workspace.id });
          send(response, 204); return;
        }
        if (parts.length === 4 && parts[3] === 'reveal' && method === 'POST') {
          const { path } = workspaces.get(parts[2]);
          try { await (options.openFolder ?? openInFileManager)(path); }
          catch { throw new ApiError(500, 'REVEAL_FAILED', 'Could not open the workspace folder.'); }
          send(response, 204); return;
        }
        throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
      }
      if (parts[0] === 'api' && parts[1] === 'folders' && parts.length === 2) {
        if (method === 'GET') { send(response, 200, await listFolders(new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('path') ?? undefined)); return; }
        if (method === 'POST') { send(response, 201, await createFolder(await json())); return; }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
      }
      const agentReply = await handleAgentRoute(sessions, parts, method, new URL(request.url ?? '/', 'http://127.0.0.1'), json);
      if (agentReply) { send(response, agentReply.status, agentReply.data); return; }
      if (parts[0] !== 'api' || parts[1] !== 'projects') throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
      // Every project route works in the open workspace.
      const { store, runs } = current;
      if (parts.length === 2) {
        if (method === 'GET') { send(response, 200, await store.list()); return; }
        if (method === 'POST') { const result = await store.create(await json()); send(response, 201, result, result.revision); return; }
      }
      const projectId = idSchema.parse(parts[2]);
      let result: unknown;
      let status = 200;
      if (parts.length === 3) {
        if (method === 'GET') result = await store.read(projectId);
        else if (method === 'PATCH') result = await store.mutate(projectId, 'rename', await json(), revision, undefined, undefined, actor);
        else if (method === 'DELETE') { result = await store.mutate(projectId, 'delete', null, revision, undefined, undefined, actor); status = 204; }
        else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
      } else if (parts.length === 4 && parts[3] === 'reveal') {
        // «Abrir carpeta»: the project's own folder, named by its ID under the data directory.
        if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
        await store.read(projectId);
        try { await (options.openFolder ?? openInFileManager)(join(await realpath(current.workspace.path), projectId)); }
        catch { throw new ApiError(500, 'REVEAL_FAILED', 'Could not open the project folder.'); }
        status = 204;
      } else if (parts[3] === 'runs') {
        if (parts.length === 4) {
          if (method === 'GET') result = await runs.list(store, projectId);
          else if (method === 'POST') { result = { run: await runs.start(store, projectId, await json(true)) }; status = 201; }
          else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
        } else {
          const runId = idSchema.parse(parts[4]);
          if (parts.length === 5) {
            if (method === 'GET') result = await runs.get(store, projectId, runId);
            else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
          } else if (parts.length === 6 && parts[5] === 'finish') {
            if (method === 'POST') result = { run: await runs.finish(store, projectId, runId) };
            else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
          } else if (parts.length === 6 && parts[5] === 'undo') {
            if (method === 'GET') result = await runs.previewUndo(store, projectId, runId);
            else if (method === 'POST') result = await runs.executeUndo(store, projectId, runId, await json());
            else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
          } else throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
        }
      } else if (parts[3] === 'assets' && parts.length === 5) {
        assetName(parts[4]);
        if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
        const asset = await store.asset(projectId, parts[4], method,
          method === 'PUT' ? await body(request, options.maxAssetBytes ?? 50 * 1024 * 1024) : undefined, revision);
        if (method === 'GET' && asset && 'bytes' in asset) {
          response.setHeader('Content-Type', 'application/octet-stream');
          response.setHeader('Content-Disposition', 'attachment');
          response.setHeader('X-Content-Type-Options', 'nosniff');
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('ETag', `"${asset.revision}"`);
          response.end(asset.bytes); return;
        }
        result = asset; status = method === 'DELETE' ? 204 : 200;
      } else if (parts[3] === 'scenes') {
        if (parts.length === 4) {
          if (method === 'GET') result = await store.read(projectId, undefined, undefined, 'scenes');
          else if (method === 'POST') { result = await store.mutate(projectId, 'createScene', await json(), undefined, undefined, undefined, actor); status = 201; }
          else if (method === 'PUT') result = await store.mutate(projectId, 'orderScenes', await json(), revision, undefined, undefined, actor);
          else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
        } else {
          const sceneId = idSchema.parse(parts[4]);
          if (parts.length === 5) {
            if (method === 'GET') result = await store.read(projectId, sceneId);
            else if (method === 'PATCH') result = await store.mutate(projectId, 'rename', await json(), revision, sceneId, undefined, actor);
            else if (method === 'DELETE') { result = await store.mutate(projectId, 'delete', null, revision, sceneId, undefined, actor); status = 204; }
            else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
          } else if (parts[5] === 'steps') {
            if (parts.length === 6) {
              if (method === 'GET') result = await store.read(projectId, sceneId, undefined, 'steps');
              else if (method === 'POST') { result = await store.mutate(projectId, 'createStep', await json(), undefined, sceneId, undefined, actor); status = 201; }
              else if (method === 'PUT') result = await store.mutate(projectId, 'orderSteps', await json(), revision, sceneId, undefined, actor);
              else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
            } else {
              const stepId = idSchema.parse(parts[6]);
              if (parts.length === 8 && parts[7] === 'duplicate' && method === 'POST') {
                result = await store.mutate(projectId, 'duplicate', await json(), revision, sceneId, stepId, actor); status = 201;
              } else if (parts.length === 7) {
                if (method === 'GET') result = await store.read(projectId, sceneId, stepId);
                else if (method === 'PUT') result = await store.mutate(projectId, 'updateStep', await json(), revision, sceneId, stepId, actor);
                else if (method === 'DELETE') { result = await store.mutate(projectId, 'delete', null, revision, sceneId, stepId, actor); status = 204; }
                else throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
              } else throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
            }
          } else throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
        }
      } else throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
      send(response, status, result, (result as { revision?: string } | null)?.revision);
    })().catch((error: unknown) => {
      const failure = errorResponse(error);
      send(response, failure.status, { error: failure.error });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on('upgrade', (request, socket, head) => {
    try {
      authorize(request, sessionToken, port, allowedOrigins, true);
      if (request.url !== '/api/events') throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
      if (!request.headers['sec-websocket-protocol']?.split(',').some((p) => p.trim() === 'paso')) throw new ApiError(400, 'PROTOCOL_REQUIRED', 'Use the paso protocol.');
      websocket.handleUpgrade(request, socket, head, (client) => {
        client.on('error', () => {});
        // A subscribe-before-read protocol lets clients avoid a startup race.
        client.send(JSON.stringify({ type: 'ready' }));
      });
    } catch (error) {
      const failure = errorResponse(error);
      socket.end(`HTTP/1.1 ${failure.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  // Agent events share the authenticated socket: { type: 'agent', sessionId, runId, seq, at, event }.
  const unsubscribeAgents = sessions.subscribe((entry) => broadcast({ type: 'agent', ...entry }));
  const unsubscribe = () => { current.unsubscribe(); unsubscribeAgents(); };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { unsubscribe(); websocket.close(); await current.store.close(); throw error; }
  port = (server.address() as { port: number }).port;
  allowedOrigins.add(`http://127.0.0.1:${port}`);
  allowedOrigins.add(`http://localhost:${port}`);
  return {
    server, port, url: `http://127.0.0.1:${port}`, sessionToken,
    async close() {
      // Stop agents first: their board tools call this service, and no harness process may outlive it.
      await sessions.close();
      unsubscribe();
      for (const client of websocket.clients) client.terminate();
      websocket.close();
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await switching;
      await Promise.all([closed, current.store.close()]);
    },
  };
}
