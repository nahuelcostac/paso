import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ApiClient, type ClientConfig } from './lib/api';
import { StepStore } from './editor/step-store';
import { BrowserRecovery } from './editor/recovery';
import { bindStepLifecycle } from './editor/lifecycle';
import { useRoute } from './lib/route';
import { MainView } from './components/MainView';
import { Storyboard } from './components/Storyboard';
import { ThumbnailCache } from './editor/thumbnails';
import { ProjectsPanel } from './components/ProjectsPanel';
import { TopBar } from './components/TopBar';
import { ProjectsStore, useProjects } from './state/projects-store';
import { formatSize } from './lib/format';

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

export function App({ config }: { config: ClientConfig }) {
  const api = useMemo(() => new ApiClient(config), [config]);
  const store = useMemo(() => new ProjectsStore(api), [api]);
  // One cache of drawn thumbnails for the whole window, so a scene is not drawn twice for the same revisions.
  const thumbnails = useMemo(() => new ThumbnailCache(48), []);
  const steps = useMemo(() => new StepStore(api, new BrowserRecovery(config.baseUrl)), [api, config.baseUrl]);
  useEffect(() => bindStepLifecycle(steps), [steps]);
  useEffect(() => store.subscribeEvents((event) => {
    if (event.type === 'ready') {
      for (const session of steps.all()) void api.getStep(session.target).then((fresh) => steps.external(session.target, fresh.revision)).catch(() => {});
    }
    if (event.kind === 'step' && event.projectId && event.sceneId && event.id) void steps.external({ projectId: event.projectId, sceneId: event.sceneId, stepId: event.id }, event.revision ?? null).catch(() => {});
  }), [store, steps, api]);
  useEffect(() => { store.start(); return () => store.dispose(); }, [store]);
  const state = useProjects(store);
  useSyncExternalStore(steps.subscribe, steps.getSnapshot);
  const failedStep = steps.all().find((session) => session.status === 'failed' || session.status === 'conflict');
  const [route, navigate] = useRoute();
  const [panelOpen, setPanelOpen] = usePanelOpen();
  const [creating, setCreating] = useState(false);

  const row = state.rows.find((candidate) => candidate.id === route.projectId);

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
    <div className={`app${panelOpen ? '' : ' app--panel-closed'}${route.view === 'storyboard' ? ' app--agent' : ''}`}>
      <TopBar
        view={route.view}
        onViewChange={(view) => navigate({ ...route, view })}
        saveNotice={failedStep ? <button className="btn btn--soft" onClick={() => navigate({ ...failedStep.target, view: 'lienzo' })}>Revisar paso sin guardar</button> : undefined}
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
      {row?.kind === 'ok' && route.view === 'lienzo' ? <Suspense fallback={<main className="main-message" aria-label="Lienzo">Cargando…</main>}>
        <Lienzo key={row.id} api={api} store={steps} projectId={row.id} projectName={row.project.name} structureRevision={row.revision} route={route} navigate={navigate} />
      </Suspense> : row?.kind === 'ok' ? (
        <Storyboard key={row.id} api={api} projectId={row.id} projectName={row.project.name} listedSize={formatSize(row.scenes, row.steps)} events={store.subscribeEvents} thumbnails={thumbnails} route={route} navigate={navigate} />
      ) : <MainView state={state} row={row} requestedId={route.projectId} onCreate={startCreating} onRetry={() => store.retry()} />}
    </div>
  );
}
