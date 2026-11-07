export type Bounds = readonly [number, number, number, number];

/** The box around every step's rotated Excalidraw bounds. Thumbnails and Presentar both start from it. */
export function unionBounds(bounds: readonly Bounds[]): Bounds {
  return [
    Math.min(...bounds.map((box) => box[0])),
    Math.min(...bounds.map((box) => box[1])),
    Math.max(...bounds.map((box) => box[2])),
    Math.max(...bounds.map((box) => box[3])),
  ];
}

/** Union rotated Excalidraw bounds, then expand to the required 16:10 frame. Empty scenes
 * use the mockup's 1000 x 625 camera. One scene camera is used by every step. */
export function sceneBounds(bounds: readonly Bounds[], padding = 32): Bounds {
  if (!bounds.length) return [0, 0, 1000, 625];
  const [left, top, right, bottom] = unionBounds(bounds);
  let width = Math.max(1, right - left) + padding * 2;
  let height = Math.max(1, bottom - top) + padding * 2;
  if (width / height < 1.6) width = height * 1.6;
  else height = width / 1.6;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
}
