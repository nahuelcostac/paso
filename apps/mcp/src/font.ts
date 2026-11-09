import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { openSync, type Font } from 'fontkit';

export const fontDirectory = join(dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw')), 'fonts');
// Excalidraw 0.18.1 fonts/Excalifont/index.ts unicodeRange descriptors.
const subsets = [
  ['a88b72a24fb54c9f94e3b5fdaa7481c9', '20-7e,a0-a3,a5-a6,a8-ab,ad-b1,b4,b6-b8,ba-ff,131,152-153,2bc,2c6,2da,2dc,304,308,2013-2014,2018-201a,201c-201e,2020,2022,2024-2026,2030,2039-203a,20ac,2122,2212'],
  ['be310b9bcd4f1a43f571c46df7809174', '100-130,132-137,139-149,14c-151,154-17e,192,1fc-1ff,218-21b,237,1e80-1e85,1ef2-1ef3,2113'],
  ['b9dcf9d2e50a1eaf42fc664b50a3fd0d', '400-45f,490-491,2116'],
  ['41b173a47b57366892116a575a43e2b6', '37e,384-38a,38c,38e-393,395-3a1,3a3-3a8,3aa-3cf,3d7'],
  ['3f2c5db56cc93c5a6873b1361d730c16', '2c7,2d8-2d9,2db,2dd,302,306-307,30a-30c,326-328,212e,2211,fb01-fb02'],
  ['349fac6ca4700ffec595a7150a0d1e1d', '462-463,472-475,4d8-4d9,4e2-4e3,4e6-4e9,4ee-4ef'],
  ['623ccf21b21ef6b3a0d87738f77eb071', '300-301,303'],
].map(([hash, ranges]) => ({ hash, ranges: ranges.split(',').map((range) => {
  const [start, end = start] = range.split('-').map((value) => parseInt(value, 16));
  return [start, end];
}) }));
const fonts = new Map<string, Font>();
function loadFont(path: string) {
  let font = fonts.get(path);
  if (!font) { font = openSync(join(fontDirectory, path)) as Font; fonts.set(path, font); }
  return font;
}
export const normalizeText = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\t/g, '        ').normalize('NFC');
// Excalidraw 0.18.1 fonts/FontMetadata.ts.
export const lineHeightForFont = (family: number) => family === 5 ? 1.25 : 1.15;

export function measureText(text: string, fontSize: number, family = 5) {
  if (family !== 5 && family !== 9) throw new Error('UNSUPPORTED_FONT. Edit this text in the Paso app.');
  const normalized = normalizeText(text);
  const lines = normalized.split('\n');
  const widths = lines.map((line) => {
    let width = 0, run = '', current: Font | undefined;
    const flush = () => {
      if (current && run) width += current.layout(run).positions.reduce((sum, position) => sum + position.xAdvance, 0) / current.unitsPerEm;
      run = '';
    };
    for (const character of line || ' ') {
      const code = character.codePointAt(0)!;
      const subset = family === 5 ? subsets.find(({ ranges }) => ranges.some(([start, end]) => code >= start && code <= end)) : undefined;
      const font = family === 9 || (family === 5 && code >= 0x2190 && code <= 0x2193) ? loadFont('Liberation/LiberationSans-Regular.woff2') : subset ? loadFont(`Excalifont/Excalifont-Regular-${subset.hash}.woff2`) : undefined;
      if (/\p{Cc}|\p{Cf}/u.test(character) || !font?.hasGlyphForCodePoint(code)) {
        throw new Error(`UNSUPPORTED_TEXT. The bundled ${family === 5 ? 'Excalifont' : 'Liberation Sans'} font cannot measure this character (U+${code.toString(16).toUpperCase()}). Use supported text, or add it in the Paso app. No system-font fallback is used.`);
      }
      if (font !== current) { flush(); current = font; }
      run += character;
    }
    flush();
    return width * fontSize;
  });
  return { text: normalized, width: Math.max(...widths), height: lines.length * fontSize * lineHeightForFont(family) };
}
