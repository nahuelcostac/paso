// Draws Paso's app icon from the brand mark in @paso/shared (packages/shared/src/brand.ts), the same
// source as the sidebar logo and the browser tab icon. Nothing here is committed: packaging and
// `pnpm dev:desktop` call buildIcon, so a change to the mark reaches the app on its next build.
// It needs macOS, for sips and iconutil. By hand: node apps/desktop/icon/build.mjs [outDir]
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandMarkSvg, macIconGrid } from '@paso/shared';

const here = dirname(fileURLToPath(import.meta.url));
export const defaultIconDir = resolve(here, '..', 'dist', 'icon');

/** The app icon as SVG: the sidebar mark, unchanged, on Apple's 1024 grid (an 824 body with 100 around it). */
export function appIconSvg() {
  return brandMarkSvg(macIconGrid);
}

/** Writes paso.svg, paso.png (1024, for the Dock in development) and Paso.icns to outDir. */
export async function buildIcon(outDir = defaultIconDir) {
  await mkdir(outDir, { recursive: true });
  const svg = join(outDir, 'paso.svg');
  const png = join(outDir, 'paso.png');
  const icns = join(outDir, 'Paso.icns');
  await writeFile(svg, appIconSvg());
  execFileSync('sips', ['-s', 'format', 'png', svg, '--out', png], { stdio: 'ignore' });
  const work = await mkdtemp(join(tmpdir(), 'paso-icon-'));
  try {
    const iconset = join(work, 'Paso.iconset');
    await mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        execFileSync('sips', ['-z', String(size * scale), String(size * scale), png, '--out', join(iconset, name)], { stdio: 'ignore' });
      }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { svg, png, icns };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { icns } = await buildIcon(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(`Wrote ${icns}`);
}
