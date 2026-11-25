import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundleEntry } from 'esbuild';
import { Arch, Platform, build } from 'electron-builder';
import { appIconSvg, buildIcon, defaultIconDir } from './icon/build.mjs';
import { packagingConfig } from './packaging-config.mjs';

const desktop = dirname(fileURLToPath(import.meta.url));
const repo = resolve(desktop, '../..');
const stage = join(desktop, 'dist', 'stage');
const output = join(desktop, 'dist', 'release');
const platform = process.platform;
if (platform !== 'darwin' && platform !== 'win32') throw new Error('Desktop packaging requires macOS or Windows.');
await rm(stage, { recursive: true, force: true });
let icon;
if (platform === 'darwin') {
  ({ icns: icon } = await buildIcon());
} else {
  await mkdir(defaultIconDir, { recursive: true });
  icon = join(defaultIconDir, 'paso.svg');
  // electron-builder rasterizes this SVG to a multi-size ICO for the exe and NSIS.
  await writeFile(icon, appIconSvg());
}
await mkdir(join(stage, 'mcp'), { recursive: true });
const bundle = { bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } };
await bundleEntry({ ...bundle, entryPoints: [join(repo, 'apps/server/dist/server.js')], outfile: join(stage, 'service.mjs') });
await bundleEntry({ ...bundle, entryPoints: [join(repo, 'apps/mcp/dist/cli.js')], outfile: join(stage, 'mcp/cli.mjs') });
await cp(join(repo, 'apps/mcp/dist/renderer'), join(stage, 'mcp/renderer'), { recursive: true });
await cp(join(desktop, 'main.mjs'), join(stage, 'main.mjs'));
await cp(join(desktop, 'preload.cjs'), join(stage, 'preload.cjs'));
await cp(join(desktop, 'lib'), join(stage, 'lib'), { recursive: true });
await cp(join(repo, 'apps/web/dist'), join(stage, 'web'), { recursive: true });
await rm(join(stage, 'mcp/renderer/fonts'), { recursive: true, force: true });
const { version } = JSON.parse(await readFile(join(repo, 'node_modules/electron/package.json'), 'utf8'));
const { targets, buildOptions } = packagingConfig(platform, icon, output, version);
const manifest = { name: 'paso-desktop', version: '0.0.0', type: 'module', main: 'main.mjs', build: buildOptions };
await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
await build({ projectDir: stage, targets: platform === 'win32'
  ? Platform.WINDOWS.createTarget(targets, Arch.x64)
  : Platform.MAC.createTarget(targets, Arch.arm64), publish: 'never' });
