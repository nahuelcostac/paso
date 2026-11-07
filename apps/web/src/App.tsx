import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ApiClient, type ClientConfig } from './lib/api';
import { StepStore, targetKey, type Recovery } from './editor/step-store';
import { StepActions } from './editor/step-actions';
import { BrowserRecovery } from './editor/recovery';
import { bindStepLifecycle } from './editor/lifecycle';
import { useRoute } from './lib/route';
import { MainView } from './components/MainView';
import { ProjectsPanel } from './components/ProjectsPanel';
import { TopBar } from './components/TopBar';
import { SceneSelector } from './components/SceneSelector';
import { useScenes } from './state/scenes';
import { ProjectsStore, useProjects } from './state/projects-store';

const Lienzo = lazy(() => import('./editor/Lienzo'));

/** Below this the canvas would not fit beside the panel. */
const NARROW = '(max-width: 1063px)';

function usePanelOpen() {
  const [open, setOpen] = useState(() => !window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    // Crossing the threshold resets the choice: open when there is room, closed when there is not.
    const sync = () => setOpen(!query.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return [open, setOpen] as const;
}

/** `recovery` is where unsaved drafts are kept. It is the browser's IndexedDB unless a host or a test supplies another. */
export function App({ config, recovery }: { config: ClientConfig; recovery?: Recovery }) {
  const api = useMemo(() => new ApiClient(config), [config]);
  const store = useMemo(() => new ProjectsStore(api), [api]);
  const steps = useMemo(() => new StepStore(api, recovery ?? new BrowserRecovery(config.baseUrl)), [api, config.baseUrl, recovery]);
  const actions = useMemo(() => new StepActions(api, steps), [api, steps]);
  useEffect(() => bindStepLifecycle(steps), [steps]);
  useEffect(() => store.subscribeEvents((event) => {
    if (event.type === 'ready') {
      for (const session of steps.all()) {
        // Back online: a step whose save failed while the service was away tries again.
        if (session.status === 'failed') void steps.flush(session.target);
        else void api.getStep(session.target).then((fresh) => steps.external(session.target, fresh.revision)).catch(() => {});
      }
    }
    if (event.kind === 'step' && event.projectId && event.sceneId && event.id) void steps.external({ projectId: event.projectId, sceneId: event.sceneId, stepId: event.id }, event.revision ?? null).catch(() => {});
  }), [store, steps, api]);
  useEffect(() => { store.start(); return () => store.dispose(); }, [store]);
  const state = useProjects(store);
  useSyncExternalStore(steps.subscribe, steps.getSnapshot);
  const [route, navigate] = useRoute();
  const [panelOpen, setPanelOpen] = usePanelOpen();
  const [creating, setCreating] = useState(false);

  const row = state.rows.find((candidate) => candidate.id === route.projectId);
  const openProject = row?.kind === 'ok' ? row : undefined;
  const { scenes, refresh: refreshScenes } = useScenes(api, openProject?.id ?? null, openProject?.revision);
  const lienzo = route.view === 'lienzo' && openProject !== undefined;
  const sceneId = scenes?.find((item) => item.document.id === route.sceneId)?.document.id;
  const [creatingScene, setCreatingScene] = useState(false);
  const [sceneError, setSceneError] = useState<string>();
  const createScene = async () => {
    if (!openProject) return;
    setCreatingScene(true); setSceneError(undefined);
    try {
      const created = await actions.createScene(openProject.id, `Escena ${(scenes?.length ?? 0) + 1}`);
      await refreshScenes();
      navigate({ projectId: openProject.id, view: 'lienzo', ...created });
    } catch (error) { setSceneError(error instanceof Error ? error.message : 'No se pudo crear la escena.'); }
    finally { setCreatingScene(false); }
  };

  // Local work that is not on the service: a failed save or a conflict. The step on screen has its own notice in the Lienzo.
  const showing = lienzo && route.sceneId && route.stepId ? targetKey({ projectId: route.projectId!, sceneId: route.sceneId, stepId: route.stepId }) : undefined;
  const failedStep = steps.unresolved().find((session) => targetKey(session.target) !== showing);
  const here = steps.current();
  const saveState = lienzo && here && targetKey(here.target) === showing ? here.status : undefined;

  // No project in the address: open the first one that can be opened.
  useEffect(() => {
    if (state.phase !== 'ready' || route.projectId) return;
    const first = state.rows.find((candidate) => candidate.kind === 'ok');
    if (first) navigate({ projectId: first.id, view: route.view }, { replace: true });
  }, [state.phase, state.rows, route, navigate]);

  useEffect(() => {
    document.title = row?.kind === 'ok' ? `${row.project.name} · Paso` : 'Paso';
  }, [row]);

  const startCreating = () => { setPanelOpen(true); setCreating(true); };

  return (
    <div className={`app${panelOpen ? '' : ' app--panel-closed'}`}>
      <TopBar
        view={route.view}
        onViewChange={(view) => navigate({ ...route, view })}
        saveNotice={failedStep ? <button className="btn btn--soft topbar__notice" onClick={() => navigate({ ...failedStep.target, view: 'lienzo' })}>Revisar paso sin guardar</button> : undefined}
        sceneSelector={lienzo ? <SceneSelector
          scenes={scenes?.map((item) => item.document)} currentId={sceneId} busy={creatingScene}
          onSelect={(id) => navigate({ projectId: openProject!.id, view: 'lienzo', sceneId: id, stepId: scenes?.find((item) => item.document.id === id)?.document.stepIds[0] })}
          onCreate={() => void createScene()}
        /> : undefined}
        saveState={saveState}
        notice={sceneError ? <span className="topbar__error" role="alert">{sceneError}<button type="button" className="icon-btn" aria-label="Cerrar aviso" onClick={() => setSceneError(undefined)}>×</button></span> : undefined}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen(!panelOpen)}
      />
      {panelOpen && (
        <ProjectsPanel
          store={store}
          state={state}
          currentId={route.projectId}
          creating={creating}
          onCreatingChange={setCreating}
          onOpen={(id) => navigate({ projectId: id, view: route.view })}
          onDeleted={(id) => {
            if (id !== route.projectId) return;
            const next = store.getState().rows.find((candidate) => candidate.kind === 'ok');
            navigate({ projectId: next?.id ?? null, view: route.view }, { replace: true });
          }}
        />
      )}
      {route.view === 'lienzo' && row?.kind === 'ok' ? <Suspense fallback={<main className="main-message" aria-label="Lienzo">Cargando…</main>}>
        <Lienzo key={row.id} api={api} store={steps} actions={actions} projectId={row.id} projectName={row.project.name} scenes={scenes} structureRevision={row.revision} refreshScenes={refreshScenes} route={route} navigate={navigate} />
      </Suspense> : <MainView state={state} row={row} requestedId={route.projectId} view={route.view} onCreate={startCreating} onRetry={() => store.retry()} />}
    </div>
  );
}
