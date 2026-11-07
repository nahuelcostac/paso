import type { Step } from '@paso/shared';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ApiClient } from '../lib/api';
import { loadFiles } from '../editor/assets';
import { canvasFiles, excalidraw } from '../editor/excalidraw-runtime';
import { restoreSceneContent } from '../editor/scene-content';
import { unionBounds, type Bounds } from '../editor/thumbnail-bounds';
import type { Theme } from '../editor/thumbnails';
import { presentationAnchor } from './framing';

export type DeckStep = { id: string; revision: string; document: Step; elements: readonly ExcalidrawElement[] };
/** The steps of a scene as the service has them now, and the framing they share. */
export type Deck = { steps: DeckStep[]; content: Bounds | null; anchor: Bounds };
/** One step, drawn and ready to show. */
export type Page = { key: string; stepId: string; url: string; content: Bounds | null; anchor: Bounds; paper: string };

export async function loadDeck(api: ApiClient, projectId: string, sceneId: string): Promise<Deck> {
  const listed = await api.listSteps(projectId, sceneId);
  const { elements, bounds } = await restoreSceneContent(listed.map(({ document }) => document));
  const content = bounds.length > 0 ? unionBounds(bounds) : null;
  return { content, anchor: presentationAnchor(content), steps: listed.map(({ document, revision }, index) => ({ id: document.id, revision, document, elements: elements[index] })) };
}

/** A new revision, theme or scene camera makes a new page. */
export const pageKey = (deck: Deck, step: DeckStep, theme: Theme) => JSON.stringify([step.id, step.revision, theme, deck.anchor]);

/**
 * Draws one step and waits until the browser can paint it, so the swap to it cannot flash. The drawing has no
 * background: Presentar paints the paper across the whole screen, and the export would stop at its own edge.
 * Fonts and images travel inside the SVG. A dark export keeps images from inverting, as thumbnails do.
 */
export async function renderPage(api: ApiClient, projectId: string, deck: Deck, step: DeckStep, theme: Theme): Promise<Page> {
  const { convertToExcalidrawElements, exportToSvg } = await excalidraw();
  const files = await loadFiles(api, projectId, step.document);
  const [left, top, right, bottom] = deck.anchor;
  const anchor = convertToExcalidrawElements([{ type: 'rectangle', x: left, y: top, width: right - left, height: bottom - top, opacity: 0, strokeWidth: 0, strokeColor: 'transparent', backgroundColor: 'transparent' }]);
  const svg = await exportToSvg({
    elements: [...anchor, ...step.elements], files: canvasFiles(files), exportPadding: 0,
    appState: { ...step.document.appState, exportWithDarkMode: theme === 'dark', exportBackground: false, exportEmbedScene: false },
  });
  const url = URL.createObjectURL(new Blob([svg.outerHTML], { type: 'image/svg+xml' }));
  const image = new Image();
  image.src = url;
  await image.decode().catch(() => { /* It still loads when it is shown, a moment later. */ });
  return { key: pageKey(deck, step, theme), stepId: step.id, url, content: deck.content, anchor: deck.anchor, paper: step.document.appState.viewBackgroundColor ?? '#ffffff' };
}
