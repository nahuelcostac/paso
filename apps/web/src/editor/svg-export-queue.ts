/** Excalidraw starts font-subsetting workers during SVG export. Keep exports from different
 * views from multiplying those workers when a person switches views while drawing is in flight. */
let tail: Promise<unknown> = Promise.resolve();

export function serializeSvgExport<T>(draw: () => Promise<T>): Promise<T> {
  const result = tail.then(draw);
  tail = result.catch(() => undefined);
  return result;
}
