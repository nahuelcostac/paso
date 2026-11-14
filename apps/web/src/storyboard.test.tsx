// @vitest-environment jsdom
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '@paso/server';
import { App } from './App';
import type { ClientConfig } from './lib/api';
import { StepFrame } from './components/StepFrame';
import { RenderQueue } from './state/render-queue';

/**
 * The Storyboard runs against a real local service on a temporary data folder. Only drawing is
 * replaced: jsdom has no canvas, so the Excalidraw exporter returns a tiny SVG that records what it was given.
 */
const drawn = vi.hoisted(() => ({ loads: 0, calls: [] as string[] }));
vi.mock('./editor/excalidraw-runtime', () => ({
  canvasElements: (step: { elements: unknown[] }) => step.elements,
  canvasFiles: (files: unknown) => files,
  loadDrawingFonts: async () => {},
  excalidraw: async () => {
    drawn.loads += 1;
    return {
      restoreElements: (elements: unknown[]) => elements,
      getCommonBounds: () => [0, 0, 100, 100],
      convertToExcalidrawElements: (elements: unknown[]) => elements,
      exportToSvg: async ({ elements, appState }: { elements: Array<{ id: string }>; appState: { exportWithDarkMode: boolean } }) => {
        const ids = elements.map((element) => element.id).join('+');
        drawn.calls.push(ids);
        return { outerHTML: `<svg data-ids="${ids}" data-dark="${appState.exportWithDarkMode}"/>` };
      },
    };
  },
}));
vi.mock('./editor/StepCanvas', () => ({ default: () => null }));

