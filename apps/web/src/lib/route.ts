import { useCallback, useEffect, useState } from 'react';

export type View = 'storyboard' | 'canvas';
export type Route = { projectId: string | null; view: View; sceneId?: string; stepId?: string };

/**
 * The route lives in the hash, `#/<project>/<view>`, so a reload returns to the same place with no
 * server rules for deep links. That also works when the app is packaged and loaded from a file.
 */
export function parseRoute(hash: string): Route {
  const [projectId, view, sceneId, stepId] = hash.replace(/^#\/?/, '').split('/');
  return {
    projectId: projectId && /^[A-Za-z0-9_-]{1,128}$/.test(projectId) ? projectId : null,
    // The board is where a diagram opens. The Studio ('storyboard') is its overview, opened from the Canvas | Studio switch.
    view: view === 'storyboard' ? 'storyboard' : 'canvas',
    ...(sceneId && /^[A-Za-z0-9_-]{1,128}$/.test(sceneId) ? { sceneId } : {}),
    ...(stepId && /^[A-Za-z0-9_-]{1,128}$/.test(stepId) ? { stepId } : {}),
  };
}
export function routeHash({ projectId, view, sceneId, stepId }: Route) {
  return projectId ? `#/${projectId}/${view}${sceneId ? `/${sceneId}${stepId ? `/${stepId}` : ''}` : ''}` : '#/';
}

/**
 * The address in today's words, for one that still names the Canvas by its old Spanish name, `#/<project>/lienzo/…`:
 * bookmarks and links from before keep working, and the address bar then shows `canvas`. Undefined for any other hash.
 */
export function legacyRouteHash(hash: string): string | undefined {
  return hash.replace(/^#\/?/, '').split('/')[1] === 'lienzo' ? routeHash(parseRoute(hash)) : undefined;
}

/** Reads the address, rewriting an old one in place first, with no history entry. */
function readRoute() {
  const legacy = legacyRouteHash(window.location.hash);
  if (legacy) window.history.replaceState(null, '', legacy);
  return parseRoute(window.location.hash);
}

export function useRoute() {
  const [route, setRoute] = useState(readRoute);
  // Back and forward fire popstate, and hashchange too when the address is a hash.
  useEffect(() => {
    const sync = () => setRoute(readRoute());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync); };
  }, []);
  /** `replace` fixes up a default route without adding a history entry. */
  const navigate = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    const hash = routeHash(next);
    if (hash === window.location.hash) return;
    // pushState and replaceState fire no event, so the state is set here.
    if (options.replace) window.history.replaceState(null, '', hash);
    else window.history.pushState(null, '', hash);
    setRoute(next);
  }, []);
  return [route, navigate] as const;
}
