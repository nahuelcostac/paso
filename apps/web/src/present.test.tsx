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
 * Present with the real app, service, store and keyboard. Two edges are stand-ins because jsdom has no canvas:
 * Excalidraw itself and the drawing of a page. Bounds and fidelity are measured in a real browser instead.
 */
const mocks = vi.hoisted(() => ({ renders: [] as string[], failing: new Set<string>() }));
vi.mock('./editor/StepCanvas', () => import('./editor/canvas-stand-in'));
vi.mock('./editor/use-thumbnails', () => ({ useThumbnails: () => ({ svgs: {}, titles: {} }) }));
// jsdom has no PointerEvent: without it, a pointer event fired in a test carries no button or coordinates.
if (typeof window.PointerEvent === 'undefined') {
  class TestPointerEvent extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; } }
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}
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
  const { document: project } = await api.createProject({ name: 'Diagrama' });
  const sceneId = (await api.createScene(project.id, 'Escena')).document.id;
  const steps: string[] = [];
  for (const elements of contents) steps.push((await api.createStep(project.id, sceneId, { elements })).document.id);
  window.location.hash = `#/${project.id}/canvas/${sceneId}${steps[start] ? `/${steps[start]}` : ''}`;
  render(<App config={config} recovery={recovery} />);
  return { projectId: project.id, sceneId, steps };
}
const hashStep = () => window.location.hash.replace(/^#\//, '').split('/')[3];
const present = () => screen.findByRole('button', { name: 'Present' });
const stage = () => screen.findByRole('dialog', { name: 'Presentation' });
const shownImage = () => document.querySelector('.present__page[data-state="current"] img');
const expectShown = (stepId: string) => waitFor(() => expect(document.querySelector('.present__page[data-state="current"]')).toHaveAttribute('data-step-id', stepId));
const expectIndicator = (label: string) => waitFor(() => expect(screen.getByRole('status', { name: label })).toBeInTheDocument());
async function start(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByTestId('canvas');
  await waitFor(async () => expect(await present()).toBeEnabled());
  await user.click(await present());
  return stage();
}

describe('the Present button', () => {
  it('is over the top right corner of the canvas, and of the Studio too, and presents from there', async () => {
    const user = userEvent.setup();
    await open([[box('a')]]);
    const button = await present();
    expect(within(document.querySelector<HTMLElement>('.canvas__corner')!).getByRole('button', { name: 'Present' })).toBe(button);
    await user.click(await screen.findByRole('button', { name: 'Studio' }));
    const studio = await screen.findByRole('main', { name: 'Studio' });
    const again = within(studio).getByRole('button', { name: 'Present' });
    expect(again.closest('.canvas__corner')).not.toBeNull();
    await waitFor(() => expect(again).toBeEnabled());
    await user.click(again);
    await stage();
    await user.keyboard('{Escape}');
    // Leaving lands back in the Studio.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentation' })).not.toBeInTheDocument());
    expect(screen.getByRole('main', { name: 'Studio' })).toBeInTheDocument();
  });
  it('is disabled on a scene with no steps, and says why', async () => {
    await open([]);
    const button = await present();
    await waitFor(() => expect(button).toHaveAttribute('title', 'This scene has no steps to present'));
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole('dialog', { name: 'Presentation' })).not.toBeInTheDocument();
  });
  it('saves unsaved edits first, so the presentation shows them', async () => {
    const user = userEvent.setup();
    const { projectId, sceneId, steps } = await open([[box('a')], [box('b')]]);
    await screen.findByTestId('canvas');
    await user.click(screen.getByRole('button', { name: 'Draw' }));
    await user.click(await present());
    await stage();
    expect((await api.getStep({ projectId, sceneId, stepId: steps[0] })).document.elements.map((e) => e.id)).toEqual(['a', 'drawn-1']);
    await waitFor(() => expect(shownImage()).toHaveAttribute('src', `page:${steps[0]}:a+drawn-1`));
  });
  it('does not present over a conflict, and tells the person', async () => {
    const user = userEvent.setup();
    const { projectId, sceneId, steps } = await open([[box('a')]]);
    await screen.findByTestId('canvas');
    await user.click(screen.getByRole('button', { name: 'Draw' }));
    const stored = await api.getStep({ projectId, sceneId, stepId: steps[0] });
    await api.saveStep({ projectId, sceneId, stepId: steps[0] }, stored.revision, { ...stored.document, title: 'externo' });
    await waitFor(() => expect(screen.getByText(/The step changed outside Paso/)).toBeInTheDocument());
    await user.click(await present());
    expect(await screen.findByText("Can't present: step 1 has a conflict.")).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Presentation' })).not.toBeInTheDocument();
    // The notice can be dismissed, and pressing again tells it again.
    await user.click(screen.getAllByRole('button', { name: 'Dismiss notice' })[0]);
    expect(screen.queryByText(/Can't present/)).not.toBeInTheDocument();
  });
  it('does not present when a save fails, and tells the person', async () => {
    const user = userEvent.setup();
    await open([[box('a')]]);
    await screen.findByTestId('canvas');
    await waitFor(async () => expect(await present()).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Draw' }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError('offline'); }) as typeof fetch;
    try {
      await user.click(await present());
      expect(await screen.findByText("Can't present: step 1 couldn't be saved.")).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Presentation' })).not.toBeInTheDocument();
    } finally { globalThis.fetch = realFetch; }
  });
  it('says so and returns when the scene cannot be read', async () => {
    const user = userEvent.setup();
    const { projectId, sceneId } = await open([[box('a')]]);
    await screen.findByTestId('canvas');
    await waitFor(async () => expect(await present()).toBeEnabled());
    const realList = ApiClient.prototype.listSteps;
    ApiClient.prototype.listSteps = async function (project, scene) { if (project === projectId && scene === sceneId) throw new Error('caído'); return realList.call(this, project, scene); };
    try {
      await user.click(await present());
      expect(await screen.findByText("Couldn't prepare the presentation.")).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Presentation' })).not.toBeInTheDocument();
    } finally { ApiClient.prototype.listSteps = realList; }
  });
});

describe('moving through the presentation', () => {
  it('starts from the current step, moves with every key, and leaves on the step last shown', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')], [box('c')], [box('d')]], 1);
    await start(user);
    await expectShown(steps[1]); await expectIndicator('Step 2 of 4');
    expect(document.querySelectorAll('.indicator__ticks i')).toHaveLength(4);
    expect(document.querySelectorAll('.indicator__ticks i.on')).toHaveLength(1);
    expect(screen.getByText('02 / 04')).toBeInTheDocument();
    for (const [key, target] of [['{ArrowRight}', 2], ['{ArrowRight}', 3], ['{ArrowRight}', 3], ['{ArrowLeft}', 2], ['{PageUp}', 1], ['{PageDown}', 2], [' ', 2], ['{Home}', 0], ['{ArrowLeft}', 0], ['{End}', 3]] as const) {
      await user.keyboard(key);
      await expectShown(steps[target]);
      await expectIndicator(`Step ${target + 1} of 4`);
    }
    await user.keyboard('{Home}'); await user.keyboard('{ArrowRight}'); await user.keyboard('{ArrowRight}');
    await expectShown(steps[2]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentation' })).not.toBeInTheDocument());
    await waitFor(() => expect(hashStep()).toBe(steps[2]));
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', steps[2]));
  });
  it('leaves with “Exit” on the step last shown, and the click does not move the presentation first', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')], [box('c')]], 1);
    await start(user);
    await expectShown(steps[1]);
    const exit = screen.getByRole('button', { name: /Exit/ });
    expect(exit).toHaveAttribute('tabindex', '-1');   // Tab stays in the presentation; Esc is the keyboard's way out.
    await user.click(exit);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentation' })).not.toBeInTheDocument());
    await waitFor(() => expect(hashStep()).toBe(steps[1]));
  });
  it('does not touch the address or the Canvas while it presents', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')]]);
    await start(user);
    await expectShown(steps[0]);
    await user.keyboard('{ArrowRight}'); await expectShown(steps[1]);
    expect(hashStep()).toBe(steps[0]);
    expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', steps[0]);
  });
  it('shows the laser only while the pointer is held down, and a click never changes the step', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')]]);
    const dialog = await start(user);
    await expectShown(steps[0]);
    expect(document.querySelector('.laser')).toBeNull();
    fireEvent.pointerDown(dialog, { button: 0, isPrimary: true, pointerId: 1, clientX: 600, clientY: 200 });
    expect(dialog).toHaveAttribute('data-laser', 'true');
    // The Canvas's laser: a red trail that follows the pointer.
    for (let x = 610; x <= 700; x += 10) fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: 200 + (x - 600) / 2 });
    await waitFor(() => expect(document.querySelector('.laser path')?.getAttribute('d')).toMatch(/^M\d/));
    expect(document.querySelector('.laser path')).toHaveAttribute('fill', 'red');
    fireEvent.pointerUp(dialog, { button: 0, isPrimary: true, pointerId: 1, clientX: 700, clientY: 250 });
    // Released: it fades for a moment, then goes.
    expect(dialog).not.toHaveAttribute('data-laser');
    expect(document.querySelector('.laser')).not.toBeNull();
    await waitFor(() => expect(document.querySelector('.laser')).toBeNull(), { timeout: 3000 });
    // Its cursor, over the drawing.
    expect(dialog.style.getPropertyValue('--laser-cursor')).toMatch(/^url\("data:image\/svg\+xml,/);
    fireEvent.click(dialog, { clientX: window.innerWidth - 10 });
    fireEvent.click(dialog, { clientX: 10 });
    await expectShown(steps[0]);
    // Not on the pager, and not while Space is held to pan.
    fireEvent.pointerDown(within(dialog).getByRole('button', { name: 'Next step' }), { button: 0, isPrimary: true, pointerId: 2 });
    expect(document.querySelector('.laser')).toBeNull();
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    fireEvent.pointerDown(dialog, { button: 0, isPrimary: true, pointerId: 3, clientX: 300, clientY: 300 });
    expect(document.querySelector('.laser')).toBeNull();
    fireEvent.pointerUp(window, { button: 0, pointerId: 3 });
    fireEvent.keyUp(window, { key: ' ', code: 'Space' });
    // L no longer turns it on.
    await user.keyboard('l');
    expect(document.querySelector('.laser')).toBeNull();
  });
  it('goes to the first and last step, and back and forth, from the pager, without the click also moving it', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')], [box('c')], [box('d')]], 1);
    await start(user);
    await expectShown(steps[1]);
    // The Canvas's own step bar stays under the presentation: these are Present's.
    const pager = within(screen.getByRole('dialog', { name: 'Presentation' }));
    await user.click(pager.getByRole('button', { name: 'Last step' })); await expectShown(steps[3]); await expectIndicator('Step 4 of 4');
    expect(pager.getByRole('button', { name: 'Last step' })).toBeDisabled();
    expect(pager.getByRole('button', { name: 'Next step' })).toBeDisabled();
    await user.click(pager.getByRole('button', { name: 'Previous step' })); await expectShown(steps[2]);
    await user.click(pager.getByRole('button', { name: 'First step' })); await expectShown(steps[0]); await expectIndicator('Step 1 of 4');
    expect(pager.getByRole('button', { name: 'First step' })).toBeDisabled();
    await user.click(pager.getByRole('button', { name: 'Next step' })); await expectShown(steps[1]);
    for (const name of ['First step', 'Previous step', 'Next step', 'Last step']) expect(pager.getByRole('button', { name })).toHaveAttribute('tabindex', '-1');
  });
  it('zooms around the pointer from the keyboard, keeping the step', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')]]);
    await start(user);
    await expectShown(steps[0]);
    const stage = document.querySelector<HTMLElement>('.present__stage')!;
    fireEvent.pointerMove(window, { clientX: 200, clientY: 100 });
    await user.keyboard('+');
    expect(Number(/scale\(([\d.]+)\)/.exec(stage.style.transform)![1])).toBeCloseTo(1.1);
    await user.keyboard('+');
    expect(Number(/scale\(([\d.]+)\)/.exec(stage.style.transform)![1])).toBeCloseTo(1.2);
    // The zoom stays while the steps change, and 0 gives the framing back.
    await user.keyboard('{ArrowRight}'); await expectShown(steps[1]);
    expect(Number(/scale\(([\d.]+)\)/.exec(stage.style.transform)![1])).toBeCloseTo(1.2);
    await user.keyboard('-');
    expect(Number(/scale\(([\d.]+)\)/.exec(stage.style.transform)![1])).toBeCloseTo(1.1);
    await user.keyboard('0');
    expect(stage.style.transform).toBe('');
    await expectShown(steps[1]);
  });
  it('keeps wheel zoom and pan between steps, reserves Space for panning and resets with 0', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [box('b')]]);
    const dialog = await start(user);
    await expectShown(steps[0]);
    const plate = document.querySelector<HTMLElement>('.present__stage')!;
    fireEvent.wheel(dialog, { ctrlKey: true, deltaY: 10, clientX: 200, clientY: 100 });
    fireEvent.wheel(dialog, { deltaX: -50, deltaY: 30 });
    expect(plate.style.transform).toMatch(/scale\(0\.9\)/);
    expect(plate).toHaveAttribute('data-motion', 'none');
    const view = plate.style.transform;
    await user.keyboard(' ');
    await expectShown(steps[0]);
    await user.keyboard('{ArrowRight}');
    await expectShown(steps[1]);
    expect(plate.style.transform).toBe(view);
    await user.keyboard('0');
    expect(plate.style.transform).toBe('');
  });
  it('glides to a step\'s camera and back to the whole scene, and 0 returns to the camera after a manual zoom', async () => {
    const user = userEvent.setup();
    const { document: project } = await api.createProject({ name: 'Diagrama' });
    const sceneId = (await api.createScene(project.id, 'Escena')).document.id;
    const camera = { x: 0, y: 0, width: 100, height: 100 };
    const ids: string[] = [];
    for (const [index, framed] of [false, true, false].entries()) ids.push((await api.createStep(project.id, sceneId, { elements: [box(`b${index}`), box(`c${index}`, 900)], ...(framed ? { camera } : {}) })).document.id);
    window.location.hash = `#/${project.id}/canvas/${sceneId}/${ids[0]}`;
    render(<App config={config} recovery={recovery} />);
    await start(user);
    await expectShown(ids[0]);
    const stagePlate = document.querySelector<HTMLElement>('.present__stage')!;
    expect(stagePlate.style.transform).toBe('');
    await user.keyboard('{ArrowRight}'); await expectShown(ids[1]);
    await waitFor(() => expect(stagePlate.style.transform).toMatch(/scale\(/));
    expect(stagePlate).toHaveAttribute('data-motion', 'camera');
    const framedView = stagePlate.style.transform;
    expect(Number(/scale\(([\d.]+)\)/.exec(framedView)![1])).toBeGreaterThan(1);
    // A manual zoom on top (out: this small camera is already at the maximum), then 0: back to the step's camera.
    await user.keyboard('-');
    expect(stagePlate.style.transform).not.toBe(framedView);
    await user.keyboard('0');
    expect(stagePlate.style.transform).toBe(framedView);
    await user.keyboard('{ArrowRight}'); await expectShown(ids[2]);
    await waitFor(() => expect(stagePlate.style.transform).toBe(''));
    expect(stagePlate).toHaveAttribute('data-motion', 'camera');
  });
  it('holds the frame across a step that keeps the previous camera, follows that camera live, and lets go when the option is removed', async () => {
    const user = userEvent.setup();
    const { document: project } = await api.createProject({ name: 'Diagrama' });
    const sceneId = (await api.createScene(project.id, 'Escena')).document.id;
    const camera = { x: 0, y: 0, width: 100, height: 100 };
    const ids: string[] = [];
    for (const [index, setting] of [camera, 'previous', 'previous', undefined].entries()) ids.push((await api.createStep(project.id, sceneId, { elements: [box(`b${index}`), box(`c${index}`, 900)], ...(setting ? { camera: setting as typeof camera | 'previous' } : {}) })).document.id);
    window.location.hash = `#/${project.id}/canvas/${sceneId}/${ids[0]}`;
    render(<App config={config} recovery={recovery} />);
    await start(user);
    await expectShown(ids[0]);
    const stagePlate = document.querySelector<HTMLElement>('.present__stage')!;
    await waitFor(() => expect(stagePlate.style.transform).toMatch(/scale\(/));
    const framedView = stagePlate.style.transform;
    // Two steps that keep it: the view does not move, not even a manual zoom made on the first one.
    await user.keyboard('{ArrowRight}'); await expectShown(ids[1]);
    expect(stagePlate.style.transform).toBe(framedView);
    await user.keyboard('-');
    const manual = stagePlate.style.transform;
    expect(manual).not.toBe(framedView);
    await user.keyboard('{ArrowRight}'); await expectShown(ids[2]);
    expect(stagePlate.style.transform).toBe(manual);
    // 0 goes back to the camera it keeps.
    await user.keyboard('0');
    expect(stagePlate.style.transform).toBe(framedView);
    // The link is live: moving the first step's camera moves this one, three steps on.
    const first = await api.getStep({ projectId: project.id, sceneId, stepId: ids[0] });
    await api.saveStep({ projectId: project.id, sceneId, stepId: ids[0] }, first.revision, { ...first.document, camera: { x: 900, y: 0, width: 100, height: 100 } });
    await waitFor(() => expect(stagePlate.style.transform).not.toBe(framedView));
    expect(stagePlate.style.transform).toMatch(/scale\(/);
    expect(stagePlate).toHaveAttribute('data-motion', 'camera');
    // Without the option, the step shows the whole scene again.
    const kept = await api.getStep({ projectId: project.id, sceneId, stepId: ids[2] });
    const plain = { ...kept.document };
    delete plain.camera;
    await api.saveStep({ projectId: project.id, sceneId, stepId: ids[2] }, kept.revision, plain);
    await waitFor(() => expect(stagePlate.style.transform).toBe(''));
  });
  it('shows a scene of one step, and an empty step within a scene', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')], [], [box('c')]]);
    await start(user);
    await expectShown(steps[0]);
    await user.keyboard('{ArrowRight}'); await expectShown(steps[1]); await expectIndicator('Step 2 of 3');
    expect(shownImage()).toHaveAttribute('src', `page:${steps[1]}:`);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('has somewhere to stop in a scene of one step', async () => {
    const user = userEvent.setup();
    const { steps } = await open([[box('a')]]);
    await start(user);
    await expectShown(steps[0]); await expectIndicator('Step 1 of 1');
    await user.keyboard('{ArrowRight}{ArrowLeft}{End}{Home}');
    await expectIndicator('Step 1 of 1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('prepares only the neighbours in a very long scene, and drops the ticks', async () => {
    const user = userEvent.setup();
    const { steps } = await open(Array.from({ length: 40 }, (_, i) => [box(`b${i}`)]), 20);
    await start(user);
    await expectShown(steps[20]); await expectIndicator('Step 21 of 40');
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
    expect(await screen.findByText("Couldn't draw this step.")).toBeInTheDocument();
    await expectIndicator('Step 2 of 3');
    await user.keyboard('{ArrowRight}'); await expectShown(steps[2]);
    expect(screen.queryByText("Couldn't draw this step.")).not.toBeInTheDocument();
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
    await expectShown(steps[2]); await expectIndicator('Step 3 of 3');
    const target = { projectId, sceneId, stepId: steps[2] };
    await api.deleteStep(target, (await api.getStep(target)).revision);
    await expectShown(steps[1]); await expectIndicator('Step 2 of 2');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The Canvas underneath moves off the deleted step on its own. Leaving afterwards lands on the step last shown.
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
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentation' })).not.toBeInTheDocument());
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
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentation' })).not.toBeInTheDocument());
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
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentation' })).not.toBeInTheDocument());
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
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentation' })).not.toBeInTheDocument());
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
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Presentation' })).not.toBeInTheDocument());
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
