import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { openSync, type Font } from 'fontkit';

export const fontDirectory = join(dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw')), 'fonts');
let font: Font | undefined;
export const normalizeText = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\t/g, '        ').normalize('NFC');

export function measureText(text: string, fontSize: number) {
  font ??= openSync(join(fontDirectory, 'Liberation/LiberationSans-Regular.woff2')) as Font;
  const normalized = normalizeText(text);
  for (const character of normalized.replace(/\n/g, '')) {
    if (/\p{Cc}|\p{Cf}/u.test(character) || !font.hasGlyphForCodePoint(character.codePointAt(0)!)) {
      throw new Error('UNSUPPORTED_TEXT. The bundled Liberation Sans font cannot measure this character. Use supported text, or add it in the Paso app. No system-font fallback is used.');
    }
  }
  const width = Math.max(...normalized.split('\n').map((line) =>
    font!.layout(line || ' ').positions.reduce((sum, position) => sum + position.xAdvance, 0) * fontSize / font!.unitsPerEm));
  return { text: normalized, width, height: normalized.split('\n').length * fontSize * 1.15 };
}
