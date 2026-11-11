// @vitest-environment jsdom
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '@paso/server';
import { App } from './App';
import type { Draft, Recovery } from './editor/step-store';
import { ApiClient, type ClientConfig } from './lib/api';

/**
 * The Lienzo with its real service, store and carousel. Two edges are stand-ins because jsdom has no canvas:
 * Excalidraw itself (a button that makes an edit the way its onChange would) and the thumbnail drawing.
 */
vi.mock('./editor/StepCanvas', async () => {
  const { useEffect } = await import('react');
  const shape = (id: string) => ({ id, type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false, x: 0, y: 0, width: 10, height: 10 });
  // With nothing selected, as here, the canvas gives ← → to the Lienzo (canvasStepKey, tested on its own).
  // It reports a fixed view: 1000×700 at 100%, scrolled to the origin.
  return { default: ({ store, session, onStepKey, view }: { store: import('./editor/step-store').StepStore; session: import('./editor/step-store').Session; onStepKey?: (delta: -1 | 1) => void; view?: import('./editor/canvas-view').ViewStore }) => {
    useEffect(() => { session.baseline = undefined; store.change(session, session.document.elements, session.document.appState, {}); }, [session, store]);
    useEffect(() => { view?.set({ scrollX: 0, scrollY: 0, zoom: 1, width: 1000, height: 700 }); }, [view]);
    return <div data-testid="canvas" data-step-id={session.target.stepId} tabIndex={0}
      onKeyDown={(event) => { const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (delta) onStepKey?.(delta); }}>
      <span>{session.document.elements.map((e) => e.id).join(',')}</span>
      <button type="button" onClick={() => store.change(session, [...session.document.elements, shape(`drawn-${session.document.elements.length}`)], session.document.appState, {})}>Dibujar</button>
    </div>;
  } };
});
// jsdom has no PointerEvent: without it, a pointer event fired in a test carries no coordinates.
if (typeof window.PointerEvent === 'undefined') {
  class TestPointerEvent extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; } }
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}
vi.mock('./editor/use-thumbnails', () => ({ useThumbnails: () => ({ svgs: {}, titles: {} }) }));

// The first test pays for loading the lazy Lienzo; each one makes several requests to a real service.
vi.setConfig({ testTimeout: 30_000 });

type Service = Awaited<ReturnType<typeof startServer>>;
const token = 'lienzo-test-session-token-with-32-chars-plus';
// jsdom has no IndexedDB, where drafts normally wait; this keeps them in memory.
const memory = (): Recovery => { const drafts = new Map<string, Draft>(); return { read: async (key) => drafts.get(key), write: async (key, draft) => { drafts.set(key, structuredClone(draft)); }, remove: async (key) => { drafts.delete(key); } }; };
let recovery: Recovery;
let service: Service; let dataDir: string; let config: ClientConfig; let api: ApiClient;
const patience = { timeout: 5000 };
const shape = (id: string) => ({ id, type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false, x: 0, y: 0, width: 10, height: 10 });

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'paso-lienzo-'));
  window.history.replaceState(null, '', '/');
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  service = await startServer({ dataDir, port: 0, sessionToken: token, allowedOrigins: [window.location.origin], pollIntervalMs: 100,
    // The agent panel asks which harnesses are installed: never run the real ones from a test.
    harnessDetection: { searchPaths: [], loginShell: false } });
  config = { baseUrl: service.url, token }; api = new ApiClient(config); recovery = memory();
});
afterEach(async () => { cleanup(); await service.close(); await rm(dataDir, { recursive: true, force: true }); });

