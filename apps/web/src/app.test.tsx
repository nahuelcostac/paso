// @vitest-environment jsdom
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '@paso/server';
import { App } from './App';
import type { ClientConfig } from './lib/api';

// jsdom cannot draw Excalidraw: the Canvas's canvas is a stand-in here, as in the other suites.
vi.mock('./editor/StepCanvas', () => import('./editor/canvas-stand-in'));

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

/** Folders “Open folder” asked to show. A test never opens the real file manager. */
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
/** The activity bar down the window's left edge: the panels, the Studio, the workspace switcher and the gear. */
const bar = () => screen.getByRole('toolbar', { name: 'Activity bar' });
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
    expect(await screen.findByRole('heading', { name: 'Create your first project' }, patience)).toBeInTheDocument();

    // Create.
    await user.click(within(screen.getByRole('complementary', { name: 'Projects and diagrams' })).getByRole('button', { name: 'New project' }));
    await user.type(screen.getByLabelText('Name of the new project'), 'Búsqueda binaria{Enter}');
    const row = await screen.findByRole('button', { name: /^Búsqueda binaria/ }, patience);
    expect(row).toHaveAttribute('aria-current', 'true');
    // A new diagram is ready to draw on: one scene with one empty step, open on the board.
    await waitFor(() => expect(row).toHaveTextContent('1 scene · 1 step'), patience);
    // The Canvas, lazily loaded, carries the heading: under load it can come after the row.
    expect(await screen.findByRole('heading', { level: 1, name: 'Búsqueda binaria' }, patience)).toBeInTheDocument();
    const [id] = await projectFolders();
    const [sceneId] = (await readProject(id)).sceneIds as string[];
    await waitFor(() => expect(window.location.hash).toMatch(new RegExp(`^#/${id}/canvas/${sceneId}/[\\w-]+$`)), patience);
    expect(await screen.findByRole('button', { name: 'Scene 1: Scene 1' }, patience)).toHaveAttribute('aria-current', 'true');
    expect(await readProject(id)).toMatchObject({ name: 'Búsqueda binaria', schemaVersion: 1 });
    expect(await readProject(id)).not.toHaveProperty('icon');

    // Rename, from the row's menu.
    await user.click(screen.getByRole('button', { name: 'More actions for Búsqueda binaria' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByLabelText('Name of Búsqueda binaria');
    await user.clear(field);
    await user.type(field, 'Búsqueda binaria, paso a paso{Enter}');
    await screen.findByRole('button', { name: /^Búsqueda binaria, paso a paso/ }, patience);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Búsqueda binaria, paso a paso');
    expect((await readProject(id)).name).toBe('Búsqueda binaria, paso a paso');

    // Escape leaves the name alone.
    await user.click(screen.getByRole('button', { name: 'More actions for Búsqueda binaria, paso a paso' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    await user.type(screen.getByLabelText('Name of Búsqueda binaria, paso a paso'), 'x{Escape}');
    expect(screen.queryByLabelText(/^Name of/)).not.toBeInTheDocument();
    expect((await readProject(id)).name).toBe('Búsqueda binaria, paso a paso');

    // Icon: search without accents, pick, and it is stored by its Lucide name.
    await user.click(screen.getByRole('button', { name: 'Change the icon of Búsqueda binaria, paso a paso' }));
    const picker = await screen.findByRole('dialog', { name: 'Project icon' });
    await user.type(within(picker).getByRole('searchbox', { name: 'Search icons' }), 'music');
    await user.click(within(picker).getByRole('button', { name: 'Music' }));
    await waitFor(async () => expect((await readProject(id)).icon).toBe('music'), patience);
    expect(screen.queryByRole('dialog', { name: 'Project icon' })).not.toBeInTheDocument();

    // Delete: it asks, names the project, and Cancel keeps everything.
    await user.click(screen.getByRole('button', { name: 'More actions for Búsqueda binaria, paso a paso' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete “Búsqueda binaria, paso a paso”?' });
    expect(dialog).toHaveTextContent("This can't be undone");
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await projectFolders()).toEqual([id]);

    // Confirm.
    await user.click(screen.getByRole('button', { name: 'More actions for Búsqueda binaria, paso a paso' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    await user.click(await screen.findByRole('button', { name: 'Delete project' }));
    expect(await screen.findByRole('heading', { name: 'Create your first project' }, patience)).toBeInTheDocument();
    expect(await projectFolders()).toEqual([]);
  });

  it('opens the next project when the open one is deleted', async () => {
    const user = userEvent.setup();
    await seed('Primero', 'first', { icon: 'leaf' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seed('Segundo', 'second');
    render(<App config={config} />);
    // The first project in alphabetical order opens by default.
    await screen.findByRole('heading', { level: 1, name: 'Primero' }, patience);
    expect(window.location.hash).toBe('#/first/canvas');
    await user.click(screen.getByRole('button', { name: 'More actions for Primero' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    await user.click(await screen.findByRole('button', { name: 'Delete project' }));
    await screen.findByRole('heading', { level: 1, name: 'Segundo' }, patience);
    expect(window.location.hash).toBe('#/second/canvas');
  });

  it('shows size, icon and current marker on every row', async () => {
    await seed('Con escenas', 'a', { icon: 'leaf' });
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    for (const sceneId of ['s1', 's2']) await fetch(`${service.url}/api/projects/a/scenes`, { method: 'POST', headers: auth, body: JSON.stringify({ id: sceneId, name: sceneId }) });
    for (const stepId of ['t1', 't2', 't3']) await fetch(`${service.url}/api/projects/a/scenes/s1/steps`, { method: 'POST', headers: auth, body: JSON.stringify({ id: stepId }) });
    render(<App config={config} />);
    const row = await screen.findByRole('button', { name: /^Con escenas/ }, patience);
    expect(row).toHaveTextContent('2 scenes · 3 steps');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Con escenas');
    // The board opens on the first step of the first scene.
    await waitFor(() => expect(window.location.hash).toBe('#/a/canvas/s1/t1'), patience);
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
      const moreBtn = screen.getByRole('button', { name: 'More actions for Diagrama teclado' });
      moreBtn.focus();
      await user.keyboard('{Enter}');
      const renameItem = await screen.findByRole('menuitem', { name: 'Rename' });
      expect(renameItem).toHaveFocus();
      expect(visibilityAtFocus).toBe('');
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: 'Open folder' })).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('menuitem', { name: /Delete/ })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(moreBtn).toHaveFocus();
    } finally {
      HTMLElement.prototype.focus = origFocus;
    }
  });
});

describe('workspaces, from the activity bar', () => {
  it('switches workspace from the menu, adds a folder from the explorer, and takes it off the list without deleting it', async () => {
    const user = userEvent.setup();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await seed('En casa', 'home-project');
    otherRoot = await realpath(await mkdtemp(join(tmpdir(), 'paso-web-other-')));
    await mkdir(join(otherRoot, 'Clases', 'tema'), { recursive: true });
    await writeFile(join(otherRoot, 'Clases', 'tema', 'project.json'), `${JSON.stringify({ schemaVersion: 1, id: 'tema', name: 'Tema 1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sceneIds: [] }, null, 2)}\n`);
    const added = await (await fetch(`${service.url}/api/workspaces`, { method: 'POST', headers: auth, body: JSON.stringify({ path: join(otherRoot, 'Clases') }) })).json() as { id: string };
    render(<App config={config} />);
    const sidebar = await screen.findByRole('complementary', { name: 'Projects and diagrams' }, patience);
    await within(sidebar).findByRole('button', { name: /^En casa/ }, patience);
    expect(within(sidebar).getByRole('list', { name: 'Projects' })).toHaveTextContent('En casa');

    // Switch: the list, the address and the board follow the other folder.
    await user.click(within(bar()).getByRole('button', { name: 'Workspace: My projects' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Clases' }, patience));
    await within(bar()).findByRole('button', { name: 'Workspace: Clases' }, patience);
    await screen.findByRole('heading', { level: 1, name: 'Tema 1' }, patience);
    await waitFor(() => expect(within(bar()).getByRole('button', { name: 'Workspace: Clases' })).toBeEnabled(), patience);
    expect(window.location.hash).toBe('#/tema/canvas');
    expect(within(sidebar).queryByRole('button', { name: /^En casa/ })).not.toBeInTheDocument();
    expect(within(sidebar).getByRole('list', { name: 'Projects' })).toHaveTextContent('Tema 1');

    // Search filters the list in place.
    await user.click(within(sidebar).getByRole('button', { name: 'Search' }));
    await user.type(within(sidebar).getByRole('searchbox', { name: 'Search projects and diagrams' }), 'nada');
    expect(within(sidebar).getByText('No matches.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(within(sidebar).getByRole('button', { name: /^Tema 1/ })).toBeInTheDocument();

    // A new workspace from the explorer: it opens beside the current one, makes a folder and uses it.
    await user.click(within(bar()).getByRole('button', { name: 'Workspace: Clases' }));
    await user.click(await screen.findByRole('menuitem', { name: 'New workspace…' }, patience));
    const explorer = await screen.findByRole('dialog', { name: 'New workspace' }, patience);
    await within(explorer).findByRole('button', { name: /Clases/ }, patience);
    expect(within(explorer).getByRole('status')).toHaveTextContent('No projects yet');
    await user.click(within(explorer).getByRole('button', { name: 'New folder' }));
    await user.type(within(explorer).getByLabelText('Name of the new folder'), 'Charlas{Enter}');
    await waitFor(() => expect(within(explorer).getByRole('navigation', { name: 'Current folder' })).toHaveTextContent('Charlas'), patience);
    await user.click(within(explorer).getByRole('button', { name: 'Use this folder' }));
    await within(bar()).findByRole('button', { name: 'Workspace: Charlas' }, patience);
    expect(screen.queryByRole('dialog', { name: 'New workspace' })).not.toBeInTheDocument();
    expect(await within(sidebar).findByText('Nothing here yet', undefined, patience)).toBeInTheDocument();
    expect(await readdir(join(otherRoot, 'Charlas'))).toEqual([]);

    // Adding the same folder again is refused in the explorer.
    await user.click(within(bar()).getByRole('button', { name: 'Workspace: Charlas' }));
    await user.click(await screen.findByRole('menuitem', { name: 'New workspace…' }, patience));
    const again = await screen.findByRole('dialog', { name: 'New workspace' }, patience);
    await user.click(await within(again).findByRole('button', { name: /Clases/ }, patience));
    await waitFor(() => expect(within(again).getByRole('status')).toHaveTextContent('Has 1 project'), patience);
    await user.click(within(again).getByRole('button', { name: 'Use this folder' }));
    expect(await within(again).findByRole('alert', undefined, patience)).toHaveTextContent("Couldn't add the folder. This folder is already the workspace “Clases”.");
    await user.click(within(again).getByRole('button', { name: 'Cancel' }));

    // Off the list: back to the default workspace, and the folder is still there.
    await user.click(within(bar()).getByRole('button', { name: 'Workspace: Charlas' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from list' }, patience));
    await within(bar()).findByRole('button', { name: 'Workspace: My projects' }, patience);
    await screen.findByRole('heading', { level: 1, name: 'En casa' }, patience);
    expect(await readdir(otherRoot)).toEqual(['Charlas', 'Clases']);
    // The switcher waits for the switch to finish before it opens again.
    await waitFor(() => expect(within(bar()).getByRole('button', { name: 'Workspace: My projects' })).toBeEnabled(), patience);
    await user.click(within(bar()).getByRole('button', { name: 'Workspace: My projects' }));
    expect((await screen.findAllByRole('menuitemradio', undefined, patience)).map((item) => item.textContent)).toEqual(['My projects', 'Clases']);
    expect(screen.queryByRole('menuitem', { name: 'Remove from list' })).not.toBeInTheDocument();
    expect(added.id).toBeTruthy();
  }, 20000);
});

describe('“New workspace…” in the desktop app', () => {
  type Bridge = { chooseFolder?: (near?: string) => Promise<string | null> };
  const desktop = window as Window & { pasoDesktop?: Bridge };
  afterEach(() => { delete desktop.pasoDesktop; });

  it('uses the system folder dialog instead of the explorer, and a cancel or a refused folder changes nothing', async () => {
    const user = userEvent.setup();
    otherRoot = await realpath(await mkdtemp(join(tmpdir(), 'paso-web-native-')));
    await mkdir(join(otherRoot, 'Charlas'));
    const asked: Array<string | undefined> = [];
    let answer: string | null | Error = null;
    desktop.pasoDesktop = { chooseFolder: async (near) => { asked.push(near); if (answer instanceof Error) throw answer; return answer; } };
    render(<App config={config} />);
    const sidebar = await screen.findByRole('complementary', { name: 'Projects and diagrams' }, patience);
    const openMenu = async (name: string) => {
      await waitFor(() => expect(within(bar()).getByRole('button', { name: `Workspace: ${name}` })).toBeEnabled(), patience);
      await user.click(within(bar()).getByRole('button', { name: `Workspace: ${name}` }));
      await user.click(await screen.findByRole('menuitem', { name: 'New workspace…' }, patience));
    };

    // Cancelled: no explorer, no notice, the same workspace.
    await openMenu('My projects');
    await waitFor(() => expect(asked).toEqual([undefined]), patience);
    expect(screen.queryByRole('dialog', { name: 'New workspace' })).not.toBeInTheDocument();
    expect(within(sidebar).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(bar()).getByRole('button', { name: 'Workspace: My projects' })).toBeInTheDocument();

    // Picked: the folder becomes the open workspace.
    answer = join(otherRoot, 'Charlas');
    await openMenu('My projects');
    await within(bar()).findByRole('button', { name: 'Workspace: Charlas' }, patience);
    expect(screen.queryByRole('dialog', { name: 'New workspace' })).not.toBeInTheDocument();

    // From a folder workspace the dialog starts beside it; the service still refuses a folder already on the list.
    await openMenu('Charlas');
    await waitFor(() => expect(asked).toEqual([undefined, undefined, join(otherRoot!, 'Charlas')]), patience);
    expect(await within(sidebar).findByRole('alert', undefined, patience)).toHaveTextContent("Couldn't add the folder. This folder is already the workspace “Charlas”.");

    // The dialog itself failing is told too.
    answer = new Error('no dialog');
    await openMenu('Charlas');
    expect(await within(sidebar).findByRole('alert', undefined, patience)).toHaveTextContent("Couldn't open the folder chooser.");
  }, 20000);
});

describe('“Open folder”', () => {
  it('sits under “Rename” and opens the project folder; a failure is told in the panel', async () => {
    const user = userEvent.setup();
    await seed('Carpeta', 'carpeta');
    render(<App config={config} />);
    await user.click(await screen.findByRole('button', { name: 'More actions for Carpeta' }, patience));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Rename', 'Open folder', 'Delete…']);
    await user.click(screen.getByRole('menuitem', { name: 'Open folder' }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0].endsWith('carpeta')).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    openFails = true;
    await user.click(screen.getByRole('button', { name: 'More actions for Carpeta' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Open folder' }));
    expect(await screen.findByText("Couldn't open the project's folder.", {}, patience)).toBeInTheDocument();
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
    expect(broken).toHaveTextContent("Can't be read: damaged files");
    expect(screen.getByRole('button', { name: /^future/ })).toHaveTextContent('Made with a newer version of Paso');
    // Neither has the edit controls a valid project has.
    expect(screen.queryByRole('button', { name: /More actions for broken/ })).not.toBeInTheDocument();

    // The valid project is the one opened, and it still renames.
    expect(await screen.findByRole('heading', { level: 1, name: 'Sano' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions for Sano' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    await user.type(screen.getByLabelText('Name of Sano'), ' y salvo{Enter}');
    await screen.findByRole('button', { name: /^Sano y salvo/ }, patience);

    // Opening the broken row explains it in the main area.
    await user.click(broken);
    expect(await screen.findByRole('heading', { name: "Can't open “broken”" })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/broken/canvas');
    await user.click(screen.getByRole('button', { name: /^future/ }));
    expect(screen.getByRole('main')).toHaveTextContent('Update Paso to open it');
  });

  it('shows a project that breaks while the app is open, and drops the error when it is repaired', async () => {
    await seed('Sano', 'ok');
    render(<App config={config} />);
    await screen.findByRole('button', { name: /^Sano/ }, patience);
    await mkdir(join(dataDir, 'late'));
    await writeFile(projectFile('late'), '{ not json');
    const row = await screen.findByRole('button', { name: /^late/ }, patience);
    expect(row).toHaveTextContent('damaged files');
    const fixed = { schemaVersion: 1, id: 'late', name: 'Reparado', createdAt: '2026-11-07T12:00:00.000Z', updatedAt: '2026-11-07T12:00:00.000Z', sceneIds: [] };
    await writeFile(projectFile('late'), JSON.stringify(fixed));
    const repaired = await screen.findByRole('button', { name: /^Reparado/ }, patience);
    expect(repaired).toHaveTextContent('No scenes');
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
    expect(await screen.findByRole('main', { name: 'Studio' }, patience)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Uno' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Uno/ })).toHaveAttribute('aria-current', 'true');
    // There is no view switch: the board is the place, the overview a way of looking at it.
    expect(screen.queryByRole('radiogroup', { name: 'View' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /^Dos/ }));
    expect(await screen.findByRole('main', { name: 'Canvas' }, patience)).toBeInTheDocument();
    expect(window.location.hash).toBe('#/two/canvas');
  });

  it('switches views with the Diagram and Studio buttons and returns to the Canvas with Escape or a step', async () => {
    const user = userEvent.setup();
    await seed('Uno', 'one');
    await scenes('one', ['Primera', 'Segunda']);
    window.location.hash = '#/one/canvas/s2/s2t2';
    render(<App config={config} />);
    // There is no view switch in the corner any more: it keeps Present, and the bar says which view is open.
    const present = await screen.findByRole('button', { name: 'Present' }, patience);
    expect(present.closest('.canvas__corner')).not.toBeNull();
    expect(screen.queryByRole('group', { name: 'View' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Canvas' })).not.toBeInTheDocument();
    const bar = screen.getByRole('toolbar', { name: 'Activity bar' });
    const diagram = within(bar).getByRole('button', { name: 'Diagram' });
    const studio = within(bar).getByRole('button', { name: 'Studio' });
    expect(diagram.querySelector('.lucide-presentation')).toBeInTheDocument();
    expect(diagram).toHaveAttribute('aria-pressed', 'true');
    expect(studio).toHaveAttribute('aria-pressed', 'false');
    await user.click(studio);
    const board = await screen.findByRole('main', { name: 'Studio' }, patience);
    expect(window.location.hash).toBe('#/one/storyboard/s2/s2t2');
    expect(diagram).toHaveAttribute('aria-pressed', 'false');
    expect(studio).toHaveAttribute('aria-pressed', 'true');
    await within(board).findByRole('heading', { level: 2, name: 'Segunda' }, patience);
    expect(within(board).getByRole('button', { name: 'Present' })).toBeInTheDocument();
    expect(within(board).queryByRole('group', { name: 'View' })).not.toBeInTheDocument();
    // Studio stays on that view when pressed again. Diagram goes back to the same step.
    await user.click(studio);
    expect(screen.getByRole('main', { name: 'Studio' })).toBeInTheDocument();
    await user.click(diagram);
    await screen.findByRole('main', { name: 'Canvas' }, patience);
    expect(window.location.hash).toBe('#/one/canvas/s2/s2t2');
    expect(diagram).toHaveAttribute('aria-pressed', 'true');
    expect(studio).toHaveAttribute('aria-pressed', 'false');

    // From the bar, the focus lands on the Studio's title, so Escape goes back.
    await user.click(studio);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Uno' })).toHaveFocus(), patience);
    await user.keyboard('{Escape}');
    await screen.findByRole('main', { name: 'Canvas' }, patience);
    expect(window.location.hash).toBe('#/one/canvas/s2/s2t2');

    await user.click(studio);
    const again = await screen.findByRole('main', { name: 'Studio' }, patience);
    // It shows the selected scene only; another one is chosen in the sidebar.
    expect(within(again).queryByRole('region', { name: 'Scene 1: Primera' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Show sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Scene 1: Primera' }));
    const first = await within(again).findByRole('region', { name: 'Scene 1: Primera' }, patience);
    await user.click(within(first).getByRole('button', { name: 'Step 1' }));
    await screen.findByRole('main', { name: 'Canvas' }, patience);
    expect(window.location.hash).toBe('#/one/canvas/s1/s1t1');
  });

  it('renames and deletes scenes from the sidebar, like pages', async () => {
    const user = userEvent.setup();
    await seed('Uno', 'one');
    await scenes('one', ['Primera', 'Segunda']);
    window.location.hash = '#/one/canvas/s2/s2t1';
    render(<App config={config} />);
    const list = () => screen.getByRole('list', { name: 'Scenes of Uno' });
    const names = () => within(list()).getAllByRole('button', { name: /^Scene \d+: / }).map((button) => button.getAttribute('aria-current') ? `[${button.textContent}]` : button.textContent);
    await waitFor(() => expect(names()).toEqual(['Scene 1: Primera', '[Scene 2: Segunda]']), patience);
    // Only the unfolded diagram, here the open one, shows its scenes.
    expect(screen.getAllByRole('list', { name: /^Scenes of / })).toHaveLength(1);

    await user.click(within(list()).getByRole('button', { name: 'Actions for the scene “Segunda”' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = await screen.findByLabelText('Name of scene 2');
    await user.clear(field);
    await user.type(field, 'El final{Enter}');
    await waitFor(() => expect(names()).toEqual(['Scene 1: Primera', '[Scene 2: El final]']), patience);
    expect((JSON.parse(await readFile(join(dataDir, 'one', 'scenes', 's2', 'scene.json'), 'utf8')) as { name: string }).name).toBe('El final');

    // Scenes change place by dragging them, so the menu has no “Up” or “Down”.
    await user.click(within(list()).getByRole('button', { name: 'Actions for the scene “El final”' }));
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Rename', 'Move to…', 'Delete…']);
    await user.keyboard('{Escape}');

    // Deleting another scene leaves the board where it is.
    await user.click(within(list()).getByRole('button', { name: 'Actions for the scene “Primera”' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const other = await screen.findByRole('alertdialog', { name: 'Delete the scene “Primera”?' });
    await user.click(within(other).getByRole('button', { name: 'Cancel' }));

    // Deleting the open one opens its neighbour.
    await user.click(within(list()).getByRole('button', { name: 'Actions for the scene “El final”' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete the scene “El final”?' });
    expect(dialog).toHaveTextContent('This deletes 2 steps');
    await user.click(within(dialog).getByRole('button', { name: 'Delete scene' }));
    await waitFor(() => expect(names()).toEqual(['[Scene 1: Primera]']), patience);
    await waitFor(() => expect(window.location.hash).toBe('#/one/canvas/s1/s1t1'), patience);
    expect((await readProject('one')).sceneIds).toEqual(['s1']);
  });

  it('shows the projects from the sidebar toggle and remembers the open panel', async () => {
    const user = userEvent.setup();
    await seed('Uno', 'one');
    await scenes('one', ['Primera']);
    window.location.hash = '#/one/canvas/s1/s1t1';
    const { unmount } = render(<App config={config} />);
    await screen.findByRole('main', { name: 'Canvas' }, patience);
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    const bar = screen.getByRole('toolbar', { name: 'Activity bar' });
    expect(bar).toHaveAttribute('aria-orientation', 'vertical');
    expect(within(bar).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Diagram', 'Studio', 'Workspace: My projects', 'Settings']);
    // The workspace switcher is no longer in the projects panel.
    expect(within(screen.getByRole('complementary', { name: 'Projects and diagrams' })).queryByRole('button', { name: /^Workspace/ })).not.toBeInTheDocument();
    for (const button of within(bar).getAllByRole('button')) expect(button).toHaveAttribute('title');
    // The projects are open at first, in the left spot, with the edge to drag.
    const sidebar = screen.getByRole('complementary', { name: 'Projects and diagrams' });
    // The main view sits apart from the panel, in its own box with rounded left corners; the panel is not in it.
    // The panel starts with the app's icon and name, after the window's buttons in the desktop app.
    expect(sidebar.querySelector('.panel-brand')).toHaveTextContent('Paso');
    const app = bar.closest('.app');
    expect(app).toHaveClass('app--projects');
    const main = document.querySelector('.main')!;
    expect(main).toContainElement(screen.getByRole('main', { name: 'Canvas' }));
    expect(main).not.toContainElement(sidebar);
    expect(sidebar).toHaveTextContent(/^Paso(?!\.)/);
    const toggle = screen.getByRole('button', { name: 'Hide sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'projects-panel');
    expect(sidebar).toHaveAttribute('id', 'projects-panel');
    expect(screen.getByRole('separator', { name: 'Sidebar width' })).toHaveAttribute('aria-valuenow', '240');
    // As in T3 Code, one row: “Search”, then the project filter and the two ways to make something new, as icons.
    const row = sidebar.querySelector<HTMLElement>('.nav-actions')!;
    expect(within(sidebar).queryByRole('separator')).not.toBeInTheDocument();
    expect([...row.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Search', 'Filter by project: All projects', 'New project', 'New diagram']);
    for (const name of ['Filter by project: All projects', 'New project', 'New diagram']) expect(within(row).getByRole('button', { name })).toHaveTextContent(/^$/);
    // While searching, the field takes the place of “Search”; the icons stay.
    await user.click(within(sidebar).getByRole('button', { name: 'Search' }));
    expect(row).toContainElement(within(sidebar).getByRole('searchbox', { name: 'Search projects and diagrams' }));
    expect(within(row).getByRole('button', { name: 'Filter by project: All projects' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(within(row).getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: 'New project' })).toHaveTextContent(/^$/);
    // Its button folds it: nothing is left of it, not even the edge to drag.
    await user.click(toggle);
    expect(screen.queryByRole('complementary', { name: 'Projects and diagrams' })).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    expect(toggle).toHaveFocus();
    expect(screen.queryByRole('separator', { name: 'Sidebar width' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('paso.side-panel')).toBe('none');
    expect(app).toHaveClass('app--folded');
    await user.click(toggle);
    expect(app).not.toHaveClass('app--folded');
    expect(screen.getByRole('complementary', { name: 'Projects and diagrams' })).toBeInTheDocument();

    const studio = within(bar).getByRole('button', { name: 'Studio' });
    expect(studio.querySelector('.lucide-clapperboard')).toBeInTheDocument();
    expect(studio).toHaveAttribute('aria-expanded', 'false');
    expect(studio).toHaveAttribute('title', 'Open Studio with agent chat');
    await user.click(studio);
    await screen.findByRole('main', { name: 'Studio' }, patience);
    const panel = await screen.findByRole('complementary', { name: 'Agent' }, patience);
    expect(panel).toHaveAttribute('id', 'agent-panel');
    expect(studio).toHaveAttribute('aria-expanded', 'true');
    expect(studio).toHaveAttribute('aria-controls', 'agent-panel');
    expect(toggle).toHaveAttribute('aria-controls', 'agent-panel');
    expect(screen.queryByRole('complementary', { name: 'Projects and diagrams' })).not.toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Chat width' })).toHaveAttribute('aria-valuenow', '360');
    expect(document.querySelector('.app')).toHaveClass('app--agent');
    // Projects take the left spot. Studio brings the chat back while the overview stays open.
    await user.click(toggle);
    await user.click(toggle);
    expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Projects and diagrams' })).toBeInTheDocument();
    expect(studio).toHaveAttribute('title', 'Open agent chat');
    await user.click(studio);
    expect(screen.getByRole('main', { name: 'Studio' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Agent' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Projects and diagrams' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('paso.side-panel')).toBe('agent');
    // Back on the Canvas the chat is not there, and the spot is empty; the Studio brings it back.
    await user.click(within(bar).getByRole('button', { name: 'Diagram' }));
    await screen.findByRole('main', { name: 'Canvas' }, patience);
    expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();
    expect(studio).toHaveAttribute('aria-expanded', 'false');
    expect(app).toHaveClass('app--folded');

    // Remembered across a relaunch.
    unmount();
    window.location.hash = '#/one/storyboard/s1/s1t1';
    render(<App config={config} />);
    expect(await screen.findByRole('complementary', { name: 'Agent' }, patience)).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Projects and diagrams' })).not.toBeInTheDocument();
  });

  it('opens projects from a folded sidebar after relaunching in Studio', async () => {
    const user = userEvent.setup();
    await seed('Uno', 'one');
    await scenes('one', ['Primera']);
    window.location.hash = '#/one/canvas/s1/s1t1';
    const { unmount } = render(<App config={config} />);
    await screen.findByRole('main', { name: 'Canvas' }, patience);
    const toggle = screen.getByRole('button', { name: 'Hide sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'projects-panel');
    await user.click(toggle);
    expect(toggle).toHaveAccessibleName('Show sidebar');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    expect(toggle).toHaveFocus();
    expect(screen.getByRole('main', { name: 'Canvas' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Projects and diagrams' })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('complementary', { name: 'Projects and diagrams' })).toBeInTheDocument();

    await user.click(within(bar()).getByRole('button', { name: 'Studio' }));
    await screen.findByRole('complementary', { name: 'Agent' }, patience);
    expect(toggle).toHaveAttribute('aria-controls', 'agent-panel');
    await user.click(toggle);
    expect(screen.getByRole('main', { name: 'Studio' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();

    unmount();
    window.localStorage.setItem('paso.last-side-panel', 'agent');
    render(<App config={config} />);
    await screen.findByRole('main', { name: 'Studio' }, patience);
    await user.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(screen.getByRole('main', { name: 'Studio' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Projects and diagrams' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();
  });

  it('moves through the activity bar with the keyboard and keeps one tab stop', async () => {
    const user = userEvent.setup();
    await seed('Uno', 'one');
    await scenes('one', ['Primera']);
    window.location.hash = '#/one/canvas/s1/s1t1';
    render(<App config={config} />);
    await screen.findByRole('main', { name: 'Canvas' }, patience);
    const bar = screen.getByRole('toolbar', { name: 'Activity bar' });
    const buttons = within(bar).getAllByRole('button');
    const [diagram, studio, workspace, settings] = buttons;
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1]);
    diagram.focus();
    await user.keyboard('{ArrowDown}');
    expect(studio).toHaveFocus();
    await user.keyboard('{End}');
    expect(settings).toHaveFocus();
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, -1, -1, 0]);
    await user.keyboard('{ArrowDown}');
    expect(settings).toHaveFocus();   // it stops at the ends
    await user.keyboard('{ArrowUp}');
    expect(workspace).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(studio).toHaveFocus();
    await user.keyboard('{Home}');
    expect(diagram).toHaveFocus();
    // The gear opens its menu by keyboard, on its first item, and Escape gives the focus back.
    settings.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu', { name: 'Settings' });
    expect(settings).toHaveAttribute('aria-expanded', 'true');
    expect(within(menu).getByRole('menuitem', { name: 'Export image…' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Show grid' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Settings' })).not.toBeInTheDocument();
    expect(settings).toHaveFocus();
  });

  it('opens each diagram again on the step where it was left', async () => {
    const user = userEvent.setup();
    await seed('Uno', 'one');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seed('Dos', 'two');
    await scenes('one', ['Primera', 'Segunda']);
    window.location.hash = '#/one/canvas/s2/s2t2';
    render(<App config={config} />);
    await screen.findByRole('button', { name: 'Scene 2: Segunda' }, patience);
    await user.click(screen.getByRole('button', { name: /^Dos/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/two/canvas'), patience);
    await user.click(screen.getByRole('button', { name: /^Uno/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/one/canvas/s2/s2t2'), patience);
  });

  it('says so when the project in the address does not exist', async () => {
    await seed('Uno', 'one');
    window.location.hash = '#/gone/storyboard';
    render(<App config={config} />);
    expect(await screen.findByRole('heading', { name: 'This project no longer exists' }, patience)).toBeInTheDocument();
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
    expect(await screen.findByRole('heading', { name: 'Create your first project' }, patience)).toBeInTheDocument();
  });

  it('counts a scene and a step added by another client', async () => {
    await seed('Vivo', 'p');
    render(<App config={config} />);
    await screen.findByRole('button', { name: /^Vivo.*No scenes/ }, patience);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await fetch(`${service.url}/api/projects/p/scenes`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 's', name: 'Escena' }) });
    await fetch(`${service.url}/api/projects/p/scenes/s/steps`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 't' }) });
    await screen.findByRole('button', { name: /^Vivo.*1 scene · 1 step/ }, patience);
  });
});

describe('when the service is not there', () => {
  it('says so, offers to retry, and recovers on its own when the service returns', async () => {
    const user = userEvent.setup();
    await seed('Vuelve', 'p');
    const port = service.port;
    await service.close();
    render(<App config={{ baseUrl: `http://127.0.0.1:${port}`, token }} />);
    expect(await screen.findByRole('heading', { name: "Can't connect to the local service" }, patience)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
    await start(port);
    await user.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(await screen.findByRole('button', { name: /^Vuelve/ }, patience)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "Can't connect to the local service" })).not.toBeInTheDocument();
  });

  it('keeps the list when the service stops, reports a failed action, and recovers', async () => {
    const user = userEvent.setup();
    await seed('Sigue', 'p');
    render(<App config={config} />);
    await screen.findByRole('button', { name: /^Sigue/ }, patience);
    const port = service.port;
    await service.close();
    expect(await screen.findByText(/No connection to the service/, undefined, patience)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Sigue/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Change the icon of Sigue' }));
    await user.click(await screen.findByRole('button', { name: 'Leaf' }));
    const alert = await screen.findByRole('alert', undefined, patience);
    expect(alert).toHaveTextContent("Couldn't change the icon of “Sigue”. No connection to the local service.");
    await user.click(within(alert).getByRole('button', { name: 'Dismiss notice' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await start(port);
    await waitFor(() => expect(screen.queryByText(/No connection to the service/)).not.toBeInTheDocument(), { timeout: 10000 });
    expect(screen.getByRole('button', { name: /^Sigue/ })).toBeInTheDocument();
  }, 20000);
});
