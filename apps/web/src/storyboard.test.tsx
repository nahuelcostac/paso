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
const board = () => screen.getByRole('main', { name: 'Storyboard' });
const sceneTitles = () => within(board()).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
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

describe('the Storyboard against the real service', () => {
  it('lays out scenes with number, title and count, and steps with number, optional title and a thumbnail', async () => {
    await seed();
    render(<App config={config} />);
    await screen.findByRole('heading', { level: 2, name: 'El problema' }, patience);
    expect(sceneTitles()).toEqual(['El problema', 'Partir en dos', 'Vacía']);
    expect(board()).toHaveTextContent('3 escenas · 4 pasos');
    const first = scene('El problema');
    expect(first).toHaveTextContent('Escena 1 de 3');
    expect(first).toHaveTextContent('3 pasos');
    expect(scene('Partir en dos')).toHaveTextContent('1 paso');
    expect(scene('Vacía')).toHaveTextContent('Sin pasos');

    // The number is always there; the title follows it. Untitled steps show the number alone.
    await within(first).findByRole('button', { name: 'Paso 2: Mira en medio' }, patience);
    const frames = within(first).getAllByRole('button', { name: /^Paso/ });
    expect(frames.map((frame) => frame.textContent)).toEqual(['01', '02Mira en medio', '03']);
    expect(frames[1]).toHaveAccessibleName('Paso 2: Mira en medio');
    expect(frames[1]).toHaveAttribute('title', 'Mira en medio');

    // Thumbnails come from the service, drawn once per scene with the scene's steps, for the current theme.
    await waitFor(() => expect(first.querySelectorAll('.frame img')).toHaveLength(3), patience);
    expect(decodeURIComponent(first.querySelector('.frame img')!.getAttribute('src')!)).toContain('data-dark="false"');
  });

  it('shows both empty states with the action that fixes each', async () => {
    const user = userEvent.setup();
    await call('POST', '/projects', { id: 'p', name: 'Nuevo' });
    render(<App config={config} />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Este proyecto aún no tiene escenas' }, patience)).toBeInTheDocument();
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

  it('renames a scene, keeping the old name on Escape', async () => {
    const user = userEvent.setup();
    await seed();
    render(<App config={config} />);
    await screen.findByRole('heading', { level: 2, name: 'El problema' }, patience);
    const menu = () => user.click(screen.getByRole('button', { name: /^Más acciones de la escena 1,/ }));

    await menu();
    await user.click(await screen.findByRole('menuitem', { name: 'Renombrar' }));
    await user.type(screen.getByLabelText('Nombre de la escena 1'), 'No se guarda{Escape}');
    expect(screen.getByRole('heading', { level: 2, name: 'El problema' })).toBeInTheDocument();
    expect((await readJson('p', 'scenes', 'a', 'scene.json')).name).toBe('El problema');

    await menu();
    await user.click(await screen.findByRole('menuitem', { name: 'Renombrar' }));
    const field = screen.getByLabelText('Nombre de la escena 1');
    await user.clear(field);
    await user.type(field, 'El enunciado{Enter}');
    await screen.findByRole('heading', { level: 2, name: 'El enunciado' }, patience);
    expect((await readJson('p', 'scenes', 'a', 'scene.json')).name).toBe('El enunciado');
  });

  it('asks before deleting a scene, says how many steps go, and removes its folder', async () => {
    const user = userEvent.setup();
    await seed();
    render(<App config={config} />);
    await screen.findByRole('heading', { level: 2, name: 'El problema' }, patience);

    await user.click(screen.getByRole('button', { name: /^Más acciones de la escena 1,/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Eliminar/ }));
    const dialog = await screen.findByRole('alertdialog', { name: '¿Eliminar la escena «El problema»?' });
    expect(dialog).toHaveTextContent('Se borrarán 3 pasos. No se puede deshacer.');
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(await sceneOrder()).toEqual(['a', 'b', 'c']);

    await user.click(screen.getByRole('button', { name: /^Más acciones de la escena 1,/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Eliminar/ }));
    await user.click(await screen.findByRole('button', { name: 'Eliminar escena' }));
    await waitFor(() => expect(sceneTitles()).toEqual(['Partir en dos', 'Vacía']), patience);
    expect(await sceneOrder()).toEqual(['b', 'c']);
    await expect(readFile(join(dataDir, 'p', 'scenes', 'a', 'scene.json'))).rejects.toThrow();
    // Numbers follow the new order.
    expect(scene('Partir en dos')).toHaveTextContent('Escena 1 de 2');
  });

  it('reorders scenes by keyboard: pick up, move, drop; Escape puts the scene back', async () => {
    const user = userEvent.setup();
    await seed();
    render(<App config={config} />);
    await screen.findByRole('heading', { level: 2, name: 'El problema' }, patience);
    const grip = (n: number) => screen.getByRole('button', { name: new RegExp(`^Reordenar la escena ${n},`) });

    grip(3).focus();
    await user.keyboard('{Enter}');
    expect(grip(3)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent(/agarrada/);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    // It moves on screen at once, but nothing is written until it is dropped.
    expect(sceneTitles()).toEqual(['Vacía', 'El problema', 'Partir en dos']);
    expect(await sceneOrder()).toEqual(['a', 'b', 'c']);
    await user.keyboard('{Enter}');
    await waitFor(async () => expect(await sceneOrder()).toEqual(['c', 'a', 'b']), patience);
    expect(sceneTitles()).toEqual(['Vacía', 'El problema', 'Partir en dos']);
    expect(scene('Vacía')).toHaveTextContent('Escena 1 de 3');

    grip(1).focus();
    await user.keyboard('{Enter}{ArrowDown}{Escape}');
    expect(sceneTitles()).toEqual(['Vacía', 'El problema', 'Partir en dos']);
    expect(await sceneOrder()).toEqual(['c', 'a', 'b']);
  });

  it('moves a scene up or down from its menu, with the ends disabled', async () => {
    const user = userEvent.setup();
    await seed();
    render(<App config={config} />);
    await screen.findByRole('heading', { level: 2, name: 'El problema' }, patience);

    await user.click(screen.getByRole('button', { name: /^Más acciones de la escena 1,/ }));
    expect(await screen.findByRole('menuitem', { name: 'Mover arriba' })).toBeDisabled();
    await user.click(screen.getByRole('menuitem', { name: 'Mover abajo' }));
    await waitFor(async () => expect(await sceneOrder()).toEqual(['b', 'a', 'c']), patience);
    expect(sceneTitles()).toEqual(['Partir en dos', 'El problema', 'Vacía']);
  });

  it('opens a step in the Lienzo by click and by keyboard, and marks the current step', async () => {
    const user = userEvent.setup();
    await seed();
    render(<App config={config} />);
    const first = await screen.findByRole('region', { name: /^Escena 1: El problema/ }, patience);
    await user.click(await within(first).findByRole('button', { name: 'Paso 2: Mira en medio' }, patience));
    expect(window.location.hash).toBe('#/p/lienzo/a/a2');
    expect(await screen.findByRole('main', { name: 'Lienzo' })).toBeInTheDocument();

    // Back in the Storyboard the step open in the Lienzo is the current one.
    await user.click(screen.getByRole('radio', { name: 'Storyboard' }));
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

    // A scene by another client, renamed, then moved to the front.
    await call('POST', '/projects/p/scenes', { id: 'ext', name: 'Externa' });
    await screen.findByRole('heading', { level: 2, name: 'Externa' }, patience);
    const ext = await call<Doc<unknown>>('GET', '/projects/p/scenes/ext');
    await call('PATCH', '/projects/p/scenes/ext', { name: 'Externa renombrada' }, ext.revision);
    await screen.findByRole('heading', { level: 2, name: 'Externa renombrada' }, patience);
    const project = await call<Doc<unknown>>('GET', '/projects/p');
    await call('PUT', '/projects/p/scenes', { ids: ['ext', 'a', 'b', 'c'] }, project.revision);
    await waitFor(() => expect(sceneTitles()[0]).toBe('Externa renombrada'), patience);

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
    await waitFor(() => expect(sceneTitles()).not.toContain('Partir en dos'), patience);
  });

  it('redraws thumbnails only when a revision or the theme changes', async () => {
    await seed();
    render(<App config={config} />);
    const first = await screen.findByRole('region', { name: /^Escena 1: El problema/ }, patience);
    await waitFor(() => expect(first.querySelectorAll('.frame img')).toHaveLength(3), patience);
    await waitFor(() => expect(scene('Partir en dos').querySelectorAll('.frame img')).toHaveLength(1), patience);
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
    // Every scene is watched and none is near yet: the frames wait as quiet placeholders and nothing is drawn.
    await waitFor(() => expect(watching.length).toBeGreaterThanOrEqual(3), patience);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(drawn.loads).toBe(0);
    expect(document.querySelectorAll('.frame__paper[data-state="loading"]').length).toBe(4);

    const second = watching.find((entry) => entry.target.getAttribute('aria-label')?.startsWith('Escena 2'))!;
    second.callback([{ isIntersecting: true, target: second.target } as IntersectionObserverEntry], {} as IntersectionObserver);
    await waitFor(() => expect(scene('Partir en dos').querySelectorAll('.frame img')).toHaveLength(1), patience);
    expect(document.querySelectorAll('.frame img')).toHaveLength(1);
    expect(drawn.calls.every((ids) => ids.includes('b1'))).toBe(true);
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
