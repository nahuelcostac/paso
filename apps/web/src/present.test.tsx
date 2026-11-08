// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '@paso/server';
import { App } from './App';
import type { Draft, Recovery } from './editor/step-store';
import { ApiClient, type ClientConfig } from './lib/api';

/**
 * Presentar with the real app, service, store and keyboard. Two edges are stand-ins because jsdom has no canvas:
 * Excalidraw itself and the drawing of a page. Bounds and fidelity are measured in a real browser instead.
 */
const mocks = vi.hoisted(() => ({ renders: [] as string[], failing: new Set<string>() }));
vi.mock('./editor/StepCanvas', async () => {
  const { useEffect } = await import('react');
  const shape = (id: string) => ({ id, type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false, x: 0, y: 0, width: 10, height: 10 });
  return { default: ({ store, session }: { store: import('./editor/step-store').StepStore; session: import('./editor/step-store').Session }) => {
    useEffect(() => { session.baseline = undefined; store.change(session, session.document.elements, session.document.appState, {}); }, [session, store]);
    return <div data-testid="canvas" data-step-id={session.target.stepId}>
      <button type="button" onClick={() => store.change(session, [...session.document.elements, shape(`drawn-${session.document.elements.length}`)], session.document.appState, {})}>Dibujar</button>
    </div>;
  } };
});
vi.mock('./editor/use-thumbnails', () => ({ useThumbnails: () => ({ svgs: {}, titles: {} }) }));
vi.mock('./editor/scene-content', () => ({ restoreSceneContent: async (steps: Array<{ elements: Array<{ isDeleted: boolean; x: number; y: number; width: number; height: number }> }>) => {
  const elements = steps.map((step) => step.elements.filter((element) => !element.isDeleted));
  return { elements, bounds: elements.filter((drawn) => drawn.length > 0).map((drawn) => [Math.min(...drawn.map((e) => e.x)), Math.min(...drawn.map((e) => e.y)), Math.max(...drawn.map((e) => e.x + e.width)), Math.max(...drawn.map((e) => e.y + e.height))]) };
} }));
vi.mock('./present/pages', async (original) => {
  const real = await original<typeof import('./present/pages')>();
  return { ...real, renderPage: async (_api: unknown, _project: string, deck: import('./present/pages').Deck, step: import('./present/pages').DeckStep, theme: 'light' | 'dark') => {
    mocks.renders.push(step.id);
    if (mocks.failing.has(step.id)) throw new Error('no se puede');
    return { key: real.pageKey(deck, step, theme), stepId: step.id, url: `page:${step.id}:${step.document.elements.map((e) => e.id).join('+')}`, content: deck.content, anchor: deck.anchor, paper: '#ffffff' };
  } };
});

vi.setConfig({ testTimeout: 30_000 });
// Each wait crosses a real service. The default second is too short on a busy machine.
configure({ asyncUtilTimeout: 5000 });
type Service = Awaited<ReturnType<typeof startServer>>;
const token = 'present-test-session-token-with-32-chars-plus';
const memory = (): Recovery => { const drafts = new Map<string, Draft>(); return { read: async (key) => drafts.get(key), write: async (key, draft) => { drafts.set(key, structuredClone(draft)); }, remove: async (key) => { drafts.delete(key); } }; };
let service: Service; let dataDir: string; let config: ClientConfig; let api: ApiClient; let recovery: Recovery;
const box = (id: string, x = 0) => ({ id, type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false, x, y: 0, width: 100, height: 100 });

beforeEach(async () => {
  mocks.renders.length = 0; mocks.failing.clear();
  URL.revokeObjectURL ??= () => {};
  dataDir = await mkdtemp(join(tmpdir(), 'paso-present-'));
  window.history.replaceState(null, '', '/');
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  service = await startServer({ dataDir, port: 0, sessionToken: token, allowedOrigins: [window.location.origin], pollIntervalMs: 100,
    // The agent panel asks which harnesses are installed: never run the real ones from a test.
    harnessDetection: { searchPaths: [], loginShell: false } });
  config = { baseUrl: service.url, token }; api = new ApiClient(config); recovery = memory();
});
afterEach(async () => { cleanup(); await service.close(); await rm(dataDir, { recursive: true, force: true }); });

