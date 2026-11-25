import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from './server.js';
import { detectHarness } from './harnesses.js';
import { fakePath, windows, writeLauncher } from './agent/testing/launcher.js';

const token = 'test-session-token-with-at-least-32-characters';
let root: string;
let service: Awaited<ReturnType<typeof startServer>>;
const fake = (id: string, script: string) => writeLauncher(fakePath(join(root, 'bin', id)), script);
async function start() { service = await startServer({ dataDir: join(root, 'projects'), port: 0, sessionToken: token, harnessDetection: { searchPaths: [join(root, 'bin')], loginShell: false, timeoutMs: 750 } }); }
async function api(path: string, method = 'GET', payload?: unknown, authenticated = true) {
  const res = await fetch(service.url + path, { method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'paso harness ')); await mkdir(join(root, 'bin')); await start(); });
afterEach(async () => { vi.unstubAllEnvs(); await service.close(); await rm(root, { recursive: true, force: true }); });
describe('harness detection and registry', () => {
  it('detects executables and handles missing, signed out, malformed and timed-out commands', async () => {
    await fake('claude', `
      if (process.argv[2] === '--version') console.log('Claude 1.2.3');
      else { console.log('{"loggedIn":false}'); process.exitCode = 1; }`);
    await fake('codex', `
      if (process.argv[2] === '--version') console.log('invalid');
      else { console.error('Not logged in'); process.exitCode = 1; }`);
    let result = await api('/api/harnesses/detect');
    expect(result.data.harnesses).toMatchObject([
      { id: 'claude', found: true, version: '1.2.3', session: 'signed_out', message: expect.any(String) },
      { id: 'codex', found: true, version: null, session: 'signed_out' },
      { id: 'agy', found: false, path: null, session: 'unknown', message: expect.any(String) },
    ]);
    await fake('agy', 'setInterval(() => {}, 1000)');
    const started = Date.now(); result = await api('/api/harnesses/detect');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.data.harnesses[2]).toMatchObject({ found: true, version: null, session: 'unknown' });
  });
  it('adds, persists, removes and rejects unknown or missing harnesses under authentication', async () => {
    await fake('agy', "console.log('1.5.3')");
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
    const path = await fake('agy', "console.log('1.5.3')");
    vi.stubEnv('PATH', windows ? `"${join(root, 'bin')}"` : join(root, 'bin'));
    vi.stubEnv('HOME', root);
    expect(await detectHarness('agy', { loginShell: false })).toMatchObject({ found: true, path, version: '1.5.3' });
  });
  it('keeps the service responsive while a detection is waiting', async () => {
    await fake('agy', 'setInterval(() => {}, 1000)');
    const pending = api('/api/harnesses/detect');
    expect((await api('/api/health')).status).toBe(200);
    await pending;
  });
  it.runIf(windows)('finds an npm global shim outside PATH and prefers an exe in the same directory', async () => {
    const appData = join(root, 'roaming');
    const npm = join(appData, 'npm');
    await mkdir(npm, { recursive: true });
    vi.stubEnv('APPDATA', appData);
    vi.stubEnv('PATH', join(root, 'bin'));
    const path = await writeLauncher(join(npm, 'agy.cmd'), "console.log('1.5.16')");
    expect(await detectHarness('agy')).toMatchObject({ path, found: true, version: '1.5.16' });
    await copyFile(process.execPath, join(npm, 'agy.exe'));
    expect(await detectHarness('agy')).toMatchObject({ path: join(npm, 'agy.exe'), found: true, version: process.versions.node });
  });
  it.runIf(windows)('does not run arbitrary cmd scripts', async () => {
    await writeFile(join(root, 'bin', 'agy.cmd'), '@echo 1.5.16');
    expect(await detectHarness('agy', { searchPaths: [join(root, 'bin')] })).toMatchObject({ found: false });
  });
});
