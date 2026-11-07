import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), 'paso-compiled-'));
const token = randomBytes(32).toString('base64url');
const sample = JSON.parse(await readFile(join(root, 'examples/demo-project/project.json'), 'utf8'));
await cp(join(root, 'examples/demo-project'), join(dataDir, sample.id), { recursive: true });
const child = spawn(process.execPath, ['cli.js'], {
  cwd: join(root, 'apps/server/dist'),
  env: { ...process.env, PASO_DATA_DIR: dataDir, PASO_PORT: '0', PASO_SESSION_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stderr.on('data', (bytes) => { output += bytes; });
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Compiled server startup timed out.')), 5000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Compiled server exited before listening.')); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', (bytes) => {
      output += bytes;
      const match = /Paso listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const api = async (path, method = 'GET', data, revision) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(revision ? { 'If-Match': `"${revision}"` } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    assert.ok(response.ok, `Compiled API returned ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
  assert.equal((await fetch(`${url}/api/health`)).status, 401);
  assert.equal((await api('/api/health')).status, 'ok');
  const listed = await api('/api/projects');
  assert.equal(listed.projects[0].document.id, sample.id);
  const scenes = await api(`/api/projects/${sample.id}/scenes`);
  assert.equal(scenes.scenes.length, 2);
  const steps = await api(`/api/projects/${sample.id}/scenes/${scenes.scenes[0].document.id}/steps`);
  const asset = Object.values(steps.steps[0].document.files)[0];
  const assetResponse = await fetch(`${url}/api/projects/${sample.id}/${asset.path}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(assetResponse.status, 200);
  assert.ok((await assetResponse.arrayBuffer()).byteLength > 0);
  const created = await api('/api/projects', 'POST', { id: 'compiled-smoke', name: 'Compiled runtime' });
  const base = '/api/projects/compiled-smoke';
  await api(`${base}/scenes`, 'POST', { id: 'scene', name: 'Scene' });
  const step = await api(`${base}/scenes/scene/steps`, 'POST', { id: 'step' });
  const updated = await api(`${base}/scenes/scene/steps/step`, 'PUT', { ...step.document, title: 'Saved by compiled JavaScript' }, step.revision);
  assert.notEqual(updated.revision, step.revision);
  const disk = JSON.parse(await readFile(join(dataDir, 'compiled-smoke/scenes/scene/steps/step.json'), 'utf8'));
  assert.equal(disk.title, 'Saved by compiled JavaScript');
  assert.equal(created.document.name, 'Compiled runtime');
  const current = await api(base);
  await api(base, 'DELETE', undefined, current.revision);
  assert.ok(!output.includes(token), 'Server logged its session token.');
  console.log('Compiled server smoke passed. Real data directory, sample assets, CRUD, revisions, authentication, no token in logs.');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  await rm(dataDir, { recursive: true, force: true });
}
