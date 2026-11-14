import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const desktop = dirname(fileURLToPath(import.meta.url));
const repo = resolve(desktop, '../..');
const stage = join(desktop, 'dist', 'stage');
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'mcp'), { recursive: true });
const bundle = { bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } };
await build({ ...bundle, entryPoints: [join(repo, 'apps/server/dist/server.js')], outfile: join(stage, 'service.mjs') });
await build({ ...bundle, entryPoints: [join(repo, 'apps/mcp/dist/cli.js')], outfile: join(stage, 'mcp/cli.mjs') });
await cp(join(repo, 'apps/mcp/dist/renderer'), join(stage, 'mcp/renderer'), { recursive: true });
await cp(join(desktop, 'main.mjs'), join(stage, 'main.mjs'));
await cp(join(desktop, 'preload.cjs'), join(stage, 'preload.cjs'));
await cp(join(desktop, 'lib'), join(stage, 'lib'), { recursive: true });
await cp(join(repo, 'apps/web/dist'), join(stage, 'web'), { recursive: true });
await rm(join(stage, 'mcp/renderer/fonts'), { recursive: true, force: true });
await symlink('../web/excalidraw/fonts', join(stage, 'mcp/fonts'));
await symlink('../../web/excalidraw/fonts', join(stage, 'mcp/renderer/fonts'));
const manifest = { name: 'paso-desktop', version: '0.0.0', type: 'module', main: 'main.mjs',
  build: { electronVersion: JSON.parse(await readFile(join(repo, 'node_modules/electron/package.json'), 'utf8')).version, appId: 'org.paso.prototype', productName: 'Paso', electronLanguages: ['en', 'es', 'es-419'], asar: false, directories: { output: join(desktop, 'dist', 'release') }, mac: { target: ['dir'], identity: null, icon: join(desktop, 'icon', 'Paso.icns') }, files: ['**/*'] } };
await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
execFileSync(join(repo, 'node_modules/.bin/electron-builder'), ['--projectDir', stage, '--mac', 'dir', '--arm64'], { cwd: repo, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
