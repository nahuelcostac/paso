import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brandMark, brandMarkLayout, brandMarkSvg, macIconGrid } from '@paso/shared';
import { appIconSvg, buildIcon } from '../icon/build.mjs';

describe('the desktop app icon', () => {
  it('is the brand mark on Apple’s 1024 grid', () => {
    expect(appIconSvg()).toBe(brandMarkSvg({ size: 1024, inset: 100 }));
    expect(macIconGrid).toEqual({ size: 1024, inset: 100 });
  });

  it('keeps no hand-drawn copy of the icon in the repository', () => {
    for (const file of ['paso.svg', 'Paso.icns']) expect(existsSync(new URL(`../icon/${file}`, import.meta.url))).toBe(false);
  });
});

// Builds the real .icns and reads it back, so the shipped pixels follow the mark too.
describe.runIf(process.platform === 'darwin')('the built .icns', () => {
  let work;
  let pixel;
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'paso-icon-test-'));
    const { icns, svg } = await buildIcon(work);
    expect(await readFile(svg, 'utf8')).toBe(appIconSvg());
    execFileSync('iconutil', ['-c', 'iconset', icns, '-o', join(work, 'out.iconset')]);
    pixel = decodePng(await readFile(join(work, 'out.iconset', 'icon_512x512@2x.png')));
  }, 60_000);
  afterAll(() => rm(work, { recursive: true, force: true }));

  const layout = brandMarkLayout(macIconGrid);
  const scale = layout.tile.size / brandMark.tile;
  // A point of the step, given in its own 16 × 16 units, on the 1024 canvas.
  const onStep = (x, y) => [x, y].map((value) => Math.round(layout.tile.x + ((brandMark.tile - brandMark.glyph) / 2 + value * brandMark.glyph / brandMark.glyphViewBox) * scale));
  const hex = ([r, g, b]) => `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;

  it('leaves Apple’s margin and the rounded corners transparent', () => {
    expect(pixel(50, 512)[3]).toBe(0);
    expect(pixel(512, 980)[3]).toBe(0);
    expect(pixel(layout.tile.x + 10, layout.tile.y + 10)[3]).toBe(0);
    expect(pixel(layout.tile.x + 10, 512)[3]).toBe(255);
  });

  it('fills the tile with the ink and draws the step on it', () => {
    expect(hex(pixel(...onStep(12, 12)))).toBe(brandMark.ink);
    expect(hex(pixel(...onStep(3.5, 14.5)))).toBe(brandMark.onInk);
    expect(hex(pixel(...onStep(10, 8)))).toBe(brandMark.onInk);
    expect(hex(pixel(...onStep(14.5, 3)))).toBe(brandMark.onInk);
  });
});

/** Decodes an 8-bit RGB or RGBA PNG (what sips writes) into a pixel reader. */
function decodePng(bytes) {
  let offset = 8;
  let width; let height; let channels;
  const data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('Only 8-bit, non-interlaced PNGs');
      channels = { 2: 3, 6: 4 }[body[9]];
      if (!channels) throw new Error(`Unsupported colour type ${body[9]}`);
    }
    if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter];
      out[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  return (x, y) => {
    const start = (y * width + x) * channels;
    return channels === 4 ? [...out.subarray(start, start + 4)] : [...out.subarray(start, start + 3), 255];
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
