import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from './server.js';

type Service = Awaited<ReturnType<typeof startServer>>;
const token = 'workspace-test-token-with-at-least-32-characters';
let root: string;
let service: Service;
let opened: string[];

const start = async () => {
  service = await startServer({
    dataDir: join(root, 'app', 'projects'), workspacesPath: join(root, 'app', 'workspaces.json'), runsDir: join(root, 'app', 'runs'),
    port: 0, sessionToken: token, pollIntervalMs: 50, openFolder: async (path) => { opened.push(path); },
    agent: { workDir: join(root, 'app', 'agent-workspace'), sessionsPath: join(root, 'app', 'agent-sessions.json') },
    harnessRegistryPath: join(root, 'app', 'harnesses.json'),
  });
};
async function api<T = unknown>(path: string, method = 'GET', input?: unknown) {
  const response = await fetch(`${service.url}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return { status: response.status, data: (response.status === 204 ? null : await response.json()) as T };
}
type Listing = { activeId: string; workspaces: Array<{ id: string; name: string; path: string; default: boolean; available: boolean }> };
const projectNames = async () => (await api<{ projects: Array<{ document: { name: string } }> }>('/api/projects')).data.projects.map((p) => p.document.name).sort();

beforeEach(async () => {
  // Real path: on macOS the temporary folder is reached through a link, and workspaces are stored by their real path.
  root = await realpath(await mkdtemp(join(tmpdir(), 'paso-workspaces-')));
  opened = [];
  await mkdir(join(root, 'Clases'));
  await start();
});
afterEach(async () => {
  await service.close();
  await rm(root, { recursive: true, force: true });
});

describe('workspaces', () => {
  it('starts in the default workspace, adds a folder, switches to it and back, and every project route follows', async () => {
    const first = await api<Listing>('/api/workspaces');
    expect(first.data).toEqual({ activeId: 'default', workspaces: [expect.objectContaining({ id: 'default', default: true, available: true })] });
    await api('/api/projects', 'POST', { id: 'a', name: 'En el predeterminado' });

    const added = await api<Listing['workspaces'][number]>('/api/workspaces', 'POST', { path: join(root, 'Clases') });
    expect(added.status).toBe(201);
    expect(added.data).toMatchObject({ name: 'Clases', default: false, available: true });
    // Adding does not open it.
    expect(await projectNames()).toEqual(['En el predeterminado']);

    const switched = await api<Listing>('/api/workspaces/active', 'PUT', { id: added.data.id });
    expect(switched.data.activeId).toBe(added.data.id);
    expect(await projectNames()).toEqual([]);
    await api('/api/projects', 'POST', { id: 'b', name: 'En Clases' });
    await api('/api/projects/b/scenes', 'POST', { id: 's', name: 'Escena' });
    expect(JSON.parse(await readFile(join(root, 'Clases', 'b', 'project.json'), 'utf8'))).toMatchObject({ name: 'En Clases', sceneIds: ['s'] });
    expect(await readdir(join(root, 'app', 'projects'))).toEqual(['a']);
    expect((await api('/api/projects/a')).status).toBe(404);

    // Restore points of this workspace live with the app's data, not in the person's folder.
    const run = await api<{ run: { id: string } }>('/api/projects/b/runs', 'POST', {});
    expect(run.status).toBe(201);
    expect(await readdir(join(root, 'Clases'))).toEqual(['b']);
    await api(`/api/projects/b/runs/${run.data.run.id}/finish`, 'POST');

    await api('/api/projects/b/reveal', 'POST');
    expect(opened).toEqual([join(root, 'Clases', 'b')]);

    await api('/api/workspaces/active', 'PUT', { id: 'default' });
    expect(await projectNames()).toEqual(['En el predeterminado']);
  });

  it('remembers the list and the open workspace across restarts', async () => {
    const added = await api<{ id: string }>('/api/workspaces', 'POST', { path: join(root, 'Clases'), name: 'Mis clases' });
    await api('/api/workspaces/active', 'PUT', { id: added.data.id });
    await api('/api/projects', 'POST', { id: 'b', name: 'Sigue aquí' });
    await service.close();
    await start();
    const listing = await api<Listing>('/api/workspaces');
    expect(listing.data.activeId).toBe(added.data.id);
    expect(listing.data.workspaces.map((w) => w.name)).toEqual(['Mis diagramas', 'Mis clases']);
    expect(await projectNames()).toEqual(['Sigue aquí']);
  });

  it('starts in the default workspace when the open one was deleted, and lists it as unavailable', async () => {
    const added = await api<{ id: string }>('/api/workspaces', 'POST', { path: join(root, 'Clases') });
    await api('/api/workspaces/active', 'PUT', { id: added.data.id });
    await service.close();
    await rm(join(root, 'Clases'), { recursive: true });
    await start();
    const listing = await api<Listing>('/api/workspaces');
    expect(listing.data.activeId).toBe('default');
    expect(listing.data.workspaces.find((w) => w.id === added.data.id)).toMatchObject({ available: false });
    // It is not quietly created again.
    const switched = await api<{ error: { code: string } }>('/api/workspaces/active', 'PUT', { id: added.data.id });
    expect(switched).toMatchObject({ status: 422, data: { error: { code: 'WORKSPACE_UNAVAILABLE' } } });
    await expect(readdir(join(root, 'Clases'))).rejects.toThrow();
  });

  it('removes a workspace from the list without deleting its files, and goes back to the default one', async () => {
    const added = await api<{ id: string }>('/api/workspaces', 'POST', { path: join(root, 'Clases') });
    await api('/api/workspaces/active', 'PUT', { id: added.data.id });
    await api('/api/projects', 'POST', { id: 'b', name: 'Se queda' });
    expect((await api(`/api/workspaces/${added.data.id}`, 'DELETE')).status).toBe(204);
    const listing = await api<Listing>('/api/workspaces');
    expect(listing.data).toMatchObject({ activeId: 'default', workspaces: [{ id: 'default' }] });
    expect(listing.data.workspaces).toHaveLength(1);
    expect(await readdir(join(root, 'Clases'))).toEqual(['b']);
    expect((await api('/api/workspaces/default', 'DELETE')).status).toBe(400);
  });

  it('refuses folders that are already a workspace, overlap one, belong to Paso, or are too broad', async () => {
    const add = async (path: string) => (await api<{ error: { code: string } }>('/api/workspaces', 'POST', { path })).data.error?.code;
    await api('/api/workspaces', 'POST', { path: join(root, 'Clases') });
    await mkdir(join(root, 'Clases', 'Tema 1'));
    expect(await add(join(root, 'Clases'))).toBe('WORKSPACE_EXISTS');
    expect(await add(join(root, 'Clases', 'Tema 1'))).toBe('WORKSPACE_OVERLAP');
    expect(await add(root)).toBe('WORKSPACE_OVERLAP');
    await mkdir(join(root, 'app', 'otra'), { recursive: true });
    expect(await add(join(root, 'app', 'otra'))).toBe('RESERVED_FOLDER');
    expect(await add(homedir())).toBe('FOLDER_TOO_BROAD');
    expect(await add('/')).toBe('FOLDER_TOO_BROAD');
    expect(await add(join(root, 'no-existe'))).toBe('FOLDER_NOT_FOUND');
    expect(await add('relativa')).toBe('INVALID_PATH');
  });

  it('tells clients on the event stream when the list or the open workspace changes', async () => {
    const ws = new WebSocket(`${service.url.replace('http', 'ws')}/api/events`, ['paso', `paso-token.${token}`]);
    const messages: Array<{ type: string; activeId?: string }> = [];
    ws.on('message', (bytes) => messages.push(JSON.parse(bytes.toString())));
    await new Promise((resolve) => ws.once('message', resolve));
    const added = await api<{ id: string }>('/api/workspaces', 'POST', { path: join(root, 'Clases') });
    await api('/api/workspaces/active', 'PUT', { id: added.data.id });
    // Changes in the newly opened folder reach the same stream.
    await mkdir(join(root, 'Clases', 'nuevo'));
    await writeFile(join(root, 'Clases', 'nuevo', 'project.json'), `${JSON.stringify({ schemaVersion: 1, id: 'nuevo', name: 'Desde fuera', createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z', sceneIds: [] }, null, 2)}\n`);
    const end = Date.now() + 5000;
    while (!messages.some((m) => m.type === 'created') && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    ws.close();
    expect(messages.filter((m) => m.type === 'workspaces')).toEqual([
      { type: 'workspaces', activeId: 'default' }, { type: 'workspaces', activeId: added.data.id },
    ]);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'created', projectId: 'nuevo' }));
  });
});

