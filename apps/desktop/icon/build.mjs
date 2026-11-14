// Builds Paso.icns from paso.svg with the tools that come with macOS (sips and iconutil).
// Run it after changing the SVG: node apps/desktop/icon/build.mjs
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'paso-icon-'));
const iconset = join(work, 'Paso.iconset');
execFileSync('mkdir', [iconset]);
const master = join(work, 'master.png');
execFileSync('sips', ['-s', 'format', 'png', join(here, 'paso.svg'), '--out', master], { stdio: 'ignore' });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
    execFileSync('sips', ['-z', String(size * scale), String(size * scale), master, '--out', join(iconset, name)], { stdio: 'ignore' });
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(here, 'Paso.icns')]);
await rm(work, { recursive: true, force: true });
console.log(`Wrote ${join(here, 'Paso.icns')}`);
