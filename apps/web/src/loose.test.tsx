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

// jsdom has no canvas: Excalidraw is a stand-in whose “Draw” button edits the step the way its onChange would.
vi.mock('./editor/StepCanvas', () => import('./editor/canvas-stand-in'));
vi.mock('./editor/use-thumbnails', () => ({ useThumbnails: () => ({ svgs: {}, titles: {} }) }));
// jsdom has no PointerEvent: without it, a pointer event fired in a test carries no coordinates.
if (typeof window.PointerEvent === 'undefined') {
  class TestPointerEvent extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; } }
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}
// The first test pays for loading the lazy Canvas.
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
const sidebar = () => screen.getByRole('complementary', { name: 'Projects and diagrams' });

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
    expect(within(sidebar()).queryByRole('heading', { name: 'Loose diagrams' })).not.toBeInTheDocument();
    expect(within(sidebar()).getByRole('button', { name: 'New diagram' })).toBeInTheDocument();
  });

  it('lists projects alphabetically, followed by a section of loose diagrams in alphabetical order', async () => {
    await seedProject('b', 'Biología');
    await seedProject('a', 'Álgebra');
    await seedLoose('alpha', 'Ábaco');
    await seedLoose('zeta', 'Zeta');
    render(<App config={config} recovery={memory()} />);

    const panel = within(sidebar());
    const section = await panel.findByRole('region', { name: 'Loose diagrams' }, patience);
    const heading = within(section).getByRole('heading', { name: 'Loose diagrams' });
    expect(panel.getAllByRole('heading')).toEqual([heading]);
    expect([...sidebar().querySelectorAll('.project__name')].map((name) => name.textContent)).toEqual([
      'Álgebra', 'Biología', 'Ábaco', 'Zeta',
    ]);
    expect(within(section).getByRole('list', { name: 'Loose diagrams' })).toHaveTextContent('Ábaco');
  });

  it('creates one with “New diagram”, opens it, renames and deletes it', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    render(<App config={config} recovery={memory()} />);
    await screen.findByRole('button', { name: /^Proyecto/ }, patience);
    // “New diagram” is the last icon of the search row, right after “New project”.
    const navButtons = within(sidebar()).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(navButtons.indexOf('New diagram')).toBe(navButtons.indexOf('New project') + 1);

    await user.click(within(sidebar()).getByRole('button', { name: 'New diagram' }));
    await user.type(screen.getByLabelText('Name of the new diagram'), 'Pizarra rápida{Enter}');
    const row = await screen.findByRole('button', { name: /^Pizarra rápida ?, loose diagram/ }, patience);
    expect(row).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(row).toHaveTextContent('Pizarra rápida'), patience);
    const list = within(sidebar()).getByRole('list', { name: 'Loose diagrams' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    const [sceneId] = await looseScenes();
    await waitFor(() => expect(window.location.hash).toMatch(new RegExp(`^#/_loose/canvas/${sceneId}/[\\w-]+$`)), patience);
    expect(screen.getByRole('heading', { level: 1, name: 'Pizarra rápida' })).toBeInTheDocument();
    expect((await readdir(dataDir)).sort()).toEqual(['.loose', 'p']);
    expect(((await call('/api/projects')) as { projects: Array<{ id: string }> }).projects.map((item) => item.id)).toEqual(['p']);

    // Its menu has no folder to open, and offers the move.
    await user.click(screen.getByRole('button', { name: 'More actions for Pizarra rápida' }));
    expect(screen.queryByRole('menuitem', { name: 'Open folder' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Move to project…' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByLabelText('Name of Pizarra rápida');
    await user.clear(field);
    await user.type(field, 'Boceto{Enter}');
    await screen.findByRole('button', { name: /^Boceto ?, loose diagram/ }, patience);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Boceto'), patience);

    await user.click(screen.getByRole('button', { name: 'More actions for Boceto' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Boceto”?' });
    expect(dialog).toHaveTextContent("This deletes the diagram and its 1 step. This can't be undone.");
    await user.click(within(dialog).getByRole('button', { name: 'Delete diagram' }));
    await waitFor(() => expect(within(sidebar()).queryByRole('list', { name: 'Loose diagrams' })).not.toBeInTheDocument(), patience);
    expect(await looseScenes()).toEqual([]);
    // The diagram on screen went away: the project opens.
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/p\/canvas/), patience);
  });

  it('opens a new loose diagram created while another one is open', async () => {
    const user = userEvent.setup();
    await seedLoose('d', 'Primero');
    window.history.replaceState(null, '', '#/_loose/canvas/d/d-step-0');
    render(<App config={config} recovery={memory()} />);
    await screen.findByRole('heading', { level: 1, name: 'Primero' }, patience);
    await user.click(within(sidebar()).getByRole('button', { name: 'New diagram' }));
    await user.type(screen.getByLabelText('Name of the new diagram'), 'Segundo{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Segundo' }, patience)).toBeInTheDocument();
    const [, created] = await looseScenes();
    await waitFor(() => expect(window.location.hash).toMatch(new RegExp(`^#/_loose/canvas/${created}/[\\w-]+$`)), patience);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(window.location.hash).toMatch(new RegExp(`^#/_loose/canvas/${created}/`));
  });

  it('finds loose diagrams by name in the search', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedLoose('a', 'Árbol binario');
    await seedLoose('b', 'Cola de prioridad');
    render(<App config={config} recovery={memory()} />);
    await screen.findByRole('button', { name: /^Árbol binario/ }, patience);
    await user.click(within(sidebar()).getByRole('button', { name: 'Search' }));
    await user.type(within(sidebar()).getByRole('searchbox', { name: 'Search projects and diagrams' }), 'arbol');
    expect(screen.getByRole('button', { name: /^Árbol binario/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cola de prioridad/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Proyecto/ })).not.toBeInTheDocument();
  });

  it('moves one into a project from “Move to project…”, and the open step follows', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedLoose('d', 'Suelto', 2);
    window.history.replaceState(null, '', '#/_loose/canvas/d/d-step-1');
    render(<App config={config} recovery={memory()} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Suelto' }, patience)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions for Suelto' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to project…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move “Suelto” to a project' });
    await user.click(within(dialog).getByRole('button', { name: 'Proyecto' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), patience);
    await waitFor(() => expect(window.location.hash).toBe('#/p/canvas/d/d-step-1'), patience);
    expect(await screen.findByRole('button', { name: /^Proyecto ?, 2 scenes · 3 steps/ }, patience)).toBeInTheDocument();
    expect(within(sidebar()).queryByRole('list', { name: 'Loose diagrams' })).not.toBeInTheDocument();
    expect(await looseScenes()).toEqual([]);
    expect((JSON.parse(await readFile(join(dataDir, 'p', 'project.json'), 'utf8')) as { sceneIds: string[] }).sceneIds).toEqual(['p-scene', 'd']);
  });

  it('saves an edit still pending before the move, so it arrives in the project', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedLoose('d', 'Suelto');
    window.history.replaceState(null, '', '#/_loose/canvas/d/d-step-0');
    render(<App config={config} recovery={memory()} />);
    await user.click(await screen.findByRole('button', { name: 'Draw' }, patience));
    // Moved at once, before the autosave would have written it.
    await user.click(screen.getByRole('button', { name: 'More actions for Suelto' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to project…' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Proyecto' }));
    await waitFor(() => expect(window.location.hash).toBe('#/p/canvas/d/d-step-0'), patience);
    const step = JSON.parse(await readFile(join(dataDir, 'p', 'scenes', 'd', 'steps', 'd-step-0.json'), 'utf8')) as { elements: Array<{ id: string }> };
    expect(step.elements.map((element) => element.id)).toEqual(['drawn-0']);
    await waitFor(() => expect(screen.getByTestId('elements')).toHaveTextContent('drawn-0'), patience);
  });

  it('moves one when it is dragged onto a project, highlights the target, and Escape cancels', async () => {
    await seedProject('p', 'Proyecto');
    await seedProject('q', 'Otro');
    await seedLoose('d', 'Suelto');
    render(<App config={config} recovery={memory()} />);
    const row = await screen.findByRole('button', { name: /^Suelto ?, loose diagram/ }, patience);
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
    expect(await screen.findByRole('button', { name: /^Proyecto ?, 2 scenes · 2 steps/ }, patience)).toBeInTheDocument();
    expect((JSON.parse(await readFile(join(dataDir, 'p', 'project.json'), 'utf8')) as { sceneIds: string[] }).sceneIds).toEqual(['p-scene', 'd']);
  });

  it('opens on a click that does not drag', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedLoose('d', 'Suelto');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/p\/canvas\/p-scene\/[\w-]+$/), patience);
    await user.click(await screen.findByRole('button', { name: /^Suelto ?, loose diagram/ }, patience));
    await waitFor(() => expect(window.location.hash).toBe('#/_loose/canvas/d/d-step-0'), patience);
    expect(await screen.findByRole('heading', { level: 1, name: 'Suelto' }, patience)).toBeInTheDocument();
  });
});

