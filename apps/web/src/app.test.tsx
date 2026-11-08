// @vitest-environment jsdom
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'paso-web-'));
  opened = []; openFails = false;
  window.history.replaceState(null, '', '/');
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  await start();
});
afterEach(async () => {
  cleanup();
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('projects panel against the real service', () => {
  it('creates, renames, changes the icon of and deletes a project, and the files follow', async () => {
    const user = userEvent.setup();
    render(<App config={config} />);

    // Nothing yet: the empty state offers the way in.
    expect(await screen.findByRole('heading', { name: 'Crea tu primer proyecto' }, patience)).toBeInTheDocument();

    // Create.
    await user.click(screen.getByRole('button', { name: 'Crear proyecto' }));
    await user.type(screen.getByLabelText('Nombre del proyecto nuevo'), 'Búsqueda binaria{Enter}');
    const row = await screen.findByRole('button', { name: /^Búsqueda binaria/ }, patience);
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveTextContent('Sin escenas');
    expect(screen.getByRole('heading', { level: 1, name: 'Búsqueda binaria' })).toBeInTheDocument();
    const [id] = await projectFolders();
    expect(window.location.hash).toBe(`#/${id}/storyboard`);
    expect(await readProject(id)).toMatchObject({ name: 'Búsqueda binaria', schemaVersion: 1, sceneIds: [] });
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
    const picker = await screen.findByRole('dialog', { name: 'Icono del proyecto' });
    await user.type(within(picker).getByRole('searchbox', { name: 'Buscar icono' }), 'musica');
    await user.click(within(picker).getByRole('button', { name: 'Música' }));
    await waitFor(async () => expect((await readProject(id)).icon).toBe('music'), patience);
    expect(screen.queryByRole('dialog', { name: 'Icono del proyecto' })).not.toBeInTheDocument();

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
    await user.click(await screen.findByRole('button', { name: 'Eliminar proyecto' }));
    expect(await screen.findByRole('heading', { name: 'Crea tu primer proyecto' }, patience)).toBeInTheDocument();
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
    expect(window.location.hash).toBe('#/second/storyboard');
    await user.click(screen.getByRole('button', { name: 'Más acciones de Segundo' }));
    await user.click(await screen.findByRole('menuitem', { name: /Eliminar/ }));
    await user.click(await screen.findByRole('button', { name: 'Eliminar proyecto' }));
    await screen.findByRole('heading', { level: 1, name: 'Primero' }, patience);
    expect(window.location.hash).toBe('#/first/storyboard');
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
    expect(screen.getByRole('main')).toHaveTextContent('2 escenas · 3 pasos');
  });

  it('focuses the first menuitem when opening RowMenu while the popover is visible', async () => {
    const user = userEvent.setup();
    await seed('Proyecto teclado', 'kb');
    render(<App config={config} />);
    await screen.findByRole('button', { name: /^Proyecto teclado/ }, patience);

    let visibilityAtFocus: string | undefined;
    const origFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...args) {
      if (this.getAttribute('role') === 'menuitem') {
        visibilityAtFocus = this.closest<HTMLElement>('.popover')?.style.visibility;
      }
      return origFocus.apply(this, args);
    };
    try {
      const moreBtn = screen.getByRole('button', { name: 'Más acciones de Proyecto teclado' });
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
    expect(await screen.findByText('No se pudo abrir la carpeta del proyecto.', {}, patience)).toBeInTheDocument();
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
    expect(window.location.hash).toBe('#/broken/storyboard');
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

describe('storyboard and lienzo', () => {
  it('returns to the same project and view from the address', async () => {
    await seed('Uno', 'one');
    await seed('Dos', 'two');
    window.location.hash = '#/one/lienzo';
    render(<App config={config} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Uno' }, patience)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Lienzo' })).toBeChecked();
    expect(screen.getByRole('main', { name: 'Lienzo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Uno/ })).toHaveAttribute('aria-current', 'true');
  });

  it('moves with the arrow keys, and the address follows', async () => {
    const user = userEvent.setup();
    await seed('Uno', 'one');
    render(<App config={config} />);
    await screen.findByRole('heading', { level: 1, name: 'Uno' }, patience);
    const group = screen.getByRole('radiogroup', { name: 'Vista' });
    const storyboard = within(group).getByRole('radio', { name: 'Storyboard' });
    const lienzo = within(group).getByRole('radio', { name: 'Lienzo' });
    expect(storyboard).toBeChecked();
    // One tab stop: the selected option.
    expect(storyboard).toHaveAttribute('tabindex', '0');
    expect(lienzo).toHaveAttribute('tabindex', '-1');
    storyboard.focus();
    await user.keyboard('{ArrowRight}');
    expect(lienzo).toBeChecked();
    expect(lienzo).toHaveFocus();
    expect(window.location.hash).toBe('#/one/lienzo');
    expect(screen.getByRole('main', { name: 'Lienzo' })).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(storyboard).toBeChecked();
    await user.keyboard('{ArrowLeft}');
    expect(lienzo).toBeChecked();
    await user.keyboard('{Home}');
    expect(storyboard).toBeChecked();
    await user.keyboard('{End}');
    expect(lienzo).toBeChecked();
    expect(screen.getByRole('main', { name: 'Lienzo' })).toHaveTextContent('Uno');
    // Clicking works too, and keeps the project.
    await user.click(storyboard);
    expect(window.location.hash).toBe('#/one/storyboard');
  });

  it('says so when the project in the address does not exist', async () => {
    await seed('Uno', 'one');
    window.location.hash = '#/gone/storyboard';
    render(<App config={config} />);
    expect(await screen.findByRole('heading', { name: 'Este proyecto ya no existe' }, patience)).toBeInTheDocument();
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
    expect(await screen.findByRole('heading', { name: 'Crea tu primer proyecto' }, patience)).toBeInTheDocument();
  });

  it('counts a scene and a step added by another client', async () => {
    await seed('Vivo', 'p');
    render(<App config={config} />);
    await screen.findByRole('button', { name: /^Vivo.*Sin escenas/ }, patience);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await fetch(`${service.url}/api/projects/p/scenes`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 's', name: 'Escena' }) });
    await fetch(`${service.url}/api/projects/p/scenes/s/steps`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 't' }) });
    await screen.findByRole('button', { name: /^Vivo.*1 escena · 1 paso/ }, patience);
    expect(screen.getByRole('main')).toHaveTextContent('1 escena · 1 paso');
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
