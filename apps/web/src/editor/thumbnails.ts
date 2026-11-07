import type { ApiClient } from '../lib/api';
import { loadFiles } from './assets';
import { canvasElements, canvasFiles, excalidraw, loadDrawingFonts } from './excalidraw-runtime';
import { sceneBounds, type Bounds } from './thumbnail-bounds';

export type Thumbnail = { stepId: string; revision: string; bounds: Bounds; svg: string };
export type Theme = 'light' | 'dark';

/** Import this service on demand. It does not mount a canvas or write project files.
 * Cache keys include ALL scene revisions because another step can change the common camera.
 * The bounded cache stores SVG strings, so consumers own and revoke any blob URLs they make. */
export class ThumbnailCache {
  private cache = new Map<string, Promise<Thumbnail[]>>();
  constructor(private limit = 24) {}
  async scene(api: ApiClient, projectId: string, sceneId: string, theme: Theme): Promise<Thumbnail[]> {
    const steps = await api.listSteps(projectId, sceneId);
    const key = JSON.stringify([api.config.baseUrl, projectId, sceneId, theme, steps.map(({ document, revision }) => [document.id, revision])]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const render = (async () => {
      const { restoreElements, getCommonBounds, convertToExcalidrawElements, exportToSvg } = await excalidraw();
      await loadDrawingFonts(steps.map(({ document }) => document));
      const restored = steps.map(({ document }) => restoreElements(canvasElements(document), null, { refreshDimensions: true }).filter((element) => !element.isDeleted));
      const bounds = sceneBounds(restored.filter((elements) => elements.length > 0).map((elements) => getCommonBounds(elements)));
      const [left, top, right, bottom] = bounds;
      const anchor = convertToExcalidrawElements([{ type: 'rectangle', x: left, y: top, width: right - left, height: bottom - top, opacity: 0, strokeWidth: 0, strokeColor: 'transparent', backgroundColor: 'transparent' }]);
      return Promise.all(steps.map(async ({ document, revision }, index) => {
        const files = await loadFiles(api, projectId, document);
        const svg = await exportToSvg({ elements: [...anchor, ...restored[index]], files: canvasFiles(files), exportPadding: 0,
          appState: { ...document.appState, exportWithDarkMode: theme === 'dark', exportBackground: true, exportEmbedScene: false } });
        return { stepId: document.id, revision, bounds, svg: svg.outerHTML };
      }));
    })();
    this.cache.set(key, render);
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
    try { return await render; } catch (error) { this.cache.delete(key); throw error; }
  }
  clear() { this.cache.clear(); }
}
