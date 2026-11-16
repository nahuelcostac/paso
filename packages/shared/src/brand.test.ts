import { describe, expect, it } from 'vitest';
import { brandFaviconHref, brandMark, brandMarkLayout, brandMarkSvg, macIconGrid } from './index.js';

describe('the brand mark', () => {
  it('lays out the sidebar mark: a 34 px tile, radius 8, the step in a centred 17 px box', () => {
    expect(brandMarkLayout()).toEqual({
      size: 34,
      tile: { x: 0, y: 0, size: 34, radius: 8 },
      step: { d: brandMark.step, transform: 'translate(8.5 8.5) scale(1.0625)', strokeWidth: 2 },
    });
  });

  it('keeps every proportion on the macOS grid, inside its 100 px margin', () => {
    const layout = brandMarkLayout(macIconGrid);
    const scale = 824 / 34;
    expect(layout.tile).toEqual({ x: 100, y: 100, size: 824, radius: 8 * scale });
    expect(layout.step.transform).toBe(`translate(${round(100 + 8.5 * scale)} ${round(100 + 8.5 * scale)}) scale(${round((17 / 16) * scale)})`);
    expect(layout.step.strokeWidth).toBe(brandMark.strokeWidth);
  });

  it('refuses an inset that leaves no tile', () => {
    expect(() => brandMarkLayout({ size: 10, inset: 5 })).toThrow();
  });

  it('draws the light theme mark as SVG and as the tab icon', () => {
    const svg = brandMarkSvg();
    expect(svg).toContain('viewBox="0 0 34 34"');
    expect(svg).toContain(`<rect x="0" y="0" width="34" height="34" rx="8" fill="${brandMark.ink}"/>`);
    expect(svg).toContain(`d="${brandMark.step}" transform="translate(8.5 8.5) scale(1.0625)" fill="none" stroke="${brandMark.onInk}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`);
    expect(decodeURIComponent(brandFaviconHref().replace('data:image/svg+xml,', ''))).toBe(svg);
  });
});

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
