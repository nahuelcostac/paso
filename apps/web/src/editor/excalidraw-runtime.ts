import type { Step } from '@paso/shared';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

// This module must run before importing Excalidraw. Both the dev server and build serve this path.
window.EXCALIDRAW_ASSET_PATH = new URL(`${import.meta.env.BASE_URL}excalidraw/`, window.location.origin).href;
export const excalidraw = () => import('@excalidraw/excalidraw');

/** Use the public canvas exporter to register/load Excalidraw's exact font faces. It awaits
 * fonts before drawing. Restore dimensions only AFTER this has completed. No private APIs. */
export async function loadDrawingFonts(steps: Step[]) {
  const { restoreElements, exportToCanvas } = await excalidraw();
  const texts = steps.flatMap((step) => step.elements.filter((element) => element.type === 'text' && !element.isDeleted));
  const sample = { id: 'paso-font-probe', type: 'text', x: 0, y: 0, width: 100, height: 25, fontSize: 20, fontFamily: 5, text: 'ÁÉÍÓÚÜÑ áéíóúüñ 0123456789', originalText: 'ÁÉÍÓÚÜÑ áéíóúüñ 0123456789', lineHeight: 1.25, version: 1, versionNonce: 1, isDeleted: false };
  const elements = restoreElements([sample, ...texts] as unknown as ExcalidrawElement[], null, { refreshDimensions: false }).filter((element) => !element.isDeleted);
  await exportToCanvas({ elements, files: {}, getDimensions: () => ({ width: 1, height: 1, scale: 0.001 }) });
}

export const canvasElements = (step: Step) => step.elements as unknown as ExcalidrawElement[];
export const canvasFiles = (files: unknown) => files as BinaryFiles;
