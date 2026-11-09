// @vitest-environment jsdom
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  return { default: ({ store, session }: { store: import('./editor/step-store').StepStore; session: import('./editor/step-store').Session }) => {
    useEffect(() => { session.baseline = undefined; store.change(session, session.document.elements, session.document.appState, {}); }, [session, store]);
    return <div data-testid="canvas" data-step-id={session.target.stepId} tabIndex={0}>
      <span>{session.document.elements.map((e) => e.id).join(',')}</span>
      <button type="button" onClick={() => store.change(session, [...session.document.elements, shape(`drawn-${session.document.elements.length}`)], session.document.appState, {})}>Dibujar</button>
    </div>;
  } };
});
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
  const { document: project } = await api.createProject({ name: 'Proyecto' });
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
/** The top bar's save label. The carousel has its own, unrelated live region. */
const saveState = () => document.querySelector('.topbar [data-save-state]');
const frames = () => screen.getAllByRole('button', { name: /^Paso \d+/ });
async function open(sizes: number[]) {
  const data = await seed(sizes);
  window.location.hash = `#/${data.projectId}/lienzo/${data.scenes[0].id}/${data.scenes[0].steps[0]}`;
  render(<App config={config} recovery={recovery} />);
  await screen.findByTestId('canvas', {}, patience);
  return data;
}

describe('the second row of the top bar', () => {
  it('names the open step: its number, and its title once it is loaded', async () => {
    const user = userEvent.setup();
    const { projectId, scenes } = await open([2]);
    const row = () => document.querySelector('.topbar__sub')!;
    await waitFor(() => expect(row()).toHaveTextContent('Paso 01'));
    expect(within(screen.getByRole('banner')).getByRole('button', { name: /Cambiar de escena/ })).toBeInTheDocument();
    const step = await api.getStep({ projectId, sceneId: scenes[0].id, stepId: scenes[0].steps[1] });
    await api.saveStep({ projectId, sceneId: scenes[0].id, stepId: scenes[0].steps[1] }, step.revision, { ...step.document, title: 'Mira en medio' });
    await user.click(frames()[1]);
    await waitFor(() => expect(row()).toHaveTextContent('Paso 02'), patience);
    await waitFor(() => expect(within(screen.getByRole('banner')).getByRole('textbox', { name: 'Título del paso' })).toHaveValue('Mira en medio'), patience);
  });

  it('names a step from the field in the second row: Enter keeps it, Escape puts it back, empty removes it', async () => {
    const user = userEvent.setup();
    const { projectId, scenes } = await open([2]);
    const target = { projectId, sceneId: scenes[0].id, stepId: scenes[0].steps[0] };
    const field = await screen.findByRole('textbox', { name: 'Título del paso' }, patience);
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', 'Añade un título');
    await user.click(field);
    await user.type(field, 'La ventana{Enter}');
    expect(field).not.toHaveFocus();
    await waitFor(async () => expect((await api.getStep(target)).document.title).toBe('La ventana'), patience);
    expect((await api.getStep(target)).document.elements.map((element) => element.id)).toEqual(['r1']);   // the drawing is untouched

    await user.click(field);
    await user.clear(field);
    await user.type(field, 'Otra cosa{Escape}');
    expect(field).toHaveValue('La ventana');
    await user.click(field);
    await user.clear(field);
    await user.tab();
    await waitFor(async () => expect((await api.getStep(target)).document.title).toBeUndefined(), patience);
    expect(field).toHaveValue('');
  });
});

describe('scene selector', () => {
  it('replaces the temporary switcher: switches scene and creates one, from the top bar', async () => {
    const user = userEvent.setup();
    const { projectId, scenes } = await open([2, 1]);
    expect(screen.queryByText('Selector temporal')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Escena temporal')).not.toBeInTheDocument();
    const pill = await screen.findByRole('button', { name: /Cambiar de escena/ });
    expect(pill).toHaveTextContent('1Escena 1');
    expect(within(screen.getByRole('banner')).getByRole('button', { name: /Cambiar de escena/ })).toBe(pill);   // it lives in the top bar
    await user.click(pill);
    expect(screen.getByRole('menuitemradio', { name: /Escena 1/ })).toBeChecked();
    await user.click(screen.getByRole('menuitemradio', { name: /Escena 2/ }));
    await waitFor(() => expect(hash()[2]).toBe(scenes[1].id)); expect(current()).toBe(scenes[1].steps[0]);
    await waitFor(() => expect(frames()).toHaveLength(1));
    expect(pill).toHaveTextContent('2Escena 2');
    await user.click(pill); await user.click(screen.getByRole('menuitem', { name: 'Nueva escena' }));
    await waitFor(() => expect(pill).toHaveTextContent('3Escena 3'), patience);
    const created = (await api.listScenes(projectId))[2].document;
    expect(hash()[2]).toBe(created.id); expect(created.stepIds).toHaveLength(1); expect(current()).toBe(created.stepIds[0]);
    expect(frames()).toHaveLength(1);
  });
  it('is the way to the first scene of an empty project', async () => {
    const user = userEvent.setup();
    const { document: project } = await api.createProject({ name: 'Vacío' });
    window.location.hash = `#/${project.id}/lienzo`;
    render(<App config={config} recovery={recovery} />);
    await user.click(await screen.findByRole('button', { name: 'Nueva escena' }, patience));
    await screen.findByTestId('canvas', {}, patience);
    expect(await api.listScenes(project.id)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Cambiar de escena/ })).toHaveTextContent('1Escena 1');
  });
});

