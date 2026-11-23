import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the real Electron with the app's scheme and handler (test/fixtures/relaunch-main.mjs), so it shows what unit
 * tests cannot: that what the page keeps in localStorage is there again after a relaunch. Skipped where Electron's
 * binary is not installed, or on Linux without a display.
 */
const repo = resolve(import.meta.dirname, '../../..');
const electronDir = join(repo, 'node_modules', 'electron');
const binary = (() => {
  try { return join(electronDir, 'dist', readFileSync(join(electronDir, 'path.txt'), 'utf8').trim()); } catch { return null; }
})();
const runnable = binary !== null && existsSync(binary) && (process.platform !== 'linux' || Boolean(process.env.DISPLAY));

let root;
const launch = (profile, value) => new Promise((resolvePromise, reject) => {
  const env = { ...process.env, PASO_TEST_PROFILE: join(root, profile), PASO_TEST_WEB: join(root, 'web'), PASO_TEST_VALUE: value };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [join(import.meta.dirname, 'fixtures', 'relaunch-main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => { child.kill(); reject(new Error(`Electron did not finish:\n${output}`)); }, 40_000);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('exit', () => {
    clearTimeout(timer);
    const line = output.split('\n').find((candidate) => candidate.startsWith('RESULT '));
    if (line) resolvePromise(JSON.parse(line.slice(7))); else reject(new Error(`No result from Electron:\n${output}`));
  });
});

describe.skipIf(!runnable)('the desktop page across relaunches', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'paso-relaunch-'));
    await mkdir(join(root, 'web'));
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><title>Paso relaunch</title>');
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('keeps localStorage at paso://app from one launch to the next, and never shares it with another profile', async () => {
    const first = await launch('profile-a', 'from the first launch');
    expect(first).toEqual({ origin: 'paso://app', secure: true, title: 'Paso relaunch', before: null });
    const second = await launch('profile-a', 'from the second launch');
    expect(second).toEqual({ origin: 'paso://app', secure: true, title: 'Paso relaunch', before: 'from the first launch' });
    // Another profile, as a test instance with its own PASO_DATA_DIR has: same origin, its own storage.
    const other = await launch('profile-b', 'elsewhere');
    expect(other.before).toBeNull();
    expect((await launch('profile-a', 'again')).before).toBe('from the second launch');
  }, 180_000);
});
