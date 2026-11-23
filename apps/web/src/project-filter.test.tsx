// @vitest-environment jsdom
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '@paso/server';
import { App } from './App';
import type { Draft, Recovery } from './editor/step-store';
import type { ClientConfig } from './lib/api';

// jsdom has no canvas: Excalidraw is a stand-in, as in the other suites.
vi.mock('./editor/StepCanvas', () => import('./editor/canvas-stand-in'));
vi.mock('./editor/use-thumbnails', () => ({ useThumbnails: () => ({ svgs: {}, titles: {} }) }));
vi.setConfig({ testTimeout: 30_000 });
const memory = (): Recovery => { const drafts = new Map<string, Draft>(); return { read: async (key) => drafts.get(key), write: async (key, draft) => { drafts.set(key, structuredClone(draft)); }, remove: async (key) => { drafts.delete(key); } }; };

/** The sidebar's project filter, against a real local service on a temporary data folder. */
type Service = Awaited<ReturnType<typeof startServer>>;
const token = 'filter-web-test-session-token-with-32-chars';
let service: Service;
let testRoot: string;
let dataDir: string;
let config: ClientConfig;
const patience = { timeout: 5000 };

async function start() {
  service = await startServer({ dataDir, port: 0, sessionToken: token, allowedOrigins: [window.location.origin], pollIntervalMs: 100,
    harnessDetection: { searchPaths: [], loginShell: false } });
  config = { baseUrl: service.url, token };
}
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
const seedLoose = async (id: string, name: string) => {
  await call('/api/projects/_loose/scenes', 'POST', { id, name });
  await call(`/api/projects/_loose/scenes/${id}/steps`, 'POST', { id: `${id}-step-0` });
};
/** What the service keeps for the default workspace. */
const storedFilter = async () => ((await call('/api/workspaces')) as { workspaces: Array<{ id: string; filter: string | null }> })
  .workspaces.find((workspace) => workspace.id === 'default')?.filter;
const sidebar = () => screen.getByRole('complementary', { name: 'Projects and diagrams' });
const trigger = () => within(sidebar()).getByRole('button', { name: /^Filter by project: / });
/** The names of the projects and diagrams the sidebar lists. */
const listed = () => [...sidebar().querySelectorAll('.project__name')].map((name) => name.textContent);

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'paso-web-filter-'));
  dataDir = join(testRoot, 'projects');
  await mkdir(dataDir);
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  await start();
  await seedProject('algebra', 'Álgebra');
  await seedProject('biologia', 'Biología');
  await seedLoose('bosquejo', 'Bosquejo');
});
afterEach(async () => {
  cleanup();
  await service.close();
  await rm(testRoot, { recursive: true, force: true });
});

