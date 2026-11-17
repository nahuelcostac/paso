import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

/**
 * Moving to another step keeps the one Excalidraw on screen and hands it the next step's drawing, so nothing is
 * mounted again and nothing flickers. What a new canvas would start with comes from the step: its drawing, its grid
 * and background, and an empty selection, menus and edits. What belongs to the window or to the person carries over:
 * the size, the theme, the camera, the open sidebar, the tool and its styles. Excalidraw would reset those last ones
 * on a new mount; keeping them is what moving from one page of a drawing to the next feels like.
 */
const CARRIED: ReadonlyArray<keyof AppState> = [
  'width', 'height', 'offsetLeft', 'offsetTop', 'theme', 'isLoading', 'scrollX', 'scrollY', 'zoom',
  'openSidebar', 'defaultSidebarDockedPreference', 'penMode', 'penDetected', 'objectsSnapModeEnabled', 'showWelcomeScreen', 'name',
];

/** The next step's app state: `restored` is what Excalidraw's restore() made of the step, `current` what is on screen. */
type Restored = Omit<AppState, 'width' | 'height' | 'offsetTop' | 'offsetLeft'>;

export function nextStepState(restored: Restored, current: AppState, looking: { zen: boolean; view: boolean }): AppState {
  const next: Record<string, unknown> = { ...restored };
  for (const key of CARRIED) next[key] = current[key];
  for (const key of Object.keys(current) as Array<keyof AppState>) if (key.startsWith('currentItem')) next[key] = current[key];
  // An image waits for a file to be chosen: as on opening, the tool goes back to selection.
  next.activeTool = current.activeTool.type === 'image' ? { ...current.activeTool, type: 'selection' } : current.activeTool;
  next.zenModeEnabled = looking.zen;
  next.viewModeEnabled = looking.view;
  return next as unknown as AppState;
}

type Swappable = Pick<ExcalidrawImperativeAPI, 'getAppState' | 'addFiles' | 'updateScene' | 'history'>;

/**
 * Puts the next step on the canvas in one update. The swap is not something to undo, and nothing the person did on
 * the step they leave can be undone here: undo never crosses from one step into another.
 */
export function swapStep(app: Swappable, step: { elements: readonly ExcalidrawElement[]; appState: Restored; files: BinaryFiles }, looking: { zen: boolean; view: boolean }) {
  app.addFiles(Object.values(step.files));
  app.updateScene({ elements: step.elements, appState: nextStepState(step.appState, app.getAppState(), looking), captureUpdate: CaptureUpdateAction.NEVER });
  app.history.clear();
}

/** A text being typed on the step being left is finished there, before its elements go: Excalidraw ends it on blur. */
export function finishTyping(container: HTMLElement | null) {
  const typing = document.activeElement;
  if (typing instanceof HTMLTextAreaElement && typing.classList.contains('excalidraw-wysiwyg') && container?.contains(typing)) typing.blur();
}

/**
 * Clears the undo history and makes Excalidraw's undo and redo buttons say so. Its history does not tell the buttons
 * when it is cleared, only when an entry is recorded or undo or redo runs: one of them still enabled is pressed, and
 * with nothing to undo or redo that only refreshes both.
 */
export function clearHistory(app: Pick<ExcalidrawImperativeAPI, 'history'>, container: HTMLElement | null) {
  app.history.clear();
  container?.querySelector<HTMLButtonElement>('[data-testid="button-undo"]:not(:disabled), [data-testid="button-redo"]:not(:disabled)')?.click();
}
