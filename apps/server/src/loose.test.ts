import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from './server.js';

type Service = Awaited<ReturnType<typeof startServer>>;
const token = 'loose-diagram-test-token-with-at-least-32-characters';
let root: string;
let dataDir: string;
let service: Service;
let opened: string[];
const loose = '/api/projects/_loose';

const start = async () => {
  service = await startServer({
    dataDir, workspacesPath: join(root, 'app', 'workspaces.json'), runsDir: join(root, 'app', 'runs'),
    port: 0, sessionToken: token, pollIntervalMs: 50, openFolder: async (path) => { opened.push(path); },
    agent: { workDir: join(root, 'app', 'agent-workspace'), sessionsPath: join(root, 'app', 'agent-sessions.json') },
    harnessRegistryPath: join(root, 'app', 'harnesses.json'),
  });
};
const restart = async () => { await service.close(); await start(); };
async function api<T = any>(path: string, method = 'GET', input?: unknown, revision?: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await fetch(`${service.url}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(revision ? { 'If-Match': `"${revision}"` } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return { status: response.status, data: (response.status === 204 ? null : await response.json()) as T };
}
const image = { id: 'image-element', type: 'image', version: 1, versionNonce: 1, isDeleted: false, fileId: 'pic' };
const box = { id: 'box-element', type: 'rectangle', version: 3, versionNonce: 7, isDeleted: false, x: 10, y: 20, futureField: { kept: true } };
const pngBytes = Buffer.from('not-really-a-png-but-bytes');

/** A loose diagram with two steps, one of them showing an image. */
async function looseDiagram(id = 'diagram', name = 'Suelto') {
  expect((await api(`${loose}/scenes`, 'POST', { id, name })).status).toBe(201);
  const upload = await fetch(`${service.url}${loose}/assets/pic.png`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: pngBytes });
  expect(upload.status).toBe(200);
  const first = await api(`${loose}/scenes/${id}/steps`, 'POST', { id: `${id}-one`, title: 'Uno', elements: [box] });
  expect(first.status).toBe(201);
  const second = await api(`${loose}/scenes/${id}/steps`, 'POST', {
    id: `${id}-two`, title: 'Dos', elements: [box, image], files: { pic: { path: 'assets/pic.png', mimeType: 'image/png', created: 1 } },
  });
  expect(second.status).toBe(201);
  return { first: first.data, second: second.data };
}
async function target(id = 'target') {
  expect((await api('/api/projects', 'POST', { id, name: 'Proyecto' })).status).toBe(201);
  expect((await api(`/api/projects/${id}/scenes`, 'POST', { id: `${id}-scene`, name: 'Existente' })).status).toBe(201);
}
const sceneRevision = async (id = 'diagram') => (await api(`${loose}/scenes/${id}`)).data.revision as string;
const move = async (id: string, projectId: string, revision?: string) => api(`${loose}/scenes/${id}/move`, 'POST', { projectId }, revision);
const hidden = () => join(dataDir, '.loose');

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'paso-loose-')));
  dataDir = join(root, 'app', 'projects');
  opened = [];
  await start();
});
afterEach(async () => {
  await service.close();
  await rm(root, { recursive: true, force: true });
});

describe('the reserved project of loose diagrams', () => {
  it('appears with the first loose diagram, in a hidden folder, and is never listed as a project', async () => {
    expect((await api(loose)).status).toBe(404);
    expect((await api(`${loose}/scenes`, 'POST', { id: 'diagram', name: 'Suelto' })).status).toBe(201);
    expect(existsSync(join(hidden(), 'project.json'))).toBe(true);
    expect(existsSync(join(hidden(), 'scenes', 'diagram', 'scene.json'))).toBe(true);
    expect(existsSync(join(dataDir, '_loose'))).toBe(false);
    expect((await api('/api/projects')).data.projects).toEqual([]);
    const read = await api(loose);
    expect(read.status).toBe(200);
    expect(read.data.document).toMatchObject({ id: '_loose', name: 'Diagramas sueltos', sceneIds: ['diagram'] });
    expect((await api(`${loose}/scenes`)).data.scenes.map((scene: { document: { name: string } }) => scene.document.name)).toEqual(['Suelto']);
  });
  it('is not a project to rename, delete, reveal or create by hand', async () => {
    await api(`${loose}/scenes`, 'POST', { id: 'diagram', name: 'Suelto' });
    const { revision } = (await api(loose)).data;
    expect((await api(loose, 'PATCH', { name: 'Otro' }, revision)).data.error.code).toBe('RESERVED_PROJECT');
    expect((await api(loose, 'DELETE', undefined, revision)).data.error.code).toBe('RESERVED_PROJECT');
    expect((await api(`${loose}/reveal`, 'POST')).status).toBe(404);
    expect(opened).toEqual([]);
    expect((await api('/api/projects', 'POST', { id: '_loose', name: 'X' })).data.error.code).toBe('RESERVED_PROJECT');
    expect(existsSync(join(hidden(), 'scenes', 'diagram'))).toBe(true);
  });
  it('renames and deletes a loose diagram as a scene', async () => {
    await looseDiagram();
    const renamed = await api(`${loose}/scenes/diagram`, 'PATCH', { name: 'Nuevo nombre' }, await sceneRevision());
    expect(renamed.data.document.name).toBe('Nuevo nombre');
    expect((await api(`${loose}/scenes/diagram`, 'DELETE', undefined, renamed.data.revision)).status).toBe(204);
    expect((await api(loose)).data.document.sceneIds).toEqual([]);
    expect(existsSync(join(hidden(), 'scenes', 'diagram'))).toBe(false);
  });
  it('keeps its own loose diagrams in each workspace', async () => {
    await looseDiagram('here', 'Del predeterminado');
    await mkdir(join(root, 'Clases'));
    const added = await api('/api/workspaces', 'POST', { path: join(root, 'Clases') });
    expect((await api('/api/workspaces/active', 'PUT', { id: added.data.id })).status).toBe(200);
    expect((await api(loose)).status).toBe(404);
    await api(`${loose}/scenes`, 'POST', { id: 'there', name: 'De Clases' });
    expect(existsSync(join(root, 'Clases', '.loose', 'scenes', 'there'))).toBe(true);
    expect((await api(loose)).data.document.sceneIds).toEqual(['there']);
    await api('/api/workspaces/active', 'PUT', { id: 'default' });
    expect((await api(loose)).data.document.sceneIds).toEqual(['here']);
  });
  it('reports live changes to a loose diagram on the event stream', async () => {
    await looseDiagram();
    const ws = new WebSocket(`${service.url.replace('http', 'ws')}/api/events`, ['paso', `paso-token.${token}`]);
    const events: Array<{ projectId?: string; kind?: string; id?: string }> = [];
    await new Promise<void>((resolve) => ws.on('message', (bytes) => { const event = JSON.parse(bytes.toString()); events.push(event); if (event.type === 'ready') resolve(); }));
    // Written behind the service's back, as a person editing the file would.
    const file = join(hidden(), 'scenes', 'diagram', 'steps', 'diagram-one.json');
    const step = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, `${JSON.stringify({ ...step, title: 'Editado' }, null, 2)}\n`);
    const end = Date.now() + 5000;
    while (!events.some((event) => event.projectId === '_loose' && event.id === 'diagram-one') && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    ws.terminate();
    expect(events.some((event) => event.projectId === '_loose' && event.kind === 'step' && event.id === 'diagram-one')).toBe(true);
  });
});

describe('moving a loose diagram into a project', () => {
  it('appends it as the last scene with its steps, element IDs, images and revisions, and removes it from the loose ones', async () => {
    const { first, second } = await looseDiagram();
    await looseDiagram('other', 'Otro suelto');
    await target();
    const moved = await move('diagram', 'target', await sceneRevision());
    expect(moved.status).toBe(200);
    expect(moved.data).toMatchObject({ projectId: 'target', document: { id: 'diagram', name: 'Suelto', stepIds: ['diagram-one', 'diagram-two'] } });

    const project = (await api('/api/projects/target')).data.document;
    expect(project.sceneIds).toEqual(['target-scene', 'diagram']);
    const steps = (await api('/api/projects/target/scenes/diagram/steps')).data.steps;
    // Same bytes, so the same revisions: an editor that had the step open keeps a valid revision.
    expect(steps).toEqual([first, second]);
    expect(steps[1].document.elements.map((element: { id: string }) => element.id)).toEqual(['box-element', 'image-element']);
    expect(steps[1].document.elements[0].futureField).toEqual({ kept: true });
    const asset = await fetch(`${service.url}/api/projects/target/assets/pic.png`, { headers: { Authorization: `Bearer ${token}` } });
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(pngBytes);

    expect((await api(loose)).data.document.sceneIds).toEqual(['other']);
    expect(existsSync(join(hidden(), 'scenes', 'diagram'))).toBe(false);
    // The other loose diagram still uses the image, so it stays.
    expect(existsSync(join(hidden(), 'assets', 'pic.png'))).toBe(true);
    expect((await readdir(join(dataDir, 'target'))).sort()).toEqual(['assets', 'project.json', 'scenes']);
    expect((await readdir(hidden())).sort()).toEqual(['assets', 'project.json', 'scenes']);
    expect(existsSync(join(hidden(), '.moves', 'diagram.json'))).toBe(false);

    // Survives a restart.
    await restart();
    expect((await api('/api/projects/target')).data.document.sceneIds).toEqual(['target-scene', 'diagram']);
    expect((await api(loose)).data.document.sceneIds).toEqual(['other']);
    expect((await api('/api/projects')).data.projects.map((item: { id: string }) => item.id)).toEqual(['target']);
  });
  it('removes images only the moved diagram used from the loose diagrams', async () => {
    await looseDiagram();
    await target();
    expect((await move('diagram', 'target', await sceneRevision())).status).toBe(200);
    expect(existsSync(join(hidden(), 'assets', 'pic.png'))).toBe(false);
    expect(existsSync(join(dataDir, 'target', 'assets', 'pic.png'))).toBe(true);
  });
  it('needs the current revision of the diagram, and refuses unknown targets and its own project', async () => {
    await looseDiagram();
    await target();
    const revision = await sceneRevision();
    expect((await move('diagram', 'target')).status).toBe(428);
    expect((await move('diagram', 'target', 'stale')).data.error.code).toBe('REVISION_CONFLICT');
    expect((await move('diagram', 'missing', revision)).status).toBe(404);
    expect((await move('diagram', '_loose', revision)).data.error.code).toBe('MOVE_NOT_SUPPORTED');
    expect((await api('/api/projects/target/scenes/target-scene/move', 'POST', { projectId: 'target' })).data.error.code).toBe('MOVE_NOT_SUPPORTED');
    expect((await move('nope', 'target', revision)).status).toBe(404);
    expect((await api(loose)).data.document.sceneIds).toEqual(['diagram']);
    expect((await api('/api/projects/target')).data.document.sceneIds).toEqual(['target-scene']);
  });
  it('stops before writing anything when a step ID or an image clashes with the project', async () => {
    await looseDiagram();
    await target();
    await api('/api/projects/target/scenes/target-scene/steps', 'POST', { id: 'diagram-one' });
    expect((await move('diagram', 'target', await sceneRevision())).data.error.code).toBe('ID_COLLISION');
    await api('/api/projects/target/scenes/target-scene/steps/diagram-one', 'DELETE', undefined, (await api('/api/projects/target/scenes/target-scene/steps/diagram-one')).data.revision);
    await fetch(`${service.url}/api/projects/target/assets/pic.png`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: 'other bytes' });
    expect((await move('diagram', 'target', await sceneRevision())).data.error.code).toBe('ASSET_CONFLICT');
    expect((await api(loose)).data.document.sceneIds).toEqual(['diagram']);
    expect((await api('/api/projects/target')).data.document.sceneIds).toEqual(['target-scene']);
    expect(existsSync(join(dataDir, 'target', 'scenes', 'diagram'))).toBe(false);
  });
  it('loses and duplicates nothing when the copy fails halfway', async () => {
    await looseDiagram();
    await target();
    // A file where the staging folder goes: the copy fails after the image was already copied.
    await writeFile(join(dataDir, 'target', '.incoming'), 'in the way');
    const failed = await move('diagram', 'target', await sceneRevision());
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect((await api(loose)).data.document.sceneIds).toEqual(['diagram']);
    expect((await api(`${loose}/scenes/diagram/steps`)).data.steps).toHaveLength(2);
    expect((await api('/api/projects/target')).status).toBe(200);
    expect((await api('/api/projects/target')).data.document.sceneIds).toEqual(['target-scene']);
    expect(existsSync(join(dataDir, 'target', 'scenes', 'diagram'))).toBe(false);
    // The image copied for the move is taken back, and no journal is left.
    expect(existsSync(join(dataDir, 'target', 'assets', 'pic.png'))).toBe(false);
    expect(existsSync(join(hidden(), '.moves', 'diagram.json'))).toBe(false);
    // The failed attempt cleared its staging place, so the same move now works.
    expect((await move('diagram', 'target', await sceneRevision())).status).toBe(200);
  });
  it('undoes at start-up a move that a crash cut short before the project listed the scene', async () => {
    await looseDiagram();
    await target();
    await service.close();
    // The state right after the staged copy was renamed into place, before the project's scene list was written.
    await cp(join(hidden(), 'scenes', 'diagram'), join(dataDir, 'target', 'scenes', 'diagram'), { recursive: true });
    await cp(join(hidden(), 'assets', 'pic.png'), join(dataDir, 'target', 'assets', 'pic.png'));
    await mkdir(join(hidden(), '.moves'), { recursive: true });
    await writeFile(join(hidden(), '.moves', 'diagram.json'), JSON.stringify({ sceneId: 'diagram', targetId: 'target', assets: ['assets/pic.png'], addedAssets: ['assets/pic.png'] }));
    await start();
    expect((await api('/api/projects/target')).status).toBe(200);
    expect((await api('/api/projects/target')).data.document.sceneIds).toEqual(['target-scene']);
    expect(existsSync(join(dataDir, 'target', 'scenes', 'diagram'))).toBe(false);
    expect(existsSync(join(dataDir, 'target', 'assets', 'pic.png'))).toBe(false);
    expect((await api(loose)).data.document.sceneIds).toEqual(['diagram']);
    expect((await api(`${loose}/scenes/diagram/steps`)).data.steps).toHaveLength(2);
    expect(existsSync(join(hidden(), '.moves', 'diagram.json'))).toBe(false);
  });
  it('finishes at start-up a move that a crash cut short after the project listed the scene', async () => {
    await looseDiagram();
    await target();
    await service.close();
    // The state right after the commit: the project lists the scene, the loose copy is still there.
    await cp(join(hidden(), 'scenes', 'diagram'), join(dataDir, 'target', 'scenes', 'diagram'), { recursive: true });
    await cp(join(hidden(), 'assets', 'pic.png'), join(dataDir, 'target', 'assets', 'pic.png'));
    const projectFile = join(dataDir, 'target', 'project.json');
    const project = JSON.parse(await readFile(projectFile, 'utf8'));
    await writeFile(projectFile, `${JSON.stringify({ ...project, sceneIds: [...project.sceneIds, 'diagram'] }, null, 2)}\n`);
    await mkdir(join(hidden(), '.moves'), { recursive: true });
    await writeFile(join(hidden(), '.moves', 'diagram.json'), JSON.stringify({ sceneId: 'diagram', targetId: 'target', assets: ['assets/pic.png'], addedAssets: ['assets/pic.png'] }));
    await start();
    expect((await api('/api/projects/target')).data.document.sceneIds).toEqual(['target-scene', 'diagram']);
    expect((await api('/api/projects/target/scenes/diagram/steps')).data.steps).toHaveLength(2);
    expect((await api(loose)).status).toBe(200);
    expect((await api(loose)).data.document.sceneIds).toEqual([]);
    expect(existsSync(join(hidden(), 'scenes', 'diagram'))).toBe(false);
    expect(existsSync(join(hidden(), 'assets', 'pic.png'))).toBe(false);
    expect(existsSync(join(hidden(), '.moves', 'diagram.json'))).toBe(false);
  });
});

/** A project whose second scene has two steps, one of them showing an image. */
async function projectWithScene(id = 'source') {
  expect((await api('/api/projects', 'POST', { id, name: 'Origen' })).status).toBe(201);
  expect((await api(`/api/projects/${id}/scenes`, 'POST', { id: `${id}-stays`, name: 'Se queda' })).status).toBe(201);
  expect((await api(`/api/projects/${id}/scenes`, 'POST', { id: `${id}-goes`, name: 'Se va' })).status).toBe(201);
  const upload = await fetch(`${service.url}/api/projects/${id}/assets/pic.png`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: pngBytes });
  expect(upload.status).toBe(200);
  const first = await api(`/api/projects/${id}/scenes/${id}-goes/steps`, 'POST', { id: `${id}-one`, elements: [box] });
  const second = await api(`/api/projects/${id}/scenes/${id}-goes/steps`, 'POST', {
    id: `${id}-two`, elements: [box, image], files: { pic: { path: 'assets/pic.png', mimeType: 'image/png', created: 1 } },
  });
  return [first.data, second.data];
}
const moveFrom = async (projectId: string, sceneId: string, to: string) => api(
  `/api/projects/${projectId}/scenes/${sceneId}/move`, 'POST', { projectId: to }, (await api(`/api/projects/${projectId}/scenes/${sceneId}`)).data.revision,
);

describe('moving a scene out of a project, or to another one', () => {
  it('takes a scene out into the loose diagrams, which appear with it, with the same steps and revisions', async () => {
    const steps = await projectWithScene();
    expect(existsSync(hidden())).toBe(false);
    const moved = await moveFrom('source', 'source-goes', '_loose');
    expect(moved.status).toBe(200);
    expect(moved.data).toMatchObject({ projectId: '_loose', document: { id: 'source-goes', name: 'Se va' } });
    expect((await api(loose)).data.document.sceneIds).toEqual(['source-goes']);
    expect((await api(`${loose}/scenes/source-goes/steps`)).data.steps).toEqual(steps);
    const asset = await fetch(`${service.url}${loose}/assets/pic.png`, { headers: { Authorization: `Bearer ${token}` } });
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(pngBytes);
    // The project loses the scene and keeps its images, as when a scene is deleted.
    expect((await api('/api/projects/source')).data.document.sceneIds).toEqual(['source-stays']);
    expect(existsSync(join(dataDir, 'source', 'scenes', 'source-goes'))).toBe(false);
    expect(existsSync(join(dataDir, 'source', 'assets', 'pic.png'))).toBe(true);
    expect((await readdir(join(dataDir, 'source'))).sort()).toEqual(['assets', 'project.json', 'scenes']);
    expect((await api('/api/projects')).data.projects.map((item: { id: string }) => item.id)).toEqual(['source']);

    await restart();
    expect((await api(loose)).data.document.sceneIds).toEqual(['source-goes']);
    expect((await api('/api/projects/source')).data.document.sceneIds).toEqual(['source-stays']);
    // And back in, to the end of the project.
    expect((await moveFrom('_loose', 'source-goes', 'source')).status).toBe(200);
    expect((await api('/api/projects/source')).data.document.sceneIds).toEqual(['source-stays', 'source-goes']);
    expect((await api(loose)).data.document.sceneIds).toEqual([]);
  });
  it('moves a scene from one project to the end of another', async () => {
    const steps = await projectWithScene();
    await target();
    expect((await moveFrom('source', 'source-goes', 'target')).status).toBe(200);
    expect((await api('/api/projects/target')).data.document.sceneIds).toEqual(['target-scene', 'source-goes']);
    expect((await api('/api/projects/target/scenes/source-goes/steps')).data.steps).toEqual(steps);
    expect(existsSync(join(dataDir, 'target', 'assets', 'pic.png'))).toBe(true);
    expect((await api('/api/projects/source')).data.document.sceneIds).toEqual(['source-stays']);
    // No loose diagrams were involved, so none appear.
    expect(existsSync(hidden())).toBe(false);
    // Its last scene can leave a project too: the project stays, empty.
    expect((await moveFrom('source', 'source-stays', 'target')).status).toBe(200);
    expect((await api('/api/projects/source')).data.document.sceneIds).toEqual([]);
  });
  it('finishes at start-up a move out of a project that a crash cut short after the commit', async () => {
    await projectWithScene();
    await target();
    await service.close();
    await cp(join(dataDir, 'source', 'scenes', 'source-goes'), join(dataDir, 'target', 'scenes', 'source-goes'), { recursive: true });
    await cp(join(dataDir, 'source', 'assets', 'pic.png'), join(dataDir, 'target', 'assets', 'pic.png'));
    const projectFile = join(dataDir, 'target', 'project.json');
    const project = JSON.parse(await readFile(projectFile, 'utf8'));
    await writeFile(projectFile, `${JSON.stringify({ ...project, sceneIds: [...project.sceneIds, 'source-goes'] }, null, 2)}\n`);
    await mkdir(join(dataDir, 'source', '.moves'), { recursive: true });
    await writeFile(join(dataDir, 'source', '.moves', 'source-goes.json'), JSON.stringify({ sceneId: 'source-goes', targetId: 'target', assets: ['assets/pic.png'], addedAssets: ['assets/pic.png'] }));
    await start();
    expect((await api('/api/projects/target')).data.document.sceneIds).toEqual(['target-scene', 'source-goes']);
    expect((await api('/api/projects/source')).data.document.sceneIds).toEqual(['source-stays']);
    expect(existsSync(join(dataDir, 'source', 'scenes', 'source-goes'))).toBe(false);
    expect(existsSync(join(dataDir, 'source', '.moves'))).toBe(false);
  });
});
