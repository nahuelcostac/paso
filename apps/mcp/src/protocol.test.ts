import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Step, Scene } from '@paso/shared';
import type { Envelope } from './api.js';

const root = resolve(import.meta.dirname, '../../..');
const entry = join(root, 'apps/mcp/dist/cli.js');
const token = randomBytes(32).toString('base64url');
let dataDir: string;
let service: ChildProcess;
let url: string;
let serviceLogs = '';
let mcpLogs = '';
let client: Client;
let transport: StdioClientTransport;
let sceneId: string;
let lastStepId: string;

async function api<T>(path: string, method = 'GET', body?: unknown, revision?: string): Promise<T> {
  const response = await fetch(`${url}${path}`, { method, headers: {
    Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(revision ? { 'If-Match': `"${revision}"` } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}
function connection(serviceUrl: string, sessionToken = token, browser?: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: tmpdir(), stderr: 'pipe', env: {
    PASO_SERVICE_URL: serviceUrl, PASO_SESSION_TOKEN: sessionToken, ...(browser ? { PASO_MCP_BROWSER_EXECUTABLE: browser } : {}),
  } });
  transport.stderr?.on('data', (bytes) => { mcpLogs += bytes.toString(); });
  return { transport, client: new Client({ name: 'paso-protocol-test', version: '1.0.0' }) };
}
async function call(name: string, args: Record<string, unknown> = {}, active = client): Promise<CallToolResult> {
  return await active.callTool({ name, arguments: args }) as CallToolResult;
}
async function value<T>(name: string, args: Record<string, unknown> = {}, active = client): Promise<T> {
  const result = await call(name, args, active);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.content[0].type).toBe('text');
  return JSON.parse((result.content[0] as { text: string }).text) as T;
}
const target = (stepId = lastStepId) => ({ projectId: 'protocol', sceneId, stepId });
const path = (stepId = lastStepId) => `/api/projects/protocol/scenes/${sceneId}/steps/${stepId}`;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'paso-ag01-protocol-'));
  service = spawn(process.execPath, [join(root, 'apps/server/dist/cli.js')], { cwd: tmpdir(), env: { ...process.env, PASO_PORT: '0', PASO_DATA_DIR: dataDir, PASO_SESSION_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stderr!.on('data', (bytes) => { serviceLogs += bytes.toString(); });
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Compiled service startup timed out.')), 10_000);
    service.once('error', reject);
    service.stdout!.on('data', (bytes) => {
      serviceLogs += bytes.toString();
      const match = /Paso listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(serviceLogs);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  await api('/api/projects', 'POST', { id: 'protocol', name: 'AG-01 protocol test' });
  ({ client, transport } = connection(url));
  await client.connect(transport);
}, 15_000);

afterAll(async () => {
  await client?.close();
  await transport?.close();
  if (service && service.exitCode === null && service.signalCode === null) { const closed = once(service, 'exit'); service.kill('SIGTERM'); await closed; }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('compiled stdio MCP with a compiled local service', () => {
  it('offers only scoped board tools and reads projects', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['list_projects', 'read_project', 'read_scene', 'read_step', 'create_scene', 'create_step', 'duplicate_step', 'add_elements', 'update_elements', 'delete_elements', 'get_step_image'].sort());
    expect(tools.every((tool) => tool.description && tool.inputSchema.additionalProperties === false)).toBe(true);
    const projects = await value<{ projects: { id: string }[] }>('list_projects');
    expect(projects.projects.some((project) => project.id === 'protocol')).toBe(true);
  });
  it('builds three progressive steps and edits the last without changing previous snapshots', async () => {
    const scene = await value<Envelope<Scene>>('create_scene', { projectId: 'protocol', id: 'scene', name: 'De entrada a resultado' });
    sceneId = scene.document.id;
    const first = await value<Envelope<Step>>('create_step', { projectId: 'protocol', sceneId, id: 'step-one', title: 'Entrada' });
    let result = await value<{ revision: string }>('add_elements', { ...target(first.document.id), revision: first.revision, elements: [
      { type: 'rectangle', id: 'input', x: 80, y: 120, width: 60, height: 30, label: 'Información\nÁrbol de decisión', backgroundColor: '#e3f5cf' },
      { type: 'text', id: 'caption', x: 80, y: 30, text: 'Una explicación en tres pasos' },
    ] });
    const second = await value<Envelope<Step>>('duplicate_step', { ...target(first.document.id), revision: result.revision, id: 'step-two' });
    expect(second.document.elements.map((element) => element.id)).toEqual((await api<Envelope<Step>>(path(first.document.id))).document.elements.map((element) => element.id));
    result = await value('add_elements', { ...target(second.document.id), revision: second.revision, elements: [
      { type: 'arrow', id: 'input-process', fromId: 'input', toId: 'process' },
      { type: 'diamond', id: 'process', x: 440, y: 90, width: 180, height: 130, label: '¿Es válido?' },
    ] });
    const third = await value<Envelope<Step>>('duplicate_step', { ...target(second.document.id), revision: result.revision, id: 'step-three' });
    lastStepId = third.document.id;
    result = await value('add_elements', { ...target(), revision: third.revision, elements: [
      { type: 'ellipse', id: 'output', x: 820, y: 120, label: 'Resultado\nVerificado', backgroundColor: '#cce5ff' },
      { type: 'arrow', id: 'process-output', fromId: 'process', toId: 'output' },
    ] });
    result = await value('update_elements', { ...target(), revision: result.revision, elements: [{ id: 'output', label: 'Resultado\nConfirmado', x: 860 }] });
    const sceneView = await value<{ steps: { stepId: string; elementCount: number }[] }>('read_scene', { projectId: 'protocol', sceneId });
    expect(sceneView.steps.map((step) => step.elementCount)).toEqual([3, 6, 9]);
    const before = await api<Envelope<Step>>(path('step-two'));
    expect(before.document.elements.some((element) => element.id === 'output')).toBe(false);
    const current = await api<Envelope<Step>>(path());
    expect(current.document.elements.find((element) => element.containerId === 'output')!.text).toBe('Resultado\nConfirmado');
    expect(current.revision).toBe(result.revision);
    const project = await value<{ scenes: Envelope<Scene>[] }>('read_project', { projectId: 'protocol' });
    expect(project.scenes[0].document.stepIds).toEqual(['step-one', 'step-two', 'step-three']);
  });
  it('rejects invalid inputs, raw internals and unknown tools without writes', async () => {
    const before = await api<Envelope<Step>>(path());
    for (const elements of [
      [{ type: 'rectangle', id: 'bad', x: 0, y: 0, width: -1 }],
      [{ type: 'text', id: 'bad', x: 0, y: 0, text: 'Hola', versionNonce: 7 }],
      [{ type: 'arrow', id: 'bad', fromId: 'input', toId: 'missing' }],
    ]) expect((await call('add_elements', { ...target(), revision: before.revision, elements })).isError).toBe(true);
    expect((await call('read_step', { ...target(), path: '/etc/passwd' })).isError).toBe(true);
    expect((await call('read_step', { ...target(), projectId: '../escape' })).isError).toBe(true);
    expect((await call('delete_project', { projectId: 'protocol' })).isError).toBe(true);
    expect((await api<Envelope<Step>>(path())).revision).toBe(before.revision);
  });
  it('rejects stale revisions and preserves newer work and unknown fields', async () => {
    const before = await api<Envelope<Step>>(path());
    const foreign = structuredClone(before.document);
    foreign.elements[0].futureData = { nested: [1, { keep: true }] };
    foreign.title = 'Cambio externo';
    const newer = await api<Envelope<Step>>(path(), 'PUT', foreign, before.revision);
    const stale = await call('update_elements', { ...target(), revision: before.revision, elements: [{ id: 'input', x: 120 }] });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain('REVISION_CONFLICT');
    expect(JSON.stringify(stale)).toContain('read_step');
    expect((await call('duplicate_step', { ...target(), revision: before.revision })).isError).toBe(true);
    const fresh = await value<{ revision: string }>('read_step', target());
    expect(fresh.revision).toBe(newer.revision);
    await value('update_elements', { ...target(), revision: fresh.revision, elements: [{ id: 'input', x: 110 }] });
    const saved = await api<Envelope<Step>>(path());
    expect(saved.document.title).toBe('Cambio externo');
    expect(saved.document.elements[0].futureData).toEqual(foreign.elements[0].futureData);
    expect(saved.document.elements[0].version).toBe(foreign.elements[0].version + 1);
    expect(saved.document.elements[0].versionNonce).not.toBe(foreign.elements[0].versionNonce);
  });
  it('also rejects a race between its internal read and service PUT', async () => {
    let raced = false;
    const proxy = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (request.method === 'PUT' && !raced) {
          raced = true;
          const current = await api<Envelope<Step>>(path());
          await api(path(), 'PUT', { ...current.document, speakerNotes: 'Concurrent human work' }, current.revision);
        }
        const result = await fetch(`${url}${request.url}`, { method: request.method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(request.headers['if-match'] ? { 'If-Match': request.headers['if-match'] } : {}) }, body: chunks.length ? Buffer.concat(chunks) : undefined });
        response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(await result.text());
      })().catch(() => { response.writeHead(500).end(); });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Proxy did not bind.');
    const other = connection(`http://127.0.0.1:${address.port}`);
    try {
      await other.client.connect(other.transport);
      const before = await api<Envelope<Step>>(path());
      const result = await call('update_elements', { ...target(), revision: before.revision, elements: [{ id: 'input', x: 150 }] }, other.client);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('REVISION_CONFLICT');
      const saved = await api<Envelope<Step>>(path());
      expect(saved.document.speakerNotes).toBe('Concurrent human work');
      expect(saved.document.elements.find((element) => element.id === 'input')!.x).toBe(110);
    } finally {
      await other.client.close(); await other.transport.close();
      await new Promise<void>((resolve) => { proxy.close(() => resolve()); proxy.closeAllConnections(); });
    }
  });
  it('returns a useful image fallback when no browser is configured', async () => {
    const result = await call('get_step_image', target());
    expect(result.isError).toBe(true);
    const fallback = JSON.parse((result.content[0] as { text: string }).text);
    expect(fallback.error).toContain('PASO_MCP_BROWSER_EXECUTABLE');
    expect(fallback.layout.elements.some((element: { id: string }) => element.id === 'input')).toBe(true);
    expect(fallback.layout.overlaps).toBeDefined();
  });
  it('returns a clear fallback if the configured browser cannot start', async () => {
    const other = connection(url, token, join(dataDir, 'missing-browser'));
    try {
      await other.client.connect(other.transport);
      const result = await call('get_step_image', target(), other.client);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('IMAGE_UNAVAILABLE');
      expect(JSON.stringify(result)).toContain('read_step');
    } finally { await other.client.close(); await other.transport.close(); }
  });
  it.runIf(Boolean(process.env.PASO_MCP_TEST_BROWSER))('returns a PNG through the real protocol with no app window', async () => {
    const other = connection(url, token, process.env.PASO_MCP_TEST_BROWSER);
    try {
      await other.client.connect(other.transport);
      const result = await call('get_step_image', target(), other.client);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const image = result.content.find((item) => item.type === 'image');
      expect(image?.type).toBe('image');
      if (image?.type !== 'image') throw new Error('Image missing.');
      const bytes = Buffer.from(image.data, 'base64');
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
      expect(bytes.readUInt32BE(16)).toBeLessThanOrEqual(2048);
      expect(bytes.readUInt32BE(20)).toBeLessThanOrEqual(2048);
    } finally { await other.client.close(); await other.transport.close(); }
  }, 45_000);
  it('rejects wrong tokens and never logs the session token', async () => {
    const other = connection(url, 'wrong'.repeat(8));
    try {
      await other.client.connect(other.transport);
      const result = await call('list_projects', {}, other.client);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('UNAUTHORIZED');
      expect(JSON.stringify(result)).not.toContain(token);
    } finally { await other.client.close(); await other.transport.close(); }
    expect(serviceLogs).not.toContain(token);
    expect(mcpLogs).not.toContain(token);
  });
  it('fails before protocol startup when the token is missing or malformed', () => {
    for (const sessionToken of ['', 'short']) {
      const child = spawnSync(process.execPath, [entry], { env: { PATH: process.env.PATH, PASO_SERVICE_URL: url, PASO_SESSION_TOKEN: sessionToken }, encoding: 'utf8', timeout: 5000 });
      expect(child.status).toBe(1);
      expect(child.stdout).toBe('');
      expect(child.stderr).toContain('PASO_SESSION_TOKEN is required');
    }
  });
  it('deletes elements through MCP without deleting any project structure', async () => {
    const before = await value<{ revision: string }>('read_step', target());
    await value('delete_elements', { ...target(), revision: before.revision, ids: ['output'] });
    const current = await api<Envelope<Step>>(path());
    expect(current.document.elements.find((element) => element.id === 'output')!.isDeleted).toBe(true);
    expect(current.document.elements.find((element) => element.id === 'process-output')!.isDeleted).toBe(true);
    expect((await value<{ steps: unknown[] }>('read_scene', { projectId: 'protocol', sceneId })).steps).toHaveLength(3);
  });
});
