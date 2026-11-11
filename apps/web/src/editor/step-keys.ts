import type { AppState } from '@excalidraw/excalidraw/types';

/** Keys that change step on the canvas, as in Presentar. Space is left out: Excalidraw pans with it. */
const STEP_KEYS: Record<string, -1 | 1> = { ArrowLeft: -1, PageUp: -1, ArrowRight: 1, PageDown: 1 };

type Press = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'defaultPrevented'>;
type Place = { closest: (selector: string) => unknown } | null;
type Drawing = Pick<AppState, 'selectedElementIds' | 'editingTextElement' | 'editingLinearElement' | 'newElement' | 'openMenu' | 'openPopup' | 'openDialog' | 'contextMenu'>;

/**
 * The step a key press on the canvas moves to, or undefined when the key belongs to someone else. The arrows belong to
 * the drawing while something is selected, drawn or edited (they nudge it), and to fields, menus and dialogs. A key
 * with a modifier belongs to Excalidraw or the browser. `onPage` is true when focus rests on the page itself.
 */
export function canvasStepKey(event: Press, target: Place, onPage: boolean, drawing: Drawing): -1 | 1 | undefined {
  const delta = STEP_KEYS[event.key];
  if (!delta || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return undefined;
  if (!onPage && !target?.closest('.step-canvas')) return undefined;
  if (target?.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="alertdialog"]')) return undefined;
  const busy = Object.values(drawing.selectedElementIds).some(Boolean) || drawing.editingTextElement || drawing.editingLinearElement
    || drawing.newElement || drawing.openMenu || drawing.openPopup || drawing.openDialog || drawing.contextMenu;
  return busy ? undefined : delta;
}
