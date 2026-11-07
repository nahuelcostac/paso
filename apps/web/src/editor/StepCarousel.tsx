import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { StepFrame } from '../components/StepFrame';
import '../styles/carousel.css';

type Props = {
  stepIds: string[];
  currentId: string | undefined;
  /** Thumbnails as SVG documents by step ID. A step without one shows the frame's quiet placeholder. */
  svgs: Record<string, string>;
  titles: Record<string, string>;
  /** An action is running: the buttons wait, so two clicks never start two copies. */
  busy: boolean;
  onSelect: (stepId: string) => void;
  onAdd: () => void;
  onDuplicate: () => void;
  /** Move one place. The caller reads the position when it runs, so a held key keeps working. */
  onNudge: (stepId: string, delta: -1 | 1) => Promise<{ index: number; count: number } | void>;
  /** Move to this position (0-based, in the order after the move). */
  onMove: (stepId: string, index: number) => Promise<void>;
  /** Resolves when the step is gone. A rejection is shown in the dialog. */
  onDelete: (stepId: string) => Promise<void>;
};

const HINT = 'Flechas: cambiar de paso. Alt y flechas: mover el paso. Supr: eliminar el paso.';

/**
 * The strip of steps under the canvas. It is not inside the Excalidraw container and never overlaps it.
 * Keys act only while focus is in here: Excalidraw uses bare keys, so nothing is bound on the window.
 */
