import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pnpmCommand, spawnPnpm } from './pnpm.mjs';

let root;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'paso-pnpm-')); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('starting pnpm from the scripts', () => {
  it('runs the pnpm entry it was started from with this Node, on every platform', () => {
    const env = { npm_execpath: 'C:\\pnpm\\bin\\pnpm.cjs' };
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(pnpmCommand(['exec', 'concurrently'], { env, platform, node: 'node.exe' })).toEqual({ file: 'node.exe', args: ['C:\\pnpm\\bin\\pnpm.cjs', 'exec', 'concurrently'] });
    }
    // The standalone pnpm is an executable of its own.
    expect(pnpmCommand(['build'], { env: { npm_execpath: 'C:\\pnpm\\pnpm.exe' }, platform: 'win32' })).toEqual({ file: 'C:\\pnpm\\pnpm.exe', args: ['build'] });
  });
  it('uses pnpm from the PATH outside pnpm on macOS and Linux, and asks for pnpm on Windows', () => {
    expect(pnpmCommand(['build'], { env: {}, platform: 'darwin' })).toEqual({ file: 'pnpm', args: ['build'] });
    // npm's own entry is not pnpm.
    expect(pnpmCommand(['build'], { env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' }, platform: 'linux' })).toEqual({ file: 'pnpm', args: ['build'] });
    expect(() => pnpmCommand(['build'], { env: {}, platform: 'win32' })).toThrow('Start this through pnpm');
  });
  it('passes each argument as it is, with no shell to read it', async () => {
    const fake = join(root, 'pnpm.cjs');
    await writeFile(fake, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    vi.stubEnv('npm_execpath', fake);
    const args = ['--filter', '@paso/server', 'pnpm --filter @paso/web dev', '& echo injected', '"quoted" %PATH% $HOME'];
    const child = spawnPnpm(args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual(args);
  });
});