type Service = Awaited<ReturnType<typeof startServer>>;
const token = 'storyboard-test-token-with-at-least-32-chars';
let service: Service;
let dataDir: string;
let config: ClientConfig;
const patience = { timeout: 5000 };
const auth = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function call<T = unknown>(method: string, path: string, body?: unknown, revision?: string): Promise<T> {
  const response = await fetch(`${service.url}/api${path}`, {
    method, headers: { ...auth(), ...(revision ? { 'If-Match': `"${revision}"` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${method} ${path} -> ${response.status}`).toBe(true);
  return (response.status === 204 ? undefined : await response.json()) as T;
}
const rect = (id: string, x = 0) => ({ id, type: 'rectangle', x, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false });
type Doc<T> = { document: T; revision: string };

/** A project "p" with scenes a (3 steps, the second titled), b (1 step) and c (empty). */
async function seed() {
  await call('POST', '/projects', { id: 'p', name: 'Búsqueda' });
  for (const [id, name, steps] of [['a', 'El problema', 3], ['b', 'Partir en dos', 1], ['c', 'Vacía', 0]] as const) {
    await call('POST', '/projects/p/scenes', { id, name });
    for (let n = 1; n <= steps; n += 1) await call('POST', `/projects/p/scenes/${id}/steps`, { id: `${id}${n}`, ...(n === 2 ? { title: 'Mira en medio' } : {}), elements: [rect(`${id}${n}-r`, n)] });
  }
}
const readJson = async (...path: string[]) => JSON.parse(await readFile(join(dataDir, ...path), 'utf8')) as Record<string, unknown>;
const sceneOrder = async () => (await readJson('p', 'project.json')).sceneIds as string[];
const stepOrder = async (scene: string) => (await readJson('p', 'scenes', scene, 'scene.json')).stepIds as string[];
const board = () => screen.getByRole('main', { name: 'Estudio' });
const sceneTitles = () => within(board()).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
/** The scenes as the sidebar lists them. */
const sidebarScenes = () => within(screen.getByRole('list', { name: /^Escenas de / })).getAllByRole('button', { name: /^Escena \d+: / }).map((button) => button.textContent?.replace(/^Escena \d+: /, ''));
const selectScene = (user: ReturnType<typeof userEvent.setup>, name: string) => user.click(within(screen.getByRole('list', { name: /^Escenas de / })).getByRole('button', { name: new RegExp(`^Escena \\d+: ${name}$`) }));
const scene = (name: RegExp | string) => screen.getByRole('region', { name: typeof name === 'string' ? new RegExp(`^Escena \\d+: ${name}$`) : name });

beforeEach(async () => {
  drawn.loads = 0; drawn.calls.length = 0;
  dataDir = await mkdtemp(join(tmpdir(), 'paso-storyboard-'));
  window.history.replaceState(null, '', '#/p/storyboard');
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  service = await startServer({ dataDir, port: 0, sessionToken: token, allowedOrigins: [window.location.origin], pollIntervalMs: 100,
    // The agent panel asks which harnesses are installed: never run the real ones from a test.
    harnessDetection: { searchPaths: [], loginShell: false } });
  config = { baseUrl: service.url, token };
});
afterEach(async () => {
  cleanup();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('the Estudio against the real service', () => {
  it('shows the scene selected in the sidebar, with number, title and count, and steps with number, optional title and a thumbnail', async () => {
    const user = userEvent.setup();
    await seed();
    render(<App config={config} />);
    await screen.findByRole('heading', { level: 2, name: 'El problema' }, patience);
    // One scene at a time: with none in the address, the first is selected.
    expect(sceneTitles()).toEqual(['El problema']);
    await waitFor(() => expect(window.location.hash).toBe('#/p/storyboard/a/a1'));
    expect(board()).toHaveTextContent('3 escenas · 4 pasos');
    const first = scene('El problema');
    expect(first).toHaveTextContent('Escena 1 de 3');
    expect(first).toHaveTextContent('3 pasos');
    // No scene tools here: the sidebar renames, moves and deletes scenes.
    expect(within(first).queryByRole('button', { name: /^Reordenar la escena/ })).not.toBeInTheDocument();
    expect(within(first).queryByRole('button', { name: /^Más acciones de la escena/ })).not.toBeInTheDocument();

    // The number is always there; the title follows it. Untitled steps show the number alone.
    await within(first).findByRole('button', { name: 'Paso 2: Mira en medio' }, patience);
    const frames = within(first).getAllByRole('button', { name: /^Paso/ });
    expect(frames.map((frame) => frame.textContent)).toEqual(['01', '02Mira en medio', '03']);
    expect(frames[1]).toHaveAccessibleName('Paso 2: Mira en medio');
    expect(frames[1]).toHaveAttribute('title', 'Mira en medio');

    // Thumbnails come from the service, drawn once per scene with the scene's steps, for the current theme.
    await waitFor(() => expect(first.querySelectorAll('.frame img')).toHaveLength(3), patience);
    expect(decodeURIComponent(first.querySelector('.frame img')!.getAttribute('src')!)).toContain('data-dark="false"');

    // Selecting another scene in the sidebar shows it instead, without leaving the Estudio.
    await selectScene(user, 'Partir en dos');
    await waitFor(() => expect(sceneTitles()).toEqual(['Partir en dos']), patience);
    expect(scene('Partir en dos')).toHaveTextContent('Escena 2 de 3');
    expect(scene('Partir en dos')).toHaveTextContent('1 paso');
    await selectScene(user, 'Vacía');
    await waitFor(() => expect(sceneTitles()).toEqual(['Vacía']), patience);
    expect(scene('Vacía')).toHaveTextContent('Sin pasos');
    expect(window.location.hash).toBe('#/p/storyboard/c');
  });

  it('names a step from its title, with a click or F2, while the rest of the card opens it', async () => {
    const user = userEvent.setup();
    await seed();
    render(<App config={config} />);
    const first = await screen.findByRole('region', { name: 'Escena 1: El problema' }, patience);
    await within(first).findByRole('button', { name: 'Paso 2: Mira en medio' }, patience);
    await user.click(within(first).getByRole('button', { name: 'Cambiar el título del paso 1' }));
    const field = within(first).getByRole('textbox', { name: 'Título del paso 1' });
    expect(field).toHaveFocus();
    await user.type(field, 'Antes de buscar{Enter}');
    await within(first).findByRole('button', { name: 'Paso 1: Antes de buscar' });
    await waitFor(async () => expect((await readJson('p', 'scenes', 'a', 'steps', 'a1.json')).title).toBe('Antes de buscar'));
    await waitFor(() => expect(within(first).getByRole('button', { name: 'Paso 1: Antes de buscar' })).toHaveFocus());
    expect(window.location.hash).toMatch(/storyboard/);   // naming it did not open it

    // F2 on a card; Escape gives up without leaving the Estudio.
    within(first).getByRole('button', { name: 'Paso 2: Mira en medio' }).focus();
    await user.keyboard('{F2}');
    const second = within(first).getByRole('textbox', { name: 'Título del paso 2' });
    expect(second).toHaveValue('Mira en medio');
    await user.keyboard('{Escape}');
    expect(within(first).queryByRole('textbox')).not.toBeInTheDocument();
    expect(board()).toBeInTheDocument();
    await waitFor(() => expect(within(first).getByRole('button', { name: 'Paso 2: Mira en medio' })).toHaveFocus());
    await user.keyboard('{F2}');
    await user.clear(within(first).getByRole('textbox', { name: 'Título del paso 2' }));
    await user.type(within(first).getByRole('textbox', { name: 'Título del paso 2' }), 'Partir{Enter}');
    await within(first).findByRole('button', { name: 'Paso 2: Partir' });

    // The card itself still opens the step.
    await user.click(within(first).getByRole('button', { name: 'Paso 1: Antes de buscar' }));
    await screen.findByRole('main', { name: 'Lienzo' }, patience);
  });

  it('shows both empty states with the action that fixes each', async () => {
    const user = userEvent.setup();
    await call('POST', '/projects', { id: 'p', name: 'Nuevo' });
    render(<App config={config} />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Este diagrama aún no tiene escenas' }, patience)).toBeInTheDocument();
    // Without steps there is nothing to draw, so Excalidraw is not even loaded.
    expect(drawn.loads).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Crear la primera escena' }));
    const field = await screen.findByLabelText('Nombre de la escena 1');
    expect(field).toHaveValue('Escena 1');
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, 'Introducción{Enter}');
    await screen.findByRole('heading', { level: 2, name: 'Introducción' }, patience);
    const [sceneId] = await sceneOrder();
    expect(await readJson('p', 'scenes', sceneId, 'scene.json')).toMatchObject({ name: 'Introducción', stepIds: [] });
    expect(scene('Introducción')).toHaveTextContent('Sin pasos');

    await user.click(screen.getByRole('button', { name: 'Añadir paso a la escena 1' }));
    await waitFor(() => expect(within(scene('Introducción')).getAllByRole('button', { name: /^Paso 1/ })).toHaveLength(1), patience);
    expect(await stepOrder(sceneId)).toHaveLength(1);
    expect(scene('Introducción')).toHaveTextContent('1 paso');
  });

  it('opens a step in the Lienzo by click and by keyboard, and marks the current step', async () => {
    const user = userEvent.setup();
    await seed();
    render(<App config={config} />);
    const first = await screen.findByRole('region', { name: /^Escena 1: El problema/ }, patience);
    await user.click(await within(first).findByRole('button', { name: 'Paso 2: Mira en medio' }, patience));
    expect(window.location.hash).toBe('#/p/lienzo/a/a2');
    expect(await screen.findByRole('main', { name: 'Lienzo' })).toBeInTheDocument();

    // Back in the overview, from the step strip, the step open in the Lienzo is the current one.
    await user.click(await screen.findByRole('button', { name: 'Estudio' }, patience));
    const again = await screen.findByRole('region', { name: /^Escena 1: El problema/ }, patience);
    expect(await within(again).findByRole('button', { name: 'Paso 2: Mira en medio' }, patience)).toHaveAttribute('aria-current', 'step');
    expect(within(again).getByRole('button', { name: 'Paso 1' })).not.toHaveAttribute('aria-current');

    // One tab stop per scene; arrows move across the steps and the add slot; Enter opens.
    const frames = within(again).getAllByRole('button', { name: /^Paso/ });
    expect(frames.filter((frame) => frame.tabIndex === 0)).toHaveLength(1);
    frames[0].focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(frames[2]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(within(again).getByRole('button', { name: 'Añadir paso a la escena 1' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{Enter}');
    expect(window.location.hash).toBe('#/p/lienzo/a/a3');
  });

  it('follows edits made outside the app: scenes, order, steps, titles and thumbnails', async () => {
    await seed();
    render(<App config={config} />);
    const first = await screen.findByRole('region', { name: /^Escena 1: El problema/ }, patience);
    await waitFor(() => expect(first.querySelectorAll('.frame img')).toHaveLength(3), patience);
    const thumbnailOf = (n: number) => decodeURIComponent(within(scene('El problema')).getByRole('button', { name: new RegExp(`^Paso ${n}`) }).querySelector('img')!.getAttribute('src')!);

    // A scene by another client, renamed, then moved to the front: the sidebar follows, and the Estudio keeps its scene.
    await call('POST', '/projects/p/scenes', { id: 'ext', name: 'Externa' });
    await waitFor(() => expect(sidebarScenes()).toContain('Externa'), patience);
    const ext = await call<Doc<unknown>>('GET', '/projects/p/scenes/ext');
    await call('PATCH', '/projects/p/scenes/ext', { name: 'Externa renombrada' }, ext.revision);
    await waitFor(() => expect(sidebarScenes()).toContain('Externa renombrada'), patience);
    const project = await call<Doc<unknown>>('GET', '/projects/p');
    await call('PUT', '/projects/p/scenes', { ids: ['ext', 'a', 'b', 'c'] }, project.revision);
    await waitFor(() => expect(sidebarScenes()[0]).toBe('Externa renombrada'), patience);
    expect(sceneTitles()).toEqual(['El problema']);
    await waitFor(() => expect(scene('El problema')).toHaveTextContent('Escena 2 de 4'), patience);

    // A new step arrives with its title, and its scene is drawn again.
    await call('POST', '/projects/p/scenes/a/steps', { id: 'a4', title: 'Nuevo', elements: [rect('a4-r', 9)] });
    await waitFor(() => expect(within(scene('El problema')).getByRole('button', { name: 'Paso 4: Nuevo' })).toBeInTheDocument(), patience);
    await waitFor(() => expect(within(scene('El problema')).getByRole('button', { name: 'Paso 4: Nuevo' }).querySelector('img')).not.toBeNull(), patience);
    expect(scene('El problema')).toHaveTextContent('4 pasos');

    // The file of one step is edited on disk: only that revision changes, and its thumbnail is redrawn.
    const before = thumbnailOf(1);
    expect(before).toContain('a1-r');
    const file = join(dataDir, 'p', 'scenes', 'a', 'steps', 'a1.json');
    const step = JSON.parse(await readFile(file, 'utf8')) as { elements: Array<Record<string, unknown>> };
    step.elements.push(rect('a1-extra', 50));
    await writeFile(file, `${JSON.stringify(step, null, 2)}\n`);
    await waitFor(() => expect(thumbnailOf(1)).toContain('a1-extra'), patience);
    expect(thumbnailOf(1)).not.toBe(before);

    // Removing a step and a scene.
    const a4 = await call<Doc<unknown>>('GET', '/projects/p/scenes/a/steps/a4');
    await call('DELETE', '/projects/p/scenes/a/steps/a4', undefined, a4.revision);
    await waitFor(() => expect(scene('El problema')).toHaveTextContent('3 pasos'), patience);
    const b = await call<Doc<unknown>>('GET', '/projects/p/scenes/b');
    await call('DELETE', '/projects/p/scenes/b', undefined, b.revision);
    await waitFor(() => expect(sidebarScenes()).not.toContain('Partir en dos'), patience);
  });

  it('redraws thumbnails only when a revision or the theme changes', async () => {
    await seed();
    render(<App config={config} />);
    const first = await screen.findByRole('region', { name: /^Escena 1: El problema/ }, patience);
    await waitFor(() => expect(first.querySelectorAll('.frame img')).toHaveLength(3), patience);
    const drawnOnce = drawn.calls.length;
    // A renamed scene changes no step revision: nothing is drawn again.
    const a = await call<Doc<unknown>>('GET', '/projects/p/scenes/a');
    await call('PATCH', '/projects/p/scenes/a', { name: 'Otro nombre' }, a.revision);
    await screen.findByRole('heading', { level: 2, name: 'Otro nombre' }, patience);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(drawn.calls.length).toBe(drawnOnce);

    // The other theme is drawn by the exporter itself, so the thumbnails are never recoloured by hand.
    document.documentElement.dataset.theme = 'dark';
    await waitFor(() => expect(decodeURIComponent(first.querySelector('.frame img')!.getAttribute('src')!)).toContain('data-dark="true"'), patience);
    expect(drawn.calls.length).toBeGreaterThan(drawnOnce);
  });
});

describe('lazy thumbnails', () => {
  it('draws a scene only once it nears the screen', async () => {
    const watching: Array<{ target: Element; callback: IntersectionObserverCallback }> = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) { watching.push({ target, callback: this.callback }); }
      disconnect() {}
      unobserve() {}
    });
    await seed();
    render(<App config={config} />);
    await screen.findByRole('region', { name: /^Escena 1: El problema/ }, patience);
    // The scene is watched and not near yet: its frames wait as quiet placeholders and nothing is drawn.
    await waitFor(() => expect(watching.some((entry) => entry.target.getAttribute('aria-label')?.startsWith('Escena 1'))).toBe(true), patience);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(drawn.loads).toBe(0);
    expect(document.querySelectorAll('.board .frame__paper[data-state="loading"]').length).toBe(3);

    const first = [...watching].reverse().find((entry) => entry.target.getAttribute('aria-label')?.startsWith('Escena 1'))!;
    first.callback([{ isIntersecting: true, target: first.target } as IntersectionObserverEntry], {} as IntersectionObserver);
    await waitFor(() => expect(scene('El problema').querySelectorAll('.frame img')).toHaveLength(3), patience);
    expect(drawn.calls).toEqual(['+a1-r', '+a2-r', '+a3-r']);   // only the scene on show
  });
});

describe('StepFrame', () => {
  it('always shows the number, puts the title after it only on the storyboard, and marks the current step', () => {
    const { rerender } = render(<StepFrame number={3} title="Mira en medio" />);
    expect(screen.getByRole('button')).toHaveTextContent('03Mira en medio');
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Mira en medio');
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-current');
    // The carousel has no room for the title: the number stands alone and the title is the tooltip.
    rerender(<StepFrame number={3} title="Mira en medio" size="carousel" current />);
    expect(screen.getByRole('button')).toHaveTextContent(/^03$/);
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Mira en medio');
    expect(screen.getByRole('button')).toHaveAttribute('aria-current', 'step');
    rerender(<StepFrame number={12} />);
    expect(screen.getByRole('button')).toHaveTextContent(/^12$/);
    expect(document.querySelector('.frame__paper')).toHaveAttribute('data-state', 'loading');
    rerender(<StepFrame number={12} svg="<svg/>" />);
    expect(document.querySelector('.frame__paper img')).not.toBeNull();
  });
});

describe('RenderQueue', () => {
  it('runs one task at a time in order and skips a task whose caller gave up', async () => {
    const queue = new RenderQueue();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => { log.push(`start ${name}`); await new Promise((resolve) => setTimeout(resolve, ms)); log.push(`end ${name}`); return name; };
    let giveUp = false;
    const first = queue.run(task('a', 30), () => false);
    const second = queue.run(task('b', 0), () => giveUp);
    const third = queue.run(task('c', 0), () => false);
    giveUp = true;
    expect(await Promise.all([first, second, third])).toEqual(['a', undefined, 'c']);
    expect(log).toEqual(['start a', 'end a', 'start c', 'end c']);
  });
});
