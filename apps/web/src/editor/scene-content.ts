import type { Step } from '@paso/shared';
import { canvasElements, excalidraw, loadDrawingFonts } from './excalidraw-runtime';
import type { Bounds } from './thumbnail-bounds';

/** What each step of a scene draws, with the bounds of the steps that draw something. Dimensions are refreshed
 * after the fonts load, or text would be measured wrong. Deleted elements count for nothing. */
export async function restoreSceneContent(steps: Step[]) {
  const { restoreElements, getCommonBounds } = await excalidraw();
  await loadDrawingFonts(steps);
  const elements = steps.map((step) => restoreElements(canvasElements(step), null, { refreshDimensions: true }).filter((element) => !element.isDeleted));
  const bounds: Bounds[] = elements.filter((drawn) => drawn.length > 0).map((drawn) => getCommonBounds(drawn));
  return { elements, bounds };
}