describe('carousel against the real service', () => {
  it('adds, duplicates and deletes steps, with a save pending', async () => {
    const user = userEvent.setup();
    const { projectId, scenes } = await open([2]);
    const [s1, s2] = scenes[0].steps;
    expect(frames()).toHaveLength(2); expect(frames()[0]).toHaveAttribute('aria-current', 'step');
    // Añadir: after the current step, starting from its drawing.
    await user.click(screen.getByRole('button', { name: 'Dibujar' }));          // edit; not saved yet
    await user.click(screen.getByRole('button', { name: 'Añadir paso' }));
    await waitFor(() => expect(frames()).toHaveLength(3), patience);
    await waitFor(() => expect(current()).not.toBe(s1));
    const added = current();
    expect(await order(projectId, scenes[0].id)).toEqual([s1, added, s2]);
    expect((await api.getStep({ projectId, sceneId: scenes[0].id, stepId: added })).document.elements.map((e) => e.id)).toEqual(['r1', 'drawn-1']);
    expect(frames()[1]).toHaveAttribute('aria-current', 'step');
    // Duplicar, again with an unsaved edit in the step that is open.
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', added));
    await user.click(screen.getByRole('button', { name: 'Dibujar' }));
    await user.click(screen.getByRole('button', { name: 'Duplicar paso' }));
    await waitFor(() => expect(frames()).toHaveLength(4), patience);
    await waitFor(() => expect(current()).not.toBe(added));
    const copy = current();
    expect(await order(projectId, scenes[0].id)).toEqual([s1, added, copy, s2]);
    expect((await api.getStep({ projectId, sceneId: scenes[0].id, stepId: copy })).document.elements.map((e) => e.id)).toEqual(['r1', 'drawn-1', 'drawn-2']);
    // Delete the current step: nothing happens until confirmed, then the next step opens.
    await user.click(screen.getByRole('button', { name: 'Eliminar el paso 3' }));
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(frames()).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: 'Eliminar el paso 3' })); await user.click(screen.getByRole('button', { name: 'Eliminar paso' }));
    await waitFor(() => expect(frames()).toHaveLength(3), patience);
    expect(current()).toBe(s2); expect(await order(projectId, scenes[0].id)).toEqual([s1, added, s2]);
    expect(await readdir(join(dataDir, projectId, 'scenes', scenes[0].id, 'steps'))).not.toContain(`${copy}.json`);
    // Delete the last step of the list: the previous one opens.
    await user.click(screen.getByRole('button', { name: 'Eliminar el paso 3' })); await user.click(screen.getByRole('button', { name: 'Eliminar paso' }));
    await waitFor(() => expect(frames()).toHaveLength(2), patience);
    expect(current()).toBe(added);
    // Empty the scene: the view is a message and a way forward, not a broken editor.
    for (const [n, name] of [[2, 'Eliminar el paso 2'], [1, 'Eliminar el paso 1']] as const) {
      await user.click(screen.getByRole('button', { name })); await user.click(screen.getByRole('button', { name: 'Eliminar paso' }));
      await waitFor(() => expect(screen.queryAllByRole('button', { name: /^Paso \d+/ })).toHaveLength(n - 1), patience);
    }
    expect(screen.queryByTestId('canvas')).not.toBeInTheDocument();
    expect(screen.getByText(/Esta escena no tiene pasos/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Duplicar paso' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Añadir paso' }));
    await screen.findByTestId('canvas', {}, patience);
    expect(frames()).toHaveLength(1);
  });
  it('moves between steps with the arrow keys inside the carousel only, and reorders with Alt', async () => {
    const user = userEvent.setup();
    const { projectId, scenes } = await open([3]);
    const [s1, s2, s3] = scenes[0].steps;
    frames()[0].focus();
    await user.keyboard('{ArrowRight}'); await waitFor(() => expect(current()).toBe(s2));
    expect(frames()[1]).toHaveFocus();
    await user.keyboard('{End}'); await waitFor(() => expect(current()).toBe(s3));
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', s3));   // the canvas is swapped once the step has loaded
    screen.getByTestId('canvas').focus();
    await user.keyboard('{ArrowLeft}{Home}');
    expect(current()).toBe(s3);                                                // the canvas keeps its keys
    frames()[2].focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await waitFor(async () => expect(await order(projectId, scenes[0].id)).toEqual([s1, s3, s2]), patience);
    await waitFor(() => expect(frames()[1]).toHaveFocus());
    expect(current()).toBe(s3);                                                // still the open step, in its new place
    expect(frames()[1]).toHaveAttribute('aria-current', 'step');
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
    expect(saveState()).toBeNull();                                            // no "Guardado" beside a conflict
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
