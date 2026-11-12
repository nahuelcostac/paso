import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUpDown, CloudOff, Folder, PanelLeft, Search, ServerOff, Shapes, SquarePen, SquarePlus, TriangleAlert, X } from 'lucide-react';
import type { ApiClient } from '../lib/api';
import { describeContents, fold, groupByRecency } from '../lib/format';
import { ActionError, workspaceErrorText, type LooseDiagram, type ProjectRow as Row, type ProjectsStore, type StoreState } from '../state/projects-store';
import { Brand } from './Brand';
import { Dialog } from './Dialog';
import { FolderPicker } from './FolderPicker';
import { IconPicker } from './IconPicker';
import { LooseRow, stepCount } from './LooseRow';
import { MoveDialog } from './MoveDialog';
import { NameField } from './NameField';
import { ProjectRow } from './ProjectRow';
import { RowMenu } from './RowMenu';
import { WorkspaceMenu } from './WorkspaceMenu';

type Props = {
  api: ApiClient;
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
  /** Opens another workspace. The app saves the open step first. */
  onSwitchWorkspace: (open: () => Promise<void>) => Promise<void>;
  onHide: () => void;
  /** The open diagram's scenes, shown under its row. */
  sceneList?: ReactNode;
  /** The open step's save state, said in the footer. */
  saveState?: 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict';
  /** Failures of the app that have no other place, such as a step elsewhere that could not be saved. */
  notices?: ReactNode;
  /** The loose diagram on screen, if one is. */
  looseCurrentId: string | null;
  onOpenLoose: (id: string) => void;
  /** «Nuevo diagrama»: the app creates it with one empty step and opens it. Rejects with the words to show. */
  onCreateLoose: (name: string) => Promise<void>;
  /** Moves a loose diagram into a project. The app saves the open step first. Rejects with the reason. */
  onMoveLoose: (id: string, projectId: string) => Promise<void>;
  /** Deletes a loose diagram, and leaves it if it is on screen. Rejects with the reason. */
  onDeleteLoose: (id: string) => Promise<void>;
};

const SAVE_LABELS = { saved: 'Guardado en este equipo', dirty: 'Cambios pendientes', saving: 'Guardando…', failed: 'Sin guardar', conflict: 'Sin guardar' } as const;

const reasonText = (error: unknown) => error instanceof ActionError ? error.message : 'Inténtalo de nuevo.';

/**
 * The sidebar, laid out like tldraw's: the mark, the workspace switcher, search and «Nuevo proyecto», then the projects
 * grouped by when they last changed. Each workspace is a folder on this computer.
 */
