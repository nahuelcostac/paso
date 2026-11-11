import type { StepCamera } from '@paso/shared';

/** What the Lienzo's canvas shows: Excalidraw's scroll and zoom, and the canvas size in screen pixels. */
export type CanvasView = { scrollX: number; scrollY: number; zoom: number; width: number; height: number };

/** The canvas's view, outside React: the canvas writes it on every change, and only what draws from it re-renders. */
export function createViewStore() {
  let view: CanvasView | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => view,
    set(next: CanvasView) {
      if (view && view.scrollX === next.scrollX && view.scrollY === next.scrollY && view.zoom === next.zoom && view.width === next.width && view.height === next.height) return;
      view = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type ViewStore = ReturnType<typeof createViewStore>;

/** The clear area between Excalidraw's controls: the toolbar on top, zoom and the step strip's edge below. */
export const CLEAR = { top: 72, bottom: 64, left: 24, right: 24 };

/** What the person sees right now, in canvas units, without the strips under Excalidraw's controls. */
export function viewCamera(view: CanvasView): StepCamera {
  const width = Math.max(1, view.width - CLEAR.left - CLEAR.right) / view.zoom;
  const height = Math.max(1, view.height - CLEAR.top - CLEAR.bottom) / view.zoom;
  const round = (value: number) => Math.round(value * 100) / 100;
  return { x: round(-view.scrollX + CLEAR.left / view.zoom), y: round(-view.scrollY + CLEAR.top / view.zoom), width: round(width), height: round(height) };
}

/** Where a camera lies on the canvas, in screen pixels from the canvas's top-left corner. */
export function cameraOnScreen(camera: StepCamera, view: CanvasView) {
  return { left: (camera.x + view.scrollX) * view.zoom, top: (camera.y + view.scrollY) * view.zoom, width: camera.width * view.zoom, height: camera.height * view.zoom };
}

/** The smallest camera, in screen pixels, so a box drawn or shrunk by hand stays something to grab. */
export const MIN_CAMERA_PX = 40;

/** A box on the canvas, in screen pixels from its top-left corner, as a camera in canvas units. */
export function screenToCamera(box: { left: number; top: number; width: number; height: number }, view: CanvasView): StepCamera {
  const round = (value: number) => Math.round(value * 100) / 100;
  return { x: round(box.left / view.zoom - view.scrollX), y: round(box.top / view.zoom - view.scrollY), width: round(box.width / view.zoom), height: round(box.height / view.zoom) };
}

/** What a handle changes: the whole box, a side or a corner. */
export type CameraHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * The camera after dragging one of its handles by (dx, dy) canvas units. A side that would cross the opposite one
 * stops at the minimum size instead, so the box never flips.
 */
export function reshapeCamera(from: StepCamera, handle: CameraHandle, dx: number, dy: number, min: number): StepCamera {
  if (handle === 'move') return { ...from, x: from.x + dx, y: from.y + dy };
  let { x, y, width, height } = from;
  const right = from.x + from.width, bottom = from.y + from.height;
  if (handle.includes('w')) { width = Math.max(min, from.width - dx); x = right - width; }
  if (handle.includes('e')) width = Math.max(min, from.width + dx);
  if (handle.includes('n')) { height = Math.max(min, from.height - dy); y = bottom - height; }
  if (handle.includes('s')) height = Math.max(min, from.height + dy);
  return { x, y, width, height };
}
