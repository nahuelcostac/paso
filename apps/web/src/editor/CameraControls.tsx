import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { Scan, X } from 'lucide-react';
import type { StepCamera } from '@paso/shared';
import { cameraOnScreen, MIN_CAMERA_PX, reshapeCamera, screenToCamera, viewCamera, type CameraHandle, type ViewStore } from './canvas-view';

/**
 * «Encuadrar»: marks the part of the drawing Presentar zooms to on this step. It opens the drawing mode; with a camera
 * set it reads «Reencuadrar», and the cross beside it removes the camera.
 */
export function CameraControl({ camera, drawing, onDraw, onClear }: { camera: StepCamera | undefined; drawing: boolean; onDraw: () => void; onClear: () => void }) {
  return (
    <div className="camera-control" data-set={camera ? true : undefined}>
      <button
        type="button" className="camera-control__take" aria-pressed={drawing}
        title="Marca la zona a la que se acercará la presentación en este paso: arrastra sobre el lienzo, o pulsa Intro para usar lo que ves"
        onClick={onDraw}
      >
        <Scan className="i" aria-hidden="true" /><span className="camera-control__label">{camera ? 'Reencuadrar' : 'Encuadrar'}</span>
      </button>
      {camera && (
        <button type="button" className="camera-control__clear" aria-label="Quitar encuadre" title="Quitar encuadre: el paso vuelve a mostrar toda la escena" onClick={onClear}>
          <X className="i" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** The point of a pointer event inside the element that holds the canvas, in screen pixels. */
/** Keeps the pointer's moves coming to this element while it is held. A pointer the browser no longer knows is let go. */
function capture(event: ReactPointerEvent) {
  try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* not an active pointer */ }
}

function local(event: { clientX: number; clientY: number }, element: Element | null) {
  const rect = element?.getBoundingClientRect();
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
}

/**
 * The drawing mode: a layer over the canvas where a drag marks the camera. A click without a drag, or Enter, takes what
 * the canvas shows. Escape gives up. The canvas does not move meanwhile.
 */
export function CameraDraw({ view, onDone, onCancel }: { view: ViewStore; onDone: (camera: StepCamera) => void; onCancel: () => void }) {
  const layer = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number }>();
  const [end, setEnd] = useState<{ x: number; y: number }>();
  useEffect(() => { layer.current?.focus(); }, []);
  const current = () => { const now = view.get(); if (now) onDone(viewCamera(now)); };
  const box = start && end ? { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) } : undefined;
  return (
    <div
      ref={layer} className="camera-draw" tabIndex={-1} role="application" aria-label="Marcar el encuadre de la presentación"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
        else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); current(); }
      }}
      onPointerDown={(event) => { event.preventDefault(); capture(event); const at = local(event, layer.current); setStart(at); setEnd(at); }}
      onPointerMove={(event) => { if (start) setEnd(local(event, layer.current)); }}
      onPointerUp={(event) => {
        if (!start) return;
        const at = local(event, layer.current);
        const drawn = { left: Math.min(start.x, at.x), top: Math.min(start.y, at.y), width: Math.abs(at.x - start.x), height: Math.abs(at.y - start.y) };
        setStart(undefined); setEnd(undefined);
        const now = view.get();
        if (!now) return;
        // A click, or a box too small to mean anything, takes the whole view.
        if (drawn.width < MIN_CAMERA_PX / 4 && drawn.height < MIN_CAMERA_PX / 4) { current(); return; }
        onDone(screenToCamera({ ...drawn, width: Math.max(MIN_CAMERA_PX, drawn.width), height: Math.max(MIN_CAMERA_PX, drawn.height) }, now));
      }}
    >
      <p className="camera-draw__hint">Arrastra para marcar lo que mostrará la presentación · Intro: usar lo que ves · Esc: cancelar</p>
      {box && <div className="camera-draw__box" style={box} />}
    </div>
  );
}

const HANDLES: Array<Exclude<CameraHandle, 'move'>> = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_NAMES: Record<Exclude<CameraHandle, 'move'>, string> = {
  nw: 'esquina superior izquierda', n: 'lado superior', ne: 'esquina superior derecha', e: 'lado derecho',
  se: 'esquina inferior derecha', s: 'lado inferior', sw: 'esquina inferior izquierda', w: 'lado izquierdo',
};

/**
 * The step's camera over the canvas: a dashed box with a tag. Its edges and the tag move it and its eight handles
 * resize it; inside, the drawing stays free to edit.
 */
export function CameraOverlay({ camera, view, onChange }: { camera: StepCamera; view: ViewStore; onChange: (camera: StepCamera) => void }) {
  const now = useSyncExternalStore(view.subscribe, view.get);
  const [draft, setDraft] = useState<StepCamera>();
  const drag = useRef<{ handle: CameraHandle; x: number; y: number; from: StepCamera }>(undefined);
  if (!now) return null;
  const shown = draft ?? camera;
  const box = cameraOnScreen(shown, now);
  const grab = (handle: CameraHandle) => ({
    onPointerDown: (event: ReactPointerEvent) => {
      event.preventDefault(); event.stopPropagation();
      capture(event);
      drag.current = { handle, x: event.clientX, y: event.clientY, from: shown };
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const held = drag.current;
      if (!held) return;
      setDraft(reshapeCamera(held.from, held.handle, (event.clientX - held.x) / now.zoom, (event.clientY - held.y) / now.zoom, MIN_CAMERA_PX / now.zoom));
    },
    onPointerUp: () => {
      const held = drag.current;
      drag.current = undefined;
      if (held && draft) onChange(draft);
      setDraft(undefined);
    },
    onPointerCancel: () => { drag.current = undefined; setDraft(undefined); },
  });
  return (
    <div className="camera-overlay" data-dragging={draft ? true : undefined} style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <span className="camera-overlay__tag" title="Arrastra para mover el encuadre" {...grab('move')}><Scan className="i" aria-hidden="true" />Encuadre de la presentación</span>
      {(['n', 's', 'e', 'w'] as const).map((side) => <span key={side} className={`camera-overlay__edge camera-overlay__edge--${side}`} aria-hidden="true" {...grab('move')} />)}
      {HANDLES.map((handle) => <span key={handle} className={`camera-overlay__handle camera-overlay__handle--${handle}`} title={`Redimensionar: ${HANDLE_NAMES[handle]}`} aria-hidden="true" {...grab(handle)} />)}
    </div>
  );
}