describe('the project filter', () => {
  it('chooses with the keyboard, searches, narrows the list and the sidebar search, and is remembered on reopening', async () => {
    const user = userEvent.setup();
    render(<App config={config} recovery={memory()} />);
    await within(sidebar()).findByRole('button', { name: /^Bosquejo/ }, patience);
    expect(trigger()).toHaveAccessibleName('Filter by project: All projects');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(listed()).toEqual(['Álgebra', 'Biología', 'Bosquejo']);

    // Open from the keyboard: the search field takes the focus, and the chosen choice is highlighted.
    trigger().focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('dialog', { name: 'Filter by project' });
    const field = within(menu).getByRole('combobox', { name: 'Search projects' });
    expect(field).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    const options = () => within(menu).getAllByRole('option').map((option) => option.textContent);
    expect(options()).toEqual(['All projects', 'Álgebra', 'Biología', 'Loose diagrams']);
    expect(within(menu).getByRole('option', { name: 'All projects' })).toHaveAttribute('aria-selected', 'true');
    expect(field).toHaveAttribute('aria-activedescendant', within(menu).getByRole('option', { name: 'All projects' }).id);

    // Arrow keys move the highlight, wrapping, while the focus stays in the field.
    await user.keyboard('{ArrowUp}');
    expect(field).toHaveAttribute('aria-activedescendant', within(menu).getByRole('option', { name: 'Loose diagrams' }).id);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(field).toHaveAttribute('aria-activedescendant', within(menu).getByRole('option', { name: 'Álgebra' }).id);
    expect(field).toHaveFocus();

    // Searching ignores accents and leaves out “All projects”; Enter chooses the first match.
    await user.type(field, 'alge');
    expect(options()).toEqual(['Álgebra']);
    await user.type(field, 'x');
    expect(within(menu).getByRole('status')).toHaveTextContent('No matching projects.');
    await user.keyboard('{Backspace}{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Filter by project' })).not.toBeInTheDocument();
    expect(trigger()).toHaveAccessibleName('Filter by project: Álgebra');
    expect(trigger()).toHaveFocus();
    expect(listed()).toEqual(['Álgebra']);
    expect(within(sidebar()).queryByRole('list', { name: 'Loose diagrams' })).not.toBeInTheDocument();
    await waitFor(async () => expect(await storedFilter()).toBe('algebra'), patience);

    // The sidebar's search works inside the filter.
    await user.click(within(sidebar()).getByRole('button', { name: 'Search' }));
    await user.type(within(sidebar()).getByRole('searchbox', { name: 'Search projects and diagrams' }), 'bio');
    expect(within(sidebar()).getByText('No matches.')).toBeInTheDocument();
    await user.clear(within(sidebar()).getByRole('searchbox', { name: 'Search projects and diagrams' }));
    await user.type(within(sidebar()).getByRole('searchbox', { name: 'Search projects and diagrams' }), 'alg');
    expect(listed()).toEqual(['Álgebra']);
    await user.keyboard('{Escape}');

    // The loose diagrams on their own, chosen with the mouse.
    await user.click(trigger());
    await user.click(within(await screen.findByRole('dialog', { name: 'Filter by project' })).getByRole('option', { name: 'Loose diagrams' }));
    expect(trigger()).toHaveAccessibleName('Filter by project: Loose diagrams');
    expect(listed()).toEqual(['Bosquejo']);
    await waitFor(async () => expect(await storedFilter()).toBe('_loose'), patience);

    // Escape closes without choosing, and gives the focus back.
    await user.click(trigger());
    await screen.findByRole('dialog', { name: 'Filter by project' });
    await user.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Filter by project' })).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAccessibleName('Filter by project: Loose diagrams');

    // Reopened, with the service restarted: the filter is still there, and the app opens on what it shows.
    cleanup();
    await service.close();
    await start();
    window.history.replaceState(null, '', '/');
    render(<App config={config} recovery={memory()} />);
    await within(sidebar()).findByRole('button', { name: /^Bosquejo/ }, patience);
    expect(trigger()).toHaveAccessibleName('Filter by project: Loose diagrams');
    expect(listed()).toEqual(['Bosquejo']);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/_loose\/canvas\/bosquejo\//), patience);
  });

  it('shows all projects again when its project is gone, or when something it hides opens', async () => {
    const user = userEvent.setup();
    await call('/api/workspaces/default/filter', 'PUT', { filter: 'biologia' });
    render(<App config={config} recovery={memory()} />);
    await waitFor(() => expect(trigger()).toHaveAccessibleName('Filter by project: Biología'), patience);
    expect(listed()).toEqual(['Biología']);
    // The app opens on the filter's project.
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/biologia\/canvas/), patience);

    // A new project opens, so the list shows everything again.
    await user.click(within(sidebar()).getByRole('button', { name: 'New project' }));
    await user.type(screen.getByLabelText('Name of the new project'), 'Química{Enter}');
    await within(sidebar()).findByRole('button', { name: /^Química/ }, patience);
    expect(trigger()).toHaveAccessibleName('Filter by project: All projects');
    await waitFor(async () => expect(await storedFilter()).toBeNull(), patience);

    // A filter's project removed from outside the app: “All projects”, and the service forgets it.
    await call('/api/workspaces/default/filter', 'PUT', { filter: 'algebra' });
    await waitFor(() => expect(trigger()).toHaveAccessibleName('Filter by project: Álgebra'), patience);
    await rm(join(dataDir, 'algebra'), { recursive: true });
    await waitFor(() => expect(trigger()).toHaveAccessibleName('Filter by project: All projects'), patience);
    await waitFor(async () => expect(await storedFilter()).toBeNull(), patience);
    expect(listed()).not.toContain('Álgebra');
    // The list answers from memory while the file is written.
    await waitFor(async () => expect(JSON.parse(await readFile(join(testRoot, 'workspaces.json'), 'utf8'))).not.toHaveProperty('filters'), patience);
  });
});