export function ProjectsPanel({ api, store, state, currentId, creating, onCreatingChange, onOpen, onCreated, onDeleted, onSwitchWorkspace, onHide, sceneList, saveState, notices, looseCurrentId, onOpenLoose, onCreateLoose, onMoveLoose, onDeleteLoose }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [picker, setPicker] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [deleting, setDeleting] = useState<Extract<Row, { kind: 'ok' }> | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Null while the search row is a button; a string, even empty, while it is a field. */
  const [query, setQuery] = useState<string | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [creatingLoose, setCreatingLoose] = useState(false);
  const [looseMenu, setLooseMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [renamingLooseId, setRenamingLooseId] = useState<string | null>(null);
  const [movingLoose, setMovingLoose] = useState<LooseDiagram | null>(null);
  const [deletingLoose, setDeletingLoose] = useState<LooseDiagram | null>(null);
  const workspaceButton = useRef<HTMLButtonElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const rowById = (id: string) => state.rows.find((row) => row.id === id);
  const named = (id: string) => { const row = rowById(id); return row?.kind === 'ok' ? row.project.name : id; };

  const listing = state.workspaces;
  const activeWorkspace = listing?.workspaces.find((workspace) => workspace.id === listing.activeId);

  const setIcon = async (id: string, icon: string) => {
    const name = named(id);
    setPicker(null);
    try { await store.update(id, { icon }); setNotice(null); }
    catch (error) { setNotice(`No se pudo cambiar el icono de «${name}». ${reasonText(error)}`); }
  };
  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true); setDeleteError(null);
    try {
      await store.remove(deleting.id);
      const id = deleting.id;
      setDeleting(null); setNotice(null);
      onDeleted(id);
    } catch (error) { setDeleteError(`No se pudo eliminar el diagrama. ${reasonText(error)}`); }
    finally { setDeleteBusy(false); }
  };
  const closeDelete = () => { if (!deleteBusy) { setDeleting(null); setDeleteError(null); } };

  const workspaceAction = async (action: () => Promise<void>, failure: string) => {
    setSwitching(true); setNotice(null);
    try { await onSwitchWorkspace(action); setQuery(null); }
    catch (error) { setNotice(`${failure} ${workspaceErrorText(error)}`); }
    finally { setSwitching(false); }
  };

  const offline = !state.connected && state.phase === 'ready';
  const looseAll = state.loose?.diagrams ?? [];
  const terms = useMemo(() => fold(query ?? '').split(/\s+/).filter(Boolean), [query]);
  const visible = useMemo(() => {
    if (!terms.length) return state.rows;
    return state.rows.filter((row) => terms.every((term) => fold(row.kind === 'ok' ? row.project.name : row.id).includes(term)));
  }, [state.rows, terms]);
  // Search finds loose diagrams by name too.
  const looseVisible = useMemo(() => terms.length ? looseAll.filter((diagram) => terms.every((term) => fold(diagram.scene.name).includes(term))) : looseAll, [looseAll, terms]);
  const looseById = (id: string) => looseAll.find((diagram) => diagram.id === id);
  const ok = visible.filter((row): row is Extract<Row, { kind: 'ok' }> => row.kind === 'ok');
  const broken = visible.filter((row) => row.kind === 'error');
  const groups = groupByRecency(ok, (row) => row.project.updatedAt);
  const showList = state.phase === 'ready' && (state.rows.length > 0 || looseAll.length > 0 || creating || creatingLoose);

  // Dragging a loose diagram onto a project. It starts once the pointer has moved a few pixels, so a click still opens.
  const [drag, setDrag] = useState<{ id: string; name: string; x: number; y: number; over: string | null } | null>(null);
  const press = useRef<{ id: string; pointerId: number; x: number; y: number; started: boolean } | null>(null);
  const swallowClick = useRef(false);
  const projectAt = (x: number, y: number) => {
    const id = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-project]')?.dataset.dropProject;
    return id && state.rows.some((row) => row.id === id && row.kind === 'ok') ? id : null;
  };
  const moveLoose = async (diagram: LooseDiagram, projectId: string) => {
    setNotice(null);
    try { await onMoveLoose(diagram.id, projectId); }
    catch (error) { setNotice(`No se pudo mover «${diagram.scene.name}». ${reasonText(error)}`); }
  };
  const dragHandlers = (diagram: LooseDiagram) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      swallowClick.current = false;
      if (event.button !== 0 || event.isPrimary === false) return;
      press.current = { id: diagram.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, started: false };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the drag still works without capture */ }
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const held = press.current;
      if (!held || held.pointerId !== event.pointerId) return;
      if (!held.started && Math.hypot(event.clientX - held.x, event.clientY - held.y) < 5) return;
      held.started = true;
      setDrag({ id: diagram.id, name: diagram.scene.name, x: event.clientX, y: event.clientY, over: projectAt(event.clientX, event.clientY) });
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const held = press.current;
      press.current = null;
      if (!held?.started) return;
      // The press ends a drag, not a click.
      swallowClick.current = true;
      const over = projectAt(event.clientX, event.clientY);
      setDrag(null);
      if (over) void moveLoose(diagram, over);
    },
    onPointerCancel: () => { press.current = null; setDrag(null); },
  });
  // Escape drops nothing.
  useEffect(() => {
    if (!drag) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); press.current = null; swallowClick.current = true; setDrag(null); } };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [drag]);
  const dropName = drag?.over ? named(drag.over) : null;

  const renderRow = (row: Row) => (
    <ProjectRow
      key={row.id}
      row={row}
      current={row.id === currentId}
      renaming={renamingId === row.id}
      onOpen={() => onOpen(row.id)}
      onIcon={(anchor) => setPicker(picker?.id === row.id ? null : { id: row.id, anchor })}
      onMenu={(anchor) => setMenu(menu?.id === row.id ? null : { id: row.id, anchor })}
      onRename={async (name) => {
        try { await store.update(row.id, { name }); setRenamingId(null); setNotice(null); }
        catch (error) { throw new Error(`No se pudo renombrar «${row.kind === 'ok' ? row.project.name : row.id}». ${reasonText(error)}`); }
      }}
      onRenameCancel={() => setRenamingId(null)}
      onRenameAbandon={(message) => { setRenamingId(null); setNotice(message); }}
      dropTarget={drag?.over === row.id}
    >{row.id === currentId && row.kind === 'ok' ? sceneList : null}</ProjectRow>
  );
  const renderLoose = (diagram: LooseDiagram) => (
    <LooseRow
      key={diagram.id}
      diagram={diagram}
      current={diagram.id === looseCurrentId}
      renaming={renamingLooseId === diagram.id}
      dragging={drag?.id === diagram.id}
      onOpen={() => { if (swallowClick.current) { swallowClick.current = false; return; } onOpenLoose(diagram.id); }}
      onMenu={(anchor) => setLooseMenu(looseMenu?.id === diagram.id ? null : { id: diagram.id, anchor })}
      onRename={async (name) => {
        try { await store.renameLoose(diagram.id, name); setRenamingLooseId(null); setNotice(null); }
        catch (error) { throw new Error(`No se pudo renombrar «${diagram.scene.name}». ${reasonText(error)}`); }
      }}
      onRenameCancel={() => setRenamingLooseId(null)}
      onRenameAbandon={(message) => { setRenamingLooseId(null); setNotice(message); }}
      drag={dragHandlers(diagram)}
    />
  );

  return (
    <aside className="projects" aria-label="Diagramas" aria-busy={switching || undefined} data-dragging={drag ? 'true' : undefined}>
      <div className="projects__head">
        <Brand />
        <button type="button" className="icon-btn" aria-label="Ocultar diagramas" title="Ocultar diagramas" aria-expanded="true" onClick={onHide}>
          <PanelLeft className="i" aria-hidden="true" />
        </button>
      </div>

      <div className="projects__nav">
        <button
          ref={workspaceButton} type="button" className="workspace-switch" aria-haspopup="menu" aria-expanded={workspaceMenu}
          aria-label={`Workspace: ${activeWorkspace?.name ?? 'cargando'}`} title={activeWorkspace?.path}
          disabled={!listing || switching} onClick={() => setWorkspaceMenu(!workspaceMenu)}
        >
          <span className="workspace-switch__name">{activeWorkspace?.name ?? ' '}</span>
          <ChevronsUpDown className="i" aria-hidden="true" />
        </button>
        <hr />
        {query === null ? (
          <button ref={searchButton} type="button" className="nav-row" onClick={() => setQuery('')}>
            <Search className="i" aria-hidden="true" />Buscar…
          </button>
        ) : (
          <label className="nav-row nav-row--field">
            <Search className="i" aria-hidden="true" />
            <input
              type="search" autoFocus value={query} placeholder="Buscar…" aria-label="Buscar diagramas" spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setQuery(null); requestAnimationFrame(() => searchButton.current?.focus()); } }}
              onBlur={(event) => { if (!event.currentTarget.value.trim()) setQuery(null); }}
            />
          </label>
        )}
        <button type="button" className="nav-row" disabled={state.phase !== 'ready'} onClick={() => { setRenamingId(null); setRenamingLooseId(null); setQuery(null); onCreatingChange(false); setCreatingLoose(true); }}>
          <SquarePlus className="i" aria-hidden="true" />Nuevo diagrama
        </button>
        <button type="button" className="nav-row" disabled={state.phase !== 'ready'} onClick={() => { setRenamingId(null); setRenamingLooseId(null); setQuery(null); setCreatingLoose(false); onCreatingChange(true); }}>
          <SquarePen className="i" aria-hidden="true" />Nuevo proyecto
        </button>
        <hr />
      </div>

      <div className="projects__body">
        {state.phase === 'loading' && (
          <ul className="project-list" aria-busy="true" aria-label="Cargando diagramas">
            {[0, 1, 2].map((n) => (
              <li key={n}><div className="project project--skeleton"><span className="project__tile" /><span className="skeleton skeleton--name" /></div></li>
            ))}
          </ul>
        )}

        {state.phase === 'unavailable' && (
          <div className="panel-message" role="status">
            <ServerOff className="i" aria-hidden="true" />
            <p className="panel-message__title">{state.reason === 'session' ? 'Sesión no válida' : 'Sin conexión'}</p>
            <p>{state.reason === 'session' ? 'El servicio local no reconoce esta ventana. Reinicia Paso.' : 'No se puede llegar al servicio local de Paso. Se reintenta solo.'}</p>
            <button type="button" className="btn" onClick={() => store.retry()}>Reintentar</button>
          </div>
        )}

        {state.phase === 'ready' && state.rows.length === 0 && looseAll.length === 0 && !creating && !creatingLoose && (
          <div className="panel-message">
            <Folder className="i" aria-hidden="true" />
            <p className="panel-message__title">Aún no hay diagramas</p>
            <p>{activeWorkspace && !activeWorkspace.default ? `La carpeta «${activeWorkspace.name}» no tiene diagramas todavía.` : 'Un diagrama reúne las escenas y los pasos de una explicación.'}</p>
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
                        label="Nombre del diagrama nuevo"
                        placeholder="Nombre del diagrama"
                        onSave={async (name) => {
                          let id: string;
                          try { id = await store.create(name); } 
                          catch (error) { throw new Error(`No se pudo crear el diagrama. ${reasonText(error)}`); }
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
            {groups.map((group) => (
              <section key={group.label} className="project-group" aria-label={group.label}>
                <h3 className="project-group__title">{group.label}</h3>
                <ul className="project-list">{group.items.map(renderRow)}</ul>
              </section>
            ))}
            {broken.length > 0 && (
              <section className="project-group" aria-label="No se pueden abrir">
                <h3 className="project-group__title">No se pueden abrir</h3>
                <ul className="project-list">{broken.map(renderRow)}</ul>
              </section>
            )}
            {/* Loose diagrams: flat below the projects, with no heading of their own. */}
            {(looseVisible.length > 0 || creatingLoose) && (
              <ul className="project-list project-list--loose" aria-label="Diagramas sueltos">
                {creatingLoose && (
                  <li>
                    <div className="project project--loose" data-draft="true">
                      <span className="project__tile"><Shapes className="i" aria-hidden="true" /></span>
                      <div className="project__text">
                        <NameField
                          initial=""
                          label="Nombre del diagrama suelto nuevo"
                          placeholder="Nombre del diagrama"
                          onSave={async (name) => {
                            try { await onCreateLoose(name); }
                            catch (error) { throw new Error(`No se pudo crear el diagrama. ${reasonText(error)}`); }
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
              </ul>
            )}
            {query !== null && visible.length === 0 && looseVisible.length === 0 && <p className="projects__empty" role="status">Ningún diagrama coincide.</p>}
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
                <span>{state.reason === 'session' ? 'El servicio rechazó esta sesión.' : 'Sin conexión con el servicio.'} La lista puede no estar al día.</span>
                <button type="button" className="notice__action" onClick={() => store.retry()}>Reintentar</button>
              </div>
            </div>
          )}
          {notice && (
            <div className="notice notice--error" role="alert">
              <TriangleAlert className="i" aria-hidden="true" />
              <span>{notice}</span>
              <button type="button" className="icon-btn" aria-label="Cerrar aviso" onClick={() => setNotice(null)}><X className="i" aria-hidden="true" /></button>
            </div>
          )}
        </div>
      )}
      <p className="projects__foot" data-save-state={saveState ?? 'saved'} role="status">{SAVE_LABELS[saveState ?? 'saved']}</p>

      {workspaceMenu && listing && workspaceButton.current && (
        <WorkspaceMenu
          anchor={workspaceButton.current}
          workspaces={listing.workspaces}
          activeId={listing.activeId}
          onClose={() => setWorkspaceMenu(false)}
          onSwitch={(id) => void workspaceAction(() => store.switchWorkspace(id), 'No se pudo abrir el workspace.')}
          onAdd={() => setChoosingFolder(true)}
          onReveal={() => { setNotice(null); void store.revealWorkspace(listing.activeId).catch(() => setNotice('No se pudo abrir la carpeta del workspace.')); }}
          onRemove={() => void workspaceAction(() => store.removeWorkspace(listing.activeId), 'No se pudo quitar el workspace.')}
        />
      )}
      {choosingFolder && (
        <FolderPicker
          api={api}
          near={activeWorkspace && !activeWorkspace.default ? activeWorkspace.path : undefined}
          onClose={() => setChoosingFolder(false)}
          onChoose={async (path) => {
            // Errors stay in the explorer, where the person can pick another folder.
            await onSwitchWorkspace(() => store.addWorkspace(path));
            setChoosingFolder(false); setQuery(null);
          }}
        />
      )}
      {menu && rowById(menu.id)?.kind === 'ok' && (
        <RowMenu
          anchor={menu.anchor}
          name={named(menu.id)}
          onClose={() => setMenu(null)}
          onRename={() => { setNotice(null); setRenamingId(menu.id); }}
          onReveal={() => { setNotice(null); void store.reveal(menu.id).catch(() => setNotice('No se pudo abrir la carpeta del diagrama.')); }}
          onDelete={() => { setDeleteError(null); setDeleting(rowById(menu.id) as Extract<Row, { kind: 'ok' }>); }}
        />
      )}
      {looseMenu && looseById(looseMenu.id) && (
        <RowMenu
          anchor={looseMenu.anchor}
          name={looseById(looseMenu.id)!.scene.name}
          onClose={() => setLooseMenu(null)}
          onRename={() => { setNotice(null); setRenamingLooseId(looseMenu.id); }}
          onMove={() => { setNotice(null); setMovingLoose(looseById(looseMenu.id)!); }}
          onDelete={() => { setDeleteError(null); setDeletingLoose(looseById(looseMenu.id)!); }}
        />
      )}
      {movingLoose && (
        <MoveDialog
          name={movingLoose.scene.name}
          projects={state.rows.filter((row): row is Extract<Row, { kind: 'ok' }> => row.kind === 'ok')}
          onClose={() => setMovingLoose(null)}
          onMove={async (projectId) => {
            try { await onMoveLoose(movingLoose.id, projectId); setNotice(null); }
            catch (error) { throw new Error(`No se pudo mover el diagrama. ${reasonText(error)}`); }
          }}
        />
      )}
      {deletingLoose && (
        <Dialog title={`¿Eliminar «${deletingLoose.scene.name}»?`} onClose={() => { if (!deleteBusy) { setDeletingLoose(null); setDeleteError(null); } }}>
          <p className="dialog__text">
            {deletingLoose.steps === 0 ? 'Se borrará el diagrama' : `Se borrará el diagrama con ${stepCount(deletingLoose.steps).toLowerCase()}`}. No se puede deshacer.
          </p>
          {deleteError && <p className="dialog__error" role="alert">{deleteError}</p>}
          <div className="dialog__actions">
            <button type="button" className="btn btn--soft" data-autofocus onClick={() => { setDeletingLoose(null); setDeleteError(null); }}>Cancelar</button>
            <button type="button" className="btn btn--danger" disabled={deleteBusy} onClick={() => void (async () => {
              setDeleteBusy(true); setDeleteError(null);
              try { await onDeleteLoose(deletingLoose.id); setDeletingLoose(null); setNotice(null); }
              catch (error) { setDeleteError(`No se pudo eliminar el diagrama. ${reasonText(error)}`); }
              finally { setDeleteBusy(false); }
            })()}>Eliminar diagrama</button>
          </div>
        </Dialog>
      )}
      {drag && createPortal(
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
          <Shapes className="i" />{drag.name}
        </div>,
        document.body,
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {drag ? (dropName ? `Suelta para mover «${drag.name}» a «${dropName}».` : `Arrastra «${drag.name}» sobre un proyecto para moverlo.`) : ''}
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
        <Dialog title={`¿Eliminar «${deleting.project.name}»?`} onClose={closeDelete}>
          <p className="dialog__text">
            Se borrará la carpeta del diagrama{deleting.scenes > 0 ? ` con ${describeContents(deleting.scenes, deleting.steps)}` : ''}. No se puede deshacer.
          </p>
          {deleteError && <p className="dialog__error" role="alert">{deleteError}</p>}
          <div className="dialog__actions">
            <button type="button" className="btn btn--soft" data-autofocus onClick={closeDelete}>Cancelar</button>
            <button type="button" className="btn btn--danger" disabled={deleteBusy} onClick={() => void confirmDelete()}>Eliminar diagrama</button>
          </div>
        </Dialog>
      )}
    </aside>
  );
}
