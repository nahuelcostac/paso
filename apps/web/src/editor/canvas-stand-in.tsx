import { useEffect, useState } from 'react';
import type { Session, StepStore } from './step-store';
import type { ViewStore } from './canvas-view';

/**
 * For tests only: StepCanvas without Excalidraw, which jsdom cannot draw. Like the real canvas it keeps the step it
 * shows until the next one is there, tells the Canvas which one that is, and owns its session: its first change is the
 * baseline. “Draw” makes an edit the way Excalidraw's onChange would. With nothing selected, as here, ← → go to
 * the Canvas (canvasStepKey, tested on its own). It reports a fixed view: 1000×700 at 100%, scrolled to the origin.
 */
const shape = (id: string) => ({ id, type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false, x: 0, y: 0, width: 10, height: 10 });

export default function CanvasStandIn({ store, session, onStepKey, view, onShow }: {
  store: StepStore; session: Session | undefined; onStepKey?: (delta: -1 | 1) => void; view?: ViewStore; onShow?: (session: Session | undefined) => void;
}) {
  const [shown, setShown] = useState<Session>();
  useEffect(() => {
    if (!session) return;
    session.baseline = undefined; store.change(session, session.document.elements, session.document.appState, {});
    setShown(session); onShow?.(session);
  }, [session, store]);
  useEffect(() => { view?.set({ scrollX: 0, scrollY: 0, zoom: 1, width: 1000, height: 700 }); }, [view]);
  if (!shown) return null;
  return <div data-testid="canvas" data-step-id={shown.target.stepId} tabIndex={0}
    onKeyDown={(event) => { const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (delta) onStepKey?.(delta); }}>
    <span data-testid="elements">{shown.document.elements.map((e) => e.id).join(',')}</span>
    <button type="button" onClick={() => store.change(shown, [...shown.document.elements, shape(`drawn-${shown.document.elements.length}`)], shown.document.appState, {})}>Draw</button>
  </div>;
}
