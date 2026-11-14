// @vitest-environment jsdom
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '@paso/server';
import { ApiClient } from '../lib/api';
import { ActionError, ProjectsStore } from './projects-store';

const token = 'store-test-session-token-with-at-least-32-chars';
let service: Awaited<ReturnType<typeof startServer>>;
let dataDir: string;
let store: ProjectsStore;

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting for the store.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'paso-store-'));
  service = await startServer({ dataDir, port: 0, sessionToken: token, allowedOrigins: [window.location.origin], pollIntervalMs: 100 });
  store = new ProjectsStore(new ApiClient({ baseUrl: service.url, token }));
});
afterEach(async () => {
  store.dispose();
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('ProjectsStore', () => {
  it('loads after the stream is ready, newest first, with errors last', async () => {
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    for (const [id, name] of [['old', 'Viejo'], ['new', 'Nuevo']]) {
      await fetch(`${service.url}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ id, name }) });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await mkdir(join(dataDir, 'bad'));
    await writeFile(join(dataDir, 'bad', 'project.json'), 'nope');
    expect(store.getState()).toMatchObject({ phase: 'loading', rows: [] });
    store.start();
    await until(() => store.getState().phase === 'ready');
    const { rows, connected } = store.getState();
    expect(connected).toBe(true);
    expect(rows.map((row) => row.id)).toEqual(['new', 'old', 'bad']);
    expect(rows[2].kind).toBe('error');
  });

  it('keeps a rename when a re-read that started before it answers after it', async () => {
    const api = new ApiClient({ baseUrl: service.url, token });
    const read = api.getProject.bind(api);
    let gate: Promise<void> | undefined;
    let answered!: () => void;
    const held = new Promise<void>((resolve) => { answered = resolve; });
    // While a gate is set, a re-read takes its answer now and delivers it only when the gate opens.
    api.getProject = async (id) => {
      const wait = gate;
      const answer = await read(id);
      if (wait) { answered(); await wait; }
      return answer;
    };
    store.dispose();
    store = new ProjectsStore(api);
    store.start();
    await until(() => store.getState().phase === 'ready');
    const id = await store.create('Antes');
    let open!: () => void;
    gate = new Promise((resolve) => { open = resolve; });
    const late = store.refresh(id);
    await held;
    gate = undefined;
    await store.update(id, { name: 'Después' });
    open();
    await late;
    const row = store.getState().rows.find((candidate) => candidate.id === id);
    expect(row?.kind === 'ok' && row.project.name).toBe('Después');
  });

  it('turns a stale revision into a clear failure and refreshes the row', async () => {
    store.start();
    await until(() => store.getState().phase === 'ready');
    const id = await store.create('Original');
    const file = join(dataDir, id, 'project.json');
    const doc = JSON.parse(await readFile(file, 'utf8'));
    // An outside edit lands, and the app tries to rename before the watcher has reported it.
    await writeFile(file, JSON.stringify({ ...doc, name: 'Fuera' }, null, 2));
    const failure = await store.update(id, { name: 'Dentro' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ActionError);
    expect((failure as ActionError).message).toMatch(/cambió fuera de Paso/);
    await until(() => {
      const row = store.getState().rows.find((candidate) => candidate.id === id);
      return row?.kind === 'ok' && row.project.name === 'Fuera';
    });
    // With the fresh revision the same change goes through.
    await store.update(id, { name: 'Dentro' });
    expect(JSON.parse(await readFile(file, 'utf8')).name).toBe('Dentro');
  });

  it('says a project that is gone cannot be changed, and drops it', async () => {
    store.start();
    await until(() => store.getState().phase === 'ready');
    const id = await store.create('Efímero');
    await rm(join(dataDir, id), { recursive: true });
    const failure = await store.update(id, { name: 'Otro' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ActionError);
    expect((failure as ActionError).message).toMatch(/ya no existe/);
    await until(() => store.getState().rows.length === 0);
  });

  it('reports the session as the reason when the service rejects the token', async () => {
    store.dispose();
    store = new ProjectsStore(new ApiClient({ baseUrl: service.url, token: 'a-different-token-that-is-long-enough-to-look-real' }));
    store.start();
    await until(() => store.getState().phase === 'unavailable');
    expect(store.getState().reason).toBe('session');
  });
});

describe('ProjectsStore: loose diagrams', () => {
  const auth = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  const post = (path: string, body: unknown) => fetch(`${service.url}${path}`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });

  it('keeps them apart from the projects, newest first, and follows changes made elsewhere', async () => {
    await post('/api/projects', { id: 'p', name: 'Proyecto' });
    store.start();
    await until(() => store.getState().phase === 'ready');
    expect(store.getState().loose).toBeNull();
    await post('/api/projects/_loose/scenes', { id: 'first', name: 'Primero' });
    await post('/api/projects/_loose/scenes/first/steps', {});
    await post('/api/projects/_loose/scenes', { id: 'second', name: 'Segundo' });
    await until(() => store.getState().loose?.diagrams.length === 2);
    const { rows, loose } = store.getState();
    expect(rows.map((row) => row.id)).toEqual(['p']);
    expect(loose!.diagrams.map((diagram) => [diagram.id, diagram.scene.name, diagram.steps])).toEqual([['second', 'Segundo', 0], ['first', 'Primero', 1]]);
  });

  it('renames, deletes and moves one into a project', async () => {
    await post('/api/projects', { id: 'p', name: 'Proyecto' });
    await post('/api/projects/_loose/scenes', { id: 'd', name: 'Suelto' });
    await post('/api/projects/_loose/scenes/d/steps', { id: 'd-step' });
    await post('/api/projects/_loose/scenes', { id: 'gone', name: 'Para borrar' });
    store.start();
    await until(() => store.getState().loose?.diagrams.length === 2);

    await store.renameLoose('d', 'Renombrado');
    expect(store.getState().loose!.diagrams.find((diagram) => diagram.id === 'd')!.scene.name).toBe('Renombrado');
    await store.removeLoose('gone');
    expect(store.getState().loose!.diagrams.map((diagram) => diagram.id)).toEqual(['d']);

    await store.moveScene('_loose', 'd', 'p');
    expect(store.getState().loose!.diagrams).toEqual([]);
    const row = store.getState().rows.find((candidate) => candidate.id === 'p');
    expect(row?.kind === 'ok' && [row.project.sceneIds, row.scenes, row.steps]).toEqual([['d'], 1, 1]);
  });

  it('takes a scene out of a project into the loose diagrams, and moves one between projects', async () => {
    await post('/api/projects', { id: 'p', name: 'Proyecto' });
    await post('/api/projects', { id: 'q', name: 'Otro' });
    await post('/api/projects/p/scenes', { id: 's1', name: 'Primera' });
    await post('/api/projects/p/scenes', { id: 's2', name: 'Segunda' });
    await post('/api/projects/p/scenes/s2/steps', { id: 's2-step' });
    store.start();
    await until(() => store.getState().rows.length === 2);
    expect(store.getState().loose).toBeNull();

    await store.moveScene('p', 's2', '_loose');
    expect(store.getState().loose!.diagrams.map((diagram) => [diagram.id, diagram.scene.name, diagram.steps])).toEqual([['s2', 'Segunda', 1]]);
    const source = store.getState().rows.find((candidate) => candidate.id === 'p');
    expect(source?.kind === 'ok' && source.sceneList.map((scene) => scene.id)).toEqual(['s1']);

    await store.moveScene('p', 's1', 'q');
    const rows = Object.fromEntries(store.getState().rows.map((row) => [row.id, row.kind === 'ok' ? row.sceneList.map((scene) => scene.id) : null]));
    expect(rows).toEqual({ p: [], q: ['s1'] });
  });

  it('says why a move failed and keeps the diagram', async () => {
    await post('/api/projects', { id: 'p', name: 'Proyecto' });
    await post('/api/projects/p/scenes', { id: 's', name: 'Escena' });
    await post('/api/projects/p/scenes/s/steps', { id: 'clash' });
    await post('/api/projects/_loose/scenes', { id: 'd', name: 'Suelto' });
    await post('/api/projects/_loose/scenes/d/steps', { id: 'clash-too' });
    store.start();
    await until(() => store.getState().loose?.diagrams.length === 1);
    await expect(store.moveScene('_loose', 'd', 'missing')).rejects.toBeInstanceOf(ActionError);
    // A step ID the project already uses stops the move.
    await post('/api/projects/_loose/scenes/d/steps', { id: 'clash' });
    await until(() => store.getState().loose?.diagrams[0].steps === 2);
    await expect(store.moveScene('_loose', 'd', 'p')).rejects.toThrow('El proyecto ya tiene pasos o imágenes con los mismos identificadores.');
    expect(store.getState().loose!.diagrams.map((diagram) => diagram.id)).toEqual(['d']);
  });

  it('shows the loose diagrams of the workspace that is open', async () => {
    // Its own folders, so the second workspace sits outside the service's data.
    const root = await mkdtemp(join(tmpdir(), 'paso-store-workspaces-'));
    store.dispose();
    await service.close();
    service = await startServer({
      dataDir: join(root, 'app', 'projects'), workspacesPath: join(root, 'app', 'workspaces.json'), runsDir: join(root, 'app', 'runs'),
      harnessRegistryPath: join(root, 'app', 'harnesses.json'), port: 0, sessionToken: token, allowedOrigins: [window.location.origin], pollIntervalMs: 100,
    });
    store = new ProjectsStore(new ApiClient({ baseUrl: service.url, token }));
    await mkdir(join(root, 'Clases'));
    try {
      await post('/api/projects/_loose/scenes', { id: 'here', name: 'Aquí' });
      store.start();
      await until(() => store.getState().loose?.diagrams.length === 1);
      await store.addWorkspace(join(root, 'Clases'));
      expect(store.getState().loose).toBeNull();
      await post('/api/projects/_loose/scenes', { id: 'there', name: 'Allí' });
      await until(() => store.getState().loose?.diagrams[0]?.id === 'there');
      await store.switchWorkspace('default');
      expect(store.getState().loose!.diagrams.map((diagram) => diagram.id)).toEqual(['here']);
    } finally { store.dispose(); await service.close(); service = await startServer({ dataDir, port: 0, sessionToken: token }); await rm(root, { recursive: true, force: true }); }
  });
});
