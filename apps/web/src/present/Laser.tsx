import { useEffect, useRef } from 'react';
import { LaserPointer, type SizeMappingDetails } from '@excalidraw/laser-pointer';

/*
 * The same laser as Excalidraw's laser tool in the Lienzo (0.18.1, `laser-trails.ts` and `animated-trail.ts`): the same
 * trail from `@excalidraw/laser-pointer`, with the same options, decay, size and colour.
 */

/** Each point of the trail fades over this time, so the whole laser has gone this long after the release. */
export const LASER_FADE_MS = 1000;
/** The last stretch of the trail, in pixels, tapers towards its end. */
const DECAY_LENGTH = 50;
const COLOR = 'red';
const easeOut = (k: number) => 1 - Math.pow(1 - k, 4);
const OPTIONS = {
  simplify: 0,
  streamline: 0.4,
  sizeMapping: (c: SizeMappingDetails) => {
    const t = Math.max(0, 1 - (performance.now() - c.pressure) / LASER_FADE_MS);
    const l = (DECAY_LENGTH - Math.min(DECAY_LENGTH, c.totalLength - c.currentIndex)) / DECAY_LENGTH;
    return Math.min(easeOut(l), easeOut(t));
  },
};

// Excalidraw's laser cursor, with a white backing on a dark canvas.
const CURSOR_TAG = '<svg viewBox="0 0 24 24" stroke-width="1" width="28" height="28" xmlns="http://www.w3.org/2000/svg">';
const CURSOR_BACKGROUND = '<path d="M6.164 11.755a5.314 5.314 0 0 1-4.932-5.298 5.314 5.314 0 0 1 5.311-5.311 5.314 5.314 0 0 1 5.307 5.113l8.773 8.773a3.322 3.322 0 0 1 0 4.696l-.895.895a3.322 3.322 0 0 1-4.696 0l-8.868-8.868Z" style="fill:#fff"/>';
const CURSOR_ICON = '<path stroke="#1b1b1f" fill="#fff" d="m7.868 11.113 7.773 7.774a2.359 2.359 0 0 0 1.667.691 2.368 2.368 0 0 0 2.357-2.358c0-.625-.248-1.225-.69-1.667L11.201 7.78 9.558 9.469l-1.69 1.643v.001Zm10.273 3.606-3.333 3.333m-3.25-6.583 2 2m-7-7 3 3M3.664 3.625l1 1M2.529 6.922l1.407-.144m5.735-2.932-1.118.866M4.285 9.823l.758-1.194m1.863-6.207-.13 1.408"/>';
/** The cursor over the drawing, as a CSS `cursor` value. */
export const laserCursor = (theme: 'light' | 'dark') =>
  `url("data:image/svg+xml,${encodeURIComponent(`${CURSOR_TAG}${theme === 'light' ? '' : CURSOR_BACKGROUND}${CURSOR_ICON}</svg>`)}"), auto`;

const average = (a: number, b: number) => (a + b) / 2;
/** Excalidraw's `getSvgPathFromStroke`: a closed, smoothed outline. */
function pathOf(points: number[][]) {
  if (points.length < 4) return '';
  let a = points[0]; let b = points[1]; const c = points[2];
  let result = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${average(b[0], c[0]).toFixed(2)},${average(b[1], c[1]).toFixed(2)} T`;
  for (let i = 2, max = points.length - 1; i < max; i++) {
    a = points[i]; b = points[i + 1];
    result += `${average(a[0], b[0]).toFixed(2)},${average(a[1], b[1]).toFixed(2)} `;
  }
  return `${result}Z`;
}

/**
 * The laser of one press, from `start`: it draws while the pointer is held and, once released (`held` false), fades
 * away like the Lienzo's. Each press gets its own, so one still fading stays while a new one starts.
 */
export function Laser({ start, held = true }: { start?: { x: number; y: number }; held?: boolean }) {
  const path = useRef<SVGPathElement>(null);
  const trail = useRef<LaserPointer>(undefined);
  const frame = useRef(0);
  const draw = useRef(() => {});
  draw.current = () => {
    const outline = trail.current ? pathOf(trail.current.getStrokeOutline()) : '';
    path.current?.setAttribute('d', outline);
    // Keep going while something is still on screen.
    frame.current = outline || held ? requestAnimationFrame(() => draw.current()) : 0;
  };
  const wake = () => { if (!frame.current) frame.current = requestAnimationFrame(() => draw.current()); };

  useEffect(() => {
    const laser = new LaserPointer(OPTIONS);
    trail.current = laser;
    if (start) laser.addPoint([start.x, start.y, performance.now()]);
    wake();
    return () => { cancelAnimationFrame(frame.current); frame.current = 0; };
    // The start is where this press began: read once.
  }, []);
  useEffect(() => {
    const laser = trail.current;
    if (!laser) return;
    if (!held) {
      laser.close();
      laser.options.keepHead = false;
      wake();
      return;
    }
    const move = (event: PointerEvent) => { laser.addPoint([event.clientX, event.clientY, performance.now()]); wake(); };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, [held]);

  return <svg className="laser" aria-hidden="true"><path ref={path} fill={COLOR} /></svg>;
}
