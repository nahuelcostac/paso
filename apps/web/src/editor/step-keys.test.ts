import { describe, expect, it } from 'vitest';
import type { AppState } from '@excalidraw/excalidraw/types';
import { canvasStepKey } from './step-keys';

const press = (key: string, extra: Partial<KeyboardEvent> = {}) => ({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, ...extra });
/** A target inside the canvas, or inside something else matched by the selector given. */
const inside = (...matches: string[]) => ({ closest: (selector: string) => (matches.some((match) => selector.includes(match)) ? {} : null) });
const idle = { selectedElementIds: {}, editingTextElement: null, editingLinearElement: null, newElement: null, openMenu: null, openPopup: null, openDialog: null, contextMenu: null } as unknown as AppState;

describe('arrow keys on the canvas', () => {
  it('change step when nothing in the drawing is selected or edited', () => {
    expect(canvasStepKey(press('ArrowRight'), inside('.step-canvas'), false, idle)).toBe(1);
    expect(canvasStepKey(press('ArrowLeft'), inside('.step-canvas'), false, idle)).toBe(-1);
    expect(canvasStepKey(press('PageDown'), null, true, idle)).toBe(1);   // focus resting on the page
    expect(canvasStepKey(press(' '), inside('.step-canvas'), false, idle)).toBeUndefined();   // Excalidraw pans with Space
  });

  it('nudge the selection, and leave fields, menus, modifiers and the rest of the app alone', () => {
    const canvas = inside('.step-canvas');
    expect(canvasStepKey(press('ArrowRight'), canvas, false, { ...idle, selectedElementIds: { a: true } } as AppState)).toBeUndefined();
    expect(canvasStepKey(press('ArrowRight'), canvas, false, { ...idle, editingTextElement: {} } as unknown as AppState)).toBeUndefined();
    expect(canvasStepKey(press('ArrowRight'), canvas, false, { ...idle, openMenu: 'canvas' } as AppState)).toBeUndefined();
    expect(canvasStepKey(press('ArrowRight', { shiftKey: true }), canvas, false, idle)).toBeUndefined();
    expect(canvasStepKey(press('ArrowRight', { defaultPrevented: true }), canvas, false, idle)).toBeUndefined();
    expect(canvasStepKey(press('ArrowRight'), inside('.step-canvas', 'input'), false, idle)).toBeUndefined();
    expect(canvasStepKey(press('ArrowRight'), inside('.carousel'), false, idle)).toBeUndefined();
  });
});
