import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../lib/api';
import type { ThumbnailCache, Theme } from './thumbnails';

/** Quiet time before thumbnails are drawn again. Saves already wait for a pause in editing, and this
 * keeps a long editing session from redrawing a long scene after every pause. */
export const THUMBNAIL_DELAY_MS = 700;

/**
 * Thumbnails for one scene as SVG documents by step ID, and the steps' titles. The drawing code loads on demand
 * and runs only after `version` has stopped changing, never on a keystroke. The frames turn an SVG into an image
 * themselves, so an unchanged string keeps its picture and an edit to one step does not make the others flicker.
 */
export function useThumbnails(api: ApiClient, projectId: string, sceneId: string | undefined, theme: Theme, version: string, delay = THUMBNAIL_DELAY_MS) {
  const [state, setState] = useState<{ svgs: Record<string, string>; titles: Record<string, string> }>({ svgs: {}, titles: {} });
  const cache = useRef<ThumbnailCache | undefined>(undefined);
  const sequence = useRef(0);
  const drawn = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!sceneId) { setState({ svgs: {}, titles: {} }); return; }
    const mine = ++sequence.current;
    // The first drawing of a scene does not wait: the person just arrived and is looking at blank frames.
    const wait = drawn.current === sceneId ? delay : 0;
    const timer = setTimeout(() => {
      void (async () => {
        cache.current ??= new (await import('./thumbnails')).ThumbnailCache();
        const thumbnails = await cache.current.scene(api, projectId, sceneId, theme);
        if (mine !== sequence.current) return;
        drawn.current = sceneId;
        setState({
          svgs: Object.fromEntries(thumbnails.map(({ stepId, svg }) => [stepId, svg])),
          titles: Object.fromEntries(thumbnails.flatMap(({ stepId, title }) => title ? [[stepId, title]] : [])),
        });
      })().catch(() => { /* Frames stay as they are. The next change tries again. */ });
    }, wait);
    return () => clearTimeout(timer);
  }, [api, projectId, sceneId, theme, version, delay]);
  useEffect(() => () => { sequence.current++; cache.current?.clear(); }, []);
  return state;
}
