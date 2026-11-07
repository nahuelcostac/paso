import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from './server.js';
import { detectHarness } from './harnesses.js';

const token = 'test-session-token-with-at-least-32-characters';
let root: string;
let service: Awaited<ReturnType<typeof startServer>>;
async function fake(id: string, script: string) { await writeFile(join(root, 'bin', id), `#!/bin/sh\n${script}\n`, { mode: 0o755 }); }
async function start() { service = await startServer({ dataDir: join(root, 'projects'), port: 0, sessionToken: token, harnessDetection: { searchPaths: [join(root, 'bin')], loginShell: false, timeoutMs: 250 } }); }
async function api(path: string, method = 'GET', payload?: unknown, authenticated = true) {
  const res = await fetch(service.url + path, { method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'paso-harness-')); await mkdir(join(root, 'bin')); await start(); });
afterEach(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
describe('harness detection and registry', () => {
  it('detects executables and handles missing, signed out, malformed and timed-out commands', async () => {
    await fake('claude', 'if [ "$1" = "--version" ]; then echo "Claude 1.2.3"; else echo \'{"loggedIn":false}\'; exit 1; fi');
    await fake('codex', 'if [ "$1" = "--version" ]; then echo invalid; else echo "Not logged in" >&2; exit 1; fi');
    let result = await api('/api/harnesses/detect');
    expect(result.data.harnesses).toMatchObject([
      { id: 'claude', found: true, version: '1.2.3', session: 'signed_out', message: expect.any(String) },
      { id: 'codex', found: true, version: null, session: 'signed_out' },
      { id: 'agy', found: false, path: null, session: 'unknown', message: expect.any(String) },
    ]);
    await fake('agy', 'exec /bin/sleep 10');
    const started = Date.now(); result = await api('/api/harnesses/detect');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.data.harnesses[2]).toMatchObject({ found: true, version: null, session: 'unknown' });
  });
  it('adds, persists, removes and rejects unknown or missing harnesses under authentication', async () => {
    await fake('agy', 'echo 1.5.3');
    expect((await api('/api/harnesses', 'POST', { id: 'agy' }, false)).status).toBe(401);
    expect((await api('/api/harnesses/detect', 'GET', undefined, false)).status).toBe(401);
    expect((await api('/api/harnesses/agy', 'DELETE', undefined, false)).status).toBe(401);
    expect((await api('/api/harnesses', 'GET', undefined, false)).status).toBe(401);
    expect((await api('/api/harnesses', 'POST', { id: 'other' })).status).toBe(400);
    expect((await api('/api/harnesses', 'POST', { id: 'claude' })).status).toBe(422);
    expect((await api('/api/harnesses', 'POST', { id: 'agy' })).status).toBe(201);
    await service.close(); await start();
    expect((await api('/api/harnesses')).data.harnesses).toMatchObject([{ id: 'agy', version: '1.5.3' }]);
    expect((await api('/api/harnesses/agy', 'DELETE')).status).toBe(204);
    expect((await api('/api/harnesses')).data.harnesses).toEqual([]);
  });
  it('finds a fake executable with a minimal PATH', async () => {
    await fake('agy', 'echo 1.5.3');
    const oldPath = process.env.PATH; const oldHome = process.env.HOME;
    try {
      process.env.PATH = join(root, 'bin'); process.env.HOME = root;
      expect(await detectHarness('agy', { loginShell: false })).toMatchObject({ found: true, version: '1.5.3' });
    } finally { process.env.PATH = oldPath; process.env.HOME = oldHome; }
  });
  it('keeps the service responsive while a detection is waiting', async () => {
    await fake('agy', 'exec /bin/sleep 10');
    const pending = api('/api/harnesses/detect');
    expect((await api('/api/health')).status).toBe(200);
    await pending;
  });
});
