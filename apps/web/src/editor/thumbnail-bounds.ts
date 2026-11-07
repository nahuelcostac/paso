export type Bounds = readonly [number, number, number, number];

/** Union rotated Excalidraw bounds, then expand to the required 16:10 frame. Empty scenes
 * use the mockup's 1000 x 625 camera. One scene camera is used by every step. */
export function sceneBounds(bounds: readonly Bounds[], padding = 32): Bounds {
  if (!bounds.length) return [0, 0, 1000, 625];
  const left = Math.min(...bounds.map((box) => box[0]));
  const top = Math.min(...bounds.map((box) => box[1]));
  const right = Math.max(...bounds.map((box) => box[2]));
  const bottom = Math.max(...bounds.map((box) => box[3]));
  let width = Math.max(1, right - left) + padding * 2;
  let height = Math.max(1, bottom - top) + padding * 2;
  if (width / height < 1.6) width = height * 1.6;
  else height = width / 1.6;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
}
