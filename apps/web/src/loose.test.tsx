// @vitest-environment jsdom
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '@paso/server';
import { App } from './App';
import type { Draft, Recovery } from './editor/step-store';
import type { ClientConfig } from './lib/api';

// jsdom has no canvas: Excalidraw is a stand-in whose «Dibujar» button edits the step the way its onChange would.
vi.mock('./editor/StepCanvas', async () => {
  const { useEffect } = await import('react');
  const shape = (id: string) => ({ id, type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false, x: 0, y: 0, width: 10, height: 10 });
  return { default: ({ store, session }: { store: import('./editor/step-store').StepStore; session: import('./editor/step-store').Session }) => {
    // Excalidraw's first onChange sets the baseline; later ones are edits.
    useEffect(() => { session.baseline = undefined; store.change(session, session.document.elements, session.document.appState, {}); }, [session, store]);
    return <div data-testid="canvas" data-step-id={session.target.stepId}>
      <span data-testid="elements">{session.document.elements.map((e) => e.id).join(',')}</span>
      <button type="button" onClick={() => store.change(session, [...session.document.elements, shape(`drawn-${session.document.elements.length}`)], session.document.appState, {})}>Dibujar</button>
    </div>;
  } };
});
vi.mock('./editor/use-thumbnails', () => ({ useThumbnails: () => ({ svgs: {}, titles: {} }) }));
// jsdom has no PointerEvent: without it, a pointer event fired in a test carries no coordinates.
if (typeof window.PointerEvent === 'undefined') {
  class TestPointerEvent extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; } }
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}
// The first test pays for loading the lazy Lienzo.
vi.setConfig({ testTimeout: 30_000 });
const memory = (): Recovery => { const drafts = new Map<string, Draft>(); return { read: async (key) => drafts.get(key), write: async (key, draft) => { drafts.set(key, structuredClone(draft)); }, remove: async (key) => { drafts.delete(key); } }; };

/** Loose diagrams in the sidebar, against a real local service on a temporary data folder. */
type Service = Awaited<ReturnType<typeof startServer>>;
const token = 'loose-web-test-session-token-with-32-chars';
let service: Service;
let testRoot: string;
let dataDir: string;
let config: ClientConfig;
const patience = { timeout: 5000 };

async function call(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${service.url}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.status === 204 ? null : response.json();
}
const seedProject = async (id: string, name: string) => {
  await call('/api/projects', 'POST', { id, name });
  await call(`/api/projects/${id}/scenes`, 'POST', { id: `${id}-scene`, name: 'Escena 1' });
  await call(`/api/projects/${id}/scenes/${id}-scene/steps`, 'POST', {});
};
const seedLoose = async (id: string, name: string, steps = 1) => {
  await call('/api/projects/_loose/scenes', 'POST', { id, name });
  for (let n = 0; n < steps; n += 1) await call(`/api/projects/_loose/scenes/${id}/steps`, 'POST', { id: `${id}-step-${n}` });
};
const looseScenes = async () => (JSON.parse(await readFile(join(dataDir, '.loose', 'project.json'), 'utf8')) as { sceneIds: string[] }).sceneIds;
const sidebar = () => screen.getByRole('complementary', { name: 'Diagramas' });

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'paso-web-loose-'));
  dataDir = join(testRoot, 'projects');
  await mkdir(dataDir);
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  service = await startServer({ dataDir, port: 0, sessionToken: token, allowedOrigins: [window.location.origin], pollIntervalMs: 100,
    harnessDetection: { searchPaths: [], loginShell: false } });
  config = { baseUrl: service.url, token };
});
afterEach(async () => {
  cleanup();
  await service.close();
  await rm(testRoot, { recursive: true, force: true });
});

