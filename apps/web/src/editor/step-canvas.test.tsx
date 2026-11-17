// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStep, type Step } from '@paso/shared';
import { StepStore, type Draft, type Recovery, type StepTransport, type Target } from './step-store';
import type { ApiClient } from '../lib/api';
import type { CanvasCamera } from './canvas-camera';
import { LOADING_DELAY_MS } from './Loading';
import { nextStepState } from './step-swap';
import type { AppState } from '@excalidraw/excalidraw/types';

/**
 * The real StepCanvas over a stand-in Excalidraw, which jsdom cannot draw. The stand-in keeps a scene and an undo
 * history the way Excalidraw does: an edit can be undone, a scene set with CaptureUpdateAction.NEVER cannot, and its
 * onChange fires after every render, as Excalidraw's does after every update.
 */
const fake = vi.hoisted(() => ({ mounts: 0, fonts: undefined as Promise<void> | undefined }));
vi.mock('@excalidraw/excalidraw', async () => {
  const { useEffect, useReducer, useRef } = await import('react');
  type Scene = { elements: Array<{ id: string; isDeleted?: boolean }>; appState: Record<string, unknown>; files: Record<string, unknown>; undo: Array<Array<{ id: string }>> };
  const element = (id: string) => ({ id, type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false, x: 0, y: 0, width: 10, height: 10 });
  function Excalidraw({ initialData, onChange, excalidrawAPI }: {
    initialData: { elements: Scene['elements']; appState: Record<string, unknown>; files: Record<string, unknown> };
    onChange: (elements: unknown, appState: unknown, files: unknown) => void; excalidrawAPI: (api: unknown) => void;
  }) {
    const [, update] = useReducer((value: number) => value + 1, 0);
    const scene = useRef<Scene>(undefined);
    if (!scene.current) {
      fake.mounts++;
      scene.current = { elements: [], appState: { isLoading: true, width: 1000, height: 700, offsetLeft: 0, offsetTop: 0, scrollX: 0, scrollY: 0, zoom: { value: 1 }, theme: 'light', activeTool: { type: 'selection' }, selectedElementIds: {} }, files: {}, undo: [] };
    }
    const live = scene.current;
    useEffect(() => {
      excalidrawAPI({
        updateScene: ({ elements, appState, captureUpdate }: { elements?: Scene['elements']; appState?: Record<string, unknown>; captureUpdate?: string }) => {
          if (elements) { if (captureUpdate !== 'NEVER') live.undo.push(live.elements); live.elements = [...elements]; }
          if (appState) live.appState = { ...live.appState, ...appState };
          update();
        },
        addFiles: (files: Array<{ id: string }>) => { for (const file of files) live.files[file.id] = file; },
        history: { clear: () => { live.undo = []; } },
        getAppState: () => live.appState,
        getSceneElements: () => live.elements.filter((item) => !item.isDeleted),
        getSceneElementsIncludingDeleted: () => live.elements,
        getFiles: () => live.files,
        scrollToContent: () => {},
        toggleSidebar: () => {},
      });
      // Excalidraw starts its scene a moment after mounting.
      const timer = setTimeout(() => { live.elements = [...initialData.elements]; live.appState = { ...live.appState, ...initialData.appState, isLoading: false }; Object.assign(live.files, initialData.files); update(); });
      return () => clearTimeout(timer);
    }, []);
    useEffect(() => { if (!live.appState.isLoading) onChange(live.elements, live.appState, live.files); });
    return <div className="excalidraw-container" tabIndex={0} data-testid="excalidraw">
      <span data-testid="drawn">{live.elements.map((item) => item.id).join(',')}</span>
      <button type="button" onClick={() => { live.undo.push(live.elements); live.elements = [...live.elements, element(`drawn-${live.elements.length}`)]; update(); }}>Dibujar</button>
      {/* An edit Excalidraw has made but not reported yet. */}
      <button type="button" onClick={() => { live.elements = [...live.elements, element(`quiet-${live.elements.length}`)]; }}>Dibujar sin avisar</button>
      <button type="button" onClick={() => { const before = live.undo.pop(); if (before) { live.elements = before as Scene['elements']; update(); } }}>Deshacer</button>
    </div>;
  }
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const MainMenu = Object.assign(Pass, { Item: Pass, Separator: () => null, Group: Pass, DefaultItems: { SaveAsImage: () => null, ChangeCanvasBackground: () => null } });
  return {
    Excalidraw, MainMenu, CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY', NEVER: 'NEVER', EVENTUALLY: 'EVENTUALLY' },
    restore: (data: { elements: unknown[]; appState: Record<string, unknown>; files: unknown }) => ({ elements: structuredClone(data.elements), appState: { selectedElementIds: {}, activeTool: { type: 'selection' }, gridModeEnabled: false, ...data.appState }, files: data.files }),
  };
});
vi.mock('./excalidraw-runtime', () => ({
  loadDrawingFonts: () => fake.fonts ?? Promise.resolve(),
  canvasElements: (step: Step) => step.elements,
  canvasFiles: (files: unknown) => files,
}));
vi.mock('./scene-content', () => ({ sceneFrame: async () => undefined }));
const { default: StepCanvas } = await import('./StepCanvas');

