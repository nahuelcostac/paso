import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../..');
const electronDir = join(repo, 'node_modules/electron');
const binary = (() => { try { return join(electronDir, 'dist', readFileSync(join(electronDir, 'path.txt'), 'utf8').trim()); } catch { return null; } })();
const runnable = binary && existsSync(binary) && (process.platform !== 'linux' || Boolean(process.env.DISPLAY));
let root;

describe.skipIf(!runnable)('offline desktop fonts', () => {
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  it('loads the bundled font families and embeds them in an SVG without external sources or CSP violations', async () => {
    root = await mkdtemp(join(tmpdir(), 'paso-fonts-'));
    const web = join(root, 'web');
    await promisify(execFile)(process.execPath, [join(repo, 'apps/web/node_modules/vite/bin/vite.js'), 'build', '--outDir', web], { cwd: join(repo, 'apps/web'), env: { ...process.env, NODE_ENV: 'production' }, maxBuffer: 4_000_000, timeout: 90_000 });
    const entry = (await readdir(join(web, 'assets'))).find((name) => /^prod-.*\.js$/.test(name));
    expect(entry).toBeTruthy();
    const result = await new Promise((resolveResult, reject) => {
      const env = { ...process.env, PASO_TEST_PROFILE: join(root, 'profile'), PASO_TEST_WEB: web, PASO_TEST_EXCALIDRAW: entry };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(binary, [join(import.meta.dirname, 'fixtures/fonts-main.mjs')], { env });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Electron timed out:\n${output}`)); }, 60_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); const line = output.split('\n').find((candidate) => candidate.startsWith('RESULT ')); if (line) resolveResult(JSON.parse(line.slice(7))); else reject(new Error(`Electron failed:\n${output}`)); });
    });
    expect(result.assetPath).toBe('paso://app/excalidraw/');
    expect(result.sources.some((source) => source.includes('Cascadia'))).toBe(true);
    expect(result.sources.some((source) => source.includes('ComicShanns'))).toBe(true);
    expect(result.sources.join('\n')).not.toContain('https://');
    expect(result.violations).toEqual([]);
    expect(result.requests.filter((url) => !url.startsWith('paso://app/') && !url.startsWith('http://127.0.0.1:9/'))).toEqual([]);
    for (const family of ['Cascadia', 'ComicShanns', 'Excalifont', 'Liberation', 'Lilita', 'Nunito', 'Virgil']) {
      expect(result.requests.some((url) => url.includes(`/fonts/${family}/`)), family).toBe(true);
    }
    expect(result.embedded).toBe(true);
    expect(result.remoteSvg).toBe(false);
  }, 180_000);
});
