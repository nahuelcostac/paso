import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiRequestError, UnavailableError } from './lib/api';
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
import { SceneList } from './components/SceneList';
import { LeftRail, RightRail } from './components/Rails';
import { AGENT_WIDTH, BOARD_MIN, PanelResizer, chatRoom, useAgentWidth } from './components/PanelResizer';
import { PresentButton } from './present/PresentButton';
import { useScenes } from './state/scenes';
import { ProjectsStore, useProjects } from './state/projects-store';
import { AgentStore, HARNESS_NAMES, activeTurn, stepMarks, useAgent } from './state/agent-store';
import { formatSize } from './lib/format';

const Lienzo = lazy(() => import('./editor/Lienzo'));

/** Below this the canvas would not fit beside the panel. */
const NARROW = '(max-width: 1063px)';

function useWindowWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const sync = () => setWidth(window.innerWidth);
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);
  return width;
}

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
  // Under this the sidebar opens over the content, and its folded column stays in place.
  const leftNarrow = useMediaQuery(NARROW);
  // The chat lives in the overview, beside the scenes it changes. It docks while the cards keep their minimum;
  // otherwise it folds into its rail and opens as a drawer. The board has the whole width to itself.
  const boardMin = BOARD_MIN.storyboard;
  const overview = route.view === 'storyboard';
  const narrow = chatRoom(useWindowWidth(), panelOpen && !leftNarrow, boardMin) < AGENT_WIDTH.min;
  // The agent panel: a drawer on a narrow window, otherwise a column the person can hide.
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentDocked, setAgentDocked] = useState(true);
  const agentShown = narrow ? agentOpen : agentDocked;
  const agentWidth = useAgentWidth(panelOpen && !leftNarrow, narrow, boardMin);

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
  /** Scene changes from the scene selector. Each reads the fresh revision first and saves the open step before it. */
  const sceneFailure = (error: unknown): never => {
    if (error instanceof UnavailableError) throw new Error('No hay conexión con el servicio local.');
    if (error instanceof ApiRequestError && (error.status === 409 || error.status === 428)) throw new Error('La escena cambió fuera de Paso. Ya está actualizada: inténtalo de nuevo.');
    if (error instanceof ApiRequestError && error.status === 404) throw new Error('La escena ya no existe.');
    throw new Error('Inténtalo de nuevo.');
  };
  const renameScene = async (id: string, name: string) => {
    if (!openProject) return;
    try { const fresh = await api.getScene(openProject.id, id); await api.renameScene(openProject.id, id, fresh.revision, name); }
    catch (error) { await refreshScenes(); sceneFailure(error); }
    await refreshScenes();
  };
  const moveScene = async (id: string, delta: -1 | 1) => {
    if (!openProject) return;
    try {
      const fresh = await api.getProject(openProject.id);
      const ids = [...fresh.document.sceneIds];
      const at = ids.indexOf(id);
      if (at < 0 || at + delta < 0 || at + delta >= ids.length) return;
      [ids[at], ids[at + delta]] = [ids[at + delta], ids[at]];
      await api.reorderScenes(openProject.id, fresh.revision, ids);
    } catch (error) { await refreshScenes(); sceneFailure(error); }
    await refreshScenes();
  };
  const deleteScene = async (id: string) => {
    if (!openProject) return;
    const order = scenes?.map((item) => item.document.id) ?? [];
    const at = order.indexOf(id);
    // The scene on screen goes: its neighbour opens, the next one or else the one before.
    const next = order[at + 1] ?? order[at - 1];
    try {
      await steps.flushAll();
      const fresh = await api.getScene(openProject.id, id);
      await api.deleteScene(openProject.id, id, fresh.revision);
    } catch (error) { await refreshScenes(); sceneFailure(error); }
    await refreshScenes();
    // Another scene than the open one: the person stays where they are.
    if (id === route.sceneId) navigate({ projectId: openProject.id, view: 'lienzo', ...(next ? { sceneId: next } : {}) }, { replace: true });
  };

  // Where each diagram was left, so opening it again lands on the same step. Kept in this browser only.
  const lastPlace = useRef<Record<string, { sceneId: string; stepId?: string }>>((() => {
    try { return JSON.parse(window.localStorage.getItem('paso.last-place') ?? '{}') as Record<string, { sceneId: string; stepId?: string }>; }
    catch { return {}; }
  })());
  useEffect(() => {
    if (route.view !== 'lienzo' || !route.projectId || !route.sceneId) return;
    lastPlace.current[route.projectId] = { sceneId: route.sceneId, ...(route.stepId ? { stepId: route.stepId } : {}) };
    try { window.localStorage.setItem('paso.last-place', JSON.stringify(lastPlace.current)); } catch { /* a convenience only */ }
  }, [route]);
  const openDiagram = (id: string) => navigate({ projectId: id, view: 'lienzo', ...lastPlace.current[id] });

  // Local work that is not on the service: a failed save or a conflict. The step on screen has its own notice in the Lienzo.
  const showing = lienzo && route.sceneId && route.stepId ? targetKey({ projectId: route.projectId!, sceneId: route.sceneId, stepId: route.stepId }) : undefined;
  const failedStep = steps.unresolved().find((session) => targetKey(session.target) !== showing);
  const here = steps.current();
  const saveState = lienzo && here && targetKey(here.target) === showing ? here.status : undefined;

  // No project in the address: open the first one that can be opened.
  useEffect(() => {
    if (state.phase !== 'ready' || route.projectId) return;
    const first = state.rows.find((candidate) => candidate.kind === 'ok');
    if (first) navigate({ projectId: first.id, view: 'lienzo', ...lastPlace.current[first.id] }, { replace: true });
  }, [state.phase, state.rows, route, navigate]);

  useEffect(() => {
    document.title = row?.kind === 'ok' ? `${row.project.name} · Paso` : 'Paso';
  }, [row]);

  const startCreating = () => { setPanelOpen(true); setCreating(true); };

  // Another workspace was opened, here or in another window: its first project opens, as on a fresh start.
  const workspaceId = state.workspaces?.activeId;
  const lastWorkspace = useRef(workspaceId);
  useEffect(() => {
    const previous = lastWorkspace.current;
    lastWorkspace.current = workspaceId;
    if (previous && workspaceId && previous !== workspaceId) { setCreating(false); navigate({ projectId: null, view: 'lienzo' }); }
  }, [workspaceId, navigate]);
  /** Saves the open step before another workspace replaces its project. */
  const switchWorkspace = async (open: () => Promise<void>) => { await steps.flushAll(); await open(); };
  /** «Nuevo proyecto» is ready to draw on: it gets its first scene, with one empty step, and opens on the board. */
  const diagramCreated = async (id: string) => {
    try {
      const created = await actions.createScene(id, 'Escena 1');
      navigate({ projectId: id, view: 'lienzo', ...created });
    } catch {
      navigate({ projectId: id, view: 'lienzo' });
      setSceneError('El diagrama se creó, pero no su primera escena. Créala con el selector de escenas.');
    }
  };

  // The agent's marks on steps and its notice in the top bar follow the open project in both views.
  useEffect(() => { if (openProject) void agentStore.openProject(openProject.id); }, [agentStore, openProject?.id]);
  const sceneDocuments = useMemo(() => scenes?.map((item) => item.document) ?? [], [scenes]);
  const marks = useMemo(() => stepMarks(agentState.turns, agentState.runs[openProject?.id ?? ''], openProject?.id), [agentState.turns, agentState.runs, openProject?.id]);
  const working = useMemo(() => activeTurn(agentState.turns, openProject?.id), [agentState.turns, openProject?.id]);
  // Without the panel in view, the top bar says who is changing which step.
  const statusShown = Boolean(openProject && overview && working && !agentShown);
  const workingAt = working?.step && sceneDocuments.length ? (() => {
    for (const [index, scene] of sceneDocuments.entries()) {
      const at = scene.stepIds.indexOf(working.step!.stepId);
      if (at >= 0) return { sceneId: scene.id, sceneNumber: index + 1, stepNumber: at + 1 };
    }
    return undefined;
  })() : undefined;

  // Failures with no place of their own. They sit in the sidebar, or above the step strip while it is folded.
  const notices = failedStep || sceneError ? <>
    {failedStep && <div className="notice notice--error" role="alert">
      <span>Un paso de otra escena no se pudo guardar.</span>
      <button type="button" className="notice__action" onClick={() => navigate({ ...failedStep.target, view: 'lienzo' })}>Revisar paso sin guardar</button>
    </div>}
    {sceneError && <div className="notice notice--error" role="alert">
      <span>{sceneError}</span>
      <button type="button" className="icon-btn" aria-label="Cerrar aviso" onClick={() => setSceneError(undefined)}>×</button>
    </div>}
  </> : undefined;
  // The agent folds into a narrow column on the right; on a narrow window that column stays, and the panel is a drawer.
  const rightRail = Boolean(openProject && overview && (narrow || !agentDocked));
  const hideAgent = () => {
    if (narrow) setAgentOpen(false); else setAgentDocked(false);
    // On a narrow window the rail is already there; a folded column appears with the next frame.
    const toggle = document.querySelector<HTMLElement>('.rail--right .agent-toggle');
    if (toggle) toggle.focus(); else requestAnimationFrame(() => document.querySelector<HTMLElement>('.rail--right .agent-toggle')?.focus());
  };

  // Presentar, in the top right corner of both views, above the Lienzo | Estudio switch. Leaving it keeps the view.
  const presentButton = row?.kind === 'ok' ? <PresentButton
    key={row.id} api={api} store={steps} subscribeEvents={store.subscribeEvents} projectId={row.id}
    scene={scenes?.find((item) => item.document.id === sceneId)?.document} stepId={route.stepId}
    onShowStep={(id, stepId) => navigate({ projectId: row.id, view: route.view, sceneId: id, stepId })}
  /> : null;

  return (
    <div
      className={`app${panelOpen ? '' : ' app--panel-closed'}${openProject && overview && agentDocked && !narrow ? ' app--agent' : ''}${rightRail ? ' app--agent-rail' : ''}`}
      style={{ '--panel-agent': `${agentWidth.width}px` } as React.CSSProperties}
    >
      {(!panelOpen || leftNarrow) && <LeftRail onShow={() => setPanelOpen(true)} onCreate={startCreating} />}
      {rightRail && openProject && <RightRail
        onShow={() => narrow ? setAgentOpen(!agentOpen) : setAgentDocked(true)} open={narrow && agentOpen}
        working={statusShown && working ? {
          sentence: `${HARNESS_NAMES[working.turn.harness]} está ${workingAt ? 'cambiando el paso' : 'trabajando'}`,
          step: workingAt ? {
            label: `Ir al paso ${workingAt.stepNumber} de la escena ${workingAt.sceneNumber}`, number: workingAt.stepNumber,
            onOpen: () => navigate({ projectId: openProject.id, view: 'lienzo', sceneId: workingAt.sceneId, stepId: working.step!.stepId }),
          } : undefined,
          onStop: () => void agentStore.stop(openProject.id),
        } : undefined}
      />}
      {panelOpen && (
        // On a narrow window the sidebar opens over the content, and a press beside it closes it.
        <div className="projects-scrim" aria-hidden="true" onPointerDown={() => setPanelOpen(false)} />
      )}
      {panelOpen && (
        <ProjectsPanel
          api={api}
          store={store}
          onSwitchWorkspace={switchWorkspace}
          onHide={() => setPanelOpen(false)}
          saveState={saveState}
          notices={notices}
          sceneList={openProject && scenes ? <SceneList
            diagram={openProject.project.name} scenes={sceneDocuments} currentId={sceneId} busy={creatingScene}
            // In the overview a scene is selected where it is, for the chat; on the board it opens.
            onSelect={(id) => navigate({ projectId: openProject.id, view: route.view, sceneId: id, stepId: scenes.find((item) => item.document.id === id)?.document.stepIds[0] })}
            onCreate={() => void createScene()}
            onRename={renameScene} onMove={moveScene} onDelete={deleteScene}
          /> : undefined}
          state={state}
          currentId={route.projectId}
          creating={creating}
          onCreatingChange={setCreating}
          onCreated={diagramCreated}
          onOpen={(id) => {
            openDiagram(id);
            // Over the content on a narrow window: it steps aside once a project is chosen.
            if (window.matchMedia(NARROW).matches) setPanelOpen(false);
          }}
          onDeleted={(id) => {
            if (id !== route.projectId) return;
            const next = store.getState().rows.find((candidate) => candidate.kind === 'ok');
            navigate({ projectId: next?.id ?? null, view: 'lienzo', ...(next ? lastPlace.current[next.id] : {}) }, { replace: true });
          }}
        />
      )}
      {row?.kind === 'ok' ? <>
        {route.view === 'lienzo' ? <Suspense fallback={<main className="main-message" aria-label="Lienzo">Cargando…</main>}>
          <Lienzo
            key={row.id} api={api} store={steps} actions={actions} projectId={row.id} projectName={row.project.name} scenes={scenes} structureRevision={row.revision} refreshScenes={refreshScenes} route={route} navigate={navigate} stepAgentStates={marks}
            notices={panelOpen ? undefined : notices}
            corner={presentButton}
          />
        </Suspense> : <Storyboard key={row.id} api={api} projectId={row.id} projectName={row.project.name} listedSize={formatSize(row.scenes, row.steps)} events={store.subscribeEvents} thumbnails={thumbnails} route={route} navigate={navigate} stepAgentStates={marks} notices={panelOpen ? undefined : notices} corner={presentButton} renameStep={(target, title) => steps.retitleStep(target, title)} />}
        {/* The agent sits beside the overview, where its changes show across the scenes. */}
        {overview && (narrow || agentDocked) && <AgentPanel
          store={agentStore} projectId={row.id} projectName={row.project.name} scenes={sceneDocuments} routeSceneId={route.sceneId}
          narrow={narrow} open={agentOpen} onClose={hideAgent}
          onOpenStep={(id, stepId) => navigate({ projectId: row.id, view: 'lienzo', sceneId: id, stepId })}
          scenesReady={scenes !== undefined}
          onOpenScene={(id) => navigate({ projectId: row.id, view: 'storyboard', sceneId: id, stepId: scenes?.find((item) => item.document.id === id)?.document.stepIds[0] })}
          resizer={<PanelResizer width={agentWidth.width} min={agentWidth.min} max={agentWidth.max} onChange={agentWidth.choose} controls="agent-panel" />}
        />}
      </> : <MainView state={state} row={row} requestedId={route.projectId} onCreate={startCreating} onRetry={() => store.retry()} />}
    </div>
  );
}