describe('loose diagrams in the sidebar', () => {
  it('shows nothing for them while there are none', async () => {
    await seedProject('p', 'Proyecto');
    render(<App config={config} recovery={memory()} />);
    await screen.findByRole('button', { name: /^Proyecto/ }, patience);
    expect(within(sidebar()).queryByRole('list', { name: 'Diagramas sueltos' })).not.toBeInTheDocument();
    expect(within(sidebar()).getByRole('button', { name: 'Nuevo diagrama' })).toBeInTheDocument();
  });

  it('creates one with «Nuevo diagrama», opens it, renames and deletes it', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    render(<App config={config} recovery={memory()} />);
    await screen.findByRole('button', { name: /^Proyecto/ }, patience);
    // «Nuevo diagrama» sits right above «Nuevo proyecto».
    const navButtons = within(sidebar()).getAllByRole('button').map((button) => button.textContent);
    expect(navButtons.indexOf('Nuevo diagrama')).toBe(navButtons.indexOf('Nuevo proyecto') - 1);

    await user.click(within(sidebar()).getByRole('button', { name: 'Nuevo diagrama' }));
    await user.type(screen.getByLabelText('Nombre del diagrama suelto nuevo'), 'Pizarra rápida{Enter}');
    const row = await screen.findByRole('button', { name: /^Pizarra rápida ?, diagrama suelto/ }, patience);
    expect(row).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(row).toHaveTextContent('Pizarra rápida'), patience);
    // Below the projects, with no heading of its own, and never as a project.
    const list = within(sidebar()).getByRole('list', { name: 'Diagramas sueltos' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(sidebar()).queryByRole('heading', { name: /suelto/i })).not.toBeInTheDocument();
    const [sceneId] = await looseScenes();
    await waitFor(() => expect(window.location.hash).toMatch(new RegExp(`^#/_loose/lienzo/${sceneId}/[\\w-]+$`)), patience);
    expect(screen.getByRole('heading', { level: 1, name: 'Pizarra rápida' })).toBeInTheDocument();
    expect((await readdir(dataDir)).sort()).toEqual(['.loose', 'p']);
    expect(((await call('/api/projects')) as { projects: Array<{ id: string }> }).projects.map((item) => item.id)).toEqual(['p']);

    // Its menu has no folder to open, and offers the move.
    await user.click(screen.getByRole('button', { name: 'Más acciones de Pizarra rápida' }));
    expect(screen.queryByRole('menuitem', { name: 'Abrir carpeta' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Mover a proyecto…' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Renombrar' }));
    const field = screen.getByLabelText('Nombre de Pizarra rápida');
    await user.clear(field);
    await user.type(field, 'Boceto{Enter}');
    await screen.findByRole('button', { name: /^Boceto ?, diagrama suelto/ }, patience);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Boceto'), patience);

    await user.click(screen.getByRole('button', { name: 'Más acciones de Boceto' }));
    await user.click(await screen.findByRole('menuitem', { name: /Eliminar/ }));
    const dialog = await screen.findByRole('alertdialog', { name: '¿Eliminar «Boceto»?' });
    expect(dialog).toHaveTextContent('Se borrará el diagrama con 1 paso. No se puede deshacer.');
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar diagrama' }));
    await waitFor(() => expect(within(sidebar()).queryByRole('list', { name: 'Diagramas sueltos' })).not.toBeInTheDocument(), patience);
    expect(await looseScenes()).toEqual([]);
    // The diagram on screen went away: the project opens.
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/p\/lienzo/), patience);
  });

  it('opens a new loose diagram created while another one is open', async () => {
    const user = userEvent.setup();
    await seedLoose('d', 'Primero');
    window.history.replaceState(null, '', '#/_loose/lienzo/d/d-step-0');
    render(<App config={config} recovery={memory()} />);
    await screen.findByRole('heading', { level: 1, name: 'Primero' }, patience);
    await user.click(within(sidebar()).getByRole('button', { name: 'Nuevo diagrama' }));
    await user.type(screen.getByLabelText('Nombre del diagrama suelto nuevo'), 'Segundo{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Segundo' }, patience)).toBeInTheDocument();
    const [, created] = await looseScenes();
    await waitFor(() => expect(window.location.hash).toMatch(new RegExp(`^#/_loose/lienzo/${created}/[\\w-]+$`)), patience);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(window.location.hash).toMatch(new RegExp(`^#/_loose/lienzo/${created}/`));
  });

  it('finds loose diagrams by name in the search', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedLoose('a', 'Árbol binario');
    await seedLoose('b', 'Cola de prioridad');
    render(<App config={config} recovery={memory()} />);
    await screen.findByRole('button', { name: /^Árbol binario/ }, patience);
    await user.click(within(sidebar()).getByRole('button', { name: 'Buscar…' }));
    await user.type(within(sidebar()).getByRole('searchbox', { name: 'Buscar diagramas' }), 'arbol');
    expect(screen.getByRole('button', { name: /^Árbol binario/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cola de prioridad/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Proyecto/ })).not.toBeInTheDocument();
  });

  it('moves one into a project from «Mover a proyecto…», and the open step follows', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedLoose('d', 'Suelto', 2);
    window.history.replaceState(null, '', '#/_loose/lienzo/d/d-step-1');
    render(<App config={config} recovery={memory()} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Suelto' }, patience)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Más acciones de Suelto' }));
    await user.click(screen.getByRole('menuitem', { name: 'Mover a proyecto…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mover «Suelto» a un proyecto' });
    await user.click(within(dialog).getByRole('button', { name: 'Proyecto' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), patience);
    await waitFor(() => expect(window.location.hash).toBe('#/p/lienzo/d/d-step-1'), patience);
    expect(await screen.findByRole('button', { name: /^Proyecto ?, 2 escenas · 3 pasos/ }, patience)).toBeInTheDocument();
    expect(within(sidebar()).queryByRole('list', { name: 'Diagramas sueltos' })).not.toBeInTheDocument();
    expect(await looseScenes()).toEqual([]);
    expect((JSON.parse(await readFile(join(dataDir, 'p', 'project.json'), 'utf8')) as { sceneIds: string[] }).sceneIds).toEqual(['p-scene', 'd']);
  });

  it('saves an edit still pending before the move, so it arrives in the project', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedLoose('d', 'Suelto');
    window.history.replaceState(null, '', '#/_loose/lienzo/d/d-step-0');
    render(<App config={config} recovery={memory()} />);
    await user.click(await screen.findByRole('button', { name: 'Dibujar' }, patience));
    // Moved at once, before the autosave would have written it.
    await user.click(screen.getByRole('button', { name: 'Más acciones de Suelto' }));
    await user.click(screen.getByRole('menuitem', { name: 'Mover a proyecto…' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Proyecto' }));
    await waitFor(() => expect(window.location.hash).toBe('#/p/lienzo/d/d-step-0'), patience);
    const step = JSON.parse(await readFile(join(dataDir, 'p', 'scenes', 'd', 'steps', 'd-step-0.json'), 'utf8')) as { elements: Array<{ id: string }> };
    expect(step.elements.map((element) => element.id)).toEqual(['drawn-0']);
    await waitFor(() => expect(screen.getByTestId('elements')).toHaveTextContent('drawn-0'), patience);
    expect(screen.getByRole('complementary', { name: 'Diagramas' }).querySelector('.projects__foot')).toHaveTextContent('Guardado en este equipo');
  });

  it('moves one when it is dragged onto a project, highlights the target, and Escape cancels', async () => {
    await seedProject('p', 'Proyecto');
    await seedProject('q', 'Otro');
    await seedLoose('d', 'Suelto');
    render(<App config={config} recovery={memory()} />);
    const row = await screen.findByRole('button', { name: /^Suelto ?, diagrama suelto/ }, patience);
    const target = screen.getByRole('button', { name: /^Proyecto ?,/ }).closest('li')!;
    // jsdom has no layout: the point under the pointer is the project's row.
    const original = document.elementFromPoint;
    document.elementFromPoint = () => target;
    try {
      // A drag cancelled with Escape moves nothing.
      fireEvent.pointerDown(row, { pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(row, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 80 });
      await waitFor(() => expect(target).toHaveAttribute('data-drop', 'true'));
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(target).not.toHaveAttribute('data-drop'));
      fireEvent.pointerUp(row, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 80 });
      expect(await looseScenes()).toEqual(['d']);

      fireEvent.pointerDown(row, { pointerId: 2, isPrimary: true, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(row, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 80 });
      await waitFor(() => expect(target).toHaveAttribute('data-drop', 'true'));
      expect(document.querySelector('.drag-ghost')).toHaveTextContent('Suelto');
      fireEvent.pointerUp(row, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 80 });
      await waitFor(async () => expect(await looseScenes()).toEqual([]), patience);
    } finally { document.elementFromPoint = original; }
    expect(document.querySelector('.drag-ghost')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Proyecto ?, 2 escenas · 2 pasos/ }, patience)).toBeInTheDocument();
    expect((JSON.parse(await readFile(join(dataDir, 'p', 'project.json'), 'utf8')) as { sceneIds: string[] }).sceneIds).toEqual(['p-scene', 'd']);
  });

  it('opens on a click that does not drag', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedLoose('d', 'Suelto');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/p\/lienzo\/p-scene\/[\w-]+$/), patience);
    await user.click(await screen.findByRole('button', { name: /^Suelto ?, diagrama suelto/ }, patience));
    await waitFor(() => expect(window.location.hash).toBe('#/_loose/lienzo/d/d-step-0'), patience);
    expect(await screen.findByRole('heading', { level: 1, name: 'Suelto' }, patience)).toBeInTheDocument();
  });
});
