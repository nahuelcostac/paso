import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Zoom } from './framing';
import { wheelZoom, zoomViewAt } from './camera-gestures';

type Gesture = Event & { scale: number; clientX: number; clientY: number };
const isControl = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('button, .indicator, .present__bar'));

/** Board gestures change only the view. A drag must never change the step. */
export function useCameraGestures(root: RefObject<HTMLDivElement | null>, zoom: Zoom, setZoom: Dispatch<SetStateAction<Zoom>>, onInteraction: () => void) {
  const [panReady, setPanReady] = useState(false);
  const [panning, setPanning] = useState(false);
  const camera = useRef(zoom);
  camera.current = zoom;

  useEffect(() => {
    const surface = root.current;
    if (!surface) return;
    let space = false;
    let drag: { id: number; x: number; y: number } | undefined;
    let suppressClick = false;
    let gestureScale: number | undefined;
    const wheel = (event: WheelEvent) => {
      if (isControl(event.target)) {
        if (event.ctrlKey || event.metaKey) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (drag || gestureScale !== undefined) return;
      onInteraction();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      const dx = event.deltaX * unit; const dy = event.deltaY * unit;
      setZoom((current) => event.ctrlKey || event.metaKey
        ? wheelZoom(current, dy, { x: event.clientX, y: event.clientY })
        : { ...current, x: current.x - (event.shiftKey ? dy || dx : dx), y: current.y - (event.shiftKey ? 0 : dy) });
    };
    const press = (event: KeyboardEvent) => {
      if (event.code !== 'Space' && event.key !== ' ') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      space = true;
      setPanReady(true);
    };
    const release = (event: KeyboardEvent) => {
      if (event.code !== 'Space' && event.key !== ' ') return;
      space = false;
      setPanReady(false);
    };
    const down = (event: PointerEvent) => {
      suppressClick = false;
      if (drag || isControl(event.target) || !(event.button === 1 || (space && event.button === 0))) return;
      event.preventDefault();
      onInteraction();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      suppressClick = true;
      surface.setPointerCapture?.(event.pointerId);
      setPanning(true);
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
      drag.x = event.clientX; drag.y = event.clientY;
      setZoom((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    };
    const up = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = undefined;
      if (surface.hasPointerCapture?.(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      setPanning(false);
    };
    const click = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const blur = () => {
      if (drag && surface.hasPointerCapture?.(drag.id)) surface.releasePointerCapture(drag.id);
      drag = undefined; space = false; gestureScale = undefined; suppressClick = false;
      setPanReady(false); setPanning(false);
    };
    // Safari uses gesture events for a trackpad pinch instead of Ctrl+wheel.
    const gestureStart = (event: Event) => {
      if (isControl(event.target)) return;
      event.preventDefault();
      onInteraction();
      gestureScale = camera.current.scale;
    };
    const gestureChange = (event: Event) => {
      if (gestureScale === undefined) return;
      event.preventDefault();
      const { scale, clientX, clientY } = event as Gesture;
      if (!Number.isFinite(scale) || scale <= 0) return;
      const next = gestureScale * scale;
      setZoom((current) => zoomViewAt(current, next, { x: clientX, y: clientY }));
    };
    const gestureEnd = (event: Event) => {
      if (gestureScale !== undefined) event.preventDefault();
      gestureScale = undefined;
    };
    surface.addEventListener('wheel', wheel, { passive: false });
    surface.addEventListener('pointerdown', down);
    surface.addEventListener('click', click, true);
    surface.addEventListener('gesturestart', gestureStart, { passive: false });
    surface.addEventListener('gesturechange', gestureChange, { passive: false });
    surface.addEventListener('gestureend', gestureEnd);
    window.addEventListener('keydown', press, true);
    window.addEventListener('keyup', release, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', blur);
    return () => {
      if (drag && surface.hasPointerCapture?.(drag.id)) surface.releasePointerCapture(drag.id);
      surface.removeEventListener('wheel', wheel);
      surface.removeEventListener('pointerdown', down);
      surface.removeEventListener('click', click, true);
      surface.removeEventListener('gesturestart', gestureStart);
      surface.removeEventListener('gesturechange', gestureChange);
      surface.removeEventListener('gestureend', gestureEnd);
      window.removeEventListener('keydown', press, true);
      window.removeEventListener('keyup', release, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', blur);
    };
  }, [root, setZoom, onInteraction]);

  return { panReady, panning };
}
