import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the real Electron with the app's scheme, CSP and sandbox (test/fixtures/startup-main.mjs), so it shows what the
 * unit tests cannot: that the startup watch sees the app render in a real page, and reports a page that freezes or
 * does not load instead of leaving the window blank. Skipped where Electron's binary is not installed, or on Linux
 * without a display.
 */
const repo = resolve(import.meta.dirname, '../../..');
const electronDir = join(repo, 'node_modules', 'electron');
const binary = (() => {
  try { return join(electronDir, 'dist', readFileSync(join(electronDir, 'path.txt'), 'utf8').trim()); } catch { return null; }
})();
const runnable = binary !== null && existsSync(binary) && (process.platform !== 'linux' || Boolean(process.env.DISPLAY));

let root;
const launch = (web, timeout) => new Promise((resolvePromise, reject) => {
  const env = { ...process.env, PASO_TEST_PROFILE: join(root, `profile-${web}`), PASO_TEST_WEB: join(root, web), PASO_TEST_TIMEOUT: String(timeout) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [join(import.meta.dirname, 'fixtures', 'startup-main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

const page = async (name, script) => {
  await mkdir(join(root, name));
  await writeFile(join(root, name, 'index.html'), '<!doctype html><title>Paso</title><div id="root"></div><script type="module" src="/app.js"></script>');
  await writeFile(join(root, name, 'app.js'), script);
};

describe.skipIf(!runnable)('the startup watch in a real window', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'paso-startup-'));
    await page('renders', "setTimeout(() => document.getElementById('root').append(document.createElement('main')), 300);");
    // A page whose script never returns, as a page waiting forever on a synchronous request would.
    await page('freezes', 'for (;;) {}');
    await mkdir(join(root, 'missing'));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('sees the app render through the CSP and the sandbox', async () => {
    const result = await launch('renders', 20_000);
    expect(result.outcome).toBe('ready');
    expect(result.lines).toContain('Page loaded');
    expect(result.lines.at(-1)).toMatch(/^Page ready after \d+ ms$/);
  }, 60_000);

  it('reports a frozen page once its time is up', async () => {
    const result = await launch('freezes', 3_000);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'Nothing appeared within 3 seconds.' });
  }, 60_000);

  it('reports a page that is not there at once', async () => {
    const result = await launch('missing', 20_000);
    expect(result).toMatchObject({ outcome: 'failed', reason: "The page didn't load (status 404)." });
  }, 60_000);
});
