import type { Zoom } from './framing';

// The same bounds and increments as Excalidraw 0.18.1.
export const VIEW_ZOOM_STEP = 0.1;
export const VIEW_ZOOM_MIN = 0.1;
export const VIEW_ZOOM_MAX = 30;

/** The point under the pointer stays fixed, even below the opening frame or after panning. */
export function zoomViewAt(zoom: Zoom, scale: number, point: { x: number; y: number }): Zoom {
  scale = Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, scale));
  const ratio = scale / zoom.scale;
  return { scale, x: point.x - (point.x - zoom.x) * ratio, y: point.y - (point.y - zoom.y) * ratio };
}

/** Excalidraw's wheel response, including smaller increments for trackpads at high zoom. */
export function wheelZoom(zoom: Zoom, deltaY: number, point: { x: number; y: number }): Zoom {
  const sign = Math.sign(deltaY);
  const delta = Math.min(Math.abs(deltaY), VIEW_ZOOM_STEP * 100) * sign;
  const scale = zoom.scale - delta / 100 - Math.log10(Math.max(1, zoom.scale)) * sign * Math.min(1, Math.abs(deltaY) / 20);
  return zoomViewAt(zoom, scale, point);
}
