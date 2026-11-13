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

describe('projects fold and unfold in the sidebar', () => {
  const sceneList = (name: string) => within(sidebar()).queryByRole('list', { name: `Escenas de ${name}` });

  it('keeps an unfolded project unfolded while a new loose diagram opens', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    window.history.replaceState(null, '', '#/p/lienzo/p-scene');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneList('Proyecto')).toBeInTheDocument(), patience);

    await user.click(within(sidebar()).getByRole('button', { name: 'Nuevo diagrama' }));
    await user.type(screen.getByLabelText('Nombre del diagrama suelto nuevo'), 'Pizarra{Enter}');
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/_loose\/lienzo\/[\w-]+\/[\w-]+$/), patience);
    expect(sceneList('Proyecto')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Proyecto ?,/ })).toHaveAttribute('aria-expanded', 'true');

    // From there a scene of the project opens it.
    await user.click(within(sceneList('Proyecto')!).getByRole('button', { name: /^Escena 1: / }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/p\/lienzo\/p-scene\/[\w-]+$/), patience);
  });

  it('folds and unfolds the open project with a press on its row, and leaves the others as they were', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedProject('q', 'Otro');
    window.history.replaceState(null, '', '#/p/lienzo/p-scene');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneList('Proyecto')).toBeInTheDocument(), patience);
    const proyecto = screen.getByRole('button', { name: /^Proyecto ?,/ });
    const otro = screen.getByRole('button', { name: /^Otro ?,/ });
    expect(otro).toHaveAttribute('aria-expanded', 'false');

    await user.click(proyecto);
    expect(sceneList('Proyecto')).not.toBeInTheDocument();
    expect(proyecto).toHaveAttribute('aria-expanded', 'false');
    expect(window.location.hash).toMatch(/^#\/p\/lienzo\/p-scene/);
    await user.click(proyecto);
    expect(sceneList('Proyecto')).toBeInTheDocument();

    // Another project opens unfolded; the first stays unfolded, and folds without being opened.
    await user.click(otro);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/q\/lienzo/), patience);
    await waitFor(() => expect(sceneList('Otro')).toBeInTheDocument(), patience);
    expect(sceneList('Proyecto')).toBeInTheDocument();
    await user.click(otro);
    expect(sceneList('Otro')).not.toBeInTheDocument();
    expect(sceneList('Proyecto')).toBeInTheDocument();

    // A scene added to a project that is not open shows under it, and the state survives a reload.
    await call('/api/projects/p/scenes', 'POST', { id: 'p-second', name: 'Escena 2' });
    await waitFor(() => expect(within(sceneList('Proyecto')!).getByRole('button', { name: /^Escena 2: / })).toBeInTheDocument(), patience);
    cleanup();
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneList('Proyecto')).toBeInTheDocument(), patience);
    expect(sceneList('Otro')).not.toBeInTheDocument();
  });
});

