import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '@paso/shared';
import { startServer } from './server.js';

type Service = Awaited<ReturnType<typeof startServer>>;
let service: Service;
let dataDir: string;
const token = 'test-session-token-with-at-least-32-characters';

async function api(path: string, method = 'GET', input?: unknown, revision?: string) {
  const response = await fetch(`${service.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(revision ? { 'If-Match': `"${revision}"` } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data, etag: response.headers.get('etag')?.replaceAll('"', '') ?? '' };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'paso-icon-'));
  service = await startServer({ dataDir, port: 0, sessionToken: token, pollIntervalMs: 100 });
});
afterEach(async () => {
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('project icon', () => {
  it('is optional: a project without one is returned as before', async () => {
    const created = await api('/api/projects', 'POST', { id: 'p', name: 'Plain' });
    expect(created.status).toBe(201);
    expect(created.data.document).not.toHaveProperty('icon');
  });

  it('is accepted on creation and returned by every read', async () => {
    const created = await api('/api/projects', 'POST', { id: 'p', name: 'Search', icon: 'chart-scatter' });
    expect(created.status).toBe(201);
    expect(created.data.document.icon).toBe('chart-scatter');
    expect((await api('/api/projects/p')).data.document.icon).toBe('chart-scatter');
    const list = await api('/api/projects');
    expect(list.data.projects[0].document.icon).toBe('chart-scatter');
    expect(JSON.parse(await readFile(join(dataDir, 'p', 'project.json'), 'utf8')).icon).toBe('chart-scatter');
  });

  it('is set, changed and removed with PATCH, and each change moves the revision', async () => {
    const created = await api('/api/projects', 'POST', { id: 'p', name: 'Name' });
    const set = await api('/api/projects/p', 'PATCH', { icon: 'leaf' }, created.etag);
    expect(set.status).toBe(200);
    expect(set.data.document).toMatchObject({ name: 'Name', icon: 'leaf' });
    expect(set.etag).not.toBe(created.etag);
    const both = await api('/api/projects/p', 'PATCH', { name: 'Other', icon: 'sigma' }, set.etag);
    expect(both.data.document).toMatchObject({ name: 'Other', icon: 'sigma' });
    // A rename alone keeps the icon.
    const renamed = await api('/api/projects/p', 'PATCH', { name: 'Third' }, both.etag);
    expect(renamed.data.document).toMatchObject({ name: 'Third', icon: 'sigma' });
    const cleared = await api('/api/projects/p', 'PATCH', { icon: null }, renamed.etag);
    expect(cleared.data.document).toMatchObject({ name: 'Third' });
    expect(cleared.data.document).not.toHaveProperty('icon');
  });

  it('rejects names that are not the shape of a Lucide icon, without knowing the list', async () => {
    const created = await api('/api/projects', 'POST', { id: 'p', name: 'Name' });
    for (const icon of ['Folder', 'my icon', 'a--b', '-a', 'a-', '', 'x'.repeat(65), 7]) {
      expect((await api('/api/projects/p', 'PATCH', { icon }, created.etag)).status).toBe(400);
      expect((await api('/api/projects', 'POST', { id: 'q', name: 'Name', icon })).status).toBe(400);
    }
    expect((await api('/api/projects/p', 'PATCH', {}, created.etag)).status).toBe(400);
    // A name that no installed Lucide release has is still stored: the app decides how to show it.
    expect((await api('/api/projects/p', 'PATCH', { icon: 'an-icon-from-the-future' }, created.etag)).status).toBe(200);
  });

  it('does not add an icon to scenes', async () => {
    const created = await api('/api/projects', 'POST', { id: 'p', name: 'Name' });
    const scene = await api('/api/projects/p/scenes', 'POST', { id: 's', name: 'Scene' });
    expect(created.status).toBe(201);
    expect((await api('/api/projects/p/scenes/s', 'PATCH', { icon: 'leaf' }, scene.etag)).status).toBe(400);
  });

  it('keeps project files written before the field existed valid at format version 1', async () => {
    const legacy = createProject('Legacy', { id: 'legacy', now: '2026-11-07T12:00:00.000Z' });
    await mkdir(join(dataDir, 'legacy'));
    await writeFile(join(dataDir, 'legacy', 'project.json'), `${JSON.stringify(legacy, null, 2)}\n`);
    const read = await api('/api/projects/legacy');
    expect(read.status).toBe(200);
    expect(read.data.document.schemaVersion).toBe(1);
    expect(read.data.document).not.toHaveProperty('icon');
  });
});
