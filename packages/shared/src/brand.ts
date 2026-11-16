/**
 * Paso's mark: a rising step on an ink tile. This is the only place its geometry and colours live.
 * The sidebar logo (apps/web/src/components/Brand.tsx), the browser tab icon (apps/web/vite.config.ts)
 * and the desktop app icon (apps/desktop/icon/build.mjs) are all drawn from it.
 *
 * Units are the sidebar's CSS pixels: a 34 px tile with the step drawn in a centred 17 px box.
 */
export const brandMark = {
  /** Side of the ink tile. */
  tile: 34,
  /** Corner radius of the tile (the web's --radius-md). */
  radius: 8,
  /** Side of the box the step is drawn in, centred on the tile. */
  glyph: 17,
  /** The step's own coordinate system: a 16 × 16 box. */
  glyphViewBox: 16,
  step: 'M1.5 14.5h4v-4h4.5V6h4.5V1.5',
  /** Stroke width in the step's own units. */
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  /** Tile colour: the light theme's --ink. */
  ink: '#18181b',
  /** Step colour: the light theme's --on-ink. */
  onInk: '#ffffff',
} as const;

export type BrandMarkLayout = {
  /** Side of the square canvas. */
  size: number;
  tile: { x: number; y: number; size: number; radius: number };
  step: { d: string; transform: string; strokeWidth: number };
};

/**
 * Lays the mark out on a `size` canvas with an empty `inset` on every side, keeping every
 * proportion of the sidebar mark. With no arguments it is the sidebar mark itself.
 */
export function brandMarkLayout({ size = brandMark.tile, inset = 0 }: { size?: number; inset?: number } = {}): BrandMarkLayout {
  const tile = size - 2 * inset;
  if (!(tile > 0)) throw new Error('The inset leaves no room for the mark');
  const scale = tile / brandMark.tile;
  const offset = inset + ((brandMark.tile - brandMark.glyph) / 2) * scale;
  const glyphScale = (brandMark.glyph / brandMark.glyphViewBox) * scale;
  return {
    size,
    tile: { x: inset, y: inset, size: tile, radius: brandMark.radius * scale },
    step: { d: brandMark.step, transform: `translate(${round(offset)} ${round(offset)}) scale(${round(glyphScale)})`, strokeWidth: brandMark.strokeWidth },
  };
}

/** The mark as a standalone SVG document, in the light theme's colours. */
export function brandMarkSvg(options: { size?: number; inset?: number } = {}): string {
  const { size, tile, step } = brandMarkLayout(options);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect x="${round(tile.x)}" y="${round(tile.y)}" width="${round(tile.size)}" height="${round(tile.size)}" rx="${round(tile.radius)}" fill="${brandMark.ink}"/>` +
    `<path d="${step.d}" transform="${step.transform}" fill="none" stroke="${brandMark.onInk}" stroke-width="${step.strokeWidth}" stroke-linecap="${brandMark.strokeLinecap}" stroke-linejoin="${brandMark.strokeLinejoin}"/>` +
    '</svg>';
}

/** The browser tab icon: the sidebar mark as an SVG data URL. */
export function brandFaviconHref(): string {
  return `data:image/svg+xml,${encodeURIComponent(brandMarkSvg())}`;
}

/** Apple's macOS app icon grid: a 1024 canvas whose icon body is 824 wide, leaving 100 on every side. */
export const macIconGrid = { size: 1024, inset: 100 } as const;

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
