import { useEffect, useRef, useState } from 'react';

/** How long the trail behind the dot lasts. */
const TRAIL_MS = 350;

type Point = { x: number; y: number; t: number };

/**
 * The laser pointer: a red dot where the pointer is, with a short trail that fades. It replaces the cursor and never
 * takes a click, so a click still moves the presentation. `start` is where the pointer was when it was turned on.
 */
export function Laser({ start }: { start?: { x: number; y: number } }) {
  const points = useRef<Point[]>(start ? [{ ...start, t: 0 }] : []);
  const [, setFrame] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      // The newest point is the dot: it stays even when the pointer rests.
      const list = points.current;
      points.current = list.filter((point, index) => index === list.length - 1 || now - point.t < TRAIL_MS);
      setFrame(now);
      raf = points.current.length > 1 ? requestAnimationFrame(tick) : 0;
    };
    const move = (event: MouseEvent) => {
      points.current = [...points.current, { x: event.clientX, y: event.clientY, t: performance.now() }];
      if (!raf) raf = requestAnimationFrame(tick);
    };
    window.addEventListener('mousemove', move);
    return () => { window.removeEventListener('mousemove', move); cancelAnimationFrame(raf); };
  }, []);

  const list = points.current;
  const head = list[list.length - 1];
  const now = performance.now();
  return <svg className="laser" aria-hidden="true">
    {list.slice(1).map((point, index) => {
      const life = Math.max(0, 1 - (now - point.t) / TRAIL_MS);
      const from = list[index];
      return <line key={point.t + index} x1={from.x} y1={from.y} x2={point.x} y2={point.y} strokeWidth={2 + 5 * life} opacity={life} />;
    })}
    {head && <circle cx={head.x} cy={head.y} r={6} />}
  </svg>;
}
