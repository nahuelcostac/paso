import { useEffect, useState } from 'react';
import type { ApiClient } from '../lib/api';
import type { Thumbnail, ThumbnailCache, Theme } from '../editor/thumbnails';
import { RenderQueue } from './render-queue';

/** One queue for the whole page: scenes draw their thumbnails one after another. */
const queue = new RenderQueue();

type Drawn = { theme: Theme; byStep: Record<string, Thumbnail> };

/**
 * The thumbnails of one scene, drawn by the thumbnail service once `key` is known and `enabled`.
 * `key` stands for the scene's step revisions: when it changes the scene is drawn again, and the
 * drawings already on screen stay until the new ones arrive, so an edit does not blink.
 * A theme change drops them, because they were drawn for the other theme.
 */
export function useSceneThumbnails(options: { api: ApiClient; cache: ThumbnailCache; projectId: string; sceneId: string; theme: Theme; key: string | null; enabled: boolean }) {
  const { api, cache, projectId, sceneId, theme, key, enabled } = options;
  const [drawn, setDrawn] = useState<Drawn>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || !key) return;
    let cancelled = false;
    setFailed(false);
    queue.run(() => cache.scene(api, projectId, sceneId, theme), () => cancelled)
      .then((result) => { if (!cancelled && result) setDrawn({ theme, byStep: Object.fromEntries(result.map((thumbnail) => [thumbnail.stepId, thumbnail])) }); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [api, cache, projectId, sceneId, theme, key, enabled]);
  return { thumbnails: drawn?.theme === theme ? drawn.byStep : undefined, failed };
}
