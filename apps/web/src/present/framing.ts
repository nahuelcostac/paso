import type { StepCamera } from '@paso/shared';
import type { Bounds } from '../editor/thumbnail-bounds';

export type Viewport = { width: number; height: number };
/** A world point (x, y) lands on screen at (x * scale + offsetX, y * scale + offsetY). */
export type Frame = { scale: number; offsetX: number; offsetY: number };
export type Rect = { left: number; top: number; width: number; height: number };

/** Margins as a share of the screen, with a floor. The bottom floor keeps every drawing clear of the step indicator. */
const MARGIN_SHARE = { x: 0.05, y: 0.06 };
export const MARGIN_MIN = { x: 32, y: 48 };
/** A scene smaller than this is framed as if it were this big: a small sketch is shown large, not blown up to the edges of the screen. */
export const MIN_EXTENT = { width: 480, height: 300 };
/** A blank scene has nothing to fit. This is the camera of the mockups and of empty thumbnails. */
const BLANK: Bounds = [0, 0, 1000, 625];
/** Room in world units around the content, in the exported drawing. Excalidraw's bounds leave out stroke width and frame labels, and these would otherwise be cut off. */
export const BLEED = 64;

/**
 * The one camera of a presentation. It comes from `content`, the union of every step's bounds, and from the screen,
 * never from a single step, so an element that stays still between steps stays still on screen. Pure, and it knows
 * nothing about the drawing: a new window size needs only this calculation, not another export.
 */
export function presentationFrame(content: Bounds | null, viewport: Viewport): Frame {
  const [left, top, right, bottom] = content ?? BLANK;
  const available = {
    width: Math.max(1, viewport.width - 2 * Math.max(MARGIN_MIN.x, viewport.width * MARGIN_SHARE.x)),
    height: Math.max(1, viewport.height - 2 * Math.max(MARGIN_MIN.y, viewport.height * MARGIN_SHARE.y)),
  };
  const scale = Math.min(available.width / Math.max(MIN_EXTENT.width, right - left), available.height / Math.max(MIN_EXTENT.height, bottom - top));
  return { scale, offsetX: viewport.width / 2 - ((left + right) / 2) * scale, offsetY: viewport.height / 2 - ((top + bottom) / 2) * scale };
}

/** The world rectangle every step of a scene is exported with, so all their drawings share one coordinate system. */
export function presentationAnchor(content: Bounds | null): Bounds {
  const [left, top, right, bottom] = content ?? BLANK;
  return [left - BLEED, top - BLEED, right + BLEED, bottom + BLEED];
}

/** Where an exported drawing goes on screen. */
export function anchorRect(anchor: Bounds, frame: Frame): Rect {
  return { left: anchor[0] * frame.scale + frame.offsetX, top: anchor[1] * frame.scale + frame.offsetY, width: (anchor[2] - anchor[0]) * frame.scale, height: (anchor[3] - anchor[1]) * frame.scale };
}

/** A magnification over the framed presentation: a screen point p shows what was at (p - x, p - y) / scale. */
export type Zoom = { scale: number; x: number; y: number };
export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };
export const ZOOM_STEP = 1.5;
export const ZOOM_MAX = 6;

/**
 * Zooms by `factor` around a screen point, which stays where it is. Never below the framing itself, and the screen
 * stays covered: the edges of the magnified view are held at the edges of the screen.
 */
export function zoomAt(zoom: Zoom, factor: number, point: { x: number; y: number }, viewport: Viewport): Zoom {
  const scale = Math.min(ZOOM_MAX, Math.max(1, zoom.scale * factor));
  if (scale === 1) return NO_ZOOM;
  const ratio = scale / zoom.scale;
  const clamp = (value: number, size: number) => Math.min(0, Math.max(size - size * scale, value));
  return { scale, x: clamp(point.x - (point.x - zoom.x) * ratio, viewport.width), y: clamp(point.y - (point.y - zoom.y) * ratio, viewport.height) };
}

/**
 * The zoom that shows a step's camera: its box fills the screen inside the usual margins, centred. It never zooms out
 * past the scene's framing, and the screen stays covered, so a box near the edge of the scene is not centred exactly.
 */
export function cameraZoom(camera: StepCamera, frame: Frame, viewport: Viewport): Zoom {
  const available = {
    width: Math.max(1, viewport.width - 2 * Math.max(MARGIN_MIN.x, viewport.width * MARGIN_SHARE.x)),
    height: Math.max(1, viewport.height - 2 * Math.max(MARGIN_MIN.y, viewport.height * MARGIN_SHARE.y)),
  };
  const width = camera.width * frame.scale, height = camera.height * frame.scale;
  const scale = Math.min(ZOOM_MAX, Math.max(1, Math.min(available.width / width, available.height / height)));
  const centre = { x: camera.x * frame.scale + frame.offsetX + width / 2, y: camera.y * frame.scale + frame.offsetY + height / 2 };
  const clamp = (value: number, size: number) => Math.min(0, Math.max(size - size * scale, value));
  return { scale, x: clamp(viewport.width / 2 - centre.x * scale, viewport.width), y: clamp(viewport.height / 2 - centre.y * scale, viewport.height) };
}
