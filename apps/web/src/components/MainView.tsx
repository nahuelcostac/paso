import { FolderOpen, FolderX, Plus, ServerOff, TriangleAlert } from 'lucide-react';
import { explainProjectError } from '../lib/format';
import type { ProjectRow, StoreState } from '../state/projects-store';

type Props = {
  state: StoreState;
  row: ProjectRow | undefined;
  /** The project the address names, whether or not it exists. */
  requestedId: string | null;
  onCreate: () => void;
  onRetry: () => void;
};

function Message({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <main className="main-message">
      <div className="main-message__icon">{icon}</div>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

/** What fills the window when there is no project to draw: loading, no connection, none yet, or one that cannot open. */
export function MainView({ state, row, requestedId, onCreate, onRetry }: Props) {
  if (state.phase === 'loading') return <main className="main-message" aria-busy="true" aria-label="Cargando" />;

  if (state.phase === 'unavailable') {
    const session = state.reason === 'session';
    return (
      <Message icon={<ServerOff className="i" aria-hidden="true" />} title={session ? 'El servicio local no acepta esta ventana' : 'No se puede conectar con el servicio local'}>
        <p>{session ? 'Reinicia Paso para abrir una sesión nueva.' : 'Paso guarda tus proyectos mediante un servicio en este equipo, y ahora no responde. Se reintenta solo.'}</p>
        <button type="button" className="btn btn--soft btn--large" onClick={onRetry}>Reintentar</button>
      </Message>
    );
  }

  if (state.rows.length === 0) {
    return (
      <Message icon={<FolderOpen className="i" aria-hidden="true" />} title="Crea tu primer proyecto">
        <p>Cada proyecto reúne las escenas y los pasos de una explicación, y se guarda como una carpeta en este equipo.</p>
        <button type="button" className="btn btn--soft btn--large" onClick={onCreate}><Plus className="i" aria-hidden="true" />Nuevo proyecto</button>
      </Message>
    );
  }

  if (!row) {
    return requestedId ? (
      <Message icon={<FolderX className="i" aria-hidden="true" />} title="Este proyecto ya no existe">
        <p>Puede que se haya eliminado o movido fuera de Paso. Elige otro en la lista.</p>
      </Message>
    ) : (
      <Message icon={<FolderOpen className="i" aria-hidden="true" />} title="Elige un proyecto">
        <p>Ábrelo desde la lista de la izquierda.</p>
      </Message>
    );
  }

  if (row.kind === 'error') {
    return (
      <Message icon={<TriangleAlert className="i" aria-hidden="true" />} title={`No se puede abrir «${row.id}»`}>
        <p>{explainProjectError(row.message).long}</p>
        <details className="main-message__details">
          <summary>Detalles</summary>
          <p>{row.message}</p>
        </details>
      </Message>
    );
  }

  // A project that opens is drawn by the Storyboard or the Lienzo, which the app mounts itself.
  return null;
}
