// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { embedArrowFont, hasArrowGlyphs, loadArrowFont } from './arrow-font';

describe('arrow font fallback', () => {
  it('loads the bundled face only for the four arrow characters and embeds it in SVG', async () => {
    expect(hasArrowGlyphs(['Hola', '→ ← ↑ ↓'])).toBe(true);
    expect(hasArrowGlyphs(['Hola', '↗'])).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })));
    const add = vi.fn();
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add } });
    const load = vi.fn(async () => {});
    const face = vi.fn(function () { return { load }; });
    vi.stubGlobal('FontFace', face);
    await loadArrowFont();
    expect(face).toHaveBeenCalledWith('Excalifont', expect.stringContaining('data:font/woff2;base64,AQID'), { unicodeRange: 'U+2190-2193' });
    expect(add).toHaveBeenCalledOnce();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    await embedArrowFont(svg);
    expect(svg.innerHTML).toContain('unicode-range: U+2190-2193');
    expect(svg.innerHTML).toContain('data:font/woff2;base64,AQID');
    vi.unstubAllGlobals();
  });
});
