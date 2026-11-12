import { useState } from 'react';
import { ProjectIcon } from '../lib/icons';
import type { ProjectRow } from '../state/projects-store';
import { Dialog } from './Dialog';

type Props = {
  name: string;
  projects: Array<Extract<ProjectRow, { kind: 'ok' }>>;
  onClose: () => void;
  /** Rejects with the words to show if the move failed. */
  onMove: (projectId: string) => Promise<void>;
};

/** «Mover a proyecto…»: the keyboard's way to do what dragging a loose diagram onto a project does. */
export function MoveDialog({ name, projects, onClose, onMove }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = async (projectId: string) => {
    setBusy(true); setError(null);
    try { await onMove(projectId); onClose(); }
    catch (failed) { setError(failed instanceof Error ? failed.message : 'No se pudo mover el diagrama.'); setBusy(false); }
  };
  return (
    <Dialog title={`Mover «${name}» a un proyecto`} role="dialog" onClose={() => { if (!busy) onClose(); }}>
      <p className="dialog__text">
        {projects.length ? 'Será la última escena del proyecto, con todos sus pasos.' : 'Aún no hay proyectos. Crea uno con «Nuevo proyecto» y vuelve a intentarlo.'}
      </p>
      {projects.length > 0 && (
        <ul className="move-list" aria-label="Proyectos">
          {projects.map((row) => (
            <li key={row.id}>
              <button type="button" className="move-list__item" disabled={busy} onClick={() => void move(row.id)}>
                <ProjectIcon name={row.project.icon} />
                <span className="move-list__name">{row.project.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="dialog__error" role="alert">{error}</p>}
      <div className="dialog__actions">
        <button type="button" className="btn btn--soft" data-autofocus disabled={busy} onClick={onClose}>Cancelar</button>
      </div>
    </Dialog>
  );
}