/** Steps with the given elements. The address opens the step at `start`. */
async function open(contents: Array<Array<ReturnType<typeof box>>>, start = 0) {
  const { document: project } = await api.createProject({ name: 'Proyecto' });
  const sceneId = (await api.createScene(project.id, 'Escena')).document.id;
  const steps: string[] = [];
  for (const elements of contents) steps.push((await api.createStep(project.id, sceneId, { elements })).document.id);
  window.location.hash = `#/${project.id}/lienzo/${sceneId}${steps[start] ? `/${steps[start]}` : ''}`;
  render(<App config={config} recovery={recovery} />);
  return { projectId: project.id, sceneId, steps };
}
const hashStep = () => window.location.hash.replace(/^#\//, '').split('/')[3];
const presentar = () => screen.findByRole('button', { name: 'Presentar' });
const stage = () => screen.findByRole('dialog', { name: 'Presentación' });
const shownImage = () => document.querySelector('.present__page[data-state="current"] img');
const expectShown = (stepId: string) => waitFor(() => expect(document.querySelector('.present__page[data-state="current"]')).toHaveAttribute('data-step-id', stepId));
const expectIndicator = (label: string) => waitFor(() => expect(screen.getByRole('status', { name: label })).toBeInTheDocument());
async function start(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByTestId('canvas');
  await waitFor(async () => expect(await presentar()).toBeEnabled());
  await user.click(await presentar());
  return stage();
}

describe('the Presentar button', () => {
  it('is in the top bar of the Lienzo, and not on the Storyboard', async () => {
    const user = userEvent.setup();
    await open([[box('a')]]);
    const button = await presentar();
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Presentar' })).toBe(button);
    await user.click(screen.getByRole('radio', { name: 'Storyboard' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Presentar' })).not.toBeInTheDocument());
    expect(document.querySelector('[data-slot="presentar"]')).toBeInTheDocument();
  });
  it('is disabled on a scene with no steps, and says why', async () => {
    await open([]);
    const button = await presentar();
    await waitFor(() => expect(button).toHaveAttribute('title', 'Esta escena no tiene pasos que presentar'));
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole('dialog', { name: 'Presentación' })).not.toBeInTheDocument();
  });
  it('saves unsaved edits first, so the presentation shows them', async () => {
    const user = userEvent.setup();
    const { projectId, sceneId, steps } = await open([[box('a')], [box('b')]]);
    await screen.findByTestId('canvas');
    await user.click(screen.getByRole('button', { name: 'Dibujar' }));
    expect(document.querySelector('.topbar [data-save-state]')).toHaveTextContent('Cambios pendientes');
    await user.click(await presentar());
    await stage();
    expect((await api.getStep({ projectId, sceneId, stepId: steps[0] })).document.elements.map((e) => e.id)).toEqual(['a', 'drawn-1']);
    await waitFor(() => expect(shownImage()).toHaveAttribute('src', `page:${steps[0]}:a+drawn-1`));
  });
  it('does not present over a conflict, and tells the person', async () => {
    const user = userEvent.setup();
    const { projectId, sceneId, steps } = await open([[box('a')]]);
    await screen.findByTestId('canvas');
    await user.click(screen.getByRole('button', { name: 'Dibujar' }));
    const stored = await api.getStep({ projectId, sceneId, stepId: steps[0] });
    await api.saveStep({ projectId, sceneId, stepId: steps[0] }, stored.revision, { ...stored.document, title: 'externo' });
    await waitFor(() => expect(screen.getByText(/El paso cambió fuera de Paso/)).toBeInTheDocument());
    await user.click(await presentar());
    expect(await screen.findByText('No se puede presentar: el paso 1 tiene un conflicto.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Presentación' })).not.toBeInTheDocument();
    // The notice can be dismissed, and pressing again tells it again.
    await user.click(screen.getAllByRole('button', { name: 'Cerrar aviso' })[0]);
    expect(screen.queryByText(/No se puede presentar/)).not.toBeInTheDocument();
  });
  it('does not present when a save fails, and tells the person', async () => {
    const user = userEvent.setup();
    await open([[box('a')]]);
    await screen.findByTestId('canvas');
    await waitFor(async () => expect(await presentar()).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Dibujar' }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError('offline'); }) as typeof fetch;
    try {
      await user.click(await presentar());
      expect(await screen.findByText('No se puede presentar: el paso 1 no se pudo guardar.')).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Presentación' })).not.toBeInTheDocument();
    } finally { globalThis.fetch = realFetch; }
  });
  it('says so and returns when the scene cannot be read', async () => {
    const user = userEvent.setup();
    const { projectId, sceneId } = await open([[box('a')]]);
    await screen.findByTestId('canvas');
    await waitFor(async () => expect(await presentar()).toBeEnabled());
    const realList = ApiClient.prototype.listSteps;
    ApiClient.prototype.listSteps = async function (project, scene) { if (project === projectId && scene === sceneId) throw new Error('caído'); return realList.call(this, project, scene); };
    try {
      await user.click(await presentar());
      expect(await screen.findByText('No se pudo preparar la presentación.')).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Presentación' })).not.toBeInTheDocument();
    } finally { ApiClient.prototype.listSteps = realList; }
  });
});

describe('moving through the presentation', () => {
  it('starts from the current step, moves with every key, and leaves on the step last shown', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')], [box('c')], [box('d')]], 1);
    await start(user);
    await expectShown(steps[1]); await expectIndicator('Paso 2 de 4');
    expect(document.querySelectorAll('.indicator__ticks i')).toHaveLength(4);
    expect(document.querySelectorAll('.indicator__ticks i.on')).toHaveLength(1);
    expect(screen.getByText('02 / 04')).toBeInTheDocument();
    for (const [key, target] of [['{ArrowRight}', 2], ['{ArrowRight}', 3], ['{ArrowRight}', 3], ['{ArrowLeft}', 2], ['{PageUp}', 1], ['{PageDown}', 2], [' ', 3], ['{Home}', 0], ['{ArrowLeft}', 0], ['{End}', 3]] as const) {
      await user.keyboard(key);
      await expectShown(steps[target]);
      await expectIndicator(`Paso ${target + 1} de 4`);
    }
    await user.keyboard('{Home}'); await user.keyboard('{ArrowRight}'); await user.keyboard('{ArrowRight}');
    await expectShown(steps[2]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentación' })).not.toBeInTheDocument());
    await waitFor(() => expect(hashStep()).toBe(steps[2]));
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', steps[2]));
  });
  it('leaves with «Salir» on the step last shown, and the click does not move the presentation first', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')], [box('c')]], 1);
    await start(user);
    await expectShown(steps[1]);
    const exit = screen.getByRole('button', { name: /Salir/ });
    expect(exit).toHaveAttribute('tabindex', '-1');   // Tab stays in the presentation; Esc is the keyboard's way out.
    await user.click(exit);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentación' })).not.toBeInTheDocument());
    await waitFor(() => expect(hashStep()).toBe(steps[1]));
  });
  it('does not touch the address or the Lienzo while it presents', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')]]);
    await start(user);
    await expectShown(steps[0]);
    await user.keyboard('{ArrowRight}'); await expectShown(steps[1]);
    expect(hashStep()).toBe(steps[0]);
    expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', steps[0]);
  });
  it('moves with a click on either half of the screen', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')]]);
    const dialog = await start(user);
    await expectShown(steps[0]);
    fireEvent.click(dialog, { clientX: window.innerWidth - 10 }); await expectShown(steps[1]);
    fireEvent.click(dialog, { clientX: 10 }); await expectShown(steps[0]);
  });
  it('shows a scene of one step, and an empty step within a scene', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [], [box('c')]]);
    await start(user);
    await expectShown(steps[0]);
    await user.keyboard('{ArrowRight}'); await expectShown(steps[1]); await expectIndicator('Paso 2 de 3');
    expect(shownImage()).toHaveAttribute('src', `page:${steps[1]}:`);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('has somewhere to stop in a scene of one step', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')]]);
    await start(user);
    await expectShown(steps[0]); await expectIndicator('Paso 1 de 1');
    await user.keyboard('{ArrowRight}{ArrowLeft}{End}{Home}');
    await expectIndicator('Paso 1 de 1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('prepares only the neighbours in a very long scene, and drops the ticks', async () => {
    const user = userEvent.setup();
    const { steps } = await open(Array.from({ length: 40 }, (_, i) => [box(`b${i}`)]), 20);
    await start(user);
    await expectShown(steps[20]); await expectIndicator('Paso 21 de 40');
    await waitFor(() => expect(mocks.renders).toHaveLength(5));
    expect(new Set(mocks.renders)).toEqual(new Set([steps[20], steps[21], steps[19], steps[22], steps[18]]));
    expect(document.querySelector('.indicator__ticks')).not.toBeInTheDocument();
    expect(screen.getByText('21 / 40')).toBeInTheDocument();
    await user.keyboard('{End}');
    await expectShown(steps[39]);
  });
  it('says so when a step cannot be drawn, and goes on', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')], [box('c')]]);
    mocks.failing.add(steps[1]);
    await start(user);
    await expectShown(steps[0]);
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByText('No se pudo dibujar este paso.')).toBeInTheDocument();
    await expectIndicator('Paso 2 de 3');
    await user.keyboard('{ArrowRight}'); await expectShown(steps[2]);
    expect(screen.queryByText('No se pudo dibujar este paso.')).not.toBeInTheDocument();
    // A new view tries again.
    mocks.failing.clear();
    await user.keyboard('{ArrowLeft}'); await expectShown(steps[1]);
  });
});

