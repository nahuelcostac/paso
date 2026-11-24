import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../lib/api';
import { untilNewest } from '../lib/newest';
import type { SceneEnvelope } from '../editor/step-actions';

/**
 * The scenes of one project, with their revisions (reordering needs the scene's revision).
 * It reads again whenever the project's own revision changes, which every step or scene change causes,
 * so changes made elsewhere arrive too. An older answer never overwrites a newer one, and `refresh` ends once the
 * newest answer is shown.
 */
export function useScenes(api: ApiClient, projectId: string | null, projectRevision: string | undefined) {
  const [state, setState] = useState<{ projectId: string; scenes: SceneEnvelope[] } | undefined>();
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);
  const newest = useRef<{ projectId: string; read: Promise<SceneEnvelope[]> }>(undefined);
  const refresh = useCallback(async () => {
    if (!projectId) return [];
    const version = ++latest.current;
    const read = api.listScenes(projectId).then((scenes) => {
      if (version === latest.current) { setState({ projectId, scenes }); setFailed(false); }
      return scenes;
    });
    newest.current = { projectId, read };
    // A caller acts on the list once this returns, such as opening a step it just made: the list shown must have it.
    return untilNewest(read, () => newest.current?.projectId === projectId ? newest.current.read : undefined);
  }, [api, projectId]);
  useEffect(() => { void refresh().catch(() => setFailed(true)); }, [refresh, projectRevision]);
  return { scenes: state?.projectId === projectId ? state?.scenes : undefined, failed, refresh };
}
