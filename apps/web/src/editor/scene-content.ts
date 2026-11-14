import type { Step } from '@paso/shared';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { canvasElements, excalidraw, loadDrawingFonts } from './excalidraw-runtime';
import { unionBounds, type Bounds } from './thumbnail-bounds';

/** What each step of a scene draws, with the bounds of the steps that draw something. Dimensions are refreshed
 * after the fonts load, or text would be measured wrong. Deleted elements count for nothing. */
export async function restoreSceneContent(steps: Step[]) {
  const { restoreElements, getCommonBounds } = await excalidraw();
  await loadDrawingFonts(steps);
  const elements = steps.map((step) => restoreElements(canvasElements(step), null, { refreshDimensions: true }).filter((element) => !element.isDeleted));
  const bounds: Bounds[] = elements.filter((drawn) => drawn.length > 0).map((drawn) => getCommonBounds(drawn));
  return { elements, bounds };
}

/**
 * An invisible box around everything the scene's steps draw, the frame Presentar uses too. It is only handed to
 * Excalidraw's fit and never enters the drawing. Undefined when no step draws anything.
 */
export async function sceneFrame(steps: Step[]): Promise<readonly ExcalidrawElement[] | undefined> {
  const { bounds } = await restoreSceneContent(steps);
  if (!bounds.length) return undefined;
  const [left, top, right, bottom] = unionBounds(bounds);
  const { convertToExcalidrawElements } = await excalidraw();
  return convertToExcalidrawElements([{ type: 'rectangle', x: left, y: top, width: right - left, height: bottom - top }]);
}
