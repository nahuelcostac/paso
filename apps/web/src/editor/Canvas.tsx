import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SceneEnvelope, StepActions } from './step-actions';
import type { ApiClient } from '../lib/api';
import type { Route } from '../lib/route';
import type { StepStore, Session } from './step-store';
import { Loading } from './Loading';
import { StepCarousel } from './StepCarousel';
import { useThumbnails } from './use-thumbnails';
import { useTheme } from './use-theme';
import './excalidraw-runtime';
import type { CanvasCamera } from './canvas-camera';
import { ViewToggle } from '../components/ViewToggle';
import { CameraControl, CameraDraw, CameraOverlay, KeptCameraOverlay, type KeptCamera } from './CameraControls';
import { createViewStore } from './canvas-view';
import { useSceneCameras } from './use-scene-cameras';
import { PREVIOUS_CAMERA, resolveStepCamera } from '@paso/shared';
import type { ServiceEvent } from '../state/projects-store';
import { StepBar } from './StepBar';
import { stripKey, useStepStrip } from './loose-strip';

const StepCanvas = lazy(() => import('./StepCanvas'));
const messages = { failed: "Couldn't save. Your work is still in this browser.", conflict: 'The step changed outside Paso. Your local work is kept.' };

function download(session: Session) {
  // Recovery includes image bytes as well as the valid shared document.
  const blob = new Blob([JSON.stringify({ document: session.document, revision: session.revision, binaries: session.binaries }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `paso-recovery-${session.target.stepId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * True when the keyboard is working the carousel or its bar's pager. A new canvas then keeps focus out of the way, or
 * the next arrow key would draw, and the next Enter on “Next step” would be lost.
 */
function keyboardInCarousel() {
  const active = document.activeElement;
  if (!active?.closest('.carousel, .step-bar')) return false;
  try { return active.matches(':focus-visible'); } catch { return true; }
}

export default function Canvas({ api, store, actions, projectId, projectName, scenes, structureRevision, refreshScenes, route, navigate, stepAgentStates, notices, corner, subscribeEvents, loose = false }: {
  api: ApiClient; store: StepStore; actions: StepActions; projectId: string; projectName: string;
  scenes: SceneEnvelope[] | undefined; structureRevision: string; refreshScenes: () => Promise<SceneEnvelope[]>;
  route: Route; navigate: (route: Route, options?: { replace?: boolean }) => void;
  stepAgentStates?: Record<string, 'working' | 'changed'>;
  /** The app's failures with no place of their own while the sidebar is folded. */
  notices?: React.ReactNode;
  /** Over the canvas's top right corner, where Excalidraw's library button was: Present. */
  corner?: React.ReactNode;
  /** The service's changes, so a camera this step keeps from an earlier one follows it when that one changes. */
  subscribeEvents?: (listener: (event: ServiceEvent) => void) => () => void;
  /** A loose diagram: a plain whiteboard, whose step strip shows on request or when it has several steps. */
  loose?: boolean;
}) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const theme = useTheme();
  const scene = scenes?.find((item) => item.document.id === route.sceneId)?.document;
  const stepIds = useMemo(() => scene?.stepIds ?? [], [scene]);
  const stepId = scene?.stepIds.includes(route.stepId ?? '') ? route.stepId : undefined;
  const current = store.current();
  // The step asked for, once the store has it. Until the canvas shows it, the controls stay with the step on screen.
  const wanted = current?.target.projectId === projectId && current.target.sceneId === scene?.id && current.target.stepId === stepId ? current : undefined;
  const [loadFailed, setLoadFailed] = useState(false);
  const canvasOpen = Boolean(scene && stepId && !loadFailed);
  const [shown, setShown] = useState<Session>();
  const session = canvasOpen && shown?.target.projectId === projectId ? shown : undefined;
  const shownStepId = session?.target.stepId;
  const shownIds = scenes?.find((item) => item.document.id === session?.target.sceneId)?.document.stepIds;
  const { svgs, titles } = useThumbnails(api, projectId, scene?.id, theme, `${structureRevision}/${stepIds.join()}`);
  // Written during render on purpose: the effect below runs after the canvas mounted, and the canvas asks when it loads.
  const routeRef = useRef(route); routeRef.current = route;
  const camera = useRef<CanvasCamera | undefined>(undefined);
  // What the canvas shows, for “Frame” and for drawing the step's presentation camera over it.
  const view = useMemo(createViewStore, []);
  // Marking the step's presentation camera by hand: a layer over the canvas. It ends with the step.
  const [framing, setFraming] = useState(false);
  useEffect(() => setFraming(false), [stepId, shownStepId]);
  // A step that keeps the previous camera shows the box of the nearest earlier step that decides, live: steps open in
  // this window are read from their sessions, unsaved changes included, and the rest from the service.
  const listedCameras = useSceneCameras(api, projectId, session?.target.sceneId, `${structureRevision}/${stepIds.join()}/${shownStepId ?? ''}`, subscribeEvents);
  // Worked out on every render, which follows every change to the store, so an open step's new camera shows at once.
  const kept = ((): KeptCamera | undefined => {
    if (!session || !listedCameras || session.document.camera !== PREVIOUS_CAMERA) return undefined;
    const { sceneId } = session.target;
    const ids = shownIds ?? [];
    const index = ids.indexOf(session.target.stepId);
    if (index < 0) return undefined;
    const settings = ids.map((id) => {
      const open = store.session({ projectId, sceneId, stepId: id });
      return { camera: open ? open.document.camera : listedCameras[id] };
    });
    const found = resolveStepCamera(settings, index);
    return found ? { camera: found.camera, number: found.stepIndex + 1 } : { reason: index === 0 ? 'first' : 'scene' };
  })();

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
    setError(undefined); setLoadFailed(false);
    void store.select({ projectId, sceneId: scene.id, stepId }).catch(() => { setError("Couldn't load the step."); setLoadFailed(true); });
    return () => { void store.flushAll(); };
  }, [store, projectId, scene?.id, stepId]);

  /** Runs a structure action. It reports its own failure, and the carousel is disabled meanwhile. */
  const run = useCallback(async <T,>(job: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(undefined);
    try { return await job(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't complete the action."); return undefined; }
    finally { setBusy(false); }
  }, []);
  // The step is made; only reading the scene again failed. The person is told, and nothing is left unhandled.
  const goTo = async (id: string | undefined) => {
    try { await refreshScenes(); }
    catch { setError("The step was created, but the scene couldn't be updated. Press “Retry”."); return; }
    navigate({ ...routeRef.current, sceneId: scene?.id, stepId: id });
  };
  const copy = (make: () => Promise<string>) => async () => { const id = await run(make); if (id) await goTo(id); };

  // The step strip: a project's scene shows it, a loose diagram shows it with several steps, or as the person chose.
  // Hidden, the steps stay, and the keys on the canvas still move through them.
  const strip = useStepStrip(scene ? stripKey(projectId, scene.id, loose) : undefined, stepIds.length, loose);

  // ← → on the canvas move through the scene's steps, as in Present. They stop at both ends.
  const stepIdsRef = useRef(stepIds); stepIdsRef.current = stepIds;
  const stepRef = useRef(stepId); stepRef.current = stepId;
  const stepKey = useCallback((delta: -1 | 1) => {
    const ids = stepIdsRef.current;
    const next = ids[ids.indexOf(stepRef.current ?? '') + delta];
    if (next) navigate({ ...routeRef.current, stepId: next });
  }, [navigate]);

  return <main className="canvas-page" aria-label="Canvas">
    {/* The page's main heading, for screen readers: the sidebar already shows the open diagram. */}
    <h1 className="visually-hidden">{projectName}</h1>
    {error && <div className="editor-notice" role="alert">{error}<button className="btn" onClick={() => { setError(undefined); void refreshScenes(); if (scene && stepId) { setLoadFailed(false); void store.select({ projectId, sceneId: scene.id, stepId }).catch(() => { setError("Couldn't load the step."); setLoadFailed(true); }); } }}>Retry</button></div>}
    {session && (session.status === 'failed' || session.status === 'conflict' || session.error) && <div className="editor-notice" role="alert">
      <span>{session.error ?? messages[session.status as 'failed' | 'conflict']}</span>
      <button className="btn" onClick={() => download(session)}>Download local copy</button>
      {session.status === 'failed' && <button className="btn" onClick={() => void store.flush(session.target)}>Retry saving</button>}
      {session.status === 'conflict' && <button className="btn" onClick={() => {
        download(session);
        void store.useServer(session).catch(() => setError("Couldn't load the service's version."));
      }}>Download copy and load the service's version</button>}
    </div>}
    <div className="canvas canvas--editor">
      <div className="canvas__corner">
        {corner}
        <ViewToggle route={route} navigate={navigate} />
        {session && <CameraControl
          camera={session.document.camera} first={shownIds?.[0] === shownStepId} kept={kept} drawing={framing} onDraw={() => setFraming((on) => !on)}
          onClear={() => { setFraming(false); store.setCamera(session, undefined); }}
          onKeep={(keep) => { setFraming(false); store.setCamera(session, keep ? PREVIOUS_CAMERA : undefined); }}
        />}
      </div>
      {/* One canvas for the diagram: moving to another step swaps the drawing in it, with no loading in between. */}
      {canvasOpen ? <Suspense fallback={<Loading>Loading editor…</Loading>}>
        <StepCanvas key={projectId} api={api} store={store} session={wanted} theme={theme} keepFocus={keyboardInCarousel} camera={camera} onStepKey={stepKey} view={view} onShow={setShown} />
      </Suspense> : <div className="canvas__placeholder"><p className="canvas__placeholder-title" aria-hidden="true">{projectName}</p><p>{scenes === undefined ? 'Loading…' : scene ? 'This scene has no steps. Use “Add step” to start drawing.' : 'Create a scene from the sidebar to start drawing.'}</p></div>}
      {typeof session?.document.camera === 'object' && !framing && <CameraOverlay camera={session.document.camera} view={view} onChange={(next) => store.setCamera(session, next)} />}
      {session && kept?.camera && !framing && <KeptCameraOverlay camera={kept.camera} number={kept.number} view={view} onOpen={() => navigate({ ...routeRef.current, sceneId: session.target.sceneId, stepId: shownIds?.[kept.number - 1] })} />}
      {session && framing && <CameraDraw view={view} onCancel={() => setFraming(false)} onDone={(next) => { setFraming(false); store.setCamera(session, next); }} />}
    </div>
    {notices && <div className="canvas-page__notices">{notices}</div>}
    {/* The strip, then its bar, which stays when the strip is hidden: its chevron never moves under the pointer. */}
    {scene && <div className="step-dock">
      {strip.shown && <StepCarousel
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
      {stepIds.length > 0 && <StepBar
        stepIds={stepIds} currentId={stepId} stripShown={strip.shown} onStep={stepKey}
        onToggle={() => strip.choose(strip.shown ? 'hidden' : 'shown')}
      />}
    </div>}
  </main>;
}
