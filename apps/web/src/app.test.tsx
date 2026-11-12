// @vitest-environment jsdom
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '@paso/server';
import { App } from './App';
import type { ClientConfig } from './lib/api';

/**
 * These tests run the real app against a real local service on a temporary data folder:
 * no mocks of fetch, of the WebSocket or of the service.
 */
type Service = Awaited<ReturnType<typeof startServer>>;
const token = 'web-test-session-token-with-at-least-32-chars';
let service: Service;
let testRoot: string;
let dataDir: string;
let config: ClientConfig;

/** Folders «Abrir carpeta» asked to show. A test never opens the real file manager. */
let opened: string[] = [];
let openFails = false;
async function start(port = 0) {
  service = await startServer({ dataDir, port, sessionToken: token, allowedOrigins: [window.location.origin], pollIntervalMs: 100,
    openFolder: async (path) => { if (openFails) throw new Error('no file manager'); opened.push(path); },
    // The agent panel asks which harnesses are installed: never run the real ones from a test.
    harnessDetection: { searchPaths: [], loginShell: false } });
  config = { baseUrl: service.url, token };
}
async function seed(name: string, id: string, extra: Record<string, unknown> = {}) {
  const response = await fetch(`${service.url}/api/projects`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name, ...extra }),
  });
  expect(response.status).toBe(201);
}
const projectFile = (id: string) => join(dataDir, id, 'project.json');
const readProject = async (id: string) => JSON.parse(await readFile(projectFile(id), 'utf8')) as Record<string, unknown>;
const projectFolders = () => readdir(dataDir);
const patience = { timeout: 5000 };
/** Folders a test adds as workspaces, outside the default one. */
let otherRoot: string | undefined;

beforeEach(async () => {
  // The app's own files (the workspace list, restore points) go next to the data folder, inside this test's folder.
  testRoot = await mkdtemp(join(tmpdir(), 'paso-web-'));
  dataDir = join(testRoot, 'projects');
  await mkdir(dataDir);
  opened = []; openFails = false;
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  await start();
});
afterEach(async () => {
  cleanup();
  await service.close();
  await rm(testRoot, { recursive: true, force: true });
  if (otherRoot) await rm(otherRoot, { recursive: true, force: true });
  otherRoot = undefined;
});