export function StepCarousel({ stepIds, currentId, svgs, titles, busy, onSelect, onAdd, onDuplicate, onNudge, onMove, onDelete }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const frames = useRef(new Map<string, HTMLElement>());
  const refocus = useRef<string | undefined>(undefined);
  const [dragging, setDragging] = useState<string>();
  const [drop, setDrop] = useState<{ id: string; after: boolean }>();
  const [confirming, setConfirming] = useState<string>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const order = stepIds.join();

  // Keep the current step in view in a long scene.
  useEffect(() => {
    const box = scroller.current, frame = currentId ? frames.current.get(currentId)?.parentElement : undefined;
    if (!box || !frame || typeof box.scrollTo !== 'function') return;
    const margin = 16;
    const left = frame.offsetLeft - margin, right = frame.offsetLeft + frame.offsetWidth + margin;
    const target = left < box.scrollLeft ? left : right > box.scrollLeft + box.clientWidth ? right - box.clientWidth : undefined;
    if (target !== undefined) box.scrollTo({ left: Math.max(0, target), behavior: matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [currentId, order]);
  // Reordering moves DOM nodes, and a moved node loses focus.
  useEffect(() => { if (refocus.current) { frames.current.get(refocus.current)?.focus(); refocus.current = undefined; } }, [order]);
  // A mouse wheel scrolls the strip sideways. Native listener: React's wheel handler cannot cancel the page scroll.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || box.scrollWidth <= box.clientWidth) return;
      event.preventDefault(); box.scrollLeft += event.deltaY;
    };
    box.addEventListener('wheel', wheel, { passive: false });
    return () => box.removeEventListener('wheel', wheel);
  }, []);

  const focusStep = (id: string | undefined) => { if (id) { frames.current.get(id)?.focus(); onSelect(id); } };
  const onKeyDown = (event: KeyboardEvent, id: string, index: number) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    const arrow = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (arrow && event.altKey) {
      event.preventDefault();
      refocus.current = id;
      void onNudge(id, arrow).then((result) => { if (result) setAnnouncement(`Paso movido a la posición ${result.index + 1} de ${result.count}.`); }).catch(() => {})
        // The effect above refocuses once the new order is drawn. At either end nothing moves, so this clears the request.
        .finally(() => setTimeout(() => { if (refocus.current === id) { frames.current.get(id)?.focus(); refocus.current = undefined; } }, 250));
      return;
    }
    if (event.altKey) return;
    if (arrow) { event.preventDefault(); focusStep(stepIds[index + arrow]); }
    else if (event.key === 'Home') { event.preventDefault(); focusStep(stepIds[0]); }
    else if (event.key === 'End') { event.preventDefault(); focusStep(stepIds[stepIds.length - 1]); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); setDeleteError(undefined); setConfirming(id); }
  };

  const reset = () => { setDragging(undefined); setDrop(undefined); };
  const over = (event: DragEvent, id: string) => {
    if (!dragging) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const box = event.currentTarget.getBoundingClientRect();
    const after = event.clientX > box.left + box.width / 2;
    if (drop?.id !== id || drop.after !== after) setDrop({ id, after });
  };
  const dropped = (event: DragEvent) => {
    event.preventDefault();
    if (!dragging || !drop) return reset();
    const from = stepIds.indexOf(dragging), target = stepIds.indexOf(drop.id) + (drop.after ? 1 : 0);
    const to = target > from ? target - 1 : target;
    const moved = dragging;
    reset();
    if (to === from) return;
    refocus.current = undefined;
    void onMove(moved, to).then(() => setAnnouncement(`Paso movido a la posición ${to + 1} de ${stepIds.length}.`)).catch(() => {});
  };

  const confirmDelete = async () => {
    if (!confirming) return;
    setDeleteBusy(true); setDeleteError(undefined);
    try { await onDelete(confirming); setAnnouncement('Paso eliminado.'); setConfirming(undefined); }
    catch (error) { setDeleteError(error instanceof Error ? error.message : 'No se pudo eliminar el paso.'); }
    finally { setDeleteBusy(false); }
  };
  const confirmingAt = confirming ? stepIds.indexOf(confirming) : -1;

  return <footer className="carousel glass" aria-label="Pasos de la escena">
    <span id="carousel-hint" className="visually-hidden">{HINT}</span>
    <div className="visually-hidden" role="status" aria-live="polite">{announcement}</div>
    <div className="carousel__frames" ref={scroller}>
      {stepIds.map((id, index) => (
        <div
          key={id} className="carousel__item" data-dragging={dragging === id || undefined} data-drop={drop?.id === id ? (drop.after ? 'after' : 'before') : undefined}
          draggable={stepIds.length > 1} onDragStart={(event) => { setDragging(id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); }}
          onDragOver={(event) => over(event, id)} onDrop={dropped} onDragEnd={reset}
        >
          <StepFrame
            ref={(element) => { if (element) frames.current.set(id, element); else frames.current.delete(id); }}
            number={index + 1} title={titles[id]} svg={svgs[id]} size="carousel" current={id === currentId}
            tabIndex={id === currentId || (!currentId && index === 0) ? 0 : -1}
            aria-describedby="carousel-hint" aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Delete"
            onClick={() => onSelect(id)} onKeyDown={(event) => onKeyDown(event, id, index)}
          />
          <button type="button" className="carousel__delete" tabIndex={-1} aria-label={`Eliminar el paso ${index + 1}`} title="Eliminar paso"
            onClick={() => { setDeleteError(undefined); setConfirming(id); }}><Trash2 className="i" aria-hidden="true" /></button>
        </div>
      ))}
      {stepIds.length === 0 && <p className="carousel__empty">Sin pasos</p>}
    </div>
    <div className="carousel__actions">
      <button type="button" className="btn" disabled={busy} onClick={onAdd} title="Un paso nuevo después del actual, que parte de su dibujo"><Plus className="i" aria-hidden="true" />Añadir paso</button>
      <button type="button" className="btn" disabled={busy || !currentId} onClick={onDuplicate} title="Una copia exacta del paso actual, justo después de él"><Copy className="i" aria-hidden="true" />Duplicar paso</button>
    </div>
    {confirming && <Dialog title={`¿Eliminar el paso ${confirmingAt + 1}?`} onClose={() => { if (!deleteBusy) setConfirming(undefined); }}>
      <p className="dialog__text">Se borra su dibujo y no se puede deshacer.{stepIds.length === 1 ? ' Es el último paso de la escena: quedará vacía.' : ''}</p>
      {deleteError && <p className="dialog__error" role="alert">{deleteError}</p>}
      <div className="dialog__actions">
        <button type="button" className="btn" data-autofocus disabled={deleteBusy} onClick={() => setConfirming(undefined)}>Cancelar</button>
        <button type="button" className="btn btn--danger" disabled={deleteBusy} onClick={() => void confirmDelete()}>Eliminar paso</button>
      </div>
    </Dialog>}
  </footer>;
}