describe('projects fold and unfold in the sidebar', () => {
  const sceneList = (name: string) => within(sidebar()).queryByRole('list', { name: `Scenes of ${name}` });

  it('keeps an unfolded project unfolded while a new loose diagram opens', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    window.history.replaceState(null, '', '#/p/canvas/p-scene');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneList('Proyecto')).toBeInTheDocument(), patience);

    await user.click(within(sidebar()).getByRole('button', { name: 'New diagram' }));
    await user.type(screen.getByLabelText('Name of the new diagram'), 'Pizarra{Enter}');
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/_loose\/canvas\/[\w-]+\/[\w-]+$/), patience);
    expect(sceneList('Proyecto')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Proyecto ?,/ })).toHaveAttribute('aria-expanded', 'true');

    // From there a scene of the project opens it.
    await user.click(within(sceneList('Proyecto')!).getByRole('button', { name: /^Scene 1: / }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/p\/canvas\/p-scene\/[\w-]+$/), patience);
  });

  it('folds and unfolds the open project with a press on its row, and leaves the others as they were', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedProject('q', 'Otro');
    window.history.replaceState(null, '', '#/p/canvas/p-scene');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneList('Proyecto')).toBeInTheDocument(), patience);
    const proyecto = screen.getByRole('button', { name: /^Proyecto ?,/ });
    const otro = screen.getByRole('button', { name: /^Otro ?,/ });
    expect(otro).toHaveAttribute('aria-expanded', 'false');

    await user.click(proyecto);
    expect(sceneList('Proyecto')).not.toBeInTheDocument();
    expect(proyecto).toHaveAttribute('aria-expanded', 'false');
    expect(window.location.hash).toMatch(/^#\/p\/canvas\/p-scene/);
    await user.click(proyecto);
    expect(sceneList('Proyecto')).toBeInTheDocument();

    // Another project opens unfolded; the first stays unfolded, and folds without being opened.
    await user.click(otro);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/q\/canvas/), patience);
    await waitFor(() => expect(sceneList('Otro')).toBeInTheDocument(), patience);
    expect(sceneList('Proyecto')).toBeInTheDocument();
    await user.click(otro);
    expect(sceneList('Otro')).not.toBeInTheDocument();
    expect(sceneList('Proyecto')).toBeInTheDocument();

    // A scene added to a project that is not open shows under it, and the state survives a reload.
    await call('/api/projects/p/scenes', 'POST', { id: 'p-second', name: 'Escena 2' });
    await waitFor(() => expect(within(sceneList('Proyecto')!).getByRole('button', { name: /^Scene 2: / })).toBeInTheDocument(), patience);
    cleanup();
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneList('Proyecto')).toBeInTheDocument(), patience);
    expect(sceneList('Otro')).not.toBeInTheDocument();
  });
});