describe('projects panel against the real service', () => {
  it('creates, renames, changes the icon of and deletes a project, and the files follow', async () => {
    const user = userEvent.setup();
    render(<App config={config} />);

    // Nothing yet: the empty state offers the way in.
    expect(await screen.findByRole('heading', { name: 'Crea tu primer diagrama' }, patience)).toBeInTheDocument();

    // Create.
    await user.click(within(screen.getByRole('complementary', { name: 'Diagramas' })).getByRole('button', { name: 'Nuevo proyecto' }));
    await user.type(screen.getByLabelText('Nombre del diagrama nuevo'), 'Búsqueda binaria{Enter}');
    const row = await screen.findByRole('button', { name: /^Búsqueda binaria/ }, patience);
    expect(row).toHaveAttribute('aria-current', 'true');
    // A new diagram is ready to draw on: one scene with one empty step, open on the board.
    await waitFor(() => expect(row).toHaveTextContent('1 escena · 1 paso'), patience);
    expect(screen.getByRole('heading', { level: 1, name: 'Búsqueda binaria' })).toBeInTheDocument();
    const [id] = await projectFolders();
    const [sceneId] = (await readProject(id)).sceneIds as string[];
    await waitFor(() => expect(window.location.hash).toMatch(new RegExp(`^#/${id}/lienzo/${sceneId}/[\\w-]+$`)), patience);
    expect(await screen.findByRole('button', { name: 'Escena 1: Escena 1' }, patience)).toHaveAttribute('aria-current', 'true');
    expect(await readProject(id)).toMatchObject({ name: 'Búsqueda binaria', schemaVersion: 1 });
    expect(await readProject(id)).not.toHaveProperty('icon');

    // Rename, from the row's menu.
    await user.click(screen.getByRole('button', { name: 'Más acciones de Búsqueda binaria' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Renombrar' }));
    const field = screen.getByLabelText('Nombre de Búsqueda binaria');
    await user.clear(field);
    await user.type(field, 'Búsqueda binaria, paso a paso{Enter}');
    await screen.findByRole('button', { name: /^Búsqueda binaria, paso a paso/ }, patience);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Búsqueda binaria, paso a paso');
    expect((await readProject(id)).name).toBe('Búsqueda binaria, paso a paso');

    // Escape leaves the name alone.
    await user.click(screen.getByRole('button', { name: 'Más acciones de Búsqueda binaria, paso a paso' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Renombrar' }));
    await user.type(screen.getByLabelText('Nombre de Búsqueda binaria, paso a paso'), 'x{Escape}');
    expect(screen.queryByLabelText(/^Nombre de/)).not.toBeInTheDocument();
    expect((await readProject(id)).name).toBe('Búsqueda binaria, paso a paso');

    // Icon: search without accents, pick, and it is stored by its Lucide name.
    await user.click(screen.getByRole('button', { name: 'Cambiar el icono de Búsqueda binaria, paso a paso' }));
    const picker = await screen.findByRole('dialog', { name: 'Icono del diagrama' });
    await user.type(within(picker).getByRole('searchbox', { name: 'Buscar icono' }), 'musica');
    await user.click(within(picker).getByRole('button', { name: 'Música' }));
    await waitFor(async () => expect((await readProject(id)).icon).toBe('music'), patience);
    expect(screen.queryByRole('dialog', { name: 'Icono del diagrama' })).not.toBeInTheDocument();

    // Delete: it asks, names the project, and Cancel keeps everything.
    await user.click(screen.getByRole('button', { name: 'Más acciones de Búsqueda binaria, paso a paso' }));
    await user.click(await screen.findByRole('menuitem', { name: /Eliminar/ }));
    const dialog = await screen.findByRole('alertdialog', { name: '¿Eliminar «Búsqueda binaria, paso a paso»?' });
    expect(dialog).toHaveTextContent('No se puede deshacer');
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await projectFolders()).toEqual([id]);

    // Confirm.
    await user.click(screen.getByRole('button', { name: 'Más acciones de Búsqueda binaria, paso a paso' }));
    await user.click(await screen.findByRole('menuitem', { name: /Eliminar/ }));
    await user.click(await screen.findByRole('button', { name: 'Eliminar diagrama' }));
    expect(await screen.findByRole('heading', { name: 'Crea tu primer diagrama' }, patience)).toBeInTheDocument();
    expect(await projectFolders()).toEqual([]);
  });

  it('opens the next project when the open one is deleted', async () => {
    const user = userEvent.setup();
    await seed('Primero', 'first', { icon: 'leaf' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seed('Segundo', 'second');
    render(<App config={config} />);
    // The newest is listed first and opened by default.
    await screen.findByRole('heading', { level: 1, name: 'Segundo' }, patience);
    expect(window.location.hash).toBe('#/second/lienzo');
    await user.click(screen.getByRole('button', { name: 'Más acciones de Segundo' }));
    await user.click(await screen.findByRole('menuitem', { name: /Eliminar/ }));
    await user.click(await screen.findByRole('button', { name: 'Eliminar diagrama' }));
    await screen.findByRole('heading', { level: 1, name: 'Primero' }, patience);
    expect(window.location.hash).toBe('#/first/lienzo');
  });

  it('shows size, icon and current marker on every row', async () => {
    await seed('Con escenas', 'a', { icon: 'leaf' });
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    for (const sceneId of ['s1', 's2']) await fetch(`${service.url}/api/projects/a/scenes`, { method: 'POST', headers: auth, body: JSON.stringify({ id: sceneId, name: sceneId }) });
    for (const stepId of ['t1', 't2', 't3']) await fetch(`${service.url}/api/projects/a/scenes/s1/steps`, { method: 'POST', headers: auth, body: JSON.stringify({ id: stepId }) });
    render(<App config={config} />);
    const row = await screen.findByRole('button', { name: /^Con escenas/ }, patience);
    expect(row).toHaveTextContent('2 escenas · 3 pasos');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Con escenas');
    // The board opens on the first step of the first scene.
    await waitFor(() => expect(window.location.hash).toBe('#/a/lienzo/s1/t1'), patience);
  });

  it('focuses the first menuitem when opening RowMenu while the popover is visible', async () => {
    const user = userEvent.setup();
    await seed('Diagrama teclado', 'kb');
    render(<App config={config} />);
    await screen.findByRole('button', { name: /^Diagrama teclado/ }, patience);

    let visibilityAtFocus: string | undefined;
    const origFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...args) {
      if (this.getAttribute('role') === 'menuitem') {
        visibilityAtFocus = this.closest<HTMLElement>('.popover')?.style.visibility;
      }
      return origFocus.apply(this, args);
    };
    try {
      const moreBtn = screen.getByRole('button', { name: 'Más acciones de Diagrama teclado' });
      moreBtn.focus();
      await user.keyboard('{Enter}');
      const renameItem = await screen.findByRole('menuitem', { name: 'Renombrar' });
      expect(renameItem).toHaveFocus();
      expect(visibilityAtFocus).toBe('');
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: 'Abrir carpeta' })).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: /Eliminar/ })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(moreBtn).toHaveFocus();
    } finally {
      HTMLElement.prototype.focus = origFocus;
    }
  });
});

describe('workspaces in the sidebar', () => {
  it('switches workspace from the menu, adds a folder from the explorer, and takes it off the list without deleting it', async () => {
    const user = userEvent.setup();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await seed('En casa', 'home-project');
    otherRoot = await realpath(await mkdtemp(join(tmpdir(), 'paso-web-other-')));
    await mkdir(join(otherRoot, 'Clases', 'tema'), { recursive: true });
    await writeFile(join(otherRoot, 'Clases', 'tema', 'project.json'), `${JSON.stringify({ schemaVersion: 1, id: 'tema', name: 'Tema 1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sceneIds: [] }, null, 2)}\n`);
    const added = await (await fetch(`${service.url}/api/workspaces`, { method: 'POST', headers: auth, body: JSON.stringify({ path: join(otherRoot, 'Clases') }) })).json() as { id: string };
    render(<App config={config} />);
    const sidebar = await screen.findByRole('complementary', { name: 'Diagramas' }, patience);
    await within(sidebar).findByRole('button', { name: /^En casa/ }, patience);
    expect(within(sidebar).getByRole('region', { name: 'Hoy' })).toHaveTextContent('En casa');

    // Switch: the list, the address and the board follow the other folder.
    await user.click(within(sidebar).getByRole('button', { name: 'Workspace: Mis diagramas' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Clases' }, patience));
    await within(sidebar).findByRole('button', { name: 'Workspace: Clases' }, patience);
    await screen.findByRole('heading', { level: 1, name: 'Tema 1' }, patience);
    await waitFor(() => expect(within(sidebar).getByRole('button', { name: 'Workspace: Clases' })).toBeEnabled(), patience);
    expect(window.location.hash).toBe('#/tema/lienzo');
    expect(within(sidebar).queryByRole('button', { name: /^En casa/ })).not.toBeInTheDocument();
    expect(within(sidebar).getByRole('region', { name: 'Anteriores' })).toHaveTextContent('Tema 1');

    // Search filters the list in place.
    await user.click(within(sidebar).getByRole('button', { name: 'Buscar…' }));
    await user.type(within(sidebar).getByRole('searchbox', { name: 'Buscar diagramas' }), 'nada');
    expect(within(sidebar).getByText('Ningún diagrama coincide.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(within(sidebar).getByRole('button', { name: /^Tema 1/ })).toBeInTheDocument();

    // A new workspace from the explorer: it opens beside the current one, makes a folder and uses it.
    await user.click(within(sidebar).getByRole('button', { name: 'Workspace: Clases' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Nuevo workspace…' }, patience));
    const explorer = await screen.findByRole('dialog', { name: 'Nuevo workspace' }, patience);
    await within(explorer).findByRole('button', { name: /Clases/ }, patience);
    expect(within(explorer).getByRole('status')).toHaveTextContent('Sin diagramas todavía');
    await user.click(within(explorer).getByRole('button', { name: 'Nueva carpeta' }));
    await user.type(within(explorer).getByLabelText('Nombre de la carpeta nueva'), 'Charlas{Enter}');
    await waitFor(() => expect(within(explorer).getByRole('navigation', { name: 'Carpeta actual' })).toHaveTextContent('Charlas'), patience);
    await user.click(within(explorer).getByRole('button', { name: 'Usar esta carpeta' }));
    await within(sidebar).findByRole('button', { name: 'Workspace: Charlas' }, patience);
    expect(screen.queryByRole('dialog', { name: 'Nuevo workspace' })).not.toBeInTheDocument();
    expect(await within(sidebar).findByText('Aún no hay diagramas', undefined, patience)).toBeInTheDocument();
    expect(await readdir(join(otherRoot, 'Charlas'))).toEqual([]);

    // Adding the same folder again is refused in the explorer.
    await user.click(within(sidebar).getByRole('button', { name: 'Workspace: Charlas' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Nuevo workspace…' }, patience));
    const again = await screen.findByRole('dialog', { name: 'Nuevo workspace' }, patience);
    await user.click(await within(again).findByRole('button', { name: /Clases/ }, patience));
    await waitFor(() => expect(within(again).getByRole('status')).toHaveTextContent('Tiene 1 diagrama'), patience);
    await user.click(within(again).getByRole('button', { name: 'Usar esta carpeta' }));
    expect(await within(again).findByRole('alert', undefined, patience)).toHaveTextContent('No se pudo añadir la carpeta. Esta carpeta ya es el workspace «Clases».');
    await user.click(within(again).getByRole('button', { name: 'Cancelar' }));

    // Off the list: back to the default workspace, and the folder is still there.
    await user.click(within(sidebar).getByRole('button', { name: 'Workspace: Charlas' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Quitar de la lista' }, patience));
    await within(sidebar).findByRole('button', { name: 'Workspace: Mis diagramas' }, patience);
    await screen.findByRole('heading', { level: 1, name: 'En casa' }, patience);
    expect(await readdir(otherRoot)).toEqual(['Charlas', 'Clases']);
    // The switcher waits for the switch to finish before it opens again.
    await waitFor(() => expect(within(sidebar).getByRole('button', { name: 'Workspace: Mis diagramas' })).toBeEnabled(), patience);
    await user.click(within(sidebar).getByRole('button', { name: 'Workspace: Mis diagramas' }));
    expect((await screen.findAllByRole('menuitemradio', undefined, patience)).map((item) => item.textContent)).toEqual(['Mis diagramas', 'Clases']);
    expect(screen.queryByRole('menuitem', { name: 'Quitar de la lista' })).not.toBeInTheDocument();
    expect(added.id).toBeTruthy();
  }, 20000);
});

describe('«Abrir carpeta»', () => {
  it('sits under «Renombrar» and opens the project folder; a failure is told in the panel', async () => {
    const user = userEvent.setup();
    await seed('Carpeta', 'carpeta');
    render(<App config={config} />);
    await user.click(await screen.findByRole('button', { name: 'Más acciones de Carpeta' }, patience));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Renombrar', 'Abrir carpeta', 'Eliminar…']);
    await user.click(screen.getByRole('menuitem', { name: 'Abrir carpeta' }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0].endsWith('carpeta')).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    openFails = true;
    await user.click(screen.getByRole('button', { name: 'Más acciones de Carpeta' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Abrir carpeta' }));
    expect(await screen.findByText('No se pudo abrir la carpeta del diagrama.', {}, patience)).toBeInTheDocument();
    expect(opened).toHaveLength(1);
  });
});

describe('corrupt and newer projects', () => {
  it('keeps them as rows with the error and leaves the other projects working', async () => {
    const user = userEvent.setup();
    await seed('Sano', 'ok');
    await mkdir(join(dataDir, 'broken'));
    await writeFile(projectFile('broken'), '{"schemaVersion":1,"id":"broken","name":"","sceneIds":[]}');
    await mkdir(join(dataDir, 'future'));
    await writeFile(projectFile('future'), JSON.stringify({ schemaVersion: 2, id: 'future', name: 'Del futuro' }));
    render(<App config={config} />);

    const broken = await screen.findByRole('button', { name: /^broken/ }, patience);
    expect(broken).toHaveTextContent('No se puede leer: archivos dañados');
    expect(screen.getByRole('button', { name: /^future/ })).toHaveTextContent('Creado con una versión más nueva de Paso');
    // Neither has the edit controls a valid project has.
    expect(screen.queryByRole('button', { name: /Más acciones de broken/ })).not.toBeInTheDocument();

    // The valid project is the one opened, and it still renames.
    expect(await screen.findByRole('heading', { level: 1, name: 'Sano' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Más acciones de Sano' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Renombrar' }));
    await user.type(screen.getByLabelText('Nombre de Sano'), ' y salvo{Enter}');
    await screen.findByRole('button', { name: /^Sano y salvo/ }, patience);

    // Opening the broken row explains it in the main area.
    await user.click(broken);
    expect(await screen.findByRole('heading', { name: 'No se puede abrir «broken»' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/broken/lienzo');
    await user.click(screen.getByRole('button', { name: /^future/ }));
    expect(screen.getByRole('main')).toHaveTextContent('Actualiza Paso para abrirlo');
  });

  it('shows a project that breaks while the app is open, and drops the error when it is repaired', async () => {
    await seed('Sano', 'ok');
    render(<App config={config} />);
    await screen.findByRole('button', { name: /^Sano/ }, patience);
    await mkdir(join(dataDir, 'late'));
    await writeFile(projectFile('late'), '{ not json');
    const row = await screen.findByRole('button', { name: /^late/ }, patience);
    expect(row).toHaveTextContent('archivos dañados');
    const fixed = { schemaVersion: 1, id: 'late', name: 'Reparado', createdAt: '2026-11-07T12:00:00.000Z', updatedAt: '2026-11-07T12:00:00.000Z', sceneIds: [] };
    await writeFile(projectFile('late'), JSON.stringify(fixed));
    const repaired = await screen.findByRole('button', { name: /^Reparado/ }, patience);
    expect(repaired).toHaveTextContent('Sin escenas');
    expect(screen.queryByRole('button', { name: /^late/ })).not.toBeInTheDocument();
  });
});

describe('the board and its overview', () => {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (path: string, method = 'POST', body?: unknown) => fetch(`${service.url}/api${path}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
  async function scenes(id: string, names: string[]) {
    for (const [index, name] of names.entries()) {
      await call(`/projects/${id}/scenes`, 'POST', { id: `s${index + 1}`, name });
      for (const step of [1, 2]) await call(`/projects/${id}/scenes/s${index + 1}/steps`, 'POST', { id: `s${index + 1}t${step}` });
    }
  }

  it('opens a diagram on the board, and the address can still name the overview', async () => {
    await seed('Uno', 'one');
    await seed('Dos', 'two');
    window.location.hash = '#/one/storyboard';
    render(<App config={config} />);
    expect(await screen.findByRole('main', { name: 'Estudio' }, patience)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Uno' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Uno/ })).toHaveAttribute('aria-current', 'true');
    // There is no view switch: the board is the place, the overview a way of looking at it.
    expect(screen.queryByRole('radiogroup', { name: 'Vista' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /^Dos/ }));
    expect(await screen.findByRole('main', { name: 'Lienzo' }, patience)).toBeInTheDocument();
    expect(window.location.hash).toBe('#/two/lienzo');
  });

  it('switches between the Lienzo and the Estudio from the same corner, and goes back with Escape and from a step', async () => {
    const user = userEvent.setup();
    await seed('Uno', 'one');
    await scenes('one', ['Primera', 'Segunda']);
    window.location.hash = '#/one/lienzo/s2/s2t2';
    render(<App config={config} />);
    const lienzo = await screen.findByRole('main', { name: 'Lienzo' }, patience);
    // The switch shows the open view, under Presentar.
    const views = within(lienzo).getByRole('group', { name: 'Vista' });
    expect(within(views).getByRole('button', { name: 'Lienzo' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(views).getByRole('button', { name: 'Estudio' }));
    const board = await screen.findByRole('main', { name: 'Estudio' }, patience);
    expect(window.location.hash).toBe('#/one/storyboard/s2/s2t2');
    await within(board).findByRole('heading', { level: 2, name: 'Segunda' }, patience);
    // The Estudio keeps the same corner: Presentar, then the switch, with the Estudio pressed.
    expect(within(board).getByRole('button', { name: 'Presentar' })).toBeInTheDocument();
    const back = within(board).getByRole('group', { name: 'Vista' });
    expect(within(back).getByRole('button', { name: 'Estudio' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(back).getByRole('button', { name: 'Lienzo' }));
    await screen.findByRole('main', { name: 'Lienzo' }, patience);
    expect(window.location.hash).toBe('#/one/lienzo/s2/s2t2');

    await user.click(await screen.findByRole('button', { name: 'Estudio' }, patience));
    await screen.findByRole('main', { name: 'Estudio' }, patience);
    await user.keyboard('{Escape}');
    await screen.findByRole('main', { name: 'Lienzo' }, patience);
    expect(window.location.hash).toBe('#/one/lienzo/s2/s2t2');

    await user.click(await screen.findByRole('button', { name: 'Estudio' }, patience));
    const again = await screen.findByRole('main', { name: 'Estudio' }, patience);
    // It shows the selected scene only; another one is chosen in the sidebar.
    expect(within(again).queryByRole('region', { name: 'Escena 1: Primera' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Escena 1: Primera' }));
    const first = await within(again).findByRole('region', { name: 'Escena 1: Primera' }, patience);
    await user.click(within(first).getByRole('button', { name: 'Paso 1' }));
    await screen.findByRole('main', { name: 'Lienzo' }, patience);
    expect(window.location.hash).toBe('#/one/lienzo/s1/s1t1');
  });

  it('renames, moves and deletes scenes from the sidebar, like pages', async () => {
    const user = userEvent.setup();
    await seed('Uno', 'one');
    await scenes('one', ['Primera', 'Segunda']);
    window.location.hash = '#/one/lienzo/s2/s2t1';
    render(<App config={config} />);
    const list = () => screen.getByRole('list', { name: 'Escenas de Uno' });
    const names = () => within(list()).getAllByRole('button', { name: /^Escena \d+: / }).map((button) => button.getAttribute('aria-current') ? `[${button.textContent}]` : button.textContent);
    await waitFor(() => expect(names()).toEqual(['Escena 1: Primera', '[Escena 2: Segunda]']), patience);
    // Only the unfolded diagram, here the open one, shows its scenes.
    expect(screen.getAllByRole('list', { name: /^Escenas de / })).toHaveLength(1);

    await user.click(within(list()).getByRole('button', { name: 'Acciones de la escena «Segunda»' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Renombrar' }));
    const field = await screen.findByLabelText('Nombre de la escena 2');
    await user.clear(field);
    await user.type(field, 'El final{Enter}');
    await waitFor(() => expect(names()).toEqual(['Escena 1: Primera', '[Escena 2: El final]']), patience);
    expect((JSON.parse(await readFile(join(dataDir, 'one', 'scenes', 's2', 'scene.json'), 'utf8')) as { name: string }).name).toBe('El final');

    await user.click(within(list()).getByRole('button', { name: 'Acciones de la escena «El final»' }));
    expect(await screen.findByRole('menuitem', { name: 'Bajar' })).toBeDisabled();
    await user.click(screen.getByRole('menuitem', { name: 'Subir' }));
    await waitFor(async () => expect((await readProject('one')).sceneIds).toEqual(['s2', 's1']), patience);
    await waitFor(() => expect(names()).toEqual(['[Escena 1: El final]', 'Escena 2: Primera']), patience);

    // Deleting another scene leaves the board where it is.
    await user.click(within(list()).getByRole('button', { name: 'Acciones de la escena «Primera»' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Eliminar…' }));
    const other = await screen.findByRole('alertdialog', { name: '¿Eliminar la escena «Primera»?' });
    await user.click(within(other).getByRole('button', { name: 'Cancelar' }));

    // Deleting the open one opens its neighbour.
    await user.click(within(list()).getByRole('button', { name: 'Acciones de la escena «El final»' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Eliminar…' }));
    const dialog = await screen.findByRole('alertdialog', { name: '¿Eliminar la escena «El final»?' });
    expect(dialog).toHaveTextContent('Se borrarán 2 pasos');
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar escena' }));
    await waitFor(() => expect(names()).toEqual(['[Escena 1: Primera]']), patience);
    await waitFor(() => expect(window.location.hash).toBe('#/one/lienzo/s1/s1t1'), patience);
    expect((await readProject('one')).sceneIds).toEqual(['s1']);
  });

  it('has no header: the sidebar folds into a rail that opens it again or starts a diagram', async () => {
    const user = userEvent.setup();
    await seed('Uno', 'one');
    render(<App config={config} />);
    await screen.findByRole('main', { name: 'Lienzo' }, patience);
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ocultar diagramas' }));
    expect(screen.queryByRole('complementary', { name: 'Diagramas' })).not.toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: 'Diagramas' });
    await user.click(within(rail).getByRole('button', { name: 'Nuevo proyecto' }));
    expect(await screen.findByLabelText('Nombre del diagrama nuevo')).toHaveFocus();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Ocultar diagramas' }));
    await user.click(screen.getByRole('button', { name: 'Mostrar diagramas' }));
    expect(screen.getByRole('complementary', { name: 'Diagramas' })).toBeInTheDocument();
  });

  it('opens each diagram again on the step where it was left', async () => {
    const user = userEvent.setup();
    await seed('Uno', 'one');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seed('Dos', 'two');
    await scenes('one', ['Primera', 'Segunda']);
    window.location.hash = '#/one/lienzo/s2/s2t2';
    render(<App config={config} />);
    await screen.findByRole('button', { name: 'Escena 2: Segunda' }, patience);
    await user.click(screen.getByRole('button', { name: /^Dos/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/two/lienzo'), patience);
    await user.click(screen.getByRole('button', { name: /^Uno/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/one/lienzo/s2/s2t2'), patience);
  });

  it('says so when the project in the address does not exist', async () => {
    await seed('Uno', 'one');
    window.location.hash = '#/gone/storyboard';
    render(<App config={config} />);
    expect(await screen.findByRole('heading', { name: 'Este diagrama ya no existe' }, patience)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Uno/ })).not.toHaveAttribute('aria-current');
  });
});

describe('live updates', () => {
  it('reflects a project renamed, re-iconed and deleted outside the app', async () => {
    await seed('Original', 'p');
    render(<App config={config} />);
    await screen.findByRole('button', { name: /^Original/ }, patience);
    const doc = await readProject('p');
    await writeFile(projectFile('p'), JSON.stringify({ ...doc, name: 'Editado fuera', icon: 'sun' }, null, 2));
    await screen.findByRole('button', { name: /^Editado fuera/ }, patience);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Editado fuera');
    expect(document.title).toBe('Editado fuera · Paso');
    await rm(join(dataDir, 'p'), { recursive: true });
    expect(await screen.findByRole('heading', { name: 'Crea tu primer diagrama' }, patience)).toBeInTheDocument();
  });

  it('counts a scene and a step added by another client', async () => {
    await seed('Vivo', 'p');
    render(<App config={config} />);
    await screen.findByRole('button', { name: /^Vivo.*Sin escenas/ }, patience);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await fetch(`${service.url}/api/projects/p/scenes`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 's', name: 'Escena' }) });
    await fetch(`${service.url}/api/projects/p/scenes/s/steps`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 't' }) });
    await screen.findByRole('button', { name: /^Vivo.*1 escena · 1 paso/ }, patience);
  });
});

describe('when the service is not there', () => {
  it('says so, offers to retry, and recovers on its own when the service returns', async () => {
    const user = userEvent.setup();
    await seed('Vuelve', 'p');
    const port = service.port;
    await service.close();
    render(<App config={{ baseUrl: `http://127.0.0.1:${port}`, token }} />);
    expect(await screen.findByRole('heading', { name: 'No se puede conectar con el servicio local' }, patience)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Reintentar' }).length).toBeGreaterThan(0);
    await start(port);
    await user.click(screen.getAllByRole('button', { name: 'Reintentar' })[0]);
    expect(await screen.findByRole('button', { name: /^Vuelve/ }, patience)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No se puede conectar con el servicio local' })).not.toBeInTheDocument();
  });

  it('keeps the list when the service stops, reports a failed action, and recovers', async () => {
    const user = userEvent.setup();
    await seed('Sigue', 'p');
    render(<App config={config} />);
    await screen.findByRole('button', { name: /^Sigue/ }, patience);
    const port = service.port;
    await service.close();
    expect(await screen.findByText(/Sin conexión con el servicio/, undefined, patience)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Sigue/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cambiar el icono de Sigue' }));
    await user.click(await screen.findByRole('button', { name: 'Hoja' }));
    const alert = await screen.findByRole('alert', undefined, patience);
    expect(alert).toHaveTextContent('No se pudo cambiar el icono de «Sigue». No hay conexión con el servicio local.');
    await user.click(within(alert).getByRole('button', { name: 'Cerrar aviso' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await start(port);
    await waitFor(() => expect(screen.queryByText(/Sin conexión con el servicio/)).not.toBeInTheDocument(), { timeout: 10000 });
    expect(screen.getByRole('button', { name: /^Sigue/ })).toBeInTheDocument();
  }, 20000);
});
