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
  if (state.phase === 'loading') return <main className="main-message" aria-busy="true" aria-label="Loading" />;

  if (state.phase === 'unavailable') {
    const session = state.reason === 'session';
    return (
      <Message icon={<ServerOff className="i" aria-hidden="true" />} title={session ? "The local service doesn't accept this window" : "Can't connect to the local service"}>
        <p>{session ? 'Restart Paso to open a new session.' : "Paso saves your work through a service on this computer, and it isn't responding. It retries on its own."}</p>
        <button type="button" className="btn btn--soft btn--large" onClick={onRetry}>Retry</button>
      </Message>
    );
  }

  if (state.rows.length === 0) {
    return (
      <Message icon={<FolderOpen className="i" aria-hidden="true" />} title="Create your first project">
        <p>A project gathers the scenes and steps of an explanation, and is saved as a folder on this computer.</p>
        <button type="button" className="btn btn--soft btn--large" onClick={onCreate}><Plus className="i" aria-hidden="true" />New project</button>
      </Message>
    );
  }

  if (!row) {
    return requestedId ? (
      <Message icon={<FolderX className="i" aria-hidden="true" />} title="This project no longer exists">
        <p>It may have been deleted or moved outside Paso. Choose another one from the list.</p>
      </Message>
    ) : (
      <Message icon={<FolderOpen className="i" aria-hidden="true" />} title="Choose a project">
        <p>Open it from the list on the left.</p>
      </Message>
    );
  }

  if (row.kind === 'error') {
    return (
      <Message icon={<TriangleAlert className="i" aria-hidden="true" />} title={`Can't open “${row.id}”`}>
        <p>{explainProjectError(row.message).long}</p>
        <details className="main-message__details">
          <summary>Details</summary>
          <p>{row.message}</p>
        </details>
      </Message>
    );
  }

  // A project that opens is drawn by the Storyboard or the Canvas, which the app mounts itself.
  return null;
}
