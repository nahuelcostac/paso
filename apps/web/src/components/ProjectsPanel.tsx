import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isLooseProject, LOOSE_PROJECT_ID, type Scene } from '@paso/shared';
import { CloudOff, Folder, FolderPlus, Layers, Search, ServerOff, Shapes, SquarePen, TriangleAlert, X } from 'lucide-react';
import { describeContents, fold } from '../lib/format';
import { shownFilter, showsUnder } from '../lib/project-filter';
import { ActionError, type LooseDiagram, type ProjectRow as Row, type ProjectsStore, type StoreState } from '../state/projects-store';
import { Brand } from './Brand';
import { Dialog } from './Dialog';
import { IconPicker } from './IconPicker';
import { LooseRow, stepCount } from './LooseRow';
import { MoveDialog } from './MoveDialog';
import { NameField } from './NameField';
import { ProjectFilter } from './ProjectFilter';
import { ProjectRow } from './ProjectRow';
import { RowMenu } from './RowMenu';
import type { SceneTransfer } from './SceneList';

type Props = {
  store: ProjectsStore;
  state: StoreState;
  currentId: string | null;
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
  onOpen: (id: string) => void;
  /** A diagram was just created: the app gives it its first scene and opens it. */
  onCreated: (id: string) => Promise<void>;
  /** After a project is deleted: the app decides where to go. */
  onDeleted: (id: string) => void;
  /** A project's scenes, shown under its row while it is expanded. `transfer` lets each be moved elsewhere. */
  sceneList?: (row: Extract<Row, { kind: 'ok' }>, transfer: SceneTransfer) => ReactNode;
  /** The open step's save state, said in the footer. */
  /** Failures of the app that have no other place, such as a step elsewhere that could not be saved. */
  notices?: ReactNode;
  /** The loose diagram on screen, if one is. */
  looseCurrentId: string | null;
  onOpenLoose: (id: string) => void;
  /** “New diagram”: the app creates it with one empty step and opens it. Rejects with the words to show. */
  onCreateLoose: (name: string) => Promise<void>;
  /**
   * Moves a scene into another project, last or at `index` in its scene list: a loose diagram into a project, a scene
   * out into the loose diagrams (`LOOSE_PROJECT_ID`) or into another project. The app saves the open step first.
   * Rejects with the reason.
   */
  onMoveScene: (sourceId: string, sceneId: string, targetId: string, index?: number) => Promise<void>;
  /** Puts a scene above or below another scene of its own project. Rejects with the words to show. */
  onReorderScene: (projectId: string, sceneId: string, besideId: string, place: 'before' | 'after') => Promise<void>;
  /** Deletes a loose diagram, and leaves it if it is on screen. Rejects with the reason. */
  onDeleteLoose: (id: string) => Promise<void>;
};


const EXPANDED_KEY = 'paso.expanded-projects';
const readExpanded = () => {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set<string>(); }
};

/** What is being moved: a loose diagram, whose source is the reserved project, or a project's scene. */
type Moving = { source: string; id: string; name: string };
/** Where a drop would put it: a project, or the loose diagrams, and in a project's open list, above or below a scene. */
type Drop = { id: string; index?: number; sceneId?: string; place?: 'before' | 'after' };

const reasonText = (error: unknown) => error instanceof ActionError ? error.message : 'Try again.';

/**
 * The sidebar of the open workspace, with its projects and loose diagrams in alphabetical order.
 */
