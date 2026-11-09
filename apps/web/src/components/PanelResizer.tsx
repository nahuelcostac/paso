import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** The chat's widths, in pixels. `initial` is --panel-agent in tokens.css, and PROJECTS is --panel-projects. */
export const AGENT_WIDTH = { initial: 360, min: 320, max: 720 } as const;
const PROJECTS = 240;
const BOARD_MIN = 440;
const STEP = 16;
const KEY = 'paso.agent-width';

function stored(): number {
  try {
    const value = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(value) && value > 0 ? value : AGENT_WIDTH.initial;
  } catch { return AGENT_WIDTH.initial; }
}

/** The widest the chat may be: the Storyboard keeps --board-min beside it, and a drawer leaves a strip of the board in view. */
function widest(projectsOpen: boolean, drawer: boolean) {
  const room = drawer ? window.innerWidth - 48 : window.innerWidth - (projectsOpen ? PROJECTS : 0) - BOARD_MIN;
  return Math.max(AGENT_WIDTH.min, Math.min(AGENT_WIDTH.max, room));
}

/**
 * The chat's width as the person left it. It is remembered in this browser only, and it never takes the board's room:
 * a smaller window shows it narrower without forgetting the chosen width.
 */
export function useAgentWidth(projectsOpen: boolean, drawer: boolean) {
  const [chosen, setChosen] = useState(stored);
  const [max, setMax] = useState(() => widest(projectsOpen, drawer));
  useEffect(() => {
    const sync = () => setMax(widest(projectsOpen, drawer));
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [projectsOpen, drawer]);
  const width = Math.min(Math.max(chosen, AGENT_WIDTH.min), max);
  const choose = (next: number) => {
    const value = Math.round(Math.min(Math.max(next, AGENT_WIDTH.min), max));
    setChosen(value);
    try { window.localStorage.setItem(KEY, String(value)); } catch { /* the width is a convenience: it just won't be remembered */ }
  };
  return { width, min: AGENT_WIDTH.min, max, choose };
}

type Props = { width: number; min: number; max: number; onChange: (width: number) => void; controls: string };

/**
 * The chat's left edge, which the person drags to change its width. It is a focusable separator: the arrow keys move it
 * (Shift for bigger steps), Home and End go to the narrowest and widest, and a double click goes back to the start.
 */
export function PanelResizer({ width, min, max, onChange, controls }: Props) {
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.dataset.resizing = 'true';
    return () => { delete document.documentElement.dataset.resizing; };
  }, [dragging]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, width };
    setDragging(true);
  };
  // The chat is on the right: moving its edge left makes it wider.
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onChange(drag.current.width + drag.current.x - event.clientX);
  };
  const end = () => { drag.current = undefined; setDragging(false); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? STEP * 4 : STEP;
    const next = event.key === 'ArrowLeft' ? width + step : event.key === 'ArrowRight' ? width - step
      : event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onChange(next);
  };

  return (
    <div
      className="resizer" role="separator" aria-orientation="vertical" aria-label="Anchura del chat" aria-controls={controls}
      aria-valuenow={width} aria-valuemin={min} aria-valuemax={max} tabIndex={0} data-dragging={dragging || undefined}
      title="Arrastra para cambiar la anchura. Doble clic: anchura inicial."
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onDoubleClick={() => onChange(AGENT_WIDTH.initial)} onKeyDown={onKeyDown}
    />
  );
}
