import { describe, expect, it } from 'vitest';
import { cameraOnScreen, createViewStore, reshapeCamera, screenToCamera, viewCamera } from './canvas-view';

describe('the canvas view and the step camera', () => {
  it('takes the clear area of what the canvas shows, and draws a camera back where it was taken', () => {
    const view = { scrollX: -100, scrollY: 50, zoom: 2, width: 1048, height: 736 };
    const camera = viewCamera(view);
    expect(camera).toEqual({ x: 112, y: -14, width: 500, height: 300 });
    expect(cameraOnScreen(camera, view)).toEqual({ left: 24, top: 72, width: 1000, height: 600 });
  });
  it('tells listeners only about a real change', () => {
    const store = createViewStore();
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    const view = { scrollX: 0, scrollY: 0, zoom: 1, width: 10, height: 10 };
    store.set(view); store.set({ ...view }); store.set({ ...view, zoom: 2 });
    expect(calls).toBe(2);
    expect(store.get()?.zoom).toBe(2);
  });
});

describe('a camera drawn and reshaped by hand', () => {
  it('turns a box on screen into canvas units, and back', () => {
    const view = { scrollX: -100, scrollY: 50, zoom: 2, width: 1000, height: 700 };
    const camera = screenToCamera({ left: 200, top: 100, width: 400, height: 300 }, view);
    expect(camera).toEqual({ x: 200, y: 0, width: 200, height: 150 });
    expect(cameraOnScreen(camera, view)).toEqual({ left: 200, top: 100, width: 400, height: 300 });
  });
  it('moves, resizes by a side or a corner, and never flips past the minimum', () => {
    const from = { x: 0, y: 0, width: 100, height: 80 };
    expect(reshapeCamera(from, 'move', 5, -5, 10)).toEqual({ x: 5, y: -5, width: 100, height: 80 });
    expect(reshapeCamera(from, 'se', 20, 10, 10)).toEqual({ x: 0, y: 0, width: 120, height: 90 });
    expect(reshapeCamera(from, 'nw', 20, 10, 10)).toEqual({ x: 20, y: 10, width: 80, height: 70 });
    expect(reshapeCamera(from, 'e', -500, 0, 10)).toEqual({ x: 0, y: 0, width: 10, height: 80 });
    expect(reshapeCamera(from, 'w', 500, 0, 10)).toEqual({ x: 90, y: 0, width: 10, height: 80 });
    expect(reshapeCamera(from, 'n', 0, 30, 10)).toEqual({ x: 0, y: 30, width: 100, height: 50 });
  });
});
