import { useEffect, useState, type RefObject } from 'react';

/**
 * True once the element has come within `margin` pixels of the scroll container's edge, and from
 * then on. Without IntersectionObserver, as in a test DOM, everything counts as near.
 */
export function useNear(ref: RefObject<HTMLElement | null>, root: HTMLElement | null, margin = 600) {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (near || !element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setNear(true); }, { root, rootMargin: `${margin}px 0px` });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, root, margin, near]);
  return near;
}

/** How many columns a CSS grid has right now. */
export function useGridColumns(ref: RefObject<HTMLElement | null>, fallback = 4) {
  const [columns, setColumns] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const count = getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length;
      if (count > 0) setColumns(count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return columns;
}