/** One project with scenes of the given sizes. Step 1 of the first scene holds a rectangle called `r1`. */
async function seed(sizes: number[]) {
  const { document: project } = await api.createProject({ name: 'Diagrama' });
  const scenes: Array<{ id: string; steps: string[] }> = [];
  for (const [index, size] of sizes.entries()) {
    const scene = (await api.createScene(project.id, `Escena ${index + 1}`)).document.id;
    const steps: string[] = [];
    for (let i = 0; i < size; i++) steps.push((await api.createStep(project.id, scene, { elements: i === 0 && index === 0 ? [shape('r1')] : [] })).document.id);
    scenes.push({ id: scene, steps });
  }
  return { projectId: project.id, scenes };
}
const hash = () => window.location.hash.replace(/^#\//, '').split('/');
const current = () => hash()[3];
const order = async (projectId: string, sceneId: string) => (await api.getScene(projectId, sceneId)).document.stepIds;
/** The save state in the sidebar's footer. The carousel has its own, unrelated live region. */
const saveState = () => document.querySelector('.projects__foot[data-save-state]');
const sceneList = () => screen.getByRole('list', { name: /^Escenas de / });
const frames = () => screen.getAllByRole('button', { name: /^Paso \d+/ });
async function open(sizes: number[]) {
  const data = await seed(sizes);
  window.location.hash = `#/${data.projectId}/lienzo/${data.scenes[0].id}/${data.scenes[0].steps[0]}`;
  render(<App config={config} recovery={recovery} />);
  await screen.findByTestId('canvas', {}, patience);
  return data;
}

describe('scenes in the sidebar', () => {
  it('lists the open diagram\'s scenes under its row: switches scene and creates one', async () => {
    const user = userEvent.setup();
    const { projectId, scenes } = await open([2, 1]);
    const list = await waitFor(sceneList, patience);
    expect(within(list).getByRole('button', { name: 'Escena 1: Escena 1' })).toHaveAttribute('aria-current', 'true');
    await user.click(within(list).getByRole('button', { name: 'Escena 2: Escena 2' }));
    await waitFor(() => expect(hash()[2]).toBe(scenes[1].id)); expect(current()).toBe(scenes[1].steps[0]);
    await waitFor(() => expect(frames()).toHaveLength(1));
    expect(within(sceneList()).getByRole('button', { name: 'Escena 2: Escena 2' })).toHaveAttribute('aria-current', 'true');
    await user.click(within(sceneList()).getByRole('button', { name: 'Añadir diagrama' }));
    await within(sceneList()).findByRole('button', { name: 'Escena 3: Escena 3' }, patience);
    const created = (await api.listScenes(projectId))[2].document;
    await waitFor(() => expect(hash()[2]).toBe(created.id)); expect(created.stepIds).toHaveLength(1); expect(current()).toBe(created.stepIds[0]);
    expect(frames()).toHaveLength(1);
  });
  it('is the way to the first scene of an empty diagram', async () => {
    const user = userEvent.setup();
    const { document: project } = await api.createProject({ name: 'Vacío' });
    window.location.hash = `#/${project.id}/lienzo`;
    render(<App config={config} recovery={recovery} />);
    await user.click(await within(await waitFor(sceneList, patience)).findByRole('button', { name: 'Añadir diagrama' }, patience));
    await screen.findByTestId('canvas', {}, patience);
    expect(await api.listScenes(project.id)).toHaveLength(1);
    expect(within(sceneList()).getByRole('button', { name: 'Escena 1: Escena 1' })).toHaveAttribute('aria-current', 'true');
  });
});

describe('carousel against the real service', () => {
  it('adds, duplicates and deletes steps, with a save pending', async () => {
    const user = userEvent.setup();
    const { projectId, scenes } = await open([2]);
    const [s1, s2] = scenes[0].steps;
    expect(frames()).toHaveLength(2); expect(frames()[0]).toHaveAttribute('aria-current', 'step');
    // Añadir appends from the final drawing, even while the first step is open and dirty.
    await user.click(screen.getByRole('button', { name: 'Dibujar' }));          // edit; not saved yet
    await user.click(screen.getByRole('button', { name: 'Añadir paso' }));
    await waitFor(() => expect(frames()).toHaveLength(3), patience);
    await waitFor(() => expect(current()).not.toBe(s1));
    const added = current();
    expect(await order(projectId, scenes[0].id)).toEqual([s1, s2, added]);
    expect((await api.getStep({ projectId, sceneId: scenes[0].id, stepId: added })).document.elements.map((e) => e.id)).toEqual([]);
    expect(frames()[2]).toHaveAttribute('aria-current', 'step');
    // Duplicar, again with an unsaved edit in the step that is open.
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', added));
    await user.click(screen.getByRole('button', { name: 'Dibujar' }));
    await user.click(screen.getByRole('button', { name: 'Duplicar el paso 3' }));
    await waitFor(() => expect(frames()).toHaveLength(4), patience);
    await waitFor(() => expect(current()).not.toBe(added));
    const copy = current();
    expect(await order(projectId, scenes[0].id)).toEqual([s1, s2, added, copy]);
    expect((await api.getStep({ projectId, sceneId: scenes[0].id, stepId: copy })).document.elements.map((e) => e.id)).toEqual(['drawn-0']);
    // Delete the current step: nothing happens until confirmed, then the next step opens.
    await user.click(screen.getByRole('button', { name: 'Eliminar el paso 4' }));
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(frames()).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: 'Eliminar el paso 4' })); await user.click(screen.getByRole('button', { name: 'Eliminar paso' }));
    await waitFor(() => expect(frames()).toHaveLength(3), patience);
    expect(current()).toBe(added); expect(await order(projectId, scenes[0].id)).toEqual([s1, s2, added]);
    expect(await readdir(join(dataDir, projectId, 'scenes', scenes[0].id, 'steps'))).not.toContain(`${copy}.json`);
    // Delete the last step of the list: the previous one opens.
    await user.click(screen.getByRole('button', { name: 'Eliminar el paso 3' })); await user.click(screen.getByRole('button', { name: 'Eliminar paso' }));
    await waitFor(() => expect(frames()).toHaveLength(2), patience);
    expect(current()).toBe(s2);
    // Empty the scene: the view is a message and a way forward, not a broken editor.
    for (const [n, name] of [[2, 'Eliminar el paso 2'], [1, 'Eliminar el paso 1']] as const) {
      await user.click(screen.getByRole('button', { name })); await user.click(screen.getByRole('button', { name: 'Eliminar paso' }));
      await waitFor(() => expect(screen.queryAllByRole('button', { name: /^Paso \d+/ })).toHaveLength(n - 1), patience);
    }
    expect(screen.queryByTestId('canvas')).not.toBeInTheDocument();
    expect(screen.getByText(/Esta escena no tiene pasos/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Duplicar el paso/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Añadir paso' }));
    await screen.findByTestId('canvas', {}, patience);
    expect(frames()).toHaveLength(1);
  });
  it('duplicates a thumbnail other than the open step and places the copy beside its source', async () => {
    const user = userEvent.setup();
    const { projectId, scenes } = await open([2]);
    const [first, second] = scenes[0].steps;
    await user.click(frames()[1]);
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', second));
    await user.click(screen.getByRole('button', { name: 'Duplicar el paso 1' }));
    await waitFor(() => expect(frames()).toHaveLength(3), patience);
    await waitFor(() => expect(current()).not.toBe(second));
    const copy = current();
    expect(await order(projectId, scenes[0].id)).toEqual([first, copy, second]);
    expect((await api.getStep({ projectId, sceneId: scenes[0].id, stepId: copy })).document.elements.map((element) => element.id)).toEqual(['r1']);
  });
  it('moves between steps with the arrow keys in the carousel and on the canvas, and reorders with Alt in the carousel', async () => {
    const user = userEvent.setup();
    const { projectId, scenes } = await open([3]);
    const [s1, s2, s3] = scenes[0].steps;
    frames()[0].focus();
    await user.keyboard('{ArrowRight}'); await waitFor(() => expect(current()).toBe(s2));
    expect(frames()[1]).toHaveFocus();
    await user.keyboard('{End}'); await waitFor(() => expect(current()).toBe(s3));
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', s3));   // the canvas is swapped once the step has loaded
    // On the canvas, as in Presentar: ← → move through the steps and stop at both ends. Home stays the drawing's.
    screen.getByTestId('canvas').focus();
    await user.keyboard('{ArrowRight}');
    expect(current()).toBe(s3);
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(current()).toBe(s2));
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', s2));
    screen.getByTestId('canvas').focus();
    await user.keyboard('{Home}');
    expect(current()).toBe(s2);
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(current()).toBe(s3));
    frames()[2].focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await waitFor(async () => expect(await order(projectId, scenes[0].id)).toEqual([s1, s3, s2]), patience);
    await waitFor(() => expect(frames()[1]).toHaveFocus());
    expect(current()).toBe(s3);                                                // still the open step, in its new place
    expect(frames()[1]).toHaveAttribute('aria-current', 'step');
  });
});

