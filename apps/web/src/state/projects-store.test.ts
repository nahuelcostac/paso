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
