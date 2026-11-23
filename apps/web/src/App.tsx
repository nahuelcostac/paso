import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LOOSE_PROJECT_ID, isLooseProject } from '@paso/shared';
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
import { AgentWorking } from './components/AgentWorking';
import { BOARD_MIN, Splitter, useAgentWidth, useProjectsWidth } from './components/Splitter';
import { ActivityBar, type SidePanel } from './components/ActivityBar';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { createCanvasMenu } from './editor/canvas-menu';
import { PresentButton } from './present/PresentButton';
import { useScenes } from './state/scenes';
import { ActionError, ProjectsStore, useProjects, type ProjectRow } from './state/projects-store';
import { AgentStore, HARNESS_NAMES, activeTurn, stepMarks, useAgent } from './state/agent-store';
import { formatSize } from './lib/format';
import { shownFilter, showsUnder } from './lib/project-filter';
import { stepCount } from './components/LooseRow';

const Canvas = lazy(() => import('./editor/Canvas'));

/** Below this the canvas would not fit beside a panel: the left spot's panel opens over the content, as a drawer. */
const NARROW = '(max-width: 1063px)';

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

const SIDE_KEY = 'paso.side-panel';
/** The panel left open in the left spot, remembered in this browser (and in the desktop app, whose origin stays). */
function storedSide(): SidePanel | null {
  try {
    const value = window.localStorage.getItem(SIDE_KEY);
    return value === 'agent' ? 'agent' : value === 'none' ? null : 'projects';
  } catch { return 'projects'; }
}

/**
 * Which panel has the left spot, as in VS Code: projects, the agent's chat, or neither. A choice made with room to dock
 * is remembered; on a narrow window the panel is a drawer, closed at first, and opening it is for the moment only.
 * Crossing the threshold closes the drawer, or brings back the remembered panel.
 */
