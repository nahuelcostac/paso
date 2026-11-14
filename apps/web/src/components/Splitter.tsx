import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/** The sidebar's widths, in pixels. `initial` is --panel-projects in tokens.css. */
export const PROJECTS_WIDTH = { initial: 240, min: 200, max: 420 } as const;
/** The chat's widths, in pixels. `initial` is --panel-agent in tokens.css. */
export const AGENT_WIDTH = { initial: 360, min: 320, max: 720 } as const;
/** A folded side: --rail-w in tokens.css. */
export const RAIL = 52;
/** What the overview keeps beside the chat: the room for its cards. The chat is only in the overview. */
export const BOARD_MIN = { storyboard: 440 } as const;
const STEP = 16;
/** A drag this far past the narrowest width folds the side; dragging a folded side out by `OPEN_AT` unfolds it. */
const FOLD_AT = 80;
const OPEN_AT = 12;

function stored(key: string, initial: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : initial;
  } catch { return initial; }
}

/** The room the window leaves for a docked chat: what is left once the left column and the board have theirs. */
export function chatRoom(width: number, left: number, boardMin: number) {
  return width - left - boardMin;
}

export type PanelWidth = { width: number; min: number; max: number; initial: number; choose: (width: number) => void };

/**
 * A side's width as the person left it, remembered in this browser only. `widest` is how wide it may be now; a smaller
 * window shows it narrower without forgetting the chosen width.
 */
function useStoredWidth(key: string, range: { initial: number; min: number }, widest: () => number, deps: unknown[]): PanelWidth {
  const [chosen, setChosen] = useState(() => stored(key, range.initial));
  const [max, setMax] = useState(widest);
  useEffect(() => {
    const sync = () => setMax(widest());
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
    // `widest` reads only what `deps` lists.
  }, deps);
  const width = Math.min(Math.max(chosen, range.min), max);
  const choose = (next: number) => {
    const value = Math.round(Math.min(Math.max(next, range.min), max));
    setChosen(value);
    try { window.localStorage.setItem(key, String(value)); } catch { /* the width is a convenience: it just won't be remembered */ }
  };
  return { width, min: range.min, max, initial: range.initial, choose };
}

/** The sidebar's width. It always leaves the board its minimum and a docked chat its narrowest. */
export function useProjectsWidth(boardMin: number = BOARD_MIN.storyboard) {
  const widest = () => Math.max(PROJECTS_WIDTH.min, Math.min(PROJECTS_WIDTH.max, window.innerWidth - boardMin - AGENT_WIDTH.min));
  return useStoredWidth('paso.projects-width', PROJECTS_WIDTH, widest, [boardMin]);
}

/**
 * The chat's width. It never takes the board's room beside the left column (`left`, the sidebar or its rail), and as a
 * drawer it leaves a strip of the board in view.
 */
export function useAgentWidth(left: number, drawer: boolean, boardMin: number = BOARD_MIN.storyboard) {
  const widest = () => {
    const room = drawer ? window.innerWidth - 48 : chatRoom(window.innerWidth, left, boardMin);
    return Math.max(AGENT_WIDTH.min, Math.min(AGENT_WIDTH.max, room));
  };
  return useStoredWidth('paso.agent-width', AGENT_WIDTH, widest, [left, drawer, boardMin]);
}

type Props = {
  /** The side of the window the panel is on. The splitter sits on its inner edge. */
  side: 'left' | 'right';
  open: boolean;
  onToggle: () => void;
  /** The tab's names: «Ocultar …» while the panel is in view, «Mostrar …» while it is folded. */
  hide: string;
  show: string;
  /** The panel's id, for `aria-controls`. */
  controls?: string;
  /** The edge's name, «Anchura de …», and the width it moves. Without it there is only the tab: the panel is a drawer. */
  label?: string;
  resize?: PanelWidth;
};

/**
 * A panel's inner edge, as in Overleaf: a tab with a chevron folds and unfolds it, and dragging the edge changes its
 * width. Dragging it well past the narrowest width folds the panel, and dragging a folded one out opens it again. The
 * edge is a focusable separator: the arrow keys move it (Shift for bigger steps), Home and End go to the narrowest and
 * widest, Enter folds and unfolds, and a double click goes back to the starting width.
 */
export function Splitter({ side, open, onToggle, hide, show, controls, label, resize }: Props) {
  // `open` is the panel's state as this drag left it, ahead of the next render.
  const drag = useRef<{ x: number; from: number; open: boolean } | undefined>(undefined);
  const now = useRef({ onToggle, resize });
  now.current = { onToggle, resize };
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.dataset.resizing = 'true';
    return () => { delete document.documentElement.dataset.resizing; };
  }, [dragging]);

  // Moving the edge towards the board widens the panel: right for the sidebar, left for the chat.
  const outwards = (dx: number) => side === 'left' ? dx : -dx;
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !resize) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, from: open ? resize.width : resize.min - FOLD_AT, open };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const { onToggle: toggle, resize: width } = now.current;
    const at = drag.current;
    if (!at || !width) return;
    const wanted = at.from + outwards(event.clientX - at.x);
    const cut = width.min - FOLD_AT;
    if (at.open && wanted < cut) { at.open = false; toggle(); }
    else if (!at.open && wanted > cut + OPEN_AT) { at.open = true; toggle(); width.choose(wanted); }
    else if (at.open) width.choose(wanted);
  };
  const end = () => { drag.current = undefined; setDragging(false); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!resize) return;
    if (event.key === 'Enter') { event.preventDefault(); onToggle(); return; }
    const step = event.shiftKey ? STEP * 4 : STEP;
    const wider = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const narrower = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    const next = event.key === wider ? resize.width + step : event.key === narrower ? resize.width - step
      : event.key === 'Home' ? resize.min : event.key === 'End' ? resize.max : undefined;
    if (next === undefined) return;
    event.preventDefault();
    // A folded panel opens with the keys that widen it, at the width it had.
    if (!open) { if (event.key === wider || event.key === 'End') { onToggle(); if (event.key === 'End') resize.choose(next); } return; }
    resize.choose(next);
  };
  // The chevron points the way the panel goes: into its side to fold, out of it to unfold.
  const Chevron = (side === 'left') === open ? ChevronLeft : ChevronRight;

  return (
    <div className={`splitter splitter--${side}`} data-folded={open ? undefined : 'true'} data-dragging={dragging || undefined}>
      {resize && <div
        className="splitter__edge" role="separator" aria-orientation="vertical" aria-label={label} aria-controls={controls}
        aria-valuenow={open ? resize.width : 0} aria-valuemin={0} aria-valuemax={resize.max}
        aria-valuetext={open ? `${resize.width} píxeles` : 'Plegado'} tabIndex={0}
        title="Arrastra para cambiar la anchura. Doble clic: anchura inicial."
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
        onDoubleClick={() => { if (!open) onToggle(); resize.choose(resize.initial); }} onKeyDown={onKeyDown}
      />}
      <button
        type="button" className="splitter__tab" aria-label={open ? hide : show} title={open ? hide : show}
        aria-expanded={open} aria-controls={controls} onClick={onToggle}
      >
        <Chevron aria-hidden="true" />
      </button>
    </div>
  );
}
