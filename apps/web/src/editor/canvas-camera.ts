import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { Target } from './step-store';
import { CLEAR } from './canvas-view';

export type CanvasCamera = { key: string; scrollX: number; scrollY: number; zoom: AppState['zoom'] };

/**
 * The camera belongs to the scene, not to the step: moving between steps keeps it, so what stays in place on the
 * paper stays in place on the screen, as in Presentar. A new scene, or a new diagram, is framed again.
 */
export const cameraKey = (target: Target) => `${target.projectId}/${target.sceneId}`;

/**
 * Excalidraw fits and centres the bounds, capped at 100%, within the clear area between its controls. The bounds
 * are the step's drawing and, when given, the scene's frame, so every step of the scene would fit the same way.
 */
export function fitOpeningDrawing(api: ExcalidrawImperativeAPI, frame?: readonly ExcalidrawElement[]) {
  const elements = [...(frame ?? []), ...api.getSceneElements().filter((element) => !element.isDeleted)];
  if (elements.length) api.scrollToContent(elements, {
    fitToViewport: true, maxZoom: 1, viewportZoomFactor: 0.9,
    canvasOffsets: CLEAR,
  });
}

/** Returns true only for the first loaded change, so later edits never trigger another fit. */
export function openingFit(hasCamera: boolean, frame?: () => readonly ExcalidrawElement[] | undefined) {
  let opened = false;
  return (api: ExcalidrawImperativeAPI) => {
    if (opened) return false;
    opened = true;
    if (!hasCamera) fitOpeningDrawing(api, frame?.());
    return true;
  };
}
