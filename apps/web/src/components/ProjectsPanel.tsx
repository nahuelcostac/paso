import { useState } from 'react';
import { CloudOff, Folder, Plus, ServerOff, TriangleAlert, X } from 'lucide-react';
import { describeContents } from '../lib/format';
import { ActionError, type ProjectRow as Row, type ProjectsStore, type StoreState } from '../state/projects-store';
import { Dialog } from './Dialog';
import { IconPicker } from './IconPicker';
import { NameField } from './NameField';
import { ProjectRow } from './ProjectRow';
import { RowMenu } from './RowMenu';

type Props = {
  store: ProjectsStore;
  state: StoreState;
  currentId: string | null;
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
  onOpen: (id: string) => void;
  /** After a project is deleted: the app decides where to go. */
  onDeleted: (id: string) => void;
};

const reasonText = (error: unknown) => error instanceof ActionError ? error.message : 'Inténtalo de nuevo.';

export function ProjectsPanel({ store, state, currentId, creating, onCreatingChange, onOpen, onDeleted }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [picker, setPicker] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [deleting, setDeleting] = useState<Extract<Row, { kind: 'ok' }> | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const rowById = (id: string) => state.rows.find((row) => row.id === id);
  const named = (id: string) => { const row = rowById(id); return row?.kind === 'ok' ? row.project.name : id; };

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
    } catch (error) { setDeleteError(`No se pudo eliminar el proyecto. ${reasonText(error)}`); }
    finally { setDeleteBusy(false); }
  };
  const closeDelete = () => { if (!deleteBusy) { setDeleting(null); setDeleteError(null); } };

  const offline = !state.connected && state.phase === 'ready';
  const showList = state.phase === 'ready' && (state.rows.length > 0 || creating);

  return (
    <aside className="projects" aria-label="Proyectos">
      <div className="projects__head">
        <h2>Proyectos</h2>
        <button type="button" className="icon-btn" aria-label="Nuevo proyecto" onClick={() => { setRenamingId(null); onCreatingChange(true); }}>
          <Plus className="i" aria-hidden="true" />
        </button>
      </div>

      <div className="projects__body">
        {state.phase === 'loading' && (
          <ul className="project-list" aria-busy="true" aria-label="Cargando proyectos">
            {[0, 1, 2].map((n) => (
              <li key={n}><div className="project project--skeleton"><span className="project__tile" /><span className="project__text"><span className="skeleton skeleton--name" /><span className="skeleton skeleton--meta" /></span></div></li>
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

        {state.phase === 'ready' && state.rows.length === 0 && !creating && (
          <div className="panel-message">
            <Folder className="i" aria-hidden="true" />
            <p className="panel-message__title">Aún no hay proyectos</p>
            <p>Un proyecto reúne las escenas y los pasos de una explicación.</p>
            <button type="button" className="btn" onClick={() => onCreatingChange(true)}><Plus className="i" aria-hidden="true" />Crear proyecto</button>
          </div>
        )}

        {showList && (
          <ul className="project-list">
            {creating && (
              <li>
                <div className="project" data-draft="true">
                  <span className="project__tile"><Folder className="i" aria-hidden="true" /></span>
                  <div className="project__text">
                    <NameField
                      initial=""
                      label="Nombre del proyecto nuevo"
                      placeholder="Nombre del proyecto"
                      onSave={async (name) => {
                        try { const id = await store.create(name); onCreatingChange(false); onOpen(id); }
                        catch (error) { throw new Error(`No se pudo crear el proyecto. ${reasonText(error)}`); }
                      }}
                      onCancel={() => onCreatingChange(false)}
                      onAbandon={(message) => { onCreatingChange(false); setNotice(message); }}
                    />
                  </div>
                </div>
              </li>
            )}
            {state.rows.map((row) => (
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
              />
            ))}
          </ul>
        )}
      </div>

      {(notice || offline) && (
        <div className="panel-notices">
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
      <p className="projects__foot">Guardado en este equipo</p>

      {menu && rowById(menu.id)?.kind === 'ok' && (
        <RowMenu
          anchor={menu.anchor}
          name={named(menu.id)}
          onClose={() => setMenu(null)}
          onRename={() => { setNotice(null); setRenamingId(menu.id); }}
          onDelete={() => { setDeleteError(null); setDeleting(rowById(menu.id) as Extract<Row, { kind: 'ok' }>); }}
        />
      )}
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
            Se borrará la carpeta del proyecto{deleting.scenes > 0 ? ` con ${describeContents(deleting.scenes, deleting.steps)}` : ''}. No se puede deshacer.
          </p>
          {deleteError && <p className="dialog__error" role="alert">{deleteError}</p>}
          <div className="dialog__actions">
            <button type="button" className="btn btn--soft" data-autofocus onClick={closeDelete}>Cancelar</button>
            <button type="button" className="btn btn--danger" disabled={deleteBusy} onClick={() => void confirmDelete()}>Eliminar proyecto</button>
          </div>
        </Dialog>
      )}
    </aside>
  );
}
