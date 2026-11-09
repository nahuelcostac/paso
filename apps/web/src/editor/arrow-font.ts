// Excalifont has no arrow glyphs. Give these four code points the bundled
// Liberation Sans face, including in self-contained SVG exports.
const range = 'U+2190-2193';
let fontData: Promise<string> | undefined;
let loaded: Promise<void> | undefined;
export const hasArrowGlyphs = (texts: string[]) => texts.some((text) => /[←↑→↓]/u.test(text));
function dataUrl() {
  return fontData ??= (async () => {
    const response = await fetch(new URL(`${import.meta.env.BASE_URL}excalidraw/fonts/Liberation/LiberationSans-Regular.woff2`, window.location.origin));
    if (!response.ok) throw new Error('Could not load the bundled arrow font');
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return `data:font/woff2;base64,${btoa(binary)}`;
  })();
}
export function loadArrowFont() {
  return loaded ??= (async () => {
    const face = new FontFace('Excalifont', `url(${await dataUrl()})`, { unicodeRange: range });
    await face.load(); (document.fonts as FontFaceSet & { add(face: FontFace): void }).add(face);
  })();
}
export async function embedArrowFont(svg: SVGSVGElement) {
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `@font-face { font-family: Excalifont; src: url(${await dataUrl()}) format('woff2'); unicode-range: ${range}; }`;
  svg.prepend(style);
}