export function ProjectsPanel({ store, state, currentId, creating, onCreatingChange, onOpen, onCreated, onDeleted, sceneList, notices, looseCurrentId, onOpenLoose, onCreateLoose, onMoveScene, onReorderScene, onDeleteLoose }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [picker, setPicker] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [deleting, setDeleting] = useState<Extract<Row, { kind: 'ok' }> | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Null while the search row is a button; a string, even empty, while it is a field. */
  const [query, setQuery] = useState<string | null>(null);
  const [creatingLoose, setCreatingLoose] = useState(false);
  const [looseMenu, setLooseMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [renamingLooseId, setRenamingLooseId] = useState<string | null>(null);
  const [moving, setMoving] = useState<Moving | null>(null);
  const [deletingLoose, setDeletingLoose] = useState<LooseDiagram | null>(null);
  // Which projects show their scenes. A project opens expanded, and a press on its row folds or unfolds it; the others
  // stay as they were, so opening a loose diagram or another project folds nothing. Kept in this browser only.
  const [expanded, setExpanded] = useState(readExpanded);
  const setExpandedTo = (id: string, open: boolean) => setExpanded((current) => {
    if (current.has(id) === open) return current;
    const next = new Set(current);
    if (open) next.add(id); else next.delete(id);
    try { window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next])); } catch { /* a convenience only */ }
    return next;
  });
  useEffect(() => { if (currentId && !isLooseProject(currentId)) setExpandedTo(currentId, true); }, [currentId]);
  const searchButton = useRef<HTMLButtonElement>(null);
  const rowById = (id: string) => state.rows.find((row) => row.id === id);
  const named = (id: string) => { const row = rowById(id); return row?.kind === 'ok' ? row.project.name : id; };

  const listing = state.workspaces;
  const activeWorkspace = listing?.workspaces.find((workspace) => workspace.id === listing.activeId);

  const setIcon = async (id: string, icon: string) => {
    const name = named(id);
    setPicker(null);
    try { await store.update(id, { icon }); setNotice(null); }
    catch (error) { setNotice(`Couldn't change the icon of “${name}”. ${reasonText(error)}`); }
  };
  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true); setDeleteError(null);
    try {
      await store.remove(deleting.id);
      const id = deleting.id;
      setDeleting(null); setNotice(null);
      onDeleted(id);
    } catch (error) { setDeleteError(`Couldn't delete the project. ${reasonText(error)}`); }
    finally { setDeleteBusy(false); }
  };
  const closeDelete = () => { if (!deleteBusy) { setDeleting(null); setDeleteError(null); } };

  // Another workspace: its list starts without a search.
  useEffect(() => setQuery(null), [listing?.activeId]);

  const offline = !state.connected && state.phase === 'ready';
  const looseAll = state.loose?.diagrams ?? [];
  // What the list shows: one project, the loose diagrams, or everything; then search narrows it.
  const filter = shownFilter(activeWorkspace?.filter, state.rows, state.phase);
  const filterProjects = useMemo(() => state.rows.flatMap((row) => row.kind === 'ok' ? [{ id: row.id, name: row.project.name, icon: row.project.icon }] : []), [state.rows]);
  const terms = useMemo(() => fold(query ?? '').split(/\s+/).filter(Boolean), [query]);
  const visible = useMemo(() => state.rows.filter((row) => showsUnder(filter, row.id)
    && terms.every((term) => fold(row.kind === 'ok' ? row.project.name : row.id).includes(term))), [state.rows, terms, filter]);
  // Search finds loose diagrams by name too.
  const looseVisible = useMemo(() => !showsUnder(filter, LOOSE_PROJECT_ID) ? []
    : terms.length ? looseAll.filter((diagram) => terms.every((term) => fold(diagram.scene.name).includes(term))) : looseAll, [looseAll, terms, filter]);
  const looseById = (id: string) => looseAll.find((diagram) => diagram.id === id);
  const ok = visible.filter((row) => row.kind === 'ok');
  const broken = visible.filter((row) => row.kind === 'error');
  const showList = state.phase === 'ready' && (state.rows.length > 0 || looseAll.length > 0 || creating || creatingLoose);

  // Dragging a loose diagram onto a project, a scene onto another project or out into the loose diagrams, or a scene to
  // another place in its own project. It starts once the pointer has moved a few pixels, so a click still opens.
  const [drag, setDrag] = useState<(Moving & { x: number; y: number; over: Drop | null }) | null>(null);
  const press = useRef<(Moving & { pointerId: number; x: number; y: number; started: boolean }) | null>(null);
  const swallowClick = useRef(false);
  const consumeClick = () => { const swallowed = swallowClick.current; swallowClick.current = false; return swallowed; };
  /**
   * Where a drop at this point would move the item: a project other than its own, or the loose diagrams. Over a scene
   * of an unfolded project, above or below it by the half of the row the pointer is on; elsewhere, last. In its own
   * project, only over another place among its scenes.
   */
  const targetAt = (x: number, y: number, item: Moving): Drop | null => {
    const under = document.elementFromPoint(x, y);
    const holder = under?.closest<HTMLElement>('[data-drop-project]');
    const id = holder?.dataset.dropProject;
    if (!holder || !id) return null;
    if (isLooseProject(id)) return id === item.source ? null : { id };
    if (!state.rows.some((row) => row.id === id && row.kind === 'ok')) return null;
    const scene = under?.closest<HTMLElement>('[data-drop-scene]');
    if (!scene || !holder.contains(scene)) return id === item.source ? null : { id };
    const box = scene.getBoundingClientRect();
    const place = y >= box.top + box.height / 2 ? 'after' : 'before';
    const index = Number(scene.dataset.dropIndex) + (place === 'after' ? 1 : 0);
    if (id === item.source) {
      // Right above or below itself, it would stay where it is.
      const own = [...holder.querySelectorAll<HTMLElement>('[data-drop-scene]')].find((candidate) => candidate.dataset.dropScene === item.id);
      const from = own ? Number(own.dataset.dropIndex) : -1;
      if (from < 0 || index === from || index === from + 1) return null;
    }
    return { id, index, sceneId: scene.dataset.dropScene, place };
  };
  const targetName = (id: string) => isLooseProject(id) ? 'Loose diagrams' : named(id);
  const transfer = async (item: Moving, target: Drop) => {
    setNotice(null);
    if (target.id === item.source && target.sceneId && target.place) {
      try { await onReorderScene(item.source, item.id, target.sceneId, target.place); }
      catch (error) { setNotice(`Couldn't move “${item.name}”. ${error instanceof Error ? error.message : 'Try again.'}`); }
      return;
    }
    try { await onMoveScene(item.source, item.id, target.id, target.index); }
    catch (error) { setNotice(`Couldn't move “${item.name}”. ${reasonText(error)}`); }
  };
  const dragHandlers = (item: Moving) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      swallowClick.current = false;
      if (event.button !== 0 || event.isPrimary === false) return;
      press.current = { ...item, pointerId: event.pointerId, x: event.clientX, y: event.clientY, started: false };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the drag still works without capture */ }
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const held = press.current;
      if (!held || held.pointerId !== event.pointerId) return;
      if (!held.started && Math.hypot(event.clientX - held.x, event.clientY - held.y) < 5) return;
      held.started = true;
      setDrag({ ...item, x: event.clientX, y: event.clientY, over: targetAt(event.clientX, event.clientY, item) });
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const held = press.current;
      press.current = null;
      if (!held?.started) return;
      // The press ends a drag, not a click.
      swallowClick.current = true;
      const over = targetAt(event.clientX, event.clientY, item);
      setDrag(null);
      if (over) void transfer(item, over);
    },
    onPointerCancel: () => { press.current = null; setDrag(null); },
  });
  const sceneTransfer = (projectId: string): SceneTransfer => ({
    drag: (scene: Scene) => {
      const item = { source: projectId, id: scene.id, name: scene.name };
      return { handlers: dragHandlers(item), dragging: drag?.source === projectId && drag.id === scene.id };
    },
    consumeClick,
    move: (scene: Scene) => { setNotice(null); setMoving({ source: projectId, id: scene.id, name: scene.name }); },
    insert: (sceneId: string) => drag?.over?.id === projectId && drag.over.sceneId === sceneId ? drag.over.place : undefined,
  });
  // Escape drops nothing.
  useEffect(() => {
    if (!drag) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); press.current = null; swallowClick.current = true; setDrag(null); } };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [drag]);
  const dropName = (() => {
    const over = drag?.over;
    if (!over) return null;
    const row = rowById(over.id);
    const beside = over.sceneId && row?.kind === 'ok' ? row.sceneList.find((scene) => scene.id === over.sceneId)?.name : undefined;
    return beside ? `${targetName(over.id)}”, ${over.place === 'after' ? 'below' : 'above'} “${beside}` : targetName(over.id);
  })();
  // In its own project, the scene only changes place.
  const reorderName = (() => {
    const over = drag?.over;
    if (!drag || !over || over.id !== drag.source || !over.sceneId) return null;
    const row = rowById(over.id);
    const beside = row?.kind === 'ok' ? row.sceneList.find((scene) => scene.id === over.sceneId)?.name : undefined;
    return beside ? `${over.place === 'after' ? 'below' : 'above'} “${beside}”` : null;
  })();
  // A scene dragged out of a project can land among the loose diagrams, even while there are none.
  const sceneOut = drag !== null && !isLooseProject(drag.source);

  const renderRow = (row: Row) => (
    <ProjectRow
      key={row.id}
      row={row}
      current={row.id === currentId}
      expanded={row.kind === 'ok' && expanded.has(row.id)}
      renaming={renamingId === row.id}
      onOpen={() => {
        // The open project folds and unfolds; another one opens, unfolded.
        if (row.kind === 'ok' && row.id === currentId) { setExpandedTo(row.id, !expanded.has(row.id)); return; }
        if (row.kind === 'ok') setExpandedTo(row.id, true);
        onOpen(row.id);
      }}
      onIcon={(anchor) => setPicker(picker?.id === row.id ? null : { id: row.id, anchor })}
      onMenu={(anchor) => setMenu(menu?.id === row.id ? null : { id: row.id, anchor })}
      onRename={async (name) => {
        try { await store.update(row.id, { name }); setRenamingId(null); setNotice(null); }
        catch (error) { throw new Error(`Couldn't rename “${row.kind === 'ok' ? row.project.name : row.id}”. ${reasonText(error)}`); }
      }}
      onRenameCancel={() => setRenamingId(null)}
      onRenameAbandon={(message) => { setRenamingId(null); setNotice(message); }}
      // A scene changing place in its own project marks only the line, not the project.
      dropTarget={drag?.over?.id === row.id && drag.source !== row.id}
    >{row.kind === 'ok' && expanded.has(row.id) ? sceneList?.(row, sceneTransfer(row.id)) : null}</ProjectRow>
  );
  const renderLoose = (diagram: LooseDiagram) => (
    <LooseRow
      key={diagram.id}
      diagram={diagram}
      current={diagram.id === looseCurrentId}
      renaming={renamingLooseId === diagram.id}
      dragging={drag !== null && isLooseProject(drag.source) && drag.id === diagram.id}
      onOpen={() => { if (!consumeClick()) onOpenLoose(diagram.id); }}
      onMenu={(anchor) => setLooseMenu(looseMenu?.id === diagram.id ? null : { id: diagram.id, anchor })}
      onRename={async (name) => {
        try { await store.renameLoose(diagram.id, name); setRenamingLooseId(null); setNotice(null); }
        catch (error) { throw new Error(`Couldn't rename “${diagram.scene.name}”. ${reasonText(error)}`); }
      }}
      onRenameCancel={() => setRenamingLooseId(null)}
      onRenameAbandon={(message) => { setRenamingLooseId(null); setNotice(message); }}
      drag={dragHandlers({ source: LOOSE_PROJECT_ID, id: diagram.id, name: diagram.scene.name })}
    />
  );

  return (
    <aside id="projects-panel" className="projects" aria-label="Projects and diagrams" data-dragging={drag ? 'true' : undefined}>
      {/* The app's icon and name, right after the window's buttons in the desktop app, which sit on the bar beside it. */}
      <div className="panel-brand"><Brand /></div>

      <div className="projects__nav">
        {/* As in T3 Code, one row: “Search” on the left, then the project filter and the two ways to make something new,
            as icons. While searching, the field takes the place of “Search”. */}
        <div className="nav-actions">
          {query === null ? (
            <button ref={searchButton} type="button" className="nav-row nav-actions__search" onClick={() => setQuery('')}>
              <Search className="i" aria-hidden="true" />Search
            </button>
          ) : (
            <label className="nav-row nav-row--field nav-actions__search">
              <Search className="i" aria-hidden="true" />
              <input
                type="search" autoFocus value={query} placeholder="Search" aria-label="Search projects and diagrams" spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setQuery(null); requestAnimationFrame(() => searchButton.current?.focus()); } }}
                onBlur={(event) => { if (!event.currentTarget.value.trim()) setQuery(null); }}
              />
            </label>
          )}
          <ProjectFilter
            projects={filterProjects} value={filter} disabled={!listing || state.phase !== 'ready'}
            onChange={(next) => { if (listing) void store.setFilter(listing.activeId, next); }}
          />
          <button type="button" className="icon-btn nav-actions__new" aria-label="New project" title="New project" disabled={state.phase !== 'ready'} onClick={() => { setRenamingId(null); setRenamingLooseId(null); setQuery(null); setCreatingLoose(false); onCreatingChange(true); }}>
            <FolderPlus className="i" aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn nav-actions__new" aria-label="New diagram" title="New diagram" disabled={state.phase !== 'ready'} onClick={() => { setRenamingId(null); setRenamingLooseId(null); setQuery(null); onCreatingChange(false); setCreatingLoose(true); }}>
            <SquarePen className="i" aria-hidden="true" />
          </button>
        </div>
        <hr />
      </div>

      <div className="projects__body">
        {state.phase === 'loading' && (
          <ul className="project-list" aria-busy="true" aria-label="Loading projects">
            {[0, 1, 2].map((n) => (
              <li key={n}><div className="project project--skeleton"><span className="project__tile" /><span className="skeleton skeleton--name" /></div></li>
            ))}
          </ul>
        )}

        {state.phase === 'unavailable' && (
          <div className="panel-message" role="status">
            <ServerOff className="i" aria-hidden="true" />
            <p className="panel-message__title">{state.reason === 'session' ? 'Invalid session' : 'Offline'}</p>
            <p>{state.reason === 'session' ? "The local service doesn't recognize this window. Restart Paso." : "Can't reach Paso's local service. It retries on its own."}</p>
            <button type="button" className="btn" onClick={() => store.retry()}>Retry</button>
          </div>
        )}

        {state.phase === 'ready' && state.rows.length === 0 && looseAll.length === 0 && !creating && !creatingLoose && (
          <div className="panel-message">
            <Folder className="i" aria-hidden="true" />
            <p className="panel-message__title">Nothing here yet</p>
            <p>{activeWorkspace && !activeWorkspace.default ? `The folder “${activeWorkspace.name}” has no projects yet.` : 'A project gathers the scenes and steps of an explanation. A diagram is a single drawing.'}</p>
          </div>
        )}

        {showList && (
          <>
            {creating && (
              <ul className="project-list">
                <li>
                  <div className="project" data-draft="true">
                    <span className="project__tile"><Folder className="i" aria-hidden="true" /></span>
                    <div className="project__text">
                      <NameField
                        initial=""
                        label="Name of the new project"
                        placeholder="Project name"
                        onSave={async (name) => {
                          let id: string;
                          try { id = await store.create(name); } 
                          catch (error) { throw new Error(`Couldn't create the project. ${reasonText(error)}`); }
                          onCreatingChange(false);
                          await onCreated(id);
                        }}
                        onCancel={() => onCreatingChange(false)}
                        onAbandon={(message) => { onCreatingChange(false); setNotice(message); }}
                      />
                    </div>
                  </div>
                </li>
              </ul>
            )}
            {ok.length > 0 && <ul className="project-list" aria-label="Projects">{ok.map(renderRow)}</ul>}
            {broken.length > 0 && (
              <section className="project-group" aria-label="Can't be opened">
                <h3 className="project-group__title">Can't be opened</h3>
                <ul className="project-list">{broken.map(renderRow)}</ul>
              </section>
            )}
            {(looseVisible.length > 0 || creatingLoose || sceneOut) && (
              <section className="project-group" aria-labelledby="loose-diagrams-title">
                <h3 id="loose-diagrams-title" className="project-group__title">Loose diagrams</h3>
                <ul
                  className="project-list project-list--loose" aria-labelledby="loose-diagrams-title"
                  data-drop-project={LOOSE_PROJECT_ID} data-drop={(sceneOut && drag?.over?.id === LOOSE_PROJECT_ID) || undefined}
                >
                  {creatingLoose && (
                    <li>
                      <div className="project project--loose" data-draft="true">
                        <span className="project__tile"><Shapes className="i" aria-hidden="true" /></span>
                        <div className="project__text">
                          <NameField
                            initial=""
                            label="Name of the new diagram"
                            placeholder="Diagram name"
                            onSave={async (name) => {
                              try { await onCreateLoose(name); }
                              catch (error) { throw new Error(`Couldn't create the diagram. ${reasonText(error)}`); }
                              setCreatingLoose(false);
                            }}
                            onCancel={() => setCreatingLoose(false)}
                            onAbandon={(message) => { setCreatingLoose(false); setNotice(message); }}
                          />
                        </div>
                      </div>
                    </li>
                  )}
                  {looseVisible.map(renderLoose)}
                  {sceneOut && looseVisible.length === 0 && !creatingLoose && (
                    <li className="loose-drop" aria-hidden="true"><Shapes className="i" />Drop here</li>
                  )}
                </ul>
              </section>
            )}
            {query !== null && visible.length === 0 && looseVisible.length === 0 && <p className="projects__empty" role="status">No matches.</p>}
            {query === null && filter === LOOSE_PROJECT_ID && looseVisible.length === 0 && !creating && !creatingLoose && (
              <p className="projects__empty" role="status">No loose diagrams yet.</p>
            )}
          </>
        )}
      </div>

      {(notice || offline || notices) && (
        <div className="panel-notices">
          {notices}
          {offline && (
            <div className="notice" role="status">
              <CloudOff className="i" aria-hidden="true" />
              <div className="notice__body">
                <span>{state.reason === 'session' ? 'The service rejected this session.' : 'No connection to the service.'} The list may be out of date.</span>
                <button type="button" className="notice__action" onClick={() => store.retry()}>Retry</button>
              </div>
            </div>
          )}
          {notice && (
            <div className="notice notice--error" role="alert">
              <TriangleAlert className="i" aria-hidden="true" />
              <span>{notice}</span>
              <button type="button" className="icon-btn" aria-label="Dismiss notice" onClick={() => setNotice(null)}><X className="i" aria-hidden="true" /></button>
            </div>
          )}
        </div>
      )}

      {menu && rowById(menu.id)?.kind === 'ok' && (
        <RowMenu
          anchor={menu.anchor}
          name={named(menu.id)}
          onClose={() => setMenu(null)}
          onRename={() => { setNotice(null); setRenamingId(menu.id); }}
          onReveal={() => { setNotice(null); void store.reveal(menu.id).catch(() => setNotice("Couldn't open the project's folder.")); }}
          onDelete={() => { setDeleteError(null); setDeleting(rowById(menu.id) as Extract<Row, { kind: 'ok' }>); }}
        />
      )}
      {looseMenu && looseById(looseMenu.id) && (
        <RowMenu
          anchor={looseMenu.anchor}
          name={looseById(looseMenu.id)!.scene.name}
          onClose={() => setLooseMenu(null)}
          onRename={() => { setNotice(null); setRenamingLooseId(looseMenu.id); }}
          onMove={() => { setNotice(null); const diagram = looseById(looseMenu.id)!; setMoving({ source: LOOSE_PROJECT_ID, id: diagram.id, name: diagram.scene.name }); }}
          onDelete={() => { setDeleteError(null); setDeletingLoose(looseById(looseMenu.id)!); }}
        />
      )}
      {moving && (
        <MoveDialog
          name={moving.name}
          kind={isLooseProject(moving.source) ? 'loose' : 'scene'}
          projects={state.rows.filter((row): row is Extract<Row, { kind: 'ok' }> => row.kind === 'ok' && row.id !== moving.source)}
          onClose={() => setMoving(null)}
          onMove={async (projectId) => {
            try { await onMoveScene(moving.source, moving.id, projectId); setNotice(null); }
            catch (error) { throw new Error(`Couldn't move “${moving.name}”. ${reasonText(error)}`); }
          }}
        />
      )}
      {deletingLoose && (
        <Dialog title={`Delete “${deletingLoose.scene.name}”?`} onClose={() => { if (!deleteBusy) { setDeletingLoose(null); setDeleteError(null); } }}>
          <p className="dialog__text">
            {deletingLoose.steps === 0 ? 'This deletes the diagram' : `This deletes the diagram and its ${stepCount(deletingLoose.steps).toLowerCase()}`}. This can't be undone.
          </p>
          {deleteError && <p className="dialog__error" role="alert">{deleteError}</p>}
          <div className="dialog__actions">
            <button type="button" className="btn btn--soft" data-autofocus onClick={() => { setDeletingLoose(null); setDeleteError(null); }}>Cancel</button>
            <button type="button" className="btn btn--danger" disabled={deleteBusy} onClick={() => void (async () => {
              setDeleteBusy(true); setDeleteError(null);
              try { await onDeleteLoose(deletingLoose.id); setDeletingLoose(null); setNotice(null); }
              catch (error) { setDeleteError(`Couldn't delete the diagram. ${reasonText(error)}`); }
              finally { setDeleteBusy(false); }
            })()}>Delete diagram</button>
          </div>
        </Dialog>
      )}
      {drag && createPortal(
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
          {isLooseProject(drag.source) ? <Shapes className="i" /> : <Layers className="i" />}{drag.name}
        </div>,
        document.body,
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {drag ? (reorderName ? `Drop to place “${drag.name}” ${reorderName}.` : dropName ? `Drop to move “${drag.name}” to “${dropName}”.` : sceneOut
          ? `Drag “${drag.name}” to another place in its project, onto another project, or onto the loose diagrams to take it out.`
          : `Drag “${drag.name}” onto a project to move it.`) : ''}
      </p>
      {picker && rowById(picker.id)?.kind === 'ok' && (
        <IconPicker
          anchor={picker.anchor}
          current={(rowById(picker.id) as Extract<Row, { kind: 'ok' }>).project.icon}
          onPick={(icon) => void setIcon(picker.id, icon)}
          onClose={() => setPicker(null)}
        />
      )}
      {deleting && (
        <Dialog title={`Delete “${deleting.project.name}”?`} onClose={closeDelete}>
          <p className="dialog__text">
            This deletes the project's folder{deleting.scenes > 0 ? `, with its ${describeContents(deleting.scenes, deleting.steps)}` : ''}. This can't be undone.
          </p>
          {deleteError && <p className="dialog__error" role="alert">{deleteError}</p>}
          <div className="dialog__actions">
            <button type="button" className="btn btn--soft" data-autofocus onClick={closeDelete}>Cancel</button>
            <button type="button" className="btn btn--danger" disabled={deleteBusy} onClick={() => void confirmDelete()}>Delete project</button>
          </div>
        </Dialog>
      )}
    </aside>
  );
}