describe('moving a scene out of a project, or to another one', () => {
  const sceneButton = (project: string, n: number) => within(screen.getByRole('list', { name: `Escenas de ${project}` })).getByRole('button', { name: new RegExp(`^Escena ${n}: `) });
  const sceneIds = async (id: string) => (JSON.parse(await readFile(join(dataDir, id, 'project.json'), 'utf8')) as { sceneIds: string[] }).sceneIds;
  const dragTo = async (from: HTMLElement, onto: () => Element, pointerId: number) => {
    const original = document.elementFromPoint;
    document.elementFromPoint = () => onto();
    try {
      fireEvent.pointerDown(from, { pointerId, isPrimary: true, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(from, { pointerId, isPrimary: true, clientX: 40, clientY: 200 });
      await waitFor(() => expect(onto()).toHaveAttribute('data-drop', 'true'));
      fireEvent.pointerUp(from, { pointerId, isPrimary: true, clientX: 40, clientY: 200 });
    } finally { document.elementFromPoint = original; }
  };

  it('takes the open scene out into the loose diagrams by dragging it there, and the board follows it', async () => {
    await seedProject('p', 'Proyecto');
    await call('/api/projects/p/scenes', 'POST', { id: 'p-two', name: 'Segunda' });
    await call('/api/projects/p/scenes/p-two/steps', 'POST', { id: 'p-two-step' });
    window.history.replaceState(null, '', '#/p/lienzo/p-two/p-two-step');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneButton('Proyecto', 2)).toHaveAttribute('aria-current', 'true'), patience);
    // While there are no loose diagrams, nothing shows for them until a scene is dragged.
    expect(within(sidebar()).queryByRole('list', { name: 'Diagramas sueltos' })).not.toBeInTheDocument();
    const from = sceneButton('Proyecto', 2);
    // Its own project does not take it.
    const original = document.elementFromPoint;
    document.elementFromPoint = () => screen.getByRole('button', { name: /^Proyecto ?,/ }).closest('li');
    fireEvent.pointerDown(from, { pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 80 });
    const zone = await within(sidebar()).findByRole('list', { name: 'Diagramas sueltos' });
    expect(zone).toHaveTextContent('Suelta aquí');
    expect(screen.getByRole('button', { name: /^Proyecto ?,/ }).closest('li')).not.toHaveAttribute('data-drop');
    fireEvent.pointerUp(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 80 });
    await waitFor(() => expect(within(sidebar()).queryByRole('list', { name: 'Diagramas sueltos' })).not.toBeInTheDocument());
    expect(await sceneIds('p')).toEqual(['p-scene', 'p-two']);

    // Onto the loose diagrams' place: it leaves the project with its steps, and the step on screen follows.
    document.elementFromPoint = () => null;
    fireEvent.pointerDown(from, { pointerId: 2, isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(from, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 200 });
    const place = await within(sidebar()).findByRole('list', { name: 'Diagramas sueltos' });
    document.elementFromPoint = () => place;
    try {
      fireEvent.pointerMove(from, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 210 });
      await waitFor(() => expect(place).toHaveAttribute('data-drop', 'true'));
      expect(document.querySelector('.drag-ghost')).toHaveTextContent('Segunda');
      fireEvent.pointerUp(from, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 210 });
    } finally { document.elementFromPoint = original; }
    await waitFor(() => expect(window.location.hash).toBe('#/_loose/lienzo/p-two/p-two-step'), patience);
    expect(await screen.findByRole('button', { name: /^Segunda ?, diagrama suelto, 1 paso/ }, patience)).toBeInTheDocument();
    expect(await sceneIds('p')).toEqual(['p-scene']);
    expect(await looseScenes()).toEqual(['p-two']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Segunda' }, patience)).toBeInTheDocument();
  });

  it('moves a scene to another project by dragging it, and the click that ends the drag opens nothing', async () => {
    await seedProject('p', 'Proyecto');
    await seedProject('q', 'Otro');
    window.history.replaceState(null, '', '#/p/lienzo/p-scene');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneButton('Proyecto', 1)).toBeInTheDocument(), patience);
    const from = sceneButton('Proyecto', 1);
    const target = () => screen.getByRole('button', { name: /^Otro ?,/ }).closest('li')!;
    await dragTo(from, target, 1);
    fireEvent.click(from);
    await waitFor(async () => expect(await sceneIds('q')).toEqual(['q-scene', 'p-scene']), patience);
    expect(await sceneIds('p')).toEqual([]);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/q\/lienzo\/p-scene\/[\w-]+$/), patience);
  });

  it('puts a dragged scene above or below the scene of the target it is dropped on', async () => {
    await seedProject('p', 'Proyecto');
    await seedProject('q', 'Otro');
    await call('/api/projects/q/scenes', 'POST', { id: 'q-two', name: 'Segunda' });
    await seedLoose('d', 'Suelto');
    window.history.replaceState(null, '', '#/p/lienzo/p-scene');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneButton('Proyecto', 1)).toBeInTheDocument(), patience);
    // Unfold the other project, then come back: both lists show.
    await userEvent.setup().click(screen.getByRole('button', { name: /^Otro ?,/ }));
    await waitFor(() => expect(sceneButton('Otro', 2)).toBeInTheDocument(), patience);
    const row = (n: number) => sceneButton('Otro', n).closest('li')!;
    // jsdom has no layout: each row is 30px tall from y = 100.
    const boxes = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const at = Number(this.dataset.dropIndex ?? 0);
      return { top: 100 + at * 30, bottom: 130 + at * 30, height: 30, left: 0, right: 200, width: 200, x: 0, y: 100 + at * 30, toJSON() {} } as DOMRect;
    });
    const original = document.elementFromPoint;
    try {
      // The upper half of «Segunda»: above it, so between the two scenes.
      document.elementFromPoint = () => row(2);
      const from = sceneButton('Proyecto', 1);
      fireEvent.pointerDown(from, { pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 135 });
      await waitFor(() => expect(row(2)).toHaveAttribute('data-insert', 'before'));
      expect(screen.getByRole('button', { name: /^Otro ?,/ }).closest('li')).toHaveAttribute('data-drop', 'true');
      expect(document.body).toHaveTextContent('Suelta para mover «Escena 1» a «Otro», encima de «Segunda».');
      // Its lower half: below it.
      fireEvent.pointerMove(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 155 });
      await waitFor(() => expect(row(2)).toHaveAttribute('data-insert', 'after'));
      expect(document.body).toHaveTextContent('Suelta para mover «Escena 1» a «Otro», debajo de «Segunda».');
      fireEvent.pointerMove(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 135 });
      await waitFor(() => expect(row(2)).toHaveAttribute('data-insert', 'before'));
      fireEvent.pointerUp(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 135 });
      await waitFor(async () => expect(await sceneIds('q')).toEqual(['q-scene', 'p-scene', 'q-two']), patience);

      // A loose diagram dropped on the first scene's upper half goes first.
      const loose = await screen.findByRole('button', { name: /^Suelto ?, diagrama suelto/ });
      await waitFor(() => expect(sceneButton('Otro', 1)).toBeInTheDocument(), patience);
      document.elementFromPoint = () => row(1);
      fireEvent.pointerDown(loose, { pointerId: 2, isPrimary: true, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(loose, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 105 });
      await waitFor(() => expect(row(1)).toHaveAttribute('data-insert', 'before'));
      fireEvent.pointerUp(loose, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 105 });
      await waitFor(async () => expect(await sceneIds('q')).toEqual(['d', 'q-scene', 'p-scene', 'q-two']), patience);
    } finally { document.elementFromPoint = original; boxes.mockRestore(); }
    expect(document.querySelector('[data-insert]')).not.toBeInTheDocument();
  });

  it('puts a scene above or below another one of its own project by dragging it, and the board stays', async () => {
    await seedProject('p', 'Proyecto');
    await call('/api/projects/p/scenes', 'POST', { id: 'p-two', name: 'Segunda' });
    await call('/api/projects/p/scenes', 'POST', { id: 'p-three', name: 'Tercera' });
    window.history.replaceState(null, '', '#/p/lienzo/p-scene');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneButton('Proyecto', 3)).toBeInTheDocument(), patience);
    const row = (n: number) => sceneButton('Proyecto', n).closest('li')!;
    const boxes = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const at = Number(this.dataset.dropIndex ?? 0);
      return { top: 100 + at * 30, bottom: 130 + at * 30, height: 30, left: 0, right: 200, width: 200, x: 0, y: 100 + at * 30, toJSON() {} } as DOMRect;
    });
    const original = document.elementFromPoint;
    try {
      const from = sceneButton('Proyecto', 1);
      // Right below itself, on the next scene's upper half, it would stay put: no line.
      document.elementFromPoint = () => row(2);
      fireEvent.pointerDown(from, { pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 105 });
      fireEvent.pointerMove(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 135 });
      await waitFor(() => expect(document.querySelector('.drag-ghost')).toBeInTheDocument());
      expect(document.querySelector('[data-insert]')).not.toBeInTheDocument();
      // The lower half of «Tercera»: last. Only the line shows, not the project as a target.
      document.elementFromPoint = () => row(3);
      fireEvent.pointerMove(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 185 });
      await waitFor(() => expect(row(3)).toHaveAttribute('data-insert', 'after'));
      expect(screen.getByRole('button', { name: /^Proyecto ?,/ }).closest('li')).not.toHaveAttribute('data-drop');
      expect(document.body).toHaveTextContent('Suelta para colocar «Escena 1» debajo de «Tercera».');
      fireEvent.pointerUp(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 185 });
      fireEvent.click(from);
      await waitFor(async () => expect(await sceneIds('p')).toEqual(['p-two', 'p-three', 'p-scene']), patience);
      await waitFor(() => expect(sceneButton('Proyecto', 3)).toHaveAttribute('aria-current', 'true'), patience);

      // «Tercera», now second, onto the upper half of the first: first.
      document.elementFromPoint = () => row(1);
      const third = sceneButton('Proyecto', 2);
      fireEvent.pointerDown(third, { pointerId: 2, isPrimary: true, button: 0, clientX: 10, clientY: 135 });
      fireEvent.pointerMove(third, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 105 });
      await waitFor(() => expect(row(1)).toHaveAttribute('data-insert', 'before'));
      fireEvent.pointerUp(third, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 105 });
      await waitFor(async () => expect(await sceneIds('p')).toEqual(['p-three', 'p-two', 'p-scene']), patience);
    } finally { document.elementFromPoint = original; boxes.mockRestore(); }
    expect(window.location.hash).toMatch(/^#\/p\/lienzo\/p-scene/);
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Escenas de Proyecto' })).getAllByRole('button', { name: /^Escena \d: / }).map((button) => button.textContent))
      .toEqual(['Escena 1: Tercera', 'Escena 2: Segunda', 'Escena 3: Escena 1']), patience);
  });

  it('moves a scene from its menu, to the loose diagrams or to another project', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedProject('q', 'Otro');
    await call('/api/projects/p/scenes', 'POST', { id: 'p-two', name: 'Segunda' });
    window.history.replaceState(null, '', '#/p/lienzo/p-scene');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneButton('Proyecto', 2)).toBeInTheDocument(), patience);

    await user.click(screen.getByRole('button', { name: 'Acciones de la escena «Segunda»' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mover a…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mover «Segunda»' });
    // Its own project is not offered.
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['Otro', 'Diagramas sueltos', 'Cancelar']);
    await user.click(within(dialog).getByRole('button', { name: 'Diagramas sueltos' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), patience);
    expect(await screen.findByRole('button', { name: /^Segunda ?, diagrama suelto/ }, patience)).toBeInTheDocument();
    expect(await looseScenes()).toEqual(['p-two']);
    // The scene on screen did not move, so the board stays where it was.
    expect(window.location.hash).toMatch(/^#\/p\/lienzo\/p-scene/);

    await user.click(screen.getByRole('button', { name: 'Acciones de la escena «Escena 1»' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mover a…' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Mover «Escena 1»' })).getByRole('button', { name: 'Otro' }));
    await waitFor(async () => expect(await sceneIds('q')).toEqual(['q-scene', 'p-scene']), patience);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/q\/lienzo\/p-scene/), patience);
  });
});