const element = (id: string) => ({ id, type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false, x: 0, y: 0, width: 10, height: 10 });
const target = (stepId: string): Target => ({ projectId: 'p', sceneId: 's', stepId });
const ids = Array.from({ length: 10 }, (_, index) => `s${index + 1}`);
let documents: Map<string, { document: Step; revision: string }>;
let store: StepStore;
const camera: { current: CanvasCamera | undefined } = { current: undefined };
const api = { listSteps: async () => [...documents.values()], asset: async () => new Response('') } as unknown as ApiClient;

function Lienzo() {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <div style={{ width: 1000, height: 700 }}><StepCanvas api={api} store={store} session={store.current()} theme="light" keepFocus={() => false} camera={camera} /></div>;
}
/** Every time the canvas's place changes, what it holds: the loading message, or which step and which Excalidraw. */
function watch() {
  const seen: string[] = [];
  const note = () => {
    const canvas = document.querySelector('.step-canvas');
    seen.push(document.body.textContent?.includes('Cargando') ? 'loading' : canvas ? `step ${canvas.getAttribute('data-step-id')}` : 'empty');
  };
  const observer = new MutationObserver(note);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  return { seen, stop: () => observer.disconnect() };
}
const drawn = () => screen.getByTestId('drawn').textContent;
const go = (stepId: string) => act(async () => { await store.select(target(stepId)); });

beforeEach(async () => {
  fake.mounts = 0; fake.fonts = undefined; camera.current = undefined;
  documents = new Map(ids.map((id) => [id, { document: { ...createStep({ id }), elements: [element(`${id}-shape`)] } as Step, revision: 'r0' }]));
  const drafts = new Map<string, Draft>();
  const recovery: Recovery = { read: async (key) => drafts.get(key), write: async (key, draft) => { drafts.set(key, structuredClone(draft)); }, remove: async (key) => { drafts.delete(key); } };
  const transport: StepTransport = {
    getStep: async ({ stepId }) => structuredClone(documents.get(stepId)!),
    saveStep: async ({ stepId }, revision, document) => {
      if (documents.get(stepId)!.revision !== revision) throw new Error('stale revision');
      const saved = { document: structuredClone(document), revision: `${revision}+` };
      documents.set(stepId, saved); return saved;
    },
    uploadFiles: async () => {},
    deleteStep: async () => {},
  };
  store = new StepStore(transport, recovery, 20);
  await store.select(target('s1'));
});
afterEach(() => { cleanup(); store.stopTimers(); });

