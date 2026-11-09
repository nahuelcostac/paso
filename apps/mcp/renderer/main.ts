import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import type { Step } from '@paso/shared';

(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL('./', window.location.href).href;
const { restoreElements, exportToCanvas } = await import('@excalidraw/excalidraw');
async function renderStep(step: Step, files: BinaryFiles) {
  if (step.elements.some((element) => element.type === 'text' && !element.isDeleted && element.fontFamily === 5 && /[←↑→↓]/u.test(String(element.text ?? '')))) {
    const face = new FontFace('Excalifont', `url(${new URL('./fonts/Liberation/LiberationSans-Regular.woff2', window.location.href).href})`, { unicodeRange: 'U+2190-2193' });
    await face.load(); (document.fonts as FontFaceSet & { add(face: FontFace): void }).add(face);
  }
  const elements = step.elements as unknown as ExcalidrawElement[];
  const initial = restoreElements(elements, null, { refreshDimensions: false }).filter((element) => !element.isDeleted);
  await exportToCanvas({ elements: initial, files, getDimensions: () => ({ width: 1, height: 1, scale: 0.001 }) });
  const restored = restoreElements(elements, null, { refreshDimensions: true }).filter((element) => !element.isDeleted);
  const canvas = await exportToCanvas({ elements: restored, files, appState: { ...step.appState, exportBackground: true, exportWithDarkMode: false },
    exportPadding: 24, getDimensions: (width: number, height: number) => {
      const scale = Math.min(1, 2048 / Math.max(width, height));
      return { width: Math.max(1, Math.ceil(width * scale)), height: Math.max(1, Math.ceil(height * scale)), scale };
    } });
  return canvas.toDataURL('image/png');
}
try {
  const { step, files } = await (await fetch(new URL('./snapshot', window.location.href))).json() as { step: Step; files: BinaryFiles };
  const image = await renderStep(step, files);
  const output = document.createElement('pre');
  output.id = 'paso-image'; output.textContent = image.split(',')[1];
  document.body.replaceChildren(output);
} catch {
  document.body.textContent = 'Paso image unavailable.';
}
