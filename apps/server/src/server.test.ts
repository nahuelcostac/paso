import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createProject, createScene, createStep } from '@paso/shared';
import { startServer } from './server.js';
import { hash } from './disk.js';
import type { ChangeEvent } from './store.js';

type Service = Awaited<ReturnType<typeof startServer>>;
let service: Service;
let dataDir: string;
const token = 'test-session-token-with-at-least-32-characters';
const clients: WebSocket[] = [];
const p = '/api/projects/p';
const s = `${p}/scenes/s`;
const t = `${s}/steps/t`;

async function api(path: string, method = 'GET', input?: unknown, revision?: string) {
  const response = await fetch(`${service.url}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(revision ? { 'If-Match': `"${revision}"` } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data, etag: response.headers.get('etag') };
}
async function project() { return api('/api/projects', 'POST', { id: 'p', name: 'Project' }); }
async function scene() { await project(); return api(`${p}/scenes`, 'POST', { id: 's', name: 'Scene' }); }
async function step() { await scene(); return api(`${s}/steps`, 'POST', { id: 't', title: 'Step' }); }

async function events() {
  const ws = new WebSocket(`${service.url.replace('http', 'ws')}/api/events`, ['paso', `paso-token.${token}`]);
  clients.push(ws);
  const messages: Array<ChangeEvent | { type: 'ready' }> = [];
  const emitter = new EventEmitter();
  ws.on('message', (bytes) => { const message = JSON.parse(bytes.toString()); messages.push(message); emitter.emit('message', message); });
  function next(predicate: (event: ChangeEvent) => boolean, since = 0): Promise<ChangeEvent> {
    const match = messages.slice(since).find((event) => predicate(event as ChangeEvent));
    if (match) return Promise.resolve(match as ChangeEvent);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { emitter.off('message', listener); reject(new Error('Expected WebSocket event was not received.')); }, 5000);
      const listener = (event: ChangeEvent) => { if (predicate(event)) { clearTimeout(timer); emitter.off('message', listener); resolve(event); } };
      emitter.on('message', listener);
    });
  }
  await next((event) => event.type as string === 'ready');
  return { messages, next };
}
function raw(path: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = request(`${service.url}`, { path, headers: { Authorization: `Bearer ${token}`, ...headers } }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject); req.end();
  });
}
function rejectedSocket(protocols: string[], headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`${service.url.replace('http', 'ws')}/api/events`, protocols, { headers });
    clients.push(ws);
    ws.on('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!); });
    ws.on('open', () => reject(new Error('Unexpected authorized WebSocket.')));
    ws.on('error', () => {});
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'paso-service-'));
  service = await startServer({ dataDir, port: 0, sessionToken: token, pollIntervalMs: 100 });
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('documents and revisions', () => {
  it('creates, lists, reads, renames and deletes projects', async () => {
    const created = await project();
    expect(created.status).toBe(201);
    expect(created.etag).toBe(`"${created.data.revision}"`);
    expect((await api('/api/projects')).data.projects).toHaveLength(1);
    expect((await api(p)).data).toEqual(created.data);
    const updated = await api(p, 'PATCH', { name: 'Renamed' }, created.data.revision);
    expect(updated.status).toBe(200);
    expect(updated.data.document.name).toBe('Renamed');
    expect((await api(p, 'DELETE', undefined, updated.data.revision)).status).toBe(204);
    expect((await api(p)).status).toBe(404);
    expect((await api('/api/projects')).data.projects).toEqual([]);
  });
  it('creates, lists, reads, renames and deletes scenes', async () => {
    const created = await scene();
    expect(created.status).toBe(201);
    expect((await api(`${p}/scenes`)).data.scenes).toEqual([created.data]);
    expect((await api(s)).data).toEqual(created.data);
    const updated = await api(s, 'PATCH', { name: 'Renamed' }, created.data.revision);
    expect(updated.data.document.name).toBe('Renamed');
    expect((await api(s, 'DELETE', undefined, updated.data.revision)).status).toBe(204);
    expect((await api(`${p}/scenes`)).data.scenes).toEqual([]);
    expect((await api(s)).status).toBe(404);
  });
  it('creates, lists, reads, replaces and deletes steps with parsed appState', async () => {
    const created = await step();
    expect(created.status).toBe(201);
    expect((await api(`${s}/steps`)).data.steps).toEqual([created.data]);
    expect((await api(t)).data).toEqual(created.data);
    const updated = await api(t, 'PUT', { ...created.data.document, title: 'New', appState: { gridSize: 20, zoom: 10 } }, created.data.revision);
    expect(updated.status).toBe(200);
    expect(updated.data.document.appState).toEqual({ gridSize: 20 });
    const disk = JSON.parse(await readFile(join(dataDir, 'p/scenes/s/steps/t.json'), 'utf8'));
    expect(disk.title).toBe('New'); expect(disk.appState).toEqual({ gridSize: 20 });
    expect((await api(t, 'DELETE', undefined, updated.data.revision)).status).toBe(204);
    expect((await api(`${s}/steps`)).data.steps).toEqual([]);
    expect((await api(t)).status).toBe(404);
  });
  it('reorders exact child sets and rejects duplicate, missing and unknown IDs', async () => {
    await step();
    await api(`${p}/scenes`, 'POST', { id: 's2', name: 'Second' });
    await api(`${s}/steps`, 'POST', { id: 't2' });
    let parent = (await api(p)).data;
    const reordered = await api(`${p}/scenes`, 'PUT', { ids: ['s2', 's'] }, parent.revision);
    expect(reordered.status).toBe(200);
    expect(reordered.data.document.sceneIds).toEqual(['s2', 's']);
    const current = (await api(s)).data;
    expect((await api(`${s}/steps`, 'PUT', { ids: ['t2', 't'] }, current.revision)).data.document.stepIds).toEqual(['t2', 't']);
    parent = (await api(p)).data;
    for (const ids of [['s'], ['s', 's'], ['s', 'absent']]) expect((await api(`${p}/scenes`, 'PUT', { ids }, parent.revision)).status).toBe(400);
  });
  it('duplicates complete snapshots, preserving element IDs and unknown fields', async () => {
    const created = await step();
    const source = { ...created.data.document, speakerNotes: 'Notes', elements: [{ id: 'e', type: 'future', version: 1, versionNonce: 1, isDeleted: false, future: { values: [1, 2] } }] };
    const updated = await api(t, 'PUT', source, created.data.revision);
    const copy = await api(`${t}/duplicate`, 'POST', { id: 'copy' }, updated.data.revision);
    expect(copy.status).toBe(201);
    expect(copy.data.document).toEqual({ ...source, id: 'copy' });
    expect((await api(`${s}/steps/copy`)).data).toEqual(copy.data);
    expect((await api(`${t}/duplicate`, 'POST', { id: 't' }, updated.data.revision)).status).toBe(409);
    expect((await api(`${t}/duplicate`, 'POST', { id: 's' }, updated.data.revision)).status).toBe(400);
  });
  it('serializes concurrent sibling creation and rejects concurrent replacement of the same revision', async () => {
    const created = await step();
    const added = await Promise.all(Array.from({ length: 12 }, (_, i) => api(`${s}/steps`, 'POST', { id: `child-${i}` })));
    expect(added.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect((await api(s)).data.document.stepIds).toHaveLength(13);
    const scenes = await Promise.all(Array.from({ length: 6 }, (_, i) => api(`${p}/scenes`, 'POST', { id: `scene-${i}`, name: 'Concurrent' })));
    expect(scenes.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect((await api(p)).data.document.sceneIds).toHaveLength(7);
    const results = await Promise.all(['First', 'Second'].map((title) => api(t, 'PUT', { ...created.data.document, title }, created.data.revision)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const persisted = (await api(t)).data;
    expect(['First', 'Second']).toContain(persisted.document.title);
  });
  it('requires revisions for all existing-document mutations and rejects stale revisions', async () => {
    const created = await step();
    expect((await api(t, 'PUT', created.data.document)).status).toBe(428);
    const sceneBefore = (await api(s)).data;
    const projectBefore = (await api(p)).data;
    await api(s, 'PATCH', { name: 'Changed' }, sceneBefore.revision);
    expect((await api(s, 'DELETE', undefined, sceneBefore.revision)).status).toBe(409);
    expect((await api(p, 'PATCH', { name: 'Stale' }, projectBefore.revision)).status).toBe(409);
    const content = { ...created.data.document, title: 'External' };
    await writeFile(join(dataDir, 'p/scenes/s/steps/t.json'), JSON.stringify(content));
    expect((await api(t, 'PUT', created.data.document, created.data.revision)).status).toBe(409);
  });
  it('cascades scene and project deletion and does not reserve valid IDs', async () => {
    await step();
    const order = await api(`${s}/steps`, 'POST', { id: 'order' });
    expect((await api(`${s}/steps/order`, 'PUT', { ...order.data.document, title: 'Allowed' }, order.data.revision)).status).toBe(200);
    expect((await api(s, 'DELETE', undefined, (await api(s)).data.revision)).status).toBe(204);
    expect((await api(p)).data.document.sceneIds).toEqual([]);
    expect((await api(p, 'DELETE', undefined, (await api(p)).data.revision)).status).toBe(204);
  });
  it('validates input without writing partial documents', async () => {
    await scene();
    expect((await api(`${s}/steps`, 'POST', { id: 'bad', elements: [{ id: 'e' }] })).status).toBe(400);
    expect((await api(`${s}/steps`, 'POST', { id: 's' })).status).toBe(400);
    expect((await api(`${s}/steps`, 'POST', { unknown: true })).status).toBe(400);
    expect((await api(`${s}/steps`, 'POST', { elements: null })).status).toBe(400);
    expect((await api(s)).data.document.stepIds).toEqual([]);
    expect((await api(p, 'PATCH', { name: 'Bad', revision: 'not-in-schema' }, (await api(p)).data.revision)).status).toBe(400);
  });
});

describe('assets and disk validation', () => {
  it('uploads and reads immutable binaries, validates manifests, duplicates references and protects used assets', async () => {
    const created = await step();
    const bytes = Buffer.from([0, 1, 255, 10]);
    const upload = () => fetch(`${service.url}${p}/assets/image.png`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: bytes });
    const uploaded = await upload(); expect(uploaded.status).toBe(200);
    const assetRevision = (await uploaded.json()).revision;
    const read = await fetch(`${service.url}${p}/assets/image.png`, { headers: { Authorization: `Bearer ${token}` } });
    expect(Buffer.from(await read.arrayBuffer())).toEqual(bytes);
    expect(read.headers.get('etag')).toBe(`"${assetRevision}"`);
    expect((await upload()).status).toBe(200);
    expect((await fetch(`${service.url}${p}/assets/image.png`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: 'different' })).status).toBe(409);
    expect((await fetch(`${service.url}${p}/assets/image.svg`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: bytes })).status).toBe(409);
    const image = { ...created.data.document, files: { image: { path: 'assets/image.png', mimeType: 'image/png', created: 1 } }, elements: [{ id: 'image-element', type: 'image', version: 1, versionNonce: 1, isDeleted: false, fileId: 'image' }] };
    const updated = await api(t, 'PUT', image, created.data.revision); expect(updated.status).toBe(200);
    const copy = await api(`${t}/duplicate`, 'POST', { id: 'copy' }, updated.data.revision);
    expect(copy.data.document.files).toEqual(image.files);
    expect((await api(`${p}/assets/image.png`, 'DELETE', undefined, assetRevision)).status).toBe(409);
    expect((await api(`${s}/steps`, 'POST', { id: 'bad', files: { absent: { path: 'assets/absent.png', mimeType: 'image/png', created: 0 } } })).status).toBe(422);
    expect((await api(`${s}/steps`, 'POST', { id: 'conflict', files: { image: { ...image.files.image, created: 2 } } })).status).toBe(400);
    await api(t, 'DELETE', undefined, updated.data.revision);
    await api(`${s}/steps/copy`, 'DELETE', undefined, copy.data.revision);
    expect((await api(`${p}/assets/image.png`, 'DELETE', undefined, 'stale')).status).toBe(409);
    expect((await api(`${p}/assets/image.png`, 'DELETE', undefined, assetRevision)).status).toBe(204);
    expect((await api(`${p}/assets/image.png`)).status).toBe(404);
  });
  it.each(['corrupt', 'newer', 'mismatched', 'unlisted', 'missing-asset', 'invalid-directory'])('isolates a %s project from healthy projects', async (mode) => {
    await project();
    await mkdir(join(dataDir, 'bad'), { recursive: true });
    const invalid = createProject('Bad', { id: mode === 'mismatched' ? 'wrong' : 'bad' });
    await writeFile(join(dataDir, 'bad/project.json'), mode === 'corrupt' ? '{' : JSON.stringify({ ...invalid, schemaVersion: mode === 'newer' ? 2 : 1 }));
    if (mode === 'invalid-directory') await writeFile(join(dataDir, 'bad/scenes'), 'not a directory');
    if (mode === 'unlisted' || mode === 'missing-asset') {
      await mkdir(join(dataDir, 'bad/scenes/scene/steps'), { recursive: true });
      const child = createScene('Unlisted', { id: 'scene' });
      if (mode === 'missing-asset') {
        invalid.sceneIds = ['scene']; child.stepIds = ['step'];
        await writeFile(join(dataDir, 'bad/project.json'), JSON.stringify(invalid));
        await writeFile(join(dataDir, 'bad/scenes/scene/steps/step.json'), JSON.stringify(createStep({ id: 'step', files: { missing: { path: 'assets/missing.png', mimeType: 'image/png', created: 0 } } })));
      }
      await writeFile(join(dataDir, 'bad/scenes/scene/scene.json'), JSON.stringify(child));
    }
    const listed = await api('/api/projects'); expect(listed.status).toBe(200);
    expect(listed.data.projects.find((x: { id: string }) => x.id === 'p').document.name).toBe('Project');
    const error = listed.data.projects.find((x: { id: string }) => x.id === 'bad').error;
    expect(error.code).toBe('INVALID_PROJECT');
    if (mode === 'newer') expect(error.message).toContain('Upgrade Paso');
    expect((await api('/api/projects/bad')).status).toBe(422);
    expect((await api(p)).status).toBe(200);
  });
  it('rejects symbolic links in projects, scene paths and asset files', async () => {
    await project();
    const outside = await mkdtemp(join(tmpdir(), 'paso-outside-'));
    try {
      await writeFile(join(outside, 'keep'), 'unchanged');
      await symlink(outside, join(dataDir, 'link'));
      expect((await api('/api/projects/link')).status).toBe(422);
      await mkdir(join(dataDir, 'p/assets'), { recursive: true });
      await symlink(join(outside, 'keep'), join(dataDir, 'p/assets/link.png'));
      expect((await api(`${p}/assets/link.png`)).status).toBe(422);
      await rm(join(dataDir, 'p/assets/link.png'));
      await mkdir(join(dataDir, 'p/scenes'), { recursive: true });
      await symlink(outside, join(dataDir, 'p/scenes/link'));
      expect((await api(p)).status).toBe(422);
      expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('unchanged');
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  it('does not overwrite paths through case aliases on case-insensitive volumes', async () => {
    await step();
    const aliases = await readFile(join(dataDir, 'P/project.json')).then(() => true, () => false);
    expect((await api('/api/projects', 'POST', { id: 'P', name: 'Uppercase' })).status).toBe(aliases ? 409 : 201);
    expect((await api(`${p}/scenes`, 'POST', { id: 'S', name: 'Uppercase' })).status).toBe(aliases ? 409 : 201);
    expect((await api(`${s}/steps`, 'POST', { id: 'T' })).status).toBe(aliases ? 409 : 201);
    const upload = (name: string, bytes: string) => fetch(`${service.url}${p}/assets/${name}.png`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: bytes });
    expect((await upload('image', 'original')).status).toBe(200);
    expect((await upload('IMAGE', 'different')).status).toBe(aliases ? 409 : 200);
    expect(await readFile(join(dataDir, 'p/assets/image.png'), 'utf8')).toBe('original');
    expect((await api(t)).data.document.id).toBe('t');
    expect((await api(s)).data.document.id).toBe('s');
    expect((await api(p)).data.document.name).toBe('Project');
  });
  it('writes the documented JSON format and leaves no temporary files', async () => {
    await step();
    const content = await readFile(join(dataDir, 'p/project.json'), 'utf8');
    expect(content).toBe(`${JSON.stringify(JSON.parse(content), null, 2)}\n`);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dataDir, { recursive: true })).some((path) => path.includes('.paso-'))).toBe(false);
  });
});

describe('real-time notifications', () => {
  it('emits API changes with revisions exactly once, including parent orders and deletions', async () => {
    const stream = await events();
    const created = await step();
    await stream.next((e) => e.type === 'created' && e.id === 't' && e.revision === created.data.revision);
    const updated = await api(t, 'PUT', { ...created.data.document, title: 'Updated' }, created.data.revision);
    await stream.next((e) => e.type === 'updated' && e.id === 't' && e.revision === updated.data.revision);
    const second = await api(`${s}/steps`, 'POST', { id: 'second' });
    const parent = (await api(s)).data;
    const reordered = await api(`${s}/steps`, 'PUT', { ids: ['second', 't'] }, parent.revision);
    await stream.next((e) => e.type === 'reordered' && e.id === 's' && e.revision === reordered.data.revision);
    await api(`${s}/steps/second`, 'DELETE', undefined, second.data.revision);
    const deleted = await stream.next((e) => e.type === 'deleted' && e.id === 'second');
    expect(deleted.revision).toBeNull(); expect(deleted.previousRevision).toBe(second.data.revision);
    // A later external event is a watcher barrier. Assertions need no timing sleep.
    const bytes = JSON.stringify({ ...(await api(t)).data.document, title: 'Barrier' });
    await writeFile(join(dataDir, 'p/scenes/s/steps/t.json'), bytes);
    await stream.next((e) => e.id === 't' && e.revision === hash(bytes));
    for (const revision of [created.data.revision, updated.data.revision]) {
      expect(stream.messages.filter((e) => 'id' in e && e.id === 't' && e.revision === revision)).toHaveLength(1);
    }
  });
  it('detects external edit, addition, reordering, deletion and atomic replacement', async () => {
    await step();
    const stream = await events();
    const path = join(dataDir, 'p/scenes/s/steps/t.json');
    const original = (await api(t)).data.document;
    const bytes = JSON.stringify({ ...original, title: 'External' });
    await writeFile(path, bytes);
    const changed = await stream.next((e) => e.type === 'updated' && e.id === 't' && e.revision === hash(bytes));
    expect(changed.sceneId).toBe('s');
    const copy = createStep({ id: 'external' });
    await writeFile(join(dataDir, 'p/scenes/s/steps/external.json'), JSON.stringify(copy));
    await stream.next((e) => e.type === 'created' && e.id === 'external');
    const parent = { ...(await readFile(join(dataDir, 'p/scenes/s/scene.json'), 'utf8').then(JSON.parse)), stepIds: ['external', 't'] };
    const parentBytes = JSON.stringify(parent);
    await writeFile(join(dataDir, 'p/scenes/s/scene.json'), parentBytes);
    await stream.next((e) => e.type === 'reordered' && e.id === 's' && e.revision === hash(parentBytes));
    const replacement = JSON.stringify({ ...original, title: 'Atomic replacement' });
    await writeFile(`${path}.tmp`, replacement); await rename(`${path}.tmp`, path);
    await stream.next((e) => e.type === 'updated' && e.id === 't' && e.revision === hash(replacement));
    await rm(join(dataDir, 'p/scenes/s/steps/external.json'));
    await stream.next((e) => e.type === 'deleted' && e.id === 'external');
    await writeFile(join(dataDir, 'p/scenes/s/scene.json'), JSON.stringify({ ...parent, stepIds: ['t'] }));
    await stream.next((e) => e.type === 'reordered' && e.id === 's' && e.revision === hash(JSON.stringify({ ...parent, stepIds: ['t'] })));
    expect((await api(p)).status).toBe(200);
  });
  it('detects new and removed project directories and assets while ignoring unknown and temporary files', async () => {
    const stream = await events();
    await mkdir(join(dataDir, 'external/assets'), { recursive: true });
    await writeFile(join(dataDir, 'external/notes.json'), '{}');
    await writeFile(join(dataDir, 'external/.paso-temp.tmp'), 'temporary');
    await writeFile(join(dataDir, 'external/project.json'), JSON.stringify(createProject('External', { id: 'external' })));
    await stream.next((e) => e.type === 'created' && e.kind === 'project' && e.id === 'external');
    await writeFile(join(dataDir, 'external/assets/image.png'), 'bytes');
    await stream.next((e) => e.type === 'created' && e.kind === 'asset' && e.id === 'image.png');
    await rm(join(dataDir, 'external'), { recursive: true });
    await stream.next((e) => e.type === 'deleted' && e.kind === 'project' && e.id === 'external');
    expect(stream.messages.filter((e) => 'id' in e && (e.id.includes('notes') || e.id.includes('temp')))).toEqual([]);
  });
  it('reports invalid external JSON and recovery without stopping healthy project events', async () => {
    await project(); const stream = await events();
    await writeFile(join(dataDir, 'p/project.json'), '{');
    await stream.next((e) => e.type === 'project-error' && e.projectId === 'p');
    const healthy = await api('/api/projects', 'POST', { id: 'healthy', name: 'Healthy' });
    await stream.next((e) => e.type === 'created' && e.id === 'healthy' && e.revision === healthy.data.revision);
    const bytes = JSON.stringify(createProject('Recovered', { id: 'p' }));
    await writeFile(join(dataDir, 'p/project.json'), bytes);
    await stream.next((e) => e.type === 'updated' && e.projectId === 'p' && e.revision === hash(bytes));
    expect((await api(p)).data.document.name).toBe('Recovered');
  });
});

describe('security', () => {
  it('binds only to IPv4 loopback and authenticates the health route', async () => {
    expect(service.server.address()).toMatchObject({ address: '127.0.0.1' });
    expect((await api('/api/health')).data).toEqual({ status: 'ok' });
    expect((await fetch(`${service.url}/api/health`)).status).toBe(401);
    expect(await raw('/unknown', { Authorization: 'Bearer wrong' })).toBe(401);
  });
  it.each([
    [{ Authorization: '' }, 401],
    [{ Authorization: 'Bearer wrong' }, 401],
    [{ Authorization: token }, 401],
    [{ Host: 'evil.example' }, 403],
    [{ Host: '127.0.0.1:9' }, 403],
    [{ Origin: 'https://evil.example' }, 403],
    [{ Origin: 'null' }, 403],
    [{ Origin: 'http://localhost:5173.evil.example' }, 403],
  ] as const)('rejects HTTP security violations %j', async (headers, status) => {
    expect(await raw('/api/health', headers)).toBe(status);
  });
  it.each([
    [['paso'], {}, 401],
    [['paso', 'paso-token.wrong'], {}, 401],
    [['paso', `paso-token.${token}`], { Host: 'evil.example' }, 403],
    [['paso', `paso-token.${token}`], { Origin: 'https://evil.example' }, 403],
    [['paso', `paso-token.${token}`], { Origin: 'null' }, 403],
  ] as const)('rejects WebSocket security violations %j %j', async (protocols, headers, status) => {
    expect(await rejectedSocket([...protocols], headers)).toBe(status);
  });
  it('accepts the exact local Origin and rejects URL query token authentication', async () => {
    expect(await raw('/api/health', { Origin: service.url })).toBe(200);
    expect((await fetch(`${service.url}/api/health?token=${token}`)).status).toBe(401);
    expect(await rejectedSocket(['paso', `paso-token.${token}`], { Origin: service.url + '.evil.example' })).toBe(403);
    const ws = new WebSocket(`${service.url.replace('http', 'ws')}/api/events`, ['paso', `paso-token.${token}`], { origin: service.url });
    clients.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once('message', () => resolve()); ws.once('error', reject); });
    expect(ws.protocol).toBe('paso');
  });
  it.each(['..', '%2e%2e', '%2fetc', '%5c..', 'bad%00id', 'a.b', 'a%2fb'])('rejects path traversal and invalid IDs %s', async (id) => {
    expect(await raw(`/api/projects/${id}`)).toBe(400);
    expect(await raw(`/api/projects/p/scenes/${id}`)).toBe(400);
    expect(await raw(`/api/projects/p/scenes/s/steps/${id}`)).toBe(400);
    expect((await api('/api/projects', 'POST', { id, name: 'Unsafe' })).status).toBe(400);
  });
  it('rejects unsafe asset names and oversized bodies', async () => {
    await project();
    for (const name of ['..%2fsecret', 'image.PNG', 'image.svg%2f..', 'image']) expect(await raw(`${p}/assets/${name}`)).toBe(400);
    await service.close();
    service = await startServer({ dataDir, port: 0, sessionToken: token, maxJsonBytes: 16, maxAssetBytes: 2 });
    expect((await api('/api/projects', 'POST', { name: 'This exceeds the limit' })).status).toBe(413);
    expect((await fetch(`${service.url}${p}/assets/image.png`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: 'too big' })).status).toBe(413);
  });
});

describe('«Abrir carpeta»', () => {
  it('opens the project folder, by its ID under the data directory, and nothing else', async () => {
    await service.close();
    const opened: string[] = [];
    let fail = false;
    service = await startServer({ dataDir, port: 0, sessionToken: token, pollIntervalMs: 100,
      openFolder: async (path) => { if (fail) throw new Error('no file manager'); opened.push(path); } });
    await project();
    expect((await api(`${p}/reveal`, 'POST')).status).toBe(204);
    expect(opened).toHaveLength(1);
    expect(opened[0].endsWith(join('', 'p'))).toBe(true);
    expect(await readFile(join(opened[0], 'project.json'), 'utf8')).toContain('"name": "Project"');
    expect((await api('/api/projects/missing/reveal', 'POST')).status).toBe(404);
    expect((await api(`${p}/reveal`, 'GET')).status).toBe(405);
    expect((await api('/api/projects/..%2F..%2Fetc/reveal', 'POST')).status).toBe(400);
    fail = true;
    const failed = await api(`${p}/reveal`, 'POST');
    expect(failed.status).toBe(500);
    expect(failed.data.error.code).toBe('REVEAL_FAILED');
    expect(opened).toHaveLength(1);
  });
});
