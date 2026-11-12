import { useState } from 'react';
import { Shapes } from 'lucide-react';
import { LOOSE_PROJECT_ID } from '@paso/shared';
import { ProjectIcon } from '../lib/icons';
import type { ProjectRow } from '../state/projects-store';
import { Dialog } from './Dialog';

type Props = {
  name: string;
  /** A loose diagram goes into a project; a project's scene can also go out, into the loose diagrams. */
  kind: 'loose' | 'scene';
  /** The projects it can go to: all but its own. */
  projects: Array<Extract<ProjectRow, { kind: 'ok' }>>;
  onClose: () => void;
  /** Rejects with the words to show if the move failed. */
  onMove: (projectId: string) => Promise<void>;
};

/** «Mover a proyecto…» and «Mover a…»: the keyboard's way to do what dragging a loose diagram or a scene does. */
export function MoveDialog({ name, kind, projects, onClose, onMove }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = async (projectId: string) => {
    setBusy(true); setError(null);
    try { await onMove(projectId); onClose(); }
    catch (failed) { setError(failed instanceof Error ? failed.message : 'No se pudo mover.'); setBusy(false); }
  };
  const text = kind === 'scene'
    ? 'Irá con todos sus pasos al final del proyecto que elijas, o quedará como un diagrama suelto.'
    : projects.length ? 'Será la última escena del proyecto, con todos sus pasos.' : 'Aún no hay proyectos. Crea uno con «Nuevo proyecto» y vuelve a intentarlo.';
  const empty = kind === 'loose' && projects.length === 0;
  return (
    <Dialog title={kind === 'scene' ? `Mover «${name}»` : `Mover «${name}» a un proyecto`} role="dialog" onClose={() => { if (!busy) onClose(); }}>
      <p className="dialog__text">{text}</p>
      {!empty && (
        <ul className="move-list" aria-label="Destinos">
          {projects.map((row) => (
            <li key={row.id}>
              <button type="button" className="move-list__item" disabled={busy} onClick={() => void move(row.id)}>
                <ProjectIcon name={row.project.icon} />
                <span className="move-list__name">{row.project.name}</span>
              </button>
            </li>
          ))}
          {kind === 'scene' && (
            <li>
              <button type="button" className="move-list__item" disabled={busy} onClick={() => void move(LOOSE_PROJECT_ID)}>
                <Shapes className="i" aria-hidden="true" />
                <span className="move-list__name">Diagramas sueltos</span>
              </button>
            </li>
          )}
        </ul>
      )}
      {error && <p className="dialog__error" role="alert">{error}</p>}
      <div className="dialog__actions">
        <button type="button" className="btn btn--soft" data-autofocus disabled={busy} onClick={onClose}>Cancelar</button>
      </div>
    </Dialog>
  );
}
