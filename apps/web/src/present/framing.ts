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