describe('the folder explorer', () => {
  it('lists subfolders only, hides hidden ones, counts projects, and goes up', async () => {
    await mkdir(join(root, 'Clases', 'b'));
    await writeFile(join(root, 'Clases', 'b', 'project.json'), '{}');
    await mkdir(join(root, 'Clases', '.oculta'));
    await mkdir(join(root, 'Clases', 'Apuntes'));
    await writeFile(join(root, 'Clases', 'secreto.txt'), 'no se lista');
    const { status, data } = await api<{ path: string; parent: string; folders: Array<{ name: string }>; projects: number; home: string }>(`/api/folders?path=${encodeURIComponent(join(root, 'Clases'))}`);
    expect(status).toBe(200);
    expect(data).toMatchObject({ path: join(root, 'Clases'), parent: root, projects: 1, home: homedir() });
    expect(data.folders.map((folder) => folder.name)).toEqual(['Apuntes', 'b']);
    expect(JSON.stringify(data)).not.toContain('secreto');
    expect((await api<{ path: string }>('/api/folders')).data.path).toBe(homedir());
    const crumbs = (await api<{ crumbs: Array<{ name: string; path: string }> }>(`/api/folders?path=${encodeURIComponent(join(root, 'Clases'))}`)).data.crumbs;
    expect(crumbs[0].path).toBe('/');
    expect(crumbs.at(-1)).toEqual({ name: 'Clases', path: join(root, 'Clases') });
    expect(crumbs.map((crumb) => crumb.name).slice(1).join('/')).toBe(join(root, 'Clases').slice(1));
    expect((await api<{ parent: null }>('/api/folders?path=%2F')).data.parent).toBeNull();
    expect((await api(`/api/folders?path=${encodeURIComponent(join(root, 'nada'))}`)).status).toBe(404);
  });

  it('creates a folder, and refuses names with slashes or one that exists', async () => {
    const made = await api<{ path: string }>('/api/folders', 'POST', { parent: root, name: 'Nueva' });
    expect(made).toEqual({ status: 201, data: { path: join(root, 'Nueva') } });
    expect((await api('/api/folders', 'POST', { parent: root, name: 'Nueva' })).status).toBe(409);
    expect((await api('/api/folders', 'POST', { parent: root, name: '../fuera' })).status).toBe(400);
    expect((await api('/api/folders', 'POST', { parent: root, name: '..' })).status).toBe(400);
  });
});
