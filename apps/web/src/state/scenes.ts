import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../lib/api';
import type { SceneEnvelope } from '../editor/step-actions';

/**
 * The scenes of one project, with their revisions (reordering needs the scene's revision).
 * It reads again whenever the project's own revision changes, which every step or scene change causes,
 * so changes made elsewhere arrive too. An older answer never overwrites a newer one.
 */
export function useScenes(api: ApiClient, projectId: string | null, projectRevision: string | undefined) {
  const [state, setState] = useState<{ projectId: string; scenes: SceneEnvelope[] } | undefined>();
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    if (!projectId) return [];
    const version = ++latest.current;
    const scenes = await api.listScenes(projectId);
    if (version === latest.current) { setState({ projectId, scenes }); setFailed(false); }
    return scenes;
  }, [api, projectId]);
  useEffect(() => { void refresh().catch(() => setFailed(true)); }, [refresh, projectRevision]);
  return { scenes: state?.projectId === projectId ? state?.scenes : undefined, failed, refresh };
}
