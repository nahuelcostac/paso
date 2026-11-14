import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SceneEnvelope, StepActions } from './step-actions';
import type { ApiClient } from '../lib/api';
import type { Route } from '../lib/route';
import { type StepStore, targetKey, type Session } from './step-store';
import { StepCarousel } from './StepCarousel';
import { useThumbnails } from './use-thumbnails';
import { useTheme } from './use-theme';
import './excalidraw-runtime';
import type { CanvasCamera } from './canvas-camera';
import { ViewToggle } from '../components/ViewToggle';
import { CameraControl, CameraDraw, CameraOverlay } from './CameraControls';
import { createViewStore } from './canvas-view';

const StepCanvas = lazy(() => import('./StepCanvas'));
const messages = { failed: 'No se pudo guardar. Tu trabajo sigue en este navegador.', conflict: 'El paso cambió fuera de Paso. Tu trabajo local se conserva.' };

function download(session: Session) {
  // Recovery includes image bytes as well as the valid shared document.
  const blob = new Blob([JSON.stringify({ document: session.document, revision: session.revision, binaries: session.binaries }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `paso-recuperacion-${session.target.stepId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** True when the keyboard is working the carousel. A new canvas then keeps focus out of the way, or the next arrow key would draw. */
function keyboardInCarousel() {
  const active = document.activeElement;
  if (!active?.closest('.carousel')) return false;
  try { return active.matches(':focus-visible'); } catch { return true; }
}

export default function Lienzo({ api, store, actions, projectId, projectName, scenes, structureRevision, refreshScenes, route, navigate, stepAgentStates, notices, corner }: {
  api: ApiClient; store: StepStore; actions: StepActions; projectId: string; projectName: string;
  scenes: SceneEnvelope[] | undefined; structureRevision: string; refreshScenes: () => Promise<SceneEnvelope[]>;
  route: Route; navigate: (route: Route, options?: { replace?: boolean }) => void;
  stepAgentStates?: Record<string, 'working' | 'changed'>;
  /** The app's failures with no place of their own while the sidebar is folded. */
  notices?: React.ReactNode;
  /** Over the canvas's top right corner, where Excalidraw's library button was: Presentar. */
  corner?: React.ReactNode;
}) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const theme = useTheme();
  const scene = scenes?.find((item) => item.document.id === route.sceneId)?.document;
  const stepIds = useMemo(() => scene?.stepIds ?? [], [scene]);
  const stepId = scene?.stepIds.includes(route.stepId ?? '') ? route.stepId : undefined;
  const current = store.current();
  const session = current?.target.projectId === projectId && current.target.sceneId === scene?.id && current.target.stepId === stepId ? current : undefined;
  const { svgs, titles } = useThumbnails(api, projectId, scene?.id, theme, `${structureRevision}/${stepIds.join()}`);
  // Written during render on purpose: the effect below runs after the canvas mounted, and the canvas asks when it loads.
  const routeRef = useRef(route); routeRef.current = route;
  const camera = useRef<CanvasCamera | undefined>(undefined);
  // What the canvas shows, for «Encuadrar» and for drawing the step's presentation camera over it.
  const view = useMemo(createViewStore, []);
  // Marking the step's presentation camera by hand: a layer over the canvas. It ends with the step.
  const [framing, setFraming] = useState(false);
  useEffect(() => setFraming(false), [stepId]);

  // An address that names a scene or step that is not there lands on the first one.
  useEffect(() => {
    if (!scenes) return;
    const selected = scenes.find((item) => item.document.id === route.sceneId)?.document ?? scenes[0]?.document;
    const selectedStep = selected?.stepIds.includes(route.stepId ?? '') ? route.stepId : selected?.stepIds[0];
    if (selected?.id !== route.sceneId || selectedStep !== route.stepId) navigate({ ...route, sceneId: selected?.id, stepId: selectedStep }, { replace: true });
  }, [scenes, route, navigate]);
  // Every step change goes through the store: it saves the step being left before it opens the next.
  useEffect(() => {
    if (!scene || !stepId) return;
    setError(undefined);
    void store.select({ projectId, sceneId: scene.id, stepId }).catch(() => setError('No se pudo cargar el paso.'));
    return () => { void store.flushAll(); };
  }, [store, projectId, scene?.id, stepId]);

  /** Runs a structure action. It reports its own failure, and the carousel is disabled meanwhile. */
  const run = useCallback(async <T,>(job: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(undefined);
    try { return await job(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo completar la acción.'); return undefined; }
    finally { setBusy(false); }
  }, []);
  // The step is made; only reading the scene again failed. The person is told, and nothing is left unhandled.
  const goTo = async (id: string | undefined) => {
    try { await refreshScenes(); }
    catch { setError('El paso se creó, pero no se pudo actualizar la escena. Pulsa «Reintentar».'); return; }
    navigate({ ...routeRef.current, sceneId: scene?.id, stepId: id });
  };
  const copy = (make: () => Promise<string>) => async () => { const id = await run(make); if (id) await goTo(id); };

  // ← → on the canvas move through the scene's steps, as in Presentar. They stop at both ends.
  const stepIdsRef = useRef(stepIds); stepIdsRef.current = stepIds;
  const stepRef = useRef(stepId); stepRef.current = stepId;
  const stepKey = useCallback((delta: -1 | 1) => {
    const ids = stepIdsRef.current;
    const next = ids[ids.indexOf(stepRef.current ?? '') + delta];
    if (next) navigate({ ...routeRef.current, stepId: next });
  }, [navigate]);

  return <main className="lienzo" aria-label="Lienzo">
    {/* The page's main heading, for screen readers: the sidebar already shows the open diagram. */}
    <h1 className="visually-hidden">{projectName}</h1>
    {error && <div className="editor-notice" role="alert">{error}<button className="btn" onClick={() => { setError(undefined); void refreshScenes(); if (scene && stepId) void store.select({ projectId, sceneId: scene.id, stepId }).catch(() => setError('No se pudo cargar el paso.')); }}>Reintentar</button></div>}
    {session && (session.status === 'failed' || session.status === 'conflict' || session.error) && <div className="editor-notice" role="alert">
      <span>{session.error ?? messages[session.status as 'failed' | 'conflict']}</span>
      <button className="btn" onClick={() => download(session)}>Descargar copia local</button>
      {session.status === 'failed' && <button className="btn" onClick={() => void store.flush(session.target)}>Reintentar guardado</button>}
      {session.status === 'conflict' && <button className="btn" onClick={() => {
        download(session);
        void store.useServer(session).catch(() => setError('No se pudo cargar la versión del servicio.'));
      }}>Descargar copia y cargar versión del servicio</button>}
    </div>}
    <div className="canvas canvas--editor">
      <div className="canvas__corner">
        {corner}
        <ViewToggle route={route} navigate={navigate} />
        {session && <CameraControl camera={session.document.camera} drawing={framing} onDraw={() => setFraming((on) => !on)} onClear={() => { setFraming(false); store.setCamera(session, undefined); }} />}
      </div>
      {session ? <Suspense fallback={<div className="editor-message">Cargando editor…</div>}>
        <StepCanvas key={`${targetKey(session.target)}/${session.canvasVersion}`} api={api} store={store} session={session} theme={theme} keepFocus={keyboardInCarousel} camera={camera} onStepKey={stepKey} view={view} />
      </Suspense> : <div className="canvas__placeholder"><p className="canvas__placeholder-title" aria-hidden="true">{projectName}</p><p>{scenes === undefined ? 'Cargando…' : scene ? 'Esta escena no tiene pasos. Usa «Añadir paso» para empezar a dibujar.' : 'Crea una escena desde la barra lateral para empezar a dibujar.'}</p></div>}
      {session?.document.camera && !framing && <CameraOverlay camera={session.document.camera} view={view} onChange={(next) => store.setCamera(session, next)} />}
      {session && framing && <CameraDraw view={view} onCancel={() => setFraming(false)} onDone={(next) => { setFraming(false); store.setCamera(session, next); }} />}
    </div>
    {notices && <div className="lienzo__notices">{notices}</div>}
    {scene && <StepCarousel
      stepIds={stepIds} currentId={stepId} svgs={svgs} titles={titles} stepAgentStates={stepAgentStates} busy={busy}
      onSelect={(id) => { if (id !== stepId) navigate({ ...route, sceneId: scene.id, stepId: id }); }}
      onAdd={() => void copy(() => actions.add(projectId, scene.id, stepIds.at(-1)))()}
      onDuplicate={(id) => void copy(() => actions.duplicate({ projectId, sceneId: scene.id, stepId: id }))()}
      onNudge={async (id, delta) => { const result = await actions.nudge(projectId, scene.id, id, delta).catch((failure: Error) => { setError(failure.message); throw failure; }); await refreshScenes(); return result; }}
      onMove={async (id, index) => { try { await actions.move(projectId, scene.id, id, index); } catch (failure) { setError((failure as Error).message); throw failure; } await refreshScenes(); }}
      onDelete={async (id) => {
        const next = await actions.remove({ projectId, sceneId: scene.id, stepId: id });
        await refreshScenes();
        // Deleting the step on screen lands on its neighbour. Deleting another one leaves the person where they are.
        if (id === stepId) navigate({ ...routeRef.current, sceneId: scene.id, stepId: next });
      }}
    />}
  </main>;
}