describe('moving between steps on the Lienzo', () => {
  it('swaps the drawing in one Excalidraw, never showing the loading message, through a scene of ten steps', async () => {
    render(<Lienzo />);
    await waitFor(() => expect(drawn()).toBe('s1-shape'));
    const watching = watch();
    for (const id of [...ids.slice(1), ...ids.slice(0, -1).reverse()]) {
      await go(id);
      await waitFor(() => expect(drawn()).toBe(`${id}-shape`));
      expect(document.querySelector('.step-canvas')).toHaveAttribute('data-step-id', id);
    }
    watching.stop();
    expect(watching.seen).not.toContain('loading');
    expect(watching.seen).not.toContain('empty');
    expect(fake.mounts).toBe(1);
  });

  it('keeps the step on screen until the next one is ready, then shows it at once', async () => {
    render(<Lienzo />);
    await waitFor(() => expect(drawn()).toBe('s1-shape'));
    let ready!: () => void;
    fake.fonts = new Promise((resolve) => { ready = resolve; });
    await go('s2');
    // Well past the loading delay: still the first step, and no message.
    await act(() => new Promise((resolve) => setTimeout(resolve, LOADING_DELAY_MS + 100)));
    expect(drawn()).toBe('s1-shape');
    expect(screen.queryByText('Cargando dibujo…')).not.toBeInTheDocument();
    await act(async () => { ready(); });
    await waitFor(() => expect(drawn()).toBe('s2-shape'));
  });

  it('saves the edits made on the step being left, even one Excalidraw has not reported yet', async () => {
    render(<Lienzo />);
    await waitFor(() => expect(drawn()).toBe('s1-shape'));
    fireEvent.click(screen.getByRole('button', { name: 'Dibujar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dibujar sin avisar' }));
    await go('s2');
    await waitFor(() => expect(drawn()).toBe('s2-shape'));
    await act(() => store.flushAll());
    expect(documents.get('s1')!.document.elements.map((item) => item.id)).toEqual(['s1-shape', 'drawn-1', 'quiet-2']);
    expect(documents.get('s2')!.document.elements.map((item) => item.id)).toEqual(['s2-shape']);
    expect(documents.get('s2')!.revision).toBe('r0');
  });

  it('never undoes into another step', async () => {
    render(<Lienzo />);
    await waitFor(() => expect(drawn()).toBe('s1-shape'));
    fireEvent.click(screen.getByRole('button', { name: 'Dibujar' }));
    await go('s2');
    await waitFor(() => expect(drawn()).toBe('s2-shape'));
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }));
    expect(drawn()).toBe('s2-shape');
    await act(() => store.flushAll());
    expect(documents.get('s2')!.document.elements.map((item) => item.id)).toEqual(['s2-shape']);
    expect(documents.get('s1')!.document.elements.map((item) => item.id)).toEqual(['s1-shape', 'drawn-1']);
    // Undo still works within the step: what was drawn here goes.
    fireEvent.click(screen.getByRole('button', { name: 'Dibujar' }));
    expect(drawn()).toBe('s2-shape,drawn-1');
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }));
    expect(drawn()).toBe('s2-shape');
  });

  it('still shows an agent\'s changes live after a switch, in the same canvas', async () => {
    render(<Lienzo />);
    await waitFor(() => expect(drawn()).toBe('s1-shape'));
    await go('s2');
    await waitFor(() => expect(drawn()).toBe('s2-shape'));
    const watching = watch();
    const agent = { document: { ...documents.get('s2')!.document, elements: [element('s2-shape'), element('agent')] }, revision: 'agent-1' };
    documents.set('s2', agent);
    await act(() => store.external(target('s2'), 'agent-1'));
    await waitFor(() => expect(drawn()).toBe('s2-shape,agent'));
    watching.stop();
    expect(watching.seen).not.toContain('loading');
    expect(fake.mounts).toBe(1);
    // The reloaded step is the one edits go to.
    fireEvent.click(screen.getByRole('button', { name: 'Dibujar' }));
    await act(() => store.flushAll());
    expect(documents.get('s2')!.document.elements.map((item) => item.id)).toEqual(['s2-shape', 'agent', 'drawn-2']);
  });

  it('mentions loading a diagram only once it takes long enough to notice', async () => {
    let ready!: () => void;
    fake.fonts = new Promise((resolve) => { ready = resolve; });
    render(<Lienzo />);
    expect(screen.queryByText('Cargando dibujo…')).not.toBeInTheDocument();
    expect(await screen.findByText('Cargando dibujo…', {}, { timeout: LOADING_DELAY_MS * 3 })).toBeInTheDocument();
    await act(async () => { ready(); });
    await waitFor(() => expect(drawn()).toBe('s1-shape'));
  });
});

describe('the next step\'s app state', () => {
  const current = { width: 900, height: 600, offsetLeft: 10, offsetTop: 20, theme: 'dark', isLoading: false, scrollX: 5, scrollY: 6, zoom: { value: 2 },
    activeTool: { type: 'laser', locked: false, lastActiveTool: null, customType: null }, currentItemStrokeColor: '#f00', openSidebar: { name: 'default', tab: 'library' },
    selectedElementIds: { old: true }, editingGroupId: 'g', gridModeEnabled: true, viewBackgroundColor: '#000' } as unknown as AppState;
  const restored = { selectedElementIds: {}, editingGroupId: null, gridModeEnabled: false, viewBackgroundColor: '#fff', activeTool: { type: 'selection' }, scrollX: 0, zoom: { value: 1 }, theme: 'light', currentItemStrokeColor: '#1e1e1e', openSidebar: null } as unknown as AppState;
  it('takes the drawing\'s settings and an empty selection from the step, and the window, camera and tool from the screen', () => {
    const next = nextStepState(restored, current, { zen: true, view: false });
    expect(next).toMatchObject({ selectedElementIds: {}, editingGroupId: null, gridModeEnabled: false, viewBackgroundColor: '#fff',
      width: 900, height: 600, offsetLeft: 10, offsetTop: 20, theme: 'dark', scrollX: 5, scrollY: 6, zoom: { value: 2 },
      activeTool: { type: 'laser' }, currentItemStrokeColor: '#f00', openSidebar: { name: 'default', tab: 'library' }, zenModeEnabled: true, viewModeEnabled: false });
  });
  it('goes back to selection from the image tool, as on opening', () => {
    expect(nextStepState(restored, { ...current, activeTool: { ...current.activeTool, type: 'image' } } as unknown as AppState, { zen: false, view: false }).activeTool.type).toBe('selection');
  });
});
