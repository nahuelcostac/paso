import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

export type CanvasCamera = { key: string; scrollX: number; scrollY: number; zoom: AppState['zoom'] };

/** Excalidraw fits and centres the bounds, capped at 100%, within the clear area between its controls. */
export function fitOpeningDrawing(api: ExcalidrawImperativeAPI) {
  const elements = api.getSceneElements().filter((element) => !element.isDeleted);
  if (elements.length) api.scrollToContent(elements, {
    fitToViewport: true, maxZoom: 1, viewportZoomFactor: 0.9,
    canvasOffsets: { top: 72, bottom: 64, left: 24, right: 24 },
  });
}

/** Returns true only for the first loaded change, so later edits never trigger another fit. */
export function openingFit(hasCamera: boolean) {
  let opened = false;
  return (api: ExcalidrawImperativeAPI) => {
    if (opened) return false;
    opened = true;
    if (!hasCamera) fitOpeningDrawing(api);
    return true;
  };
}