function useSidePanel(narrow: boolean) {
  const [side, setSide] = useState<SidePanel | null>(() => narrow ? null : storedSide());
  const crossed = useRef(narrow);
  useEffect(() => {
    if (crossed.current === narrow) return;
    crossed.current = narrow;
    setSide(narrow ? null : storedSide());
  }, [narrow]);
  const choose = useCallback((next: SidePanel | null) => {
    setSide(next);
    if (window.matchMedia(NARROW).matches) return;
    try { window.localStorage.setItem(SIDE_KEY, next ?? 'none'); } catch { /* a convenience: it just won't be remembered */ }
  }, []);
  return [side, choose] as const;
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
  const [creating, setCreating] = useState(false);
  // Under this the panel in the left spot opens over the content, as a drawer.
  const narrow = useMediaQuery(NARROW);
  const [side, chooseSide] = useSidePanel(narrow);
  const boardMin = BOARD_MIN.storyboard;
  const overview = route.view === 'storyboard';
  // Each panel's width, which the person drags, remembered apart.
  const projectsWidth = useProjectsWidth(boardMin);
  const agentWidth = useAgentWidth(narrow, boardMin);
  // What Excalidraw's main menu held, in the activity bar's gear: it acts on the Canvas's drawing while one is shown.
  const canvasMenu = useMemo(createCanvasMenu, []);
  // Drafts belong to a diagram, not to an individual scene or a mounted panel.
  const [agentDrafts, setAgentDrafts] = useState<Record<string, string>>({});

  const routeRef = useRef(route);
  routeRef.current = route;
  // A loose diagram opens like a project with one scene: the reserved project, limited to that scene, under its name.
  const looseOpen = isLooseProject(route.projectId);
  const looseDiagram = looseOpen ? state.loose?.diagrams.find((diagram) => diagram.id === route.sceneId) : undefined;
  // A loose diagram with one step is a plain whiteboard: no step overview, no Present. Its agent sits beside the Canvas.
  const plainLoose = Boolean(looseDiagram && looseDiagram.steps <= 1);
  const looseRow = useMemo((): ProjectRow | undefined => state.loose && looseDiagram ? {
    kind: 'ok', id: LOOSE_PROJECT_ID, project: { ...state.loose.project, name: looseDiagram.scene.name },
    revision: state.loose.revision, scenes: 1, steps: looseDiagram.steps, sceneList: [looseDiagram.scene],
  } : undefined, [state.loose, looseDiagram]);
  const row = looseOpen ? looseRow : state.rows.find((candidate) => candidate.id === route.projectId);
  const openProject = row?.kind === 'ok' ? row : undefined;
  const { scenes: projectScenes, refresh: refreshProjectScenes } = useScenes(api, openProject?.id ?? null, openProject?.revision);
  const onlySceneId = looseOpen ? looseDiagram?.id : undefined;
  // A loose diagram just created may not be in the scene list read so far: until it is, its scenes are still loading,
  // so the Canvas does not mistake it for a missing scene and send the route elsewhere.
  const scenes = useMemo(() => {
    if (!onlySceneId) return projectScenes;
    const only = projectScenes?.filter((item) => item.document.id === onlySceneId);
    return only?.length ? only : undefined;
  }, [projectScenes, onlySceneId]);
  const refreshScenes = useCallback(async () => {
    const listed = await refreshProjectScenes();
    return onlySceneId ? listed.filter((item) => item.document.id === onlySceneId) : listed;
  }, [refreshProjectScenes, onlySceneId]);
  const onCanvas = route.view === 'canvas' && openProject !== undefined;
  const sceneId = scenes?.find((item) => item.document.id === route.sceneId)?.document.id;
  const [creatingScene, setCreatingScene] = useState(false);
  const [sceneError, setSceneError] = useState<string>();
  /** A workspace that couldn't be opened, added or removed, from the activity bar's switcher. */
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);
  /** The project the sidebar acts on: the open one, or another expanded there. */
  const isOpen = (projectId: string) => openProject?.id === projectId;
  const scenesOf = async (projectId: string) => {
    if (isOpen(projectId)) return (await refreshScenes()).map((item) => item.document);
    await store.refresh(projectId);
    const listed = store.getState().rows.find((candidate) => candidate.id === projectId);
    return listed?.kind === 'ok' ? listed.sceneList : [];
  };
  const createScene = async (projectId: string) => {
    setCreatingScene(true); setSceneError(undefined);
    try {
      const listed = store.getState().rows.find((candidate) => candidate.id === projectId);
      const count = isOpen(projectId) ? scenes?.length ?? 0 : listed?.kind === 'ok' ? listed.scenes : 0;
      const created = await actions.createScene(projectId, `Scene ${count + 1}`);
      await scenesOf(projectId);
      navigate({ projectId, view: 'canvas', ...created });
    } catch (error) { setSceneError(error instanceof Error ? error.message : "Couldn't create the scene."); }
    finally { setCreatingScene(false); }
  };
  /** Scene changes from the scene selector. Each reads the fresh revision first and saves the open step before it. */
  const sceneFailure = (error: unknown): never => {
    if (error instanceof UnavailableError) throw new Error('No connection to the local service.');
    if (error instanceof ApiRequestError && (error.status === 409 || error.status === 428)) throw new Error("The scene changed outside Paso. It's up to date now: try again.");
    if (error instanceof ApiRequestError && error.status === 404) throw new Error('The scene no longer exists.');
    throw new Error('Try again.');
  };
  const renameScene = async (projectId: string, id: string, name: string) => {
    try { const fresh = await api.getScene(projectId, id); await api.renameScene(projectId, id, fresh.revision, name); }
    catch (error) { await scenesOf(projectId); sceneFailure(error); }
    await scenesOf(projectId);
  };
  /** A scene dropped above or below another of its project. It is placed by its neighbour, so a change made meanwhile elsewhere is kept. */
  const reorderScene = async (projectId: string, id: string, besideId: string, place: 'before' | 'after') => {
    try {
      const fresh = await api.getProject(projectId);
      const ids = fresh.document.sceneIds.filter((candidate) => candidate !== id);
      const beside = ids.indexOf(besideId);
      if (beside < 0 || !fresh.document.sceneIds.includes(id)) throw new ApiRequestError(404, 'NOT_FOUND', 'gone');
      ids.splice(beside + (place === 'after' ? 1 : 0), 0, id);
      if (ids.every((candidate, at) => candidate === fresh.document.sceneIds[at])) return;
      await api.reorderScenes(projectId, fresh.revision, ids);
    } catch (error) { await scenesOf(projectId); sceneFailure(error); }
    await scenesOf(projectId);
  };
  const deleteScene = async (projectId: string, id: string) => {
    const listed = store.getState().rows.find((candidate) => candidate.id === projectId);
    const order = isOpen(projectId) ? scenes?.map((item) => item.document.id) ?? [] : listed?.kind === 'ok' ? listed.sceneList.map((scene) => scene.id) : [];
    const at = order.indexOf(id);
    // The scene on screen goes: its neighbour opens, the next one or else the one before.
    const next = order[at + 1] ?? order[at - 1];
    try {
      await steps.flushAll();
      const fresh = await api.getScene(projectId, id);
      await api.deleteScene(projectId, id, fresh.revision);
    } catch (error) { await scenesOf(projectId); sceneFailure(error); }
    await scenesOf(projectId);
    // Another scene than the open one: the person stays where they are.
    if (isOpen(projectId) && id === route.sceneId) navigate({ projectId, view: 'canvas', ...(next ? { sceneId: next } : {}) }, { replace: true });
  };

  // Where each diagram was left, so opening it again lands on the same step. Kept in this browser only.
  const lastPlace = useRef<Record<string, { sceneId: string; stepId?: string }>>((() => {
    try { return JSON.parse(window.localStorage.getItem('paso.last-place') ?? '{}') as Record<string, { sceneId: string; stepId?: string }>; }
    catch { return {}; }
  })());
  // A loose diagram is remembered on its own, as each is a diagram of its own.
  const placeKey = (projectId: string, sceneId?: string) => isLooseProject(projectId) ? `${projectId}/${sceneId}` : projectId;
  useEffect(() => {
    if (route.view !== 'canvas' || !route.projectId || !route.sceneId) return;
    lastPlace.current[placeKey(route.projectId, route.sceneId)] = { sceneId: route.sceneId, ...(route.stepId ? { stepId: route.stepId } : {}) };
    try { window.localStorage.setItem('paso.last-place', JSON.stringify(lastPlace.current)); } catch { /* a convenience only */ }
  }, [route]);
  const openDiagram = (id: string) => navigate({ projectId: id, view: 'canvas', ...lastPlace.current[id] });
  const openLoose = (id: string, replace = false) => {
    const last = lastPlace.current[placeKey(LOOSE_PROJECT_ID, id)];
    navigate({ projectId: LOOSE_PROJECT_ID, view: 'canvas', sceneId: id, ...(last?.sceneId === id && last.stepId ? { stepId: last.stepId } : {}) }, { replace });
  };
  /** “New diagram”: a loose diagram with one empty step, open on the board. */
  const createLoose = async (name: string) => {
    let created: { sceneId: string; stepId: string };
    try { created = await actions.createScene(LOOSE_PROJECT_ID, name); }
    catch (error) { throw new ActionError(error instanceof Error ? error.message : 'Try again.'); }
    await store.addedLoose();
    navigate({ projectId: LOOSE_PROJECT_ID, view: 'canvas', ...created });
    closeDrawer();
  };
  /** Steps of a loose diagram with work that is not on the service. Such a diagram is not moved. */
  const unsavedIn = (projectId: string, sceneId: string) => steps.unresolved().some(({ target }) => target.projectId === projectId && target.sceneId === sceneId);
  /**
   * Moves a loose diagram into a project. The open step is saved first; one that cannot be saved blocks the move.
   * The service keeps the files, so the step on screen opens again at its new place with the same revision.
   */
  /**
   * Moves a scene into another project, last or at `index`, or out into the loose diagrams. Its unsaved edits are saved first, and
   * if one cannot be, nothing moves. The scene on screen is followed to where it went.
   */
  const transferScene = async (sourceId: string, sceneId: string, targetId: string, index?: number) => {
    await steps.flushAll();
    if (unsavedIn(sourceId, sceneId)) throw new ActionError('It has unsaved changes: resolve them and try again.');
    // Where the person was before the move: once the scene leaves, the board may already have stepped away from it.
    const here = routeRef.current;
    await store.moveScene(sourceId, sceneId, targetId, index);
    if (here.projectId === sourceId && here.sceneId === sceneId) {
      navigate({ projectId: targetId, view: here.view, sceneId, ...(here.stepId ? { stepId: here.stepId } : {}) }, { replace: true });
    }
  };
  const deleteLoose = async (id: string) => {
    await steps.flushAll();
    await store.removeLoose(id);
    const here = routeRef.current;
    if (isLooseProject(here.projectId) && here.sceneId === id) {
      const next = store.getState().rows.find((candidate) => candidate.kind === 'ok');
      navigate({ projectId: next?.id ?? null, view: 'canvas', ...(next ? lastPlace.current[next.id] : {}) }, { replace: true });
    }
  };

  // Local work that is not on the service: a failed save or a conflict. The step on screen has its own notice in the Canvas.
  const showing = onCanvas && route.sceneId && route.stepId ? targetKey({ projectId: route.projectId!, sceneId: route.sceneId, stepId: route.stepId }) : undefined;
  const failedStep = steps.unresolved().find((session) => targetKey(session.target) !== showing);

  // The sidebar's project filter of the open workspace, kept by the service.
  const workspace = state.workspaces?.workspaces.find((candidate) => candidate.id === state.workspaces?.activeId);
  const filter = shownFilter(workspace?.filter, state.rows, state.phase);

  // No project in the address: open the first one that can be opened, among what the sidebar's filter shows.
  useEffect(() => {
    if (state.phase !== 'ready' || route.projectId) return;
    const loose = state.loose?.diagrams[0];
    if (isLooseProject(filter) && loose) { openLoose(loose.id, true); return; }
    const opens = state.rows.filter((candidate) => candidate.kind === 'ok');
    const first = opens.find((candidate) => candidate.id === filter) ?? opens[0];
    if (first) navigate({ projectId: first.id, view: 'canvas', ...lastPlace.current[first.id] }, { replace: true });
    else if (loose) openLoose(loose.id, true);
  }, [state.phase, state.rows, state.loose, route, navigate, filter]);

  // As in T3 Code, opening something the filter hides (a new project, a scene followed into another project) shows
  // “All projects” again, so the open item is always in the list. A filter whose project is gone is forgotten.
  const filterState = useRef({ stored: workspace?.filter, activeId: state.workspaces?.activeId });
  filterState.current = { stored: workspace?.filter, activeId: state.workspaces?.activeId };
  useEffect(() => {
    const { stored, activeId } = filterState.current;
    if (route.projectId && stored && activeId && !showsUnder(stored, route.projectId)) void store.setFilter(activeId, null);
  }, [route.projectId, store]);
  useEffect(() => {
    if (workspace?.filter && filter === null && state.connected && state.workspaces) void store.setFilter(state.workspaces.activeId, null);
  }, [workspace?.filter, filter, state.connected, state.workspaces, store]);

  useEffect(() => {
    document.title = row?.kind === 'ok' ? `${row.project.name} · Paso` : 'Paso';
  }, [row]);

  const startCreating = () => { chooseSide('projects'); setCreating(true); };

  // Another workspace was opened, here or in another window: its first project opens, as on a fresh start.
  const workspaceId = state.workspaces?.activeId;
  const lastWorkspace = useRef(workspaceId);
  useEffect(() => {
    const previous = lastWorkspace.current;
    lastWorkspace.current = workspaceId;
    if (previous && workspaceId && previous !== workspaceId) { setCreating(false); navigate({ projectId: null, view: 'canvas' }); }
  }, [workspaceId, navigate]);
  /** Saves the open step before another workspace replaces its project. */
  const switchWorkspace = async (open: () => Promise<void>) => { await steps.flushAll(); await open(); };
  /** “New project” is ready to draw on: it gets its first scene, with one empty step, and opens on the board. */
  const diagramCreated = async (id: string) => {
    try {
      const created = await actions.createScene(id, 'Scene 1');
      navigate({ projectId: id, view: 'canvas', ...created });
    } catch {
      navigate({ projectId: id, view: 'canvas' });
      setSceneError('The project was created, but not its first scene. Add one from its scene list.');
    }
  };

  // Where the agent sits: beside the Studio, or beside the Canvas of a plain loose diagram, which has no Studio. Both
  // take the left spot, one at a time; on a project's Canvas the chat is not there, and the spot shows nothing for it.
  const chatHere = overview || plainLoose;
  const shown = side === 'agent' && !(openProject && chatHere) ? null : side;
  const docked = narrow ? null : shown;
  const left = docked === 'projects' ? projectsWidth.width : docked === 'agent' ? agentWidth.width : 0;
  /** A drawer steps aside once something is chosen in it. Docked, the panel stays. */
  const closeDrawer = () => { if (window.matchMedia(NARROW).matches) chooseSide(null); };
  useEffect(() => {
    if (plainLoose && overview) navigate({ ...routeRef.current, view: 'canvas' }, { replace: true });
  }, [plainLoose, overview, navigate]);
  // The agent's marks on steps and its notice in the top bar follow the open project in both views.
  useEffect(() => { if (openProject) void agentStore.openProject(openProject.id); }, [agentStore, openProject?.id]);
  const sceneDocuments = useMemo(() => scenes?.map((item) => item.document) ?? [], [scenes]);
  const marks = useMemo(() => stepMarks(agentState.turns, agentState.runs[openProject?.id ?? ''], openProject?.id), [agentState.turns, agentState.runs, openProject?.id]);
  const working = useMemo(() => activeTurn(agentState.turns, openProject?.id), [agentState.turns, openProject?.id]);
  // Without the panel in view, a pill says who is changing which step, and the Studio button has a dot.
  const statusShown = Boolean(openProject && chatHere && working && shown !== 'agent');
  const workingAt = working?.step && sceneDocuments.length ? (() => {
    for (const [index, scene] of sceneDocuments.entries()) {
      const at = scene.stepIds.indexOf(working.step!.stepId);
      if (at >= 0) return { sceneId: scene.id, sceneNumber: index + 1, stepNumber: at + 1 };
    }
    return undefined;
  })() : undefined;

  // Failures with no place of their own. They sit in the sidebar, or above the step strip while it is folded.
  const notices = failedStep || sceneError || workspaceNotice ? <>
    {failedStep && <div className="notice notice--error" role="alert">
      <span>A step in another scene couldn't be saved.</span>
      <button type="button" className="notice__action" onClick={() => navigate({ ...failedStep.target, view: 'canvas' })}>Review unsaved step</button>
    </div>}
    {workspaceNotice && <div className="notice notice--error" role="alert">
      <span>{workspaceNotice}</span>
      <button type="button" className="icon-btn" aria-label="Dismiss notice" onClick={() => setWorkspaceNotice(null)}>×</button>
    </div>}
    {sceneError && <div className="notice notice--error" role="alert">
      <span>{sceneError}</span>
      <button type="button" className="icon-btn" aria-label="Dismiss notice" onClick={() => setSceneError(undefined)}>×</button>
    </div>}
  </> : undefined;
  const hideAgent = () => {
    chooseSide(null);
    // Focus goes back to the button that opened it.
    document.querySelector<HTMLElement>('.activity-bar__button[data-id="studio"]')?.focus();
  };
  const toggleStudio = () => {
    if (plainLoose) {
      chooseSide(shown === 'agent' ? null : 'agent');
      return;
    }
    if (overview && shown === 'agent') {
      navigate({ ...routeRef.current, view: 'canvas' });
      return;
    }
    chooseSide('agent');
    if (!overview) navigate({ ...routeRef.current, view: 'storyboard' });
  };

  // Present, in the top right corner of both views. Leaving it keeps the view.
  const presentButton = row?.kind === 'ok' ? <PresentButton
    key={`${row.id}/${onlySceneId ?? ''}`} api={api} store={steps} subscribeEvents={store.subscribeEvents} projectId={row.id}
    scene={scenes?.find((item) => item.document.id === sceneId)?.document} stepId={route.stepId}
    onShowStep={(id, stepId) => navigate({ projectId: row.id, view: route.view, sceneId: id, stepId })}
  /> : null;

  return (
    <div
      className={`app app--${shown ?? 'folded'}${narrow ? ' app--narrow' : ''}`}
      style={{ '--left': `${left}px`, '--panel-projects': `${projectsWidth.width}px`, '--panel-agent': `${agentWidth.width}px` } as React.CSSProperties}
    >
      <ActivityBar
        panel={shown} onProjects={() => chooseSide(shown === 'projects' ? null : 'projects')}
        working={Boolean(openProject && working && shown !== 'agent')}
        studio={openProject ? (plainLoose ? 'whiteboard' : overview ? 'overview' : 'canvas') : undefined}
        onStudio={toggleStudio}
        canvasMenu={canvasMenu}
        workspace={(stop) => <WorkspaceSwitcher api={api} store={store} state={state} onSwitchWorkspace={switchWorkspace} onNotice={setWorkspaceNotice} {...stop} />}
      />
      <div className="shell">
        {/* The docked panel's inner edge: a drag changes its width, and dragging it well past the narrowest folds it. */}
        {docked && <Splitter
          key={docked} side="left" open onToggle={() => chooseSide(null)}
          hide={docked === 'projects' ? 'Hide projects' : 'Hide agent'} show={docked === 'projects' ? 'Show projects' : 'Show agent'}
          controls={docked === 'projects' ? 'projects-panel' : 'agent-panel'} label={docked === 'projects' ? 'Sidebar width' : 'Chat width'}
          resize={docked === 'projects' ? projectsWidth : agentWidth} tab={false}
        />}
        {openProject && statusShown && working && <AgentWorking
          working={{
            sentence: `${HARNESS_NAMES[working.turn.harness]} is ${workingAt ? 'changing a step' : 'working'}`,
            step: workingAt ? {
              label: `Go to step ${workingAt.stepNumber} of scene ${workingAt.sceneNumber}`, number: workingAt.stepNumber,
              onOpen: () => navigate({ projectId: openProject.id, view: 'canvas', sceneId: workingAt.sceneId, stepId: working.step!.stepId }),
            } : undefined,
            onStop: () => void agentStore.stop(openProject.id),
          }}
        />}
        {shown === 'projects' && (
          // On a narrow window the projects open over the content, and a press beside them closes them.
          <div className="projects-scrim" aria-hidden="true" onPointerDown={() => chooseSide(null)} />
        )}
        {shown === 'projects' && (
          <ProjectsPanel
            store={store}
            notices={notices}
            // Under each expanded project: its scenes. The open one shows them as the board reads them, the others as listed.
            sceneList={(projectRow, transfer) => {
              const open = isOpen(projectRow.id);
              if (open && !scenes) return null;
              const listed = open ? sceneDocuments : projectRow.sceneList;
              return <SceneList
                diagram={projectRow.project.name} scenes={listed} currentId={open ? sceneId : undefined} busy={creatingScene}
                // In the overview a scene is selected where it is, for the chat; on the board it opens.
                onSelect={(id) => {
                  navigate({ projectId: projectRow.id, view: open ? route.view : 'canvas', sceneId: id, stepId: listed.find((scene) => scene.id === id)?.stepIds[0] });
                  if (!open) closeDrawer();
                }}
                onCreate={() => void createScene(projectRow.id)}
                onRename={(id, name) => renameScene(projectRow.id, id, name)}
                onDelete={(id) => deleteScene(projectRow.id, id)}
                transfer={transfer}
              />;
            }}
            state={state}
            looseCurrentId={looseOpen ? route.sceneId ?? null : null}
            onOpenLoose={(id) => {
              openLoose(id);
              closeDrawer();
            }}
            onCreateLoose={createLoose}
            onMoveScene={transferScene}
            onReorderScene={reorderScene}
            onDeleteLoose={deleteLoose}
            currentId={route.projectId}
            creating={creating}
            onCreatingChange={setCreating}
            onCreated={diagramCreated}
            onOpen={(id) => {
              openDiagram(id);
              // Over the content on a narrow window: it steps aside once a project is chosen.
              closeDrawer();
            }}
            onDeleted={(id) => {
              if (id !== route.projectId) return;
              const next = store.getState().rows.find((candidate) => candidate.kind === 'ok');
              navigate({ projectId: next?.id ?? null, view: 'canvas', ...(next ? lastPlace.current[next.id] : {}) }, { replace: true });
            }}
          />
        )}
        {row?.kind === 'ok' ? <>
          {/* The main view, flush with the window's edges, meeting the black in a straight edge. */}
          <div className="main">{route.view === 'canvas' ? <Suspense fallback={<main className="main-message" aria-label="Canvas">Loading…</main>}>
            <Canvas
              key={row.id} api={api} store={steps} actions={actions} projectId={row.id} projectName={row.project.name} scenes={scenes} structureRevision={row.revision} refreshScenes={refreshScenes} route={route} navigate={navigate} stepAgentStates={marks}
              notices={shown === 'projects' ? undefined : notices}
              corner={presentButton} subscribeEvents={store.subscribeEvents} loose={looseOpen} menu={canvasMenu}
            />
          </Suspense> : <Storyboard key={row.id} api={api} projectId={row.id} projectName={row.project.name} onlySceneId={onlySceneId} listedSize={onlySceneId ? stepCount(row.steps) : formatSize(row.scenes, row.steps)} events={store.subscribeEvents} thumbnails={thumbnails} route={route} navigate={navigate} stepAgentStates={marks} notices={shown === 'projects' ? undefined : notices} corner={presentButton} renameStep={(target, title) => steps.retitleStep(target, title)} />}</div>
          {/* The agent sits in the left spot beside the overview, where its changes show across the scenes. As a drawer it
              stays mounted, closed. */}
          {chatHere && (narrow || shown === 'agent') && <AgentPanel
            store={agentStore} projectId={row.id} projectName={row.project.name} scenes={sceneDocuments} routeSceneId={route.sceneId}
            input={agentDrafts[JSON.stringify([row.id, onlySceneId ?? null])] ?? ''}
            setInput={(value) => {
              const key = JSON.stringify([row.id, onlySceneId ?? null]);
              setAgentDrafts((drafts) => ({ ...drafts, [key]: typeof value === 'function' ? value(drafts[key] ?? '') : value }));
            }}
            narrow={narrow} open={shown === 'agent'} onClose={hideAgent}
            onOpenStep={(id, stepId) => navigate({ projectId: row.id, view: 'canvas', sceneId: id, stepId })}
            scenesReady={scenes !== undefined}
            onOpenScene={(id) => navigate({ projectId: row.id, view: 'storyboard', sceneId: id, stepId: scenes?.find((item) => item.document.id === id)?.document.stepIds[0] })}
          />}
        </> : <div className="main"><MainView state={state} row={row} requestedId={route.projectId} onCreate={startCreating} onRetry={() => store.retry()} /></div>}
      </div>
    </div>
  );
}
