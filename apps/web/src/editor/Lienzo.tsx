import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Scene } from '@paso/shared';
import type { ApiClient } from '../lib/api';
import type { Route } from '../lib/route';
import { type StepStore, targetKey, type Session } from './step-store';
import { useTheme } from './use-theme';
import './excalidraw-runtime';

const StepCanvas = lazy(() => import('./StepCanvas'));
const labels = { saved: 'Guardado', dirty: 'Cambios pendientes', saving: 'Guardando…', failed: 'No se pudo guardar', conflict: 'El paso cambió fuera de Paso. Tu trabajo local se conserva.' };

function download(session: Session) {
  // Recovery includes image bytes as well as the valid shared document.
  const blob = new Blob([JSON.stringify({ document: session.document, revision: session.revision, binaries: session.binaries }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `paso-recuperacion-${session.target.stepId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Lienzo({ api, store, projectId, projectName, structureRevision, route, navigate }: {
  api: ApiClient; store: StepStore; projectId: string; projectName: string; structureRevision: string; route: Route;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
}) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [scenes, setScenes] = useState<Scene[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const theme = useTheme();
  const scene = scenes?.find((item) => item.id === route.sceneId);
  const stepId = scene?.stepIds.includes(route.stepId ?? '') ? route.stepId : undefined;
  const current = store.current();
  const session = current?.target.projectId === projectId && current.target.sceneId === scene?.id && current.target.stepId === stepId ? current : undefined;
  const refresh = useCallback(async () => {
    const result = await api.listScenes(projectId);
    setScenes(result.map(({ document }) => document));
  }, [api, projectId]);

  useEffect(() => { void refresh().catch(() => setError('No se pudieron cargar las escenas.')); }, [refresh, structureRevision]);
  useEffect(() => {
    if (!scenes) return;
    const selected = scenes.find((item) => item.id === route.sceneId) ?? scenes[0];
    const selectedStep = selected?.stepIds.includes(route.stepId ?? '') ? route.stepId : selected?.stepIds[0];
    if (selected?.id !== route.sceneId || selectedStep !== route.stepId) navigate({ ...route, sceneId: selected?.id, stepId: selectedStep }, { replace: true });
  }, [scenes, route, navigate]);
  useEffect(() => {
    if (!scene || !stepId) return;
    setError(undefined);
    void store.select({ projectId, sceneId: scene.id, stepId }).catch(() => setError('No se pudo cargar el paso.'));
    return () => { void store.flushAll(); };
  }, [store, projectId, scene?.id, stepId]);

  async function create(kind: 'scene' | 'step') {
    setBusy(true); setError(undefined);
    try {
      const sceneId = kind === 'scene' ? (await api.createScene(projectId, `Escena ${(scenes?.length ?? 0) + 1}`)).document.id : scene!.id;
      const step = await api.createStep(projectId, sceneId);
      await refresh();
      navigate({ ...route, sceneId, stepId: step.document.id });
    } catch { setError('No se pudo crear. Inténtalo de nuevo.'); }
    finally { setBusy(false); }
  }
  return <main className="lienzo" aria-label="Lienzo">
    <div className="step-switcher glass">
      <span>Selector temporal</span>
      {scenes && scenes.length > 0 && <>
        <label>Escena <select aria-label="Escena temporal" value={scene?.id ?? ''} onChange={(event) => navigate({ ...route, sceneId: event.target.value, stepId: scenes.find((item) => item.id === event.target.value)?.stepIds[0] })}>
          {scenes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {scene && scene.stepIds.length > 0 && <label>Paso <select aria-label="Paso temporal" value={stepId ?? ''} onChange={(event) => navigate({ ...route, stepId: event.target.value })}>
          {scene.stepIds.map((id, index) => <option key={id} value={id}>{index + 1}</option>)}
        </select></label>}
        <button className="btn" disabled={busy} onClick={() => void create('step')}>Añadir paso</button>
      </>}
      <button className="btn" disabled={busy} onClick={() => void create('scene')}>{scenes?.length ? 'Añadir escena' : 'Crear primera escena'}</button>
      {session && <span className="save-state" role="status" data-save-state={session.status}>{labels[session.status]}</span>}
    </div>
    {error && <div role="alert">{error}<button className="btn" onClick={() => { void refresh(); if (scene && stepId) void store.select({ projectId, sceneId: scene.id, stepId }); }}>Reintentar</button></div>}
    {session && (session.status === 'failed' || session.status === 'conflict' || session.error) && <div className="editor-notice" role="alert">
      <span>{session.error ?? labels[session.status]}</span>
      <button className="btn" onClick={() => download(session)}>Descargar copia local</button>
      {session.status === 'failed' && <button className="btn" onClick={() => void store.flush(session.target)}>Reintentar guardado</button>}
      {session.status === 'conflict' && <button className="btn" onClick={() => {
        download(session);
        void store.useServer(session).catch(() => setError('No se pudo cargar la versión del servicio.'));
      }}>Descargar copia y cargar versión del servicio</button>}
    </div>}
    <div className="canvas canvas--editor">
      {session ? <Suspense fallback={<div className="editor-message">Cargando editor…</div>}>
        <StepCanvas key={`${targetKey(session.target)}/${session.canvasVersion}`} api={api} store={store} session={session} theme={theme} />
      </Suspense> : <div className="canvas__placeholder"><h1>{projectName}</h1><p>{scenes === undefined ? 'Cargando…' : scene ? 'Esta escena no tiene pasos.' : 'Crea una escena para empezar a dibujar.'}</p>
        {scene && !stepId && <button className="btn" disabled={busy} onClick={() => void create('step')}>Crear primer paso</button>}
      </div>}
    </div>
  </main>;
}