describe('moving a scene out of a project, or to another one', () => {
  const sceneButton = (project: string, n: number) => within(screen.getByRole('list', { name: `Scenes of ${project}` })).getByRole('button', { name: new RegExp(`^Scene ${n}: `) });
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
    window.history.replaceState(null, '', '#/p/canvas/p-two/p-two-step');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneButton('Proyecto', 2)).toHaveAttribute('aria-current', 'true'), patience);
    // While there are no loose diagrams, nothing shows for them until a scene is dragged.
    expect(within(sidebar()).queryByRole('list', { name: 'Loose diagrams' })).not.toBeInTheDocument();
    const from = sceneButton('Proyecto', 2);
    // Its own project does not take it.
    const original = document.elementFromPoint;
    document.elementFromPoint = () => screen.getByRole('button', { name: /^Proyecto ?,/ }).closest('li');
    fireEvent.pointerDown(from, { pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 80 });
    const zone = await within(sidebar()).findByRole('list', { name: 'Loose diagrams' });
    expect(zone).toHaveTextContent('Drop here');
    expect(screen.getByRole('button', { name: /^Proyecto ?,/ }).closest('li')).not.toHaveAttribute('data-drop');
    fireEvent.pointerUp(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 80 });
    await waitFor(() => expect(within(sidebar()).queryByRole('list', { name: 'Loose diagrams' })).not.toBeInTheDocument());
    expect(await sceneIds('p')).toEqual(['p-scene', 'p-two']);

    // Onto the loose diagrams' place: it leaves the project with its steps, and the step on screen follows.
    document.elementFromPoint = () => null;
    fireEvent.pointerDown(from, { pointerId: 2, isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(from, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 200 });
    const place = await within(sidebar()).findByRole('list', { name: 'Loose diagrams' });
    document.elementFromPoint = () => place;
    try {
      fireEvent.pointerMove(from, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 210 });
      await waitFor(() => expect(place).toHaveAttribute('data-drop', 'true'));
      expect(document.querySelector('.drag-ghost')).toHaveTextContent('Segunda');
      fireEvent.pointerUp(from, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 210 });
    } finally { document.elementFromPoint = original; }
    await waitFor(() => expect(window.location.hash).toBe('#/_loose/canvas/p-two/p-two-step'), patience);
    expect(await screen.findByRole('button', { name: /^Segunda ?, loose diagram, 1 step/ }, patience)).toBeInTheDocument();
    expect(await sceneIds('p')).toEqual(['p-scene']);
    expect(await looseScenes()).toEqual(['p-two']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Segunda' }, patience)).toBeInTheDocument();
  });

  it('moves a scene to another project by dragging it, and the click that ends the drag opens nothing', async () => {
    await seedProject('p', 'Proyecto');
    await seedProject('q', 'Otro');
    window.history.replaceState(null, '', '#/p/canvas/p-scene');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneButton('Proyecto', 1)).toBeInTheDocument(), patience);
    const from = sceneButton('Proyecto', 1);
    const target = () => screen.getByRole('button', { name: /^Otro ?,/ }).closest('li')!;
    await dragTo(from, target, 1);
    fireEvent.click(from);
    await waitFor(async () => expect(await sceneIds('q')).toEqual(['q-scene', 'p-scene']), patience);
    // The target is written first, as the commit; the source follows a moment later.
    await waitFor(async () => expect(await sceneIds('p')).toEqual([]), patience);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/q\/canvas\/p-scene\/[\w-]+$/), patience);
  });

  it('puts a dragged scene above or below the scene of the target it is dropped on', async () => {
    await seedProject('p', 'Proyecto');
    await seedProject('q', 'Otro');
    await call('/api/projects/q/scenes', 'POST', { id: 'q-two', name: 'Segunda' });
    await seedLoose('d', 'Suelto');
    window.history.replaceState(null, '', '#/p/canvas/p-scene');
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
      // The upper half of “Segunda”: above it, so between the two scenes.
      document.elementFromPoint = () => row(2);
      const from = sceneButton('Proyecto', 1);
      fireEvent.pointerDown(from, { pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 135 });
      await waitFor(() => expect(row(2)).toHaveAttribute('data-insert', 'before'));
      expect(screen.getByRole('button', { name: /^Otro ?,/ }).closest('li')).toHaveAttribute('data-drop', 'true');
      expect(document.body).toHaveTextContent('Drop to move “Escena 1” to “Otro”, above “Segunda”.');
      // Its lower half: below it.
      fireEvent.pointerMove(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 155 });
      await waitFor(() => expect(row(2)).toHaveAttribute('data-insert', 'after'));
      expect(document.body).toHaveTextContent('Drop to move “Escena 1” to “Otro”, below “Segunda”.');
      fireEvent.pointerMove(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 135 });
      await waitFor(() => expect(row(2)).toHaveAttribute('data-insert', 'before'));
      fireEvent.pointerUp(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 135 });
      await waitFor(async () => expect(await sceneIds('q')).toEqual(['q-scene', 'p-scene', 'q-two']), patience);

      // A loose diagram dropped on the first scene's upper half goes first.
      const loose = await screen.findByRole('button', { name: /^Suelto ?, loose diagram/ });
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
    window.history.replaceState(null, '', '#/p/canvas/p-scene');
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
      // The lower half of “Tercera”: last. Only the line shows, not the project as a target.
      document.elementFromPoint = () => row(3);
      fireEvent.pointerMove(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 185 });
      await waitFor(() => expect(row(3)).toHaveAttribute('data-insert', 'after'));
      expect(screen.getByRole('button', { name: /^Proyecto ?,/ }).closest('li')).not.toHaveAttribute('data-drop');
      expect(document.body).toHaveTextContent('Drop to place “Escena 1” below “Tercera”.');
      fireEvent.pointerUp(from, { pointerId: 1, isPrimary: true, clientX: 40, clientY: 185 });
      fireEvent.click(from);
      await waitFor(async () => expect(await sceneIds('p')).toEqual(['p-two', 'p-three', 'p-scene']), patience);
      await waitFor(() => expect(sceneButton('Proyecto', 3)).toHaveAttribute('aria-current', 'true'), patience);

      // “Tercera”, now second, onto the upper half of the first: first.
      document.elementFromPoint = () => row(1);
      const third = sceneButton('Proyecto', 2);
      fireEvent.pointerDown(third, { pointerId: 2, isPrimary: true, button: 0, clientX: 10, clientY: 135 });
      fireEvent.pointerMove(third, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 105 });
      await waitFor(() => expect(row(1)).toHaveAttribute('data-insert', 'before'));
      fireEvent.pointerUp(third, { pointerId: 2, isPrimary: true, clientX: 40, clientY: 105 });
      await waitFor(async () => expect(await sceneIds('p')).toEqual(['p-three', 'p-two', 'p-scene']), patience);
    } finally { document.elementFromPoint = original; boxes.mockRestore(); }
    expect(window.location.hash).toMatch(/^#\/p\/canvas\/p-scene/);
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Scenes of Proyecto' })).getAllByRole('button', { name: /^Scene \d: / }).map((button) => button.textContent))
      .toEqual(['Scene 1: Tercera', 'Scene 2: Segunda', 'Scene 3: Escena 1']), patience);
  });

  it('moves a scene from its menu, to the loose diagrams or to another project', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedProject('q', 'Otro');
    await call('/api/projects/p/scenes', 'POST', { id: 'p-two', name: 'Segunda' });
    window.history.replaceState(null, '', '#/p/canvas/p-scene');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(sceneButton('Proyecto', 2)).toBeInTheDocument(), patience);

    await user.click(screen.getByRole('button', { name: 'Actions for the scene “Segunda”' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move “Segunda”' });
    // Its own project is not offered.
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['Otro', 'Loose diagrams', 'Cancel']);
    await user.click(within(dialog).getByRole('button', { name: 'Loose diagrams' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), patience);
    expect(await screen.findByRole('button', { name: /^Segunda ?, loose diagram/ }, patience)).toBeInTheDocument();
    expect(await looseScenes()).toEqual(['p-two']);
    // The scene on screen did not move, so the board stays where it was.
    expect(window.location.hash).toMatch(/^#\/p\/canvas\/p-scene/);

    await user.click(screen.getByRole('button', { name: 'Actions for the scene “Escena 1”' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Move “Escena 1”' })).getByRole('button', { name: 'Otro' }));
    await waitFor(async () => expect(await sceneIds('q')).toEqual(['q-scene', 'p-scene']), patience);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/q\/canvas\/p-scene/), patience);
  });
});

describe('the step strip of a loose diagram', () => {
  const strip = () => screen.queryByRole('contentinfo', { name: 'Steps of the scene' }) ?? screen.queryByLabelText('Steps of the scene');
  const frames = () => screen.getAllByRole('button', { name: /^Step \d+/ });
  const stepsOf = async (id: string) => ((await call(`/api/projects/_loose/scenes/${id}`)) as { document: { stepIds: string[] } }).document.stepIds;

  it('opens a new one as a plain whiteboard, shows and hides the strip, and remembers the choice', async () => {
    const user = userEvent.setup();
    await seedLoose('d', 'Pizarra');
    window.history.replaceState(null, '', '#/_loose/canvas/d/d-step-0');
    const { unmount } = render(<App config={config} recovery={memory()} />);
    await screen.findByTestId('canvas', {}, patience);
    expect(strip()).not.toBeInTheDocument();
    const show = screen.getByRole('button', { name: 'Show steps' });
    expect(screen.queryByTestId('step-count')).not.toBeInTheDocument();   // one step: no pager

    await user.click(show);
    expect(strip()).toBeInTheDocument();
    expect(frames()).toHaveLength(1);
    // The same button, at the same place, now hides the strip.
    expect(screen.getByRole('button', { name: 'Hide steps' })).toBe(show);
    expect(show).toHaveFocus();
    expect(show).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Add step' }));
    await waitFor(async () => expect(await stepsOf('d')).toHaveLength(2), patience);
    await waitFor(() => expect(frames()).toHaveLength(2), patience);
    const [, second] = await stepsOf('d');
    await waitFor(() => expect(window.location.hash).toBe(`#/_loose/canvas/d/${second}`), patience);
    await waitFor(() => expect(screen.getByTestId('step-count')).toHaveTextContent('02 / 02'), patience);

    // Hidden again, the steps stay, the bar's pager says where you are, and ← → on the canvas still move between them.
    await user.click(screen.getByRole('button', { name: 'Hide steps' }));
    expect(strip()).not.toBeInTheDocument();
    expect(await stepsOf('d')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Show steps' })).toBe(show);
    expect(show).toHaveFocus();
    expect(screen.getByTestId('step-count')).toHaveTextContent('02 / 02');
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveAttribute('data-step-id', second), patience);
    screen.getByTestId('canvas').focus();
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(window.location.hash).toBe('#/_loose/canvas/d/d-step-0'), patience);
    await waitFor(() => expect(screen.getByTestId('step-count')).toHaveTextContent('01 / 02'), patience);
    // The bar's pager moves too, with the strip hidden.
    await user.click(screen.getByRole('button', { name: 'Next step' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/_loose/canvas/d/${second}`), patience);

    // The choice is kept for this diagram, in this browser, even though it now has several steps.
    unmount();
    render(<App config={config} recovery={memory()} />);
    await screen.findByTestId('canvas', {}, patience);
    expect(strip()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show steps' })).toBeInTheDocument();
  });

  it('is a plain whiteboard with one step: no Present, no Studio, the agent beside the Canvas', async () => {
    await seedLoose('d', 'Pizarra');
    window.history.replaceState(null, '', '#/_loose/canvas/d/d-step-0');
    const { unmount } = render(<App config={config} recovery={memory()} />);
    await screen.findByTestId('canvas', {}, patience);
    expect(document.querySelector('.canvas__corner')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Present/ })).not.toBeInTheDocument();
    // The activity bar has no Studio for it, and its chat opens in the left spot, beside the Canvas.
    const bar = screen.getByRole('toolbar', { name: 'Activity bar' });
    expect(within(bar).queryByRole('button', { name: 'Studio' })).not.toBeInTheDocument();
    await userEvent.setup().click(within(bar).getByRole('button', { name: 'Agent chat' }));
    expect(await screen.findByRole('textbox', { name: /agent/i }, patience)).toBeInTheDocument();
    expect(screen.getByTestId('canvas')).toBeInTheDocument();
    unmount();
    // The Studio has nothing to show for it: an old address lands on the Canvas.
    window.history.replaceState(null, '', '#/_loose/storyboard/d/d-step-0');
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(window.location.hash).toBe('#/_loose/canvas/d/d-step-0'), patience);
  });

  it('shows the strip from the start when the diagram has several steps', async () => {
    const user = userEvent.setup();
    await seedLoose('d', 'Varios', 3);
    window.history.replaceState(null, '', '#/_loose/canvas/d/d-step-0');
    render(<App config={config} recovery={memory()} />);
    await screen.findByTestId('canvas', {}, patience);
    expect(strip()).toBeInTheDocument();
    expect(frames()).toHaveLength(3);
    expect(document.querySelector('.canvas__corner')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show steps' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide steps' }));
    expect(screen.getByRole('button', { name: 'Show steps' })).toBeInTheDocument();
    expect(screen.getByTestId('step-count')).toHaveTextContent('01 / 03');
  });

  it('shows a project\'s strip by default, also for a loose diagram moved into one, and lets it be hidden', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    await seedLoose('d', 'Suelto');
    window.history.replaceState(null, '', '#/p/canvas/p-scene');
    const { unmount } = render(<App config={config} recovery={memory()} />);
    await screen.findByTestId('canvas', {}, patience);
    // One step in a project's scene: the strip is there, and the same button can hide it.
    expect(strip()).toBeInTheDocument();
    expect(frames()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Show steps' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide steps' }));
    expect(strip()).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show steps' }));
    expect(strip()).toBeInTheDocument();
    unmount();

    window.history.replaceState(null, '', '#/_loose/canvas/d/d-step-0');
    render(<App config={config} recovery={memory()} />);
    await screen.findByTestId('canvas', {}, patience);
    expect(strip()).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions for Suelto' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to project…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move “Suelto” to a project' });
    await user.click(within(dialog).getByRole('button', { name: 'Proyecto' }));
    await waitFor(() => expect(window.location.hash).toBe('#/p/canvas/d/d-step-0'), patience);
    await waitFor(() => expect(strip()).toBeInTheDocument(), patience);
    expect(screen.getByRole('button', { name: 'Hide steps' })).toBeInTheDocument();
  });
});

describe('the gear in the activity bar', () => {
  afterEach(() => { delete document.documentElement.dataset.theme; });

  it('holds Excalidraw\'s main menu in the gear: it acts on the Canvas, and only the theme works in the Studio', async () => {
    const user = userEvent.setup();
    await seedProject('p', 'Proyecto');
    window.history.replaceState(null, '', '#/p/canvas/p-scene');
    render(<App config={config} recovery={memory()} />);
    await screen.findByTestId('canvas', {}, patience);
    const settings = within(screen.getByRole('toolbar', { name: 'Activity bar' })).getByRole('button', { name: 'Settings' });
    expect(settings).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(settings);
    let menu = await screen.findByRole('menu', { name: 'Settings' });
    expect([...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.getAttribute('aria-label'))).toEqual([
      'Export image…', 'Show grid', 'Zen mode', 'View mode', 'Light theme', 'Dark theme', 'System theme',
      'Library', 'White', 'Light grey', 'Light blue', 'Light yellow', 'Light rose', 'Other colour…',
    ]);
    expect(menu.querySelector('[aria-disabled="true"]')).toBeNull();
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Show grid' }));
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Show grid' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Light blue' }));
    expect(within(menu).getByRole('menuitemradio', { name: 'Light blue' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('canvas-look')).toHaveTextContent('grid #f5faff');
    await user.click(within(menu).getByRole('menuitem', { name: 'Export image…' }));
    expect(screen.queryByRole('menu', { name: 'Settings' })).not.toBeInTheDocument();
    await user.click(settings);
    await user.click(within(await screen.findByRole('menu', { name: 'Settings' })).getByRole('menuitem', { name: 'Library' }));
    expect(screen.getByTestId('canvas-asked')).toHaveTextContent('export,library');
    await user.click(settings);
    menu = await screen.findByRole('menu', { name: 'Settings' });
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(within(menu).getByRole('menuitemradio', { name: 'Dark theme' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Escape}');

    // In the Studio there is no canvas: its options stay in place, greyed, with a note; the theme still works.
    await user.click(within(screen.getByRole('toolbar', { name: 'Activity bar' })).getByRole('button', { name: 'Studio' }));
    await screen.findByRole('main', { name: 'Studio' }, patience);
    await user.click(settings);
    menu = await screen.findByRole('menu', { name: 'Settings' });
    const note = within(menu).getByText('Open a step on the Canvas to use the drawing options.');
    for (const name of ['Export image…', 'Library']) expect(within(menu).getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Show grid' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: 'White' })).toHaveAccessibleDescription(note.textContent!);
    expect(within(menu).getByRole('menuitemradio', { name: 'Light theme' })).not.toHaveAttribute('aria-disabled');
    await user.click(within(menu).getByRole('menuitem', { name: 'Export image…' }));
    expect(screen.getByRole('menu', { name: 'Settings' })).toBeInTheDocument();   // nothing happens, and it stays open
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Light theme' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.click(within(menu).getByRole('menuitemradio', { name: 'System theme' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