describe('steps changing on the service during the presentation', () => {
  it('shows the current version on the next view, without redrawing the step on screen', async () => {
    const user = userEvent.setup();
    const { projectId, sceneId, steps } = await open([[box('a')], [box('b')]]);
    await start(user);
    await expectShown(steps[0]);
    const target = { projectId, sceneId, stepId: steps[0] };
    const stored = await api.getStep(target);
    await api.saveStep(target, stored.revision, { ...stored.document, elements: [box('a'), box('new', 50)] });
    // The fresh version gets prepared underneath while the old one stays on screen.
    await waitFor(() => expect(document.querySelector(`.present__page[data-state="ready"] img[src="page:${steps[0]}:a+new"]`)).toBeInTheDocument());
    expect(shownImage()).toHaveAttribute('src', `page:${steps[0]}:a`);
    await user.keyboard('{ArrowRight}'); await expectShown(steps[1]);
    await user.keyboard('{ArrowLeft}'); await expectShown(steps[0]);
    await waitFor(() => expect(shownImage()).toHaveAttribute('src', `page:${steps[0]}:a+new`));
  });
  it('moves the common framing when another step grows, for the next view', async () => {
    const user = userEvent.setup();
    const { projectId, sceneId, steps } = await open([[box('a')], [box('b')]]);
    await start(user);
    await expectShown(steps[0]);
    const before = (shownImage() as HTMLElement).style.width;
    await waitFor(() => expect(document.querySelector(`.present__page[data-step-id="${steps[1]}"] img`)).toBeInTheDocument());
    const target = { projectId, sceneId, stepId: steps[1] };
    const stored = await api.getStep(target);
    await api.saveStep(target, stored.revision, { ...stored.document, elements: [box('b'), box('far', 5000)] });
    await waitFor(() => expect(document.querySelector(`.present__page[data-state="ready"] img[src="page:${steps[1]}:b+far"]`)).toBeInTheDocument());
    expect((shownImage() as HTMLElement).style.width).toBe(before);
    await user.keyboard('{ArrowRight}'); await expectShown(steps[1]);
    await waitFor(() => expect((shownImage() as HTMLElement).style.width).not.toBe(before));
  });
  it('lands on a neighbour when the step on screen is deleted, and counts again', async () => {
    const user = userEvent.setup();
    const { projectId, sceneId, steps } = await open([[box('a')], [box('b')], [box('c')]], 2);
    await start(user);
    await expectShown(steps[2]); await expectIndicator('Paso 3 de 3');
    const target = { projectId, sceneId, stepId: steps[2] };
    await api.deleteStep(target, (await api.getStep(target)).revision);
    await expectShown(steps[1]); await expectIndicator('Paso 2 de 2');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The Lienzo underneath moves off the deleted step on its own. Leaving afterwards lands on the step last shown.
    await waitFor(() => expect(hashStep()).not.toBe(steps[2]));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(hashStep()).toBe(steps[1]));
  });
  it('ends when the scene is gone', async () => {
    const user = userEvent.setup();
    const { projectId, sceneId, steps } = await open([[box('a')], [box('b')]]);
    await start(user);
    await expectShown(steps[0]);
    const scene = await api.getScene(projectId, sceneId);
    const response = await fetch(`${service.url}/api/projects/${projectId}/scenes/${sceneId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'If-Match': `"${scene.revision}"` } });
    expect(response.ok).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentación' })).not.toBeInTheDocument());
    expect(document.fullscreenElement ?? null).toBeNull();
  });
});

describe('fullscreen', () => {
  /** jsdom has none. This behaves as a browser that grants it. */
  function grantFullscreen() {
    const root = document.documentElement;
    let element: Element | null = null;
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element });
    root.requestFullscreen = vi.fn(async () => { element = root; document.dispatchEvent(new Event('fullscreenchange')); });
    document.exitFullscreen = vi.fn(async () => { element = null; document.dispatchEvent(new Event('fullscreenchange')); });
    return { browserExit: () => { element = null; document.dispatchEvent(new Event('fullscreenchange')); } };
  }
  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
    delete (document as unknown as Record<string, unknown>).fullscreenElement;
    delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
    delete (document as unknown as Record<string, unknown>).exitFullscreen;
  });
  it('fills the window when the browser has none', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')]]);
    expect(document.fullscreenEnabled).toBeFalsy();
    await start(user);
    await expectShown(steps[0]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentación' })).not.toBeInTheDocument());
  });
  it('still presents when the browser refuses it', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')]]);
    grantFullscreen();
    document.documentElement.requestFullscreen = vi.fn(async () => { throw new TypeError('denegado'); });
    await start(user);
    await expectShown(steps[0]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('asks for it, gives it back on leaving, and does not leave twice', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')]]);
    grantFullscreen();
    await start(user);
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    await expectShown(steps[0]);
    await user.keyboard('{ArrowRight}'); await expectShown(steps[1]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentación' })).not.toBeInTheDocument());
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(hashStep()).toBe(steps[1]));
  });
  it('leaves cleanly when the person uses the browser\'s own control, on the step last shown', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')]]);
    const browser = grantFullscreen();
    await start(user);
    await expectShown(steps[0]);
    await user.keyboard('{ArrowRight}'); await expectShown(steps[1]);
    browser.browserExit();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentación' })).not.toBeInTheDocument());
    expect(document.exitFullscreen).not.toHaveBeenCalled();
    await waitFor(() => expect(hashStep()).toBe(steps[1]));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('gives it back if the person has left before the browser answers', async () => {
    const user = userEvent.setup();
    await open([[box('a')]]);
    grantFullscreen();
    let answer!: () => void;
    const request = document.documentElement.requestFullscreen;
    document.documentElement.requestFullscreen = vi.fn(() => new Promise<void>((resolve) => { answer = () => { void request.call(document.documentElement).then(resolve); }; }));
    await start(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentación' })).not.toBeInTheDocument());
    answer();
    await waitFor(() => expect(document.fullscreenElement).toBeNull());
  });
});

describe('the cursor', () => {
  it('hides after a moment of inactivity and comes back with a real move', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')]]);
    const dialog = await start(user);
    await expectShown(steps[0]);
    expect(dialog).toHaveAttribute('data-idle', 'false');
    await waitFor(() => expect(dialog).toHaveAttribute('data-idle', 'true'), { timeout: 3500 });
    fireEvent.mouseMove(window, { clientX: 10, clientY: 10 });
    await waitFor(() => expect(dialog).toHaveAttribute('data-idle', 'false'));
    await waitFor(() => expect(dialog).toHaveAttribute('data-idle', 'true'), { timeout: 3500 });
    // A move with the same coordinates is the browser's, after a layout change.
    fireEvent.mouseMove(window, { clientX: 10, clientY: 10 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dialog).toHaveAttribute('data-idle', 'true');
  });
});
