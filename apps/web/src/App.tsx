import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Sparkles, Square } from 'lucide-react';
import { ApiClient, type ClientConfig } from './lib/api';
import { StepStore, targetKey, type Recovery } from './editor/step-store';
import { StepActions } from './editor/step-actions';
import { BrowserRecovery } from './editor/recovery';
import { bindStepLifecycle } from './editor/lifecycle';
import { useRoute } from './lib/route';
import { MainView } from './components/MainView';
import { Storyboard } from './components/Storyboard';
import { AgentPanel } from './components/AgentPanel';
import { ThumbnailCache } from './editor/thumbnails';
import { ProjectsPanel } from './components/ProjectsPanel';
import { TopBar } from './components/TopBar';
import { SceneSelector } from './components/SceneSelector';
import { PresentButton } from './present/PresentButton';
import { useScenes } from './state/scenes';
import { ProjectsStore, useProjects } from './state/projects-store';
import { AgentStore, HARNESS_NAMES, activeTurn, stepMarks, useAgent } from './state/agent-store';
import { formatSize } from './lib/format';

const Lienzo = lazy(() => import('./editor/Lienzo'));

/** Below this the canvas would not fit beside the panel. */
const NARROW = '(max-width: 1063px)';

/** Below this the Storyboard has no room for the agent's column: the panel becomes a drawer. */
const AGENT_NARROW = '(max-width: 1099px)';

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const sync = () => setMatches(list.matches);
    sync();
    list.addEventListener('change', sync);
    return () => list.removeEventListener('change', sync);
  }, [query]);
  return matches;
}

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
  const agentStore = useMemo(() => new AgentStore(api, store.subscribeEvents), [api, store]);
  // One cache of drawn thumbnails for the whole window, so a scene is not drawn twice for the same revisions.
  const thumbnails = useMemo(() => new ThumbnailCache(48), []);
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
  useEffect(() => { store.start(); agentStore.start(); return () => { agentStore.dispose(); store.dispose(); }; }, [store, agentStore]);
  const state = useProjects(store);
  const agentState = useAgent(agentStore);
  useSyncExternalStore(steps.subscribe, steps.getSnapshot);
  const [route, navigate] = useRoute();
  const [panelOpen, setPanelOpen] = usePanelOpen();
  const [creating, setCreating] = useState(false);
  const narrow = useMediaQuery(AGENT_NARROW);
  const [agentOpen, setAgentOpen] = useState(false);

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

  // The agent's marks on steps and its notice in the top bar follow the open project in both views.
  useEffect(() => { if (openProject) void agentStore.openProject(openProject.id); }, [agentStore, openProject?.id]);
  const sceneDocuments = useMemo(() => scenes?.map((item) => item.document) ?? [], [scenes]);
  const marks = useMemo(() => stepMarks(agentState.turns, agentState.runs[openProject?.id ?? ''], openProject?.id), [agentState.turns, agentState.runs, openProject?.id]);
  const working = useMemo(() => activeTurn(agentState.turns, openProject?.id), [agentState.turns, openProject?.id]);
  const storyboard = row?.kind === 'ok' && route.view === 'storyboard';
  // Without the panel in view, the top bar says who is changing which step: on the Lienzo, and on a narrow Storyboard with the drawer closed.
  const statusShown = Boolean(openProject && working && (lienzo || (storyboard && narrow && !agentOpen)));
  const workingAt = working?.step && sceneDocuments.length ? (() => {
    for (const [index, scene] of sceneDocuments.entries()) {
      const at = scene.stepIds.indexOf(working.step!.stepId);
      if (at >= 0) return { sceneId: scene.id, sceneNumber: index + 1, stepNumber: at + 1 };
    }
    return undefined;
  })() : undefined;

  return (
    <div className={`app${panelOpen ? '' : ' app--panel-closed'}${storyboard ? ' app--agent' : ''}`}>
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
        agentStatus={statusShown && working && openProject ? (
          <div className="agent-status glass" role="status" aria-label="Agente trabajando">
            <span className="agent-status__text">{HARNESS_NAMES[working.turn.harness]} está {workingAt ? 'cambiando el paso' : 'trabajando'}</span>
            {workingAt && (
              <button
                type="button" className="chip chip--agent"
                aria-label={`Ir al paso ${workingAt.stepNumber} de la escena ${workingAt.sceneNumber}`} title={`Escena ${workingAt.sceneNumber}, paso ${workingAt.stepNumber}`}
                onClick={() => navigate({ projectId: openProject.id, view: 'lienzo', sceneId: workingAt.sceneId, stepId: working.step!.stepId })}
              >{workingAt.stepNumber}</button>
            )}
            <button type="button" className="btn btn--bare" onClick={() => void agentStore.stop(openProject.id)}>
              <Square className="i" aria-hidden="true" />Detener
            </button>
          </div>
        ) : undefined}
        agentToggle={storyboard && narrow ? (
          <button type="button" className="btn agent-toggle glass" aria-expanded={agentOpen} aria-controls="agent-panel" onClick={() => setAgentOpen(!agentOpen)}>
            <Sparkles className="i" aria-hidden="true" />Agente
          </button>
        ) : undefined}
        presentar={lienzo ? <PresentButton
          key={openProject!.id} api={api} store={steps} subscribeEvents={store.subscribeEvents} projectId={openProject!.id}
          scene={scenes?.find((item) => item.document.id === sceneId)?.document} stepId={route.stepId}
          onShowStep={(id, stepId) => navigate({ projectId: openProject!.id, view: 'lienzo', sceneId: id, stepId })}
        /> : undefined}
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
        <Lienzo key={row.id} api={api} store={steps} actions={actions} projectId={row.id} projectName={row.project.name} scenes={scenes} structureRevision={row.revision} refreshScenes={refreshScenes} route={route} navigate={navigate} stepAgentStates={marks} />
      </Suspense> : row?.kind === 'ok' ? (
        <>
          <Storyboard key={row.id} api={api} projectId={row.id} projectName={row.project.name} listedSize={formatSize(row.scenes, row.steps)} events={store.subscribeEvents} thumbnails={thumbnails} route={route} navigate={navigate} stepAgentStates={marks} />
          <AgentPanel
            store={agentStore} projectId={row.id} projectName={row.project.name} scenes={sceneDocuments} routeSceneId={route.sceneId}
            narrow={narrow} open={agentOpen} onClose={() => { setAgentOpen(false); document.querySelector<HTMLElement>('.agent-toggle')?.focus(); }}
            onOpenStep={(id, stepId) => navigate({ projectId: row.id, view: 'lienzo', sceneId: id, stepId })}
          />
        </>
      ) : <MainView state={state} row={row} requestedId={route.projectId} onCreate={startCreating} onRetry={() => store.retry()} />}
    </div>
  );
}
