import { useEffect, useMemo, useState } from 'react';
import { ApiClient, type ClientConfig } from './lib/api';
import { useRoute } from './lib/route';
import { MainView } from './components/MainView';
import { ProjectsPanel } from './components/ProjectsPanel';
import { TopBar } from './components/TopBar';
import { ProjectsStore, useProjects } from './state/projects-store';

/** Below this the Excalidraw canvas would not fit beside the panel (docs/design/direction.md). */
const NARROW = '(max-width: 1063px)';

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

export function App({ config }: { config: ClientConfig }) {
  const store = useMemo(() => new ProjectsStore(new ApiClient(config)), [config]);
  useEffect(() => { store.start(); return () => store.dispose(); }, [store]);
  const state = useProjects(store);
  const [route, navigate] = useRoute();
  const [panelOpen, setPanelOpen] = usePanelOpen();
  const [creating, setCreating] = useState(false);

  const row = state.rows.find((candidate) => candidate.id === route.projectId);

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

  return (
    <div className={`app${panelOpen ? '' : ' app--panel-closed'}`}>
      <TopBar
        view={route.view}
        onViewChange={(view) => navigate({ projectId: route.projectId, view })}
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
      <MainView state={state} row={row} requestedId={route.projectId} view={route.view} onCreate={startCreating} onRetry={() => store.retry()} />
    </div>
  );
}
