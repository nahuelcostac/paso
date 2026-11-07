import type { ApiClient } from '../lib/api';
import { loadFiles } from './assets';
import { canvasElements, canvasFiles, excalidraw, loadDrawingFonts } from './excalidraw-runtime';
import { sceneBounds, type Bounds } from './thumbnail-bounds';

export type Thumbnail = { stepId: string; title?: string; revision: string; bounds: Bounds; svg: string };
export type Theme = 'light' | 'dark';

/** Import this service on demand. It does not mount a canvas or write project files.
 * Cache keys include ALL scene revisions because another step can change the common camera.
 * The bounded caches (whole scenes, and single steps within them) store SVG strings, so consumers own and revoke any blob URLs they make. */
export class ThumbnailCache {
  private cache = new Map<string, Promise<Thumbnail[]>>();
  private exports = new Map<string, Promise<string>>();
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
        // A step is exported again only when its own revision, the scene's camera or the theme changed.
        // Saving one step of a long scene therefore costs one export, not one per step.
        const stepKey = JSON.stringify([api.config.baseUrl, projectId, sceneId, theme, document.id, revision, bounds]);
        let svg = this.exports.get(stepKey);
        if (!svg) {
          svg = (async () => {
            const files = await loadFiles(api, projectId, document);
            const exported = await exportToSvg({ elements: [...anchor, ...restored[index]], files: canvasFiles(files), exportPadding: 0,
              appState: { ...document.appState, exportWithDarkMode: theme === 'dark', exportBackground: true, exportEmbedScene: false } });
            return exported.outerHTML;
          })();
          this.exports.set(stepKey, svg);
          if (this.exports.size > this.limit * 16) this.exports.delete(this.exports.keys().next().value!);
          svg.catch(() => this.exports.delete(stepKey));
        }
        return { stepId: document.id, ...(document.title ? { title: document.title } : {}), revision, bounds, svg: await svg };
      }));
    })();
    this.cache.set(key, render);
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
    try { return await render; } catch (error) { this.cache.delete(key); throw error; }
  }
  clear() { this.cache.clear(); this.exports.clear(); }
}