describe('the presentation camera of a step', () => {
  it('marks the camera by dragging over the canvas, takes the whole view with Enter, and removes it', async () => {
    const user = userEvent.setup();
    const { projectId, scenes } = await open([2]);
    const [first, second] = scenes[0].steps;
    const stepFile = async (id: string) => (await api.getStep({ projectId, sceneId: scenes[0].id, stepId: id })).document;
    expect(document.querySelector('.camera-overlay')).toBeNull();
    // «Encuadrar» opens the drawing mode; a drag marks the box (the canvas shows 1000×700 at 100% from the origin).
    await user.click(screen.getByRole('button', { name: 'Encuadrar' }));
    expect(screen.getByRole('button', { name: 'Encuadrar' })).toHaveAttribute('aria-pressed', 'true');
    const layer = screen.getByRole('application', { name: 'Marcar el encuadre de la presentación' });
    fireEvent.pointerDown(layer, { clientX: 500, clientY: 450, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 100, clientY: 150, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 100, clientY: 150, pointerId: 1 });
    await waitFor(async () => expect((await stepFile(first)).camera).toEqual({ x: 100, y: 150, width: 400, height: 300 }), patience);
    expect(screen.queryByRole('application')).not.toBeInTheDocument();
    const overlay = document.querySelector<HTMLElement>('.camera-overlay')!;
    expect(overlay.style).toMatchObject({ left: '100px', top: '150px', width: '400px', height: '300px' });

    // A corner resizes it, the tag moves it.
    const corner = overlay.querySelector('.camera-overlay__handle--se')!;
    fireEvent.pointerDown(corner, { clientX: 500, clientY: 450, pointerId: 2 });
    fireEvent.pointerMove(corner, { clientX: 600, clientY: 500, pointerId: 2 });
    fireEvent.pointerUp(corner, { clientX: 600, clientY: 500, pointerId: 2 });
    await waitFor(async () => expect((await stepFile(first)).camera).toEqual({ x: 100, y: 150, width: 500, height: 350 }), patience);
    const tag = document.querySelector('.camera-overlay__tag')!;
    fireEvent.pointerDown(tag, { clientX: 110, clientY: 140, pointerId: 3 });
    fireEvent.pointerMove(tag, { clientX: 90, clientY: 160, pointerId: 3 });
    fireEvent.pointerUp(tag, { clientX: 90, clientY: 160, pointerId: 3 });
    await waitFor(async () => expect((await stepFile(first)).camera).toEqual({ x: 80, y: 170, width: 500, height: 350 }), patience);
    expect(screen.getByRole('button', { name: 'Reencuadrar' })).toBeInTheDocument();

    // Escape leaves the drawing mode without a change; Enter takes what the canvas shows, without the strips under the controls.
    await user.click(screen.getByRole('button', { name: 'Reencuadrar' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('application')).not.toBeInTheDocument();
    expect((await stepFile(first)).camera).toEqual({ x: 80, y: 170, width: 500, height: 350 });
    await user.click(screen.getByRole('button', { name: 'Reencuadrar' }));
    await user.keyboard('{Enter}');
    await waitFor(async () => expect((await stepFile(first)).camera).toEqual({ x: 24, y: 72, width: 952, height: 564 }), patience);

    // Another step has none of its own.
    await user.click(frames()[1]);
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', second));
    expect(screen.getByRole('button', { name: 'Encuadrar' })).toBeInTheDocument();
    expect(document.querySelector('.camera-overlay')).toBeNull();
    expect((await stepFile(second)).camera).toBeUndefined();
    await user.click(frames()[0]);
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', first));
    await user.click(screen.getByRole('button', { name: 'Quitar encuadre' }));
    await waitFor(async () => expect((await stepFile(first)).camera).toBeUndefined(), patience);
    expect(document.querySelector('.camera-overlay')).toBeNull();
  });
});

describe('what the person is told about unsaved work', () => {
  it('tells a conflict once, and offers the top-bar button only for another step', async () => {
    const user = userEvent.setup();
    const { projectId, scenes } = await open([2]);
    const [s1] = scenes[0].steps;
    await user.click(screen.getByRole('button', { name: 'Dibujar' }));
    const stored = await api.getStep({ projectId, sceneId: scenes[0].id, stepId: s1 });
    await api.saveStep({ projectId, sceneId: scenes[0].id, stepId: s1 }, stored.revision, { ...stored.document, title: 'externo' });
    const message = /El paso cambió fuera de Paso/;
    await screen.findByText(message, {}, patience);
    expect(screen.getAllByText(message)).toHaveLength(1);                       // the banner alone
    expect(saveState()).toHaveAttribute('data-save-state', 'conflict');         // never "Guardado" beside a conflict
    expect(screen.queryByRole('button', { name: 'Revisar paso sin guardar' })).not.toBeInTheDocument();
    // On another step the top bar points back at it, and the step on screen is saved.
    await user.click(frames()[1]);
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', scenes[0].steps[1]));
    await waitFor(() => expect(saveState()).toHaveTextContent('Guardado'));
    const review = await screen.findByRole('button', { name: 'Revisar paso sin guardar' });
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    await user.click(review);
    await waitFor(() => expect(current()).toBe(s1));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revisar paso sin guardar' })).not.toBeInTheDocument();
  });
  it('does not warn about a clean step that was deleted outside the app', async () => {
    const user = userEvent.setup();
    const { projectId, scenes } = await open([3]);
    const [s1, s2] = scenes[0].steps;
    await user.click(frames()[1]); await waitFor(() => expect(current()).toBe(s2));
    await user.click(frames()[2]); await waitFor(() => expect(current()).toBe(scenes[0].steps[2]));
    const doomed = await api.getStep({ projectId, sceneId: scenes[0].id, stepId: s2 });
    await api.deleteStep({ projectId, sceneId: scenes[0].id, stepId: s2 }, doomed.revision);
    await waitFor(() => expect(frames()).toHaveLength(2), patience);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole('button', { name: 'Revisar paso sin guardar' })).not.toBeInTheDocument();
    expect(await order(projectId, scenes[0].id)).toEqual([s1, scenes[0].steps[2]]);
  });
});
