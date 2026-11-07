// @vitest-environment jsdom
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer, type AgentEvent, type AgentRunRequest, type HarnessAdapter } from '@paso/server';
import { App } from './App';
import type { ClientConfig } from './lib/api';

/**
 * The agent panel against a real service on a temporary data folder. Only the harness is fake: an adapter
 * that emits the normalized events and writes to the board through the same API the board tools use.
 */
const drawn = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('./editor/excalidraw-runtime', () => ({
  canvasElements: (step: { elements: unknown[] }) => step.elements,
  canvasFiles: (files: unknown) => files,
  loadDrawingFonts: async () => {},
  excalidraw: async () => ({
    restoreElements: (elements: unknown[]) => elements,
    getCommonBounds: () => [0, 0, 100, 100],
    convertToExcalidrawElements: (elements: unknown[]) => elements,
    exportToSvg: async ({ elements, appState }: { elements: Array<{ id: string }>; appState: { exportWithDarkMode: boolean } }) => {
      const ids = elements.map((element) => element.id).join('+');
      drawn.calls.push(ids);
      return { outerHTML: `<svg data-ids="${ids}" data-dark="${appState.exportWithDarkMode}"/>` };
    },
  }),
}));
vi.mock('./editor/StepCanvas', () => ({ default: () => null }));

type Service = Awaited<ReturnType<typeof startServer>>;
type StepEnvelope = { document: { id: string; title?: string; elements: unknown[] }; revision: string };
const token = 'agent-panel-test-token-with-at-least-32-chars';
const patience = { timeout: 4000 };
let rootDir: string;
let binDir: string;
let harnessRegistryPath: string;
let service: Service;
let config: ClientConfig;
let narrowWindow = false;
let requests: AgentRunRequest[];
let adapterImpl: (request: AgentRunRequest, signal: AbortSignal) => AsyncIterable<AgentEvent>;

async function call<T = unknown>(method: string, path: string, body?: unknown, revision?: string): Promise<T> {
  const response = await fetch(`${service.url}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      // What the board tools send. The panel itself never relies on it.
      'X-Paso-Actor': 'mcp',
      ...(revision ? { 'If-Match': `"${revision}"` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${method} ${path} -> ${response.status}`).toBe(true);
  return (response.status === 204 ? undefined : await response.json()) as T;
}
/** A person's edit: the same request without the board tools' header. */
async function personEdits(path: string, change: (document: StepEnvelope['document']) => StepEnvelope['document']) {
  const current = await call<StepEnvelope>('GET', path);
  const response = await fetch(`${service.url}/api${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'If-Match': `"${current.revision}"` },
    body: JSON.stringify(change(current.document)),
  });
  expect(response.status).toBe(200);
}
async function agentEdits(path: string, change: (document: StepEnvelope['document']) => StepEnvelope['document']) {
  const current = await call<StepEnvelope>('GET', path);
  await call('PUT', path, change(current.document), current.revision);
}
const rect = (id: string, x = 0) => ({ id, type: 'rectangle', x, y: 0, width: 40, height: 30, version: 1, versionNonce: 1, isDeleted: false });

async function installHarness(id: string, version: string, loggedIn = true) {
  const script = join(binDir, id);
  await writeFile(script, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":${loggedIn}}'; exit 0; fi
if [ "$1" = "login" ]; then echo "Logged in"; exit 0; fi
exit 0
`, 'utf8');
  await chmod(script, 0o755);
}

async function seedProject() {
  await call('POST', '/projects', { id: 'p', name: 'Búsqueda binaria' });
  await call('POST', '/projects/p/scenes', { id: 's1', name: 'El problema' });
  await call('POST', '/projects/p/scenes/s1/steps', { id: 'step1', title: 'Inicio', elements: [rect('r1', 10)] });
  await call('POST', '/projects/p/scenes', { id: 's2', name: 'Partir en dos' });
  await call('POST', '/projects/p/scenes/s2/steps', { id: 'step2', title: 'Mitad', elements: [rect('r2', 20)] });
}

/** An agent turn that adds a rectangle to step 1 and renames it. */
function editsStepOne(text = 'Paso 1 actualizado.') {
  return async function* (): AsyncIterable<AgentEvent> {
    yield { type: 'session', resumeToken: 'tok' };
    yield { type: 'tool_use', id: `edit-${Math.random()}`, tool: 'add_elements', readOnly: false, target: { projectId: 'p', sceneId: 's1', stepId: 'step1' } };
    await agentEdits('/projects/p/scenes/s1/steps/step1', (document) => ({ ...document, title: 'Editado por agente', elements: [...document.elements, rect(`agent-${Math.random()}`, 60)] }));
    yield { type: 'text', text };
    yield { type: 'finished', reason: 'completed' };
  };
}

async function openPanel() {
  render(<App config={config} />);
  return screen.findByRole('complementary', { name: 'Agente' }, patience);
}
async function send(panel: HTMLElement, user: ReturnType<typeof userEvent.setup>, text: string) {
  const input = within(panel).getByRole('textbox', { name: 'Mensaje para el agente' });
  await user.type(input, text);
  await waitFor(() => expect(within(panel).getByRole('button', { name: 'Enviar' })).toBeEnabled(), patience);
  await user.keyboard('{Enter}');
}

beforeEach(async () => {
  drawn.calls.length = 0;
  narrowWindow = false;
  requests = [];
  rootDir = await mkdtemp(join(tmpdir(), 'paso-agent-web-'));
  binDir = join(rootDir, 'bin');
  harnessRegistryPath = join(rootDir, 'state', 'harnesses.json');
  await mkdir(join(rootDir, 'projects'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await installHarness('claude', '2.1.40 (Claude Code)');

  window.history.replaceState(null, '', '#/p/storyboard');
  window.matchMedia = ((query: string) => ({
    matches: narrowWindow && query.includes('1099px'), media: query, addEventListener() {}, removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  adapterImpl = editsStepOne();
  const adapter: HarnessAdapter = { id: 'claude', run: (request, signal) => { requests.push(request); return adapterImpl(request, signal); } };
  service = await startServer({
    dataDir: join(rootDir, 'projects'), port: 0, sessionToken: token, allowedOrigins: [window.location.origin], pollIntervalMs: 80,
    harnessRegistryPath, runsDir: join(rootDir, 'runs'),
    harnessDetection: { searchPaths: [binDir], loginShell: false },
    agent: { workDir: join(rootDir, 'work'), sessionsPath: join(rootDir, 'state', 'sessions.json'), adapters: { claude: adapter } },
  });
  config = { baseUrl: service.url, token };
  await seedProject();
});

afterEach(async () => {
  cleanup();
  await service.close();
  await rm(rootDir, { recursive: true, force: true });
});

describe('agent and model picker', () => {
  it('asks once to add Claude Code, shows the other harnesses as detected but unavailable, and passes the chosen model', async () => {
    await installHarness('codex', 'codex-cli 0.80.0');
    const user = userEvent.setup();
    const panel = await openPanel();

    // Not added yet: the panel says what adding means, and nothing can be sent.
    const add = await within(panel).findByRole('button', { name: 'Añadir Claude Code' }, patience);
    expect(within(panel).getByText(/con tu propia sesión y tu cuota/)).toBeInTheDocument();
    await user.type(within(panel).getByRole('textbox', { name: 'Mensaje para el agente' }), 'Hola');
    expect(within(panel).getByRole('button', { name: 'Enviar' })).toBeDisabled();
    await user.click(add);
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Enviar' })).toBeEnabled(), patience);
    expect(within(panel).queryByText(/con tu propia sesión y tu cuota/)).not.toBeInTheDocument();
    expect(JSON.parse(await readFile(harnessRegistryPath, 'utf8'))).toEqual(['claude']);

    // The picker is a menu on the body. Codex is found but cannot run a session yet; agy is not installed.
    await user.click(within(panel).getByRole('button', { name: 'Agente: Claude Code' }));
    const menu = await screen.findByRole('menu', { name: 'Elegir agente' });
    expect(panel.contains(menu)).toBe(false);
    const claude = within(menu).getByRole('menuitemradio', { name: /Claude Code/ });
    expect(claude).toHaveFocus();
    expect(claude).toHaveTextContent('2.1.40 · Con tu sesión');
    const codex = within(menu).getByRole('menuitemradio', { name: /Codex/ });
    expect(codex).toHaveAttribute('aria-disabled', 'true');
    expect(codex).toHaveTextContent('0.80.0 · Todavía no disponible en Paso');
    expect(within(menu).getByRole('menuitemradio', { name: /Antigravity/ })).toHaveTextContent('No instalado');
    await user.keyboard('{ArrowDown}');
    expect(codex).toHaveFocus();
    await user.click(codex);
    expect(within(panel).getByRole('button', { name: 'Agente: Claude Code' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // Models: the account's own, without Fable.
    await user.click(within(panel).getByRole('button', { name: 'Modelo: Predeterminado' }));
    const models = await screen.findByRole('menu', { name: 'Elegir modelo' });
    expect(within(models).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['Predeterminado', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(models).not.toHaveTextContent(/Fable/i);
    await user.click(within(models).getByRole('menuitemradio', { name: 'Haiku 5.5' }));

    await user.clear(within(panel).getByRole('textbox', { name: 'Mensaje para el agente' }));
    await send(panel, user, 'Hola');
    expect(await within(panel).findByText('Paso 1 actualizado.', {}, patience)).toBeInTheDocument();
    expect(requests[0].model).toBe('claude-haiku-5-5');
  });

  it('says so when Claude Code is signed out', async () => {
    await installHarness('claude', '2.1.40 (Claude Code)', false);
    await call('POST', '/harnesses', { id: 'claude' });
    const panel = await openPanel();
    expect(await within(panel).findByText(/no tiene la sesión iniciada/, {}, patience)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Comprobar de nuevo' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });
});

describe('a turn as it happens', () => {
  it('streams the answer, shows the tools and the steps they touched, and marks those steps live', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    adapterImpl = async function* () {
      yield { type: 'session', resumeToken: 'tok-stream' };
      yield { type: 'tool_use', id: 'read', tool: 'read_scene', readOnly: true, target: { projectId: 'p', sceneId: 's2' } };
      yield { type: 'tool_result', id: 'read', ok: true };
      yield { type: 'text_delta', text: 'Cambio el paso 1 ' };
      yield { type: 'tool_use', id: 'edit', tool: 'add_elements', readOnly: false, target: { projectId: 'p', sceneId: 's2', stepId: 'step2' } };
      await gate;
      await agentEdits('/projects/p/scenes/s2/steps/step2', (document) => ({ ...document, elements: [...document.elements, rect('r2-agent', 80)] }));
      yield { type: 'tool_result', id: 'edit', ok: true };
      // create_step names no step: the new one is the step the service reports.
      yield { type: 'tool_use', id: 'create', tool: 'create_step', readOnly: false, target: { projectId: 'p', sceneId: 's2' } };
      await call('POST', '/projects/p/scenes/s2/steps', { id: 'step3', title: 'Creado por agente', elements: [rect('r3-agent', 120)] });
      yield { type: 'tool_result', id: 'create', ok: true };
      yield { type: 'text', text: 'Hecho: revisa los pasos 1 y 2.' };
      yield { type: 'finished', reason: 'completed' };
    };
    const user = userEvent.setup();
    const panel = await openPanel();
    const scene2 = await screen.findByRole('region', { name: 'Escena 2: Partir en dos' }, patience);

    // The target: what the agent receives is said before anything is sent.
    expect(within(panel).getByText(/El agente recibe «Búsqueda binaria», todas sus escenas/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: /El agente recibe: Todo el proyecto/ }));
    const targets = await screen.findByRole('menu', { name: 'Qué recibe el agente' });
    await user.click(await within(targets).findByRole('menuitemradio', { name: /Partir en dos/ }, patience));
    expect(within(panel).getByText(/El agente recibe «Búsqueda binaria», escena 2: «Partir en dos»/)).toBeInTheDocument();

    await send(panel, user, 'Amplía la escena 2');
    expect(await within(panel).findByText('Amplía la escena 2')).toBeInTheDocument();
    // Streaming: the partial text and the running tool, with its step chip.
    expect(await within(panel).findByText('Cambio el paso 1', { exact: false }, patience)).toBeInTheDocument();
    expect(await within(panel).findByText('Cambiando el paso', {}, patience)).toBeInTheDocument();
    expect(within(panel).getByText('Leyó la escena 2')).toBeInTheDocument();
    expect(within(panel).getByText('1 paso')).toBeInTheDocument();
    expect(within(panel).getByText(/Trabajando ·/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Detener' })).toBeInTheDocument();
    expect(requests[0].context).toEqual({ projectId: 'p', sceneId: 's2' });

    // The step being changed: an agent edge and "cambiando…".
    await waitFor(() => {
      const frame = within(scene2).getByRole('button', { name: /Paso 1/ });
      expect(frame).toHaveClass('frame--agent-working');
      expect(within(frame).getByText('cambiando…')).toBeInTheDocument();
    }, patience);

    release();
    expect(await within(panel).findByText('Hecho: revisa los pasos 1 y 2.', {}, patience)).toBeInTheDocument();
    expect(within(panel).getByText('Cambió el paso')).toBeInTheDocument();
    expect(within(panel).getByText('Creó el paso')).toBeInTheDocument();
    // Both steps carry the agent chip, and their thumbnails were drawn again from the new content.
    await waitFor(() => {
      const one = within(scene2).getByRole('button', { name: 'Paso 1: Mitad' });
      const two = within(scene2).getByRole('button', { name: 'Paso 2: Creado por agente' });
      expect(one).not.toHaveClass('frame--agent-working');
      expect(within(one).getByText('agente')).toBeInTheDocument();
      expect(within(two).getByText('agente')).toBeInTheDocument();
      expect(drawn.calls).toContain('+r2+r2-agent');
      expect(drawn.calls).toContain('+r3-agent');
    }, patience);
    await waitFor(() => expect(within(panel).getByText(/· 2 cambios/)).toBeInTheDocument(), patience);

    // A step chip jumps to that step.
    await user.click(await within(panel).findByRole('button', { name: 'Ir al paso 2 de la escena 2' }, patience));
    expect(await screen.findByRole('main', { name: 'Lienzo' }, patience)).toBeInTheDocument();
    expect(window.location.hash).toBe('#/p/lienzo/s2/step3');
  });

  it('shows a failed turn with its Spanish message and still closes its restore point', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    adapterImpl = async function* () {
      yield { type: 'tool_use', id: 'edit', tool: 'add_elements', readOnly: false, target: { projectId: 'p', sceneId: 's1', stepId: 'step1' } };
      await agentEdits('/projects/p/scenes/s1/steps/step1', (document) => ({ ...document, elements: [...document.elements, rect('half', 5)] }));
      yield { type: 'failed', code: 'quota', message: 'Has llegado al límite de uso de tu cuenta.' };
    };
    const user = userEvent.setup();
    const panel = await openPanel();
    await send(panel, user, 'Algo largo');
    expect(await within(panel).findByText('Has llegado al límite de uso de tu cuenta.', {}, patience)).toBeInTheDocument();
    // A failed run's changes can still be undone.
    expect(await within(panel).findByRole('button', { name: 'Deshacer ejecución' }, patience)).toBeInTheDocument();
    expect(within(panel).getByText(/Falló · .* · 1 cambio/)).toBeInTheDocument();
    const { runs } = await call<{ runs: Array<{ status: string }> }>('GET', '/projects/p/runs');
    expect(runs.map((run) => run.status)).toEqual(['finished']);
  });

  it('stops a run from the Lienzo, where the top bar says who is changing which step', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    adapterImpl = async function* (_request, signal) {
      yield { type: 'tool_use', id: 'slow', tool: 'update_elements', readOnly: false, target: { projectId: 'p', sceneId: 's1', stepId: 'step1' } };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'finished', reason: 'cancelled' };
    };
    const user = userEvent.setup();
    const panel = await openPanel();
    await send(panel, user, 'Cambio lento');
    expect(await within(panel).findByText('Cambiando el paso', {}, patience)).toBeInTheDocument();
    // With the panel in view, the top bar says nothing.
    expect(screen.queryByRole('status', { name: 'Agente trabajando' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Lienzo' }));
    const status = await screen.findByRole('status', { name: 'Agente trabajando' }, patience);
    expect(status).toHaveTextContent('Claude Code está cambiando el paso');
    expect(within(status).getByRole('button', { name: 'Ir al paso 1 de la escena 1' })).toHaveTextContent('1');
    await user.click(within(status).getByRole('button', { name: 'Detener' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Agente trabajando' })).not.toBeInTheDocument(), patience);

    await user.click(screen.getByRole('radio', { name: 'Storyboard' }));
    const after = await screen.findByRole('complementary', { name: 'Agente' }, patience);
    expect(await within(after).findByText(/^Detenida · /, {}, patience)).toBeInTheDocument();
    expect(within(after).getByRole('button', { name: 'Enviar' })).toBeInTheDocument();
    // The cancelled turn's restore point is closed, not left running.
    await waitFor(async () => {
      const { runs } = await call<{ runs: Array<{ status: string }> }>('GET', '/projects/p/runs');
      expect(runs.map((run) => run.status)).toEqual(['finished']);
    }, patience);
  });
});

describe('undoing a run', () => {
  it('previews, then undoes on confirmation', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup();
    const panel = await openPanel();
    const scene1 = await screen.findByRole('region', { name: 'Escena 1: El problema' }, patience);
    await send(panel, user, 'Actualiza el paso 1');
    await user.click(await within(panel).findByRole('button', { name: 'Deshacer ejecución' }, patience));

    const dialog = await screen.findByRole('alertdialog', { name: '¿Deshacer esta ejecución?' }, patience);
    expect(dialog).toHaveTextContent('Un paso vuelve a como estaba antes.');
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    // Nothing changes until it is confirmed.
    expect(await within(scene1).findByRole('button', { name: 'Paso 1: Editado por agente' }, patience)).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Deshacer ejecución' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(within(panel).getByText(/· Deshecha/)).toBeInTheDocument();
      expect(within(scene1).getByRole('button', { name: 'Paso 1: Inicio' })).toBeInTheDocument();
    }, patience);
    expect(within(panel).queryByRole('button', { name: 'Deshacer ejecución' })).not.toBeInTheDocument();
  });

  it('shows the warnings plainly and needs an explicit confirmation when a person edited a step afterwards', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup();
    const panel = await openPanel();
    const scene1 = await screen.findByRole('region', { name: 'Escena 1: El problema' }, patience);
    await send(panel, user, 'Actualiza el paso 1');
    const undo = await within(panel).findByRole('button', { name: 'Deshacer ejecución' }, patience);
    await personEdits('/projects/p/scenes/s1/steps/step1', (document) => ({ ...document, title: 'Editado por persona' }));
    await within(scene1).findByRole('button', { name: 'Paso 1: Editado por persona' }, patience);

    await user.click(undo);
    const dialog = await screen.findByRole('alertdialog', { name: '¿Deshacer esta ejecución?' }, patience);
    expect(within(dialog).getByRole('list', { name: 'Avisos' })).toHaveTextContent('El paso 1 de «El problema» se editó después de la ejecución. Al deshacer se pierden esas ediciones.');
    const confirm = within(dialog).getByRole('button', { name: 'Deshacer y perder las ediciones' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /Entiendo que se perderán ediciones/ }));
    expect(confirm).toBeEnabled();

    // Another change after the preview: the plan is read again and asked again.
    await personEdits('/projects/p/scenes/s1/steps/step1', (document) => ({ ...document, speakerNotes: 'otra' }));
    await user.click(confirm);
    expect(await within(dialog).findByText(/El proyecto cambió mientras mirabas el resumen/, {}, patience)).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox')).not.toBeChecked();
    expect(within(scene1).getByRole('button', { name: 'Paso 1: Editado por persona' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Deshacer y perder las ediciones' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(within(scene1).getByRole('button', { name: 'Paso 1: Inicio' })).toBeInTheDocument();
    }, patience);
  });

  it('is not blocked by a later run that changed nothing, such as a question', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup();
    const panel = await openPanel();
    const scene1 = await screen.findByRole('region', { name: 'Escena 1: El problema' }, patience);
    await send(panel, user, 'Actualiza el paso 1');
    await within(panel).findByRole('button', { name: 'Deshacer ejecución' }, patience);

    adapterImpl = async function* () {
      yield { type: 'tool_use', id: 'look', tool: 'read_scene', readOnly: true, target: { projectId: 'p', sceneId: 's1' } };
      yield { type: 'tool_result', id: 'look', ok: true };
      yield { type: 'text', text: 'La escena 1 tiene un paso.' };
      yield { type: 'finished', reason: 'completed' };
    };
    await send(panel, user, '¿Qué hay en la escena 1?');
    await within(panel).findByText('La escena 1 tiene un paso.', {}, patience);
    await waitFor(() => expect(within(panel).getByText(/· Sin cambios/)).toBeInTheDocument(), patience);
    // The button stays on the run with changes.
    const buttons = within(panel).getAllByRole('button', { name: 'Deshacer ejecución' });
    expect(buttons).toHaveLength(1);

    await user.click(buttons[0]);
    const dialog = await screen.findByRole('alertdialog', { name: '¿Deshacer esta ejecución?' }, patience);
    await user.click(within(dialog).getByRole('button', { name: 'Deshacer ejecución' }));
    await waitFor(() => expect(within(scene1).getByRole('button', { name: 'Paso 1: Inicio' })).toBeInTheDocument(), patience);
  });
});

describe('after a reload', () => {
  it('replays the conversation from the service and can still undo its run', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    adapterImpl = async function* () {
      yield { type: 'tool_use', id: 'create', tool: 'create_step', readOnly: false, target: { projectId: 'p', sceneId: 's1' } };
      await call('POST', '/projects/p/scenes/s1/steps', { id: 'made', elements: [] });
      yield { type: 'tool_result', id: 'create', ok: true };
      // Then it draws in the step it created, so that step is named by a later row too.
      yield { type: 'tool_use', id: 'draw', tool: 'add_elements', readOnly: false, target: { projectId: 'p', sceneId: 's1', stepId: 'made' } };
      await agentEdits('/projects/p/scenes/s1/steps/made', (document) => ({ ...document, elements: [rect('drawn', 30)] }));
      yield { type: 'tool_result', id: 'draw', ok: true };
      yield* editsStepOne()();
    };
    const user = userEvent.setup();
    let panel = await openPanel();
    await send(panel, user, 'Actualiza el paso 1');
    await within(panel).findByRole('button', { name: 'Deshacer ejecución' }, patience);

    cleanup();
    panel = await openPanel();
    expect(await within(panel).findByText('Paso 1 actualizado.', {}, patience)).toBeInTheDocument();
    expect(within(panel).getAllByText('Cambió el paso')).toHaveLength(2);
    expect(await within(panel).findByRole('button', { name: 'Ir al paso 1 de la escena 1' }, patience)).toBeInTheDocument();
    // The step it created is found again from the restore point, since creation events are not replayed.
    await waitFor(() => expect(within(panel).getAllByRole('button', { name: 'Ir al paso 2 de la escena 1' })).toHaveLength(2), patience);
    // The prompt is not stored by the service, so it is not shown again.
    expect(within(panel).queryByText('Actualiza el paso 1')).not.toBeInTheDocument();
    expect(await within(panel).findByRole('button', { name: 'Deshacer ejecución' }, patience)).toBeInTheDocument();

    // A new conversation still reaches the last run's undo.
    await user.click(within(panel).getByRole('button', { name: 'Nueva conversación' }));
    expect(within(panel).queryByText('Paso 1 actualizado.')).not.toBeInTheDocument();
    expect(within(panel).getByText(/Última ejecución · .* · 2 cambios/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Deshacer ejecución' })).toBeInTheDocument();
  });
});

describe('continuing a conversation', () => {
  it('keeps the conversation’s session and model after a reload, and starts a new one only when the model changes', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup();
    let panel = await openPanel();
    await user.click(within(panel).getByRole('button', { name: 'Modelo: Predeterminado' }));
    await user.click(within(await screen.findByRole('menu', { name: 'Elegir modelo' })).getByRole('menuitemradio', { name: 'Haiku 5.5' }));
    await send(panel, user, 'Primero');
    await within(panel).findByText(/· 1 cambio/, {}, patience);

    cleanup();
    panel = await openPanel();
    await within(panel).findByText('Paso 1 actualizado.', {}, patience);
    expect(within(panel).getByRole('button', { name: 'Modelo: Haiku 5.5' })).toBeInTheDocument();
    await send(panel, user, 'Segundo');
    await waitFor(() => expect(requests).toHaveLength(2), patience);
    expect(requests[1]).toMatchObject({ model: 'claude-haiku-5-5', resumeToken: 'tok' });
    await waitFor(() => expect(within(panel).queryByText(/Trabajando ·/)).not.toBeInTheDocument(), patience);

    await user.click(within(panel).getByRole('button', { name: 'Modelo: Haiku 5.5' }));
    await user.click(within(await screen.findByRole('menu', { name: 'Elegir modelo' })).getByRole('menuitemradio', { name: 'Predeterminado' }));
    expect(within(panel).queryByText('Paso 1 actualizado.')).not.toBeInTheDocument();
    await send(panel, user, 'Tercero');
    await waitFor(() => expect(requests).toHaveLength(3), patience);
    expect(requests[2].model).toBeUndefined();
    expect(requests[2].resumeToken).toBeUndefined();
  });
});

describe('narrow windows', () => {
  it('opens the panel as a drawer from the top bar, and shows the agent status there while it is closed', async () => {
    narrowWindow = true;
    await call('POST', '/harnesses', { id: 'claude' });
    adapterImpl = async function* (_request, signal) {
      yield { type: 'tool_use', id: 'slow', tool: 'update_elements', readOnly: false, target: { projectId: 'p', sceneId: 's1', stepId: 'step1' } };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'finished', reason: 'cancelled' };
    };
    const user = userEvent.setup();
    render(<App config={config} />);
    const toggle = await screen.findByRole('button', { name: 'Agente' }, patience);
    const panel = screen.getByRole('complementary', { name: 'Agente', hidden: true });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel).not.toHaveAttribute('data-open');

    await user.click(toggle);
    expect(panel).toHaveAttribute('data-open', 'true');
    expect(within(panel).getByRole('textbox', { name: 'Mensaje para el agente' })).toHaveFocus();
    await send(panel, user, 'Cambio lento');
    await within(panel).findByText('Cambiando el paso', {}, patience);

    await user.keyboard('{Escape}');
    expect(panel).not.toHaveAttribute('data-open');
    expect(toggle).toHaveFocus();
    const status = await screen.findByRole('status', { name: 'Agente trabajando' }, patience);
    await user.click(within(status).getByRole('button', { name: 'Detener' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Agente trabajando' })).not.toBeInTheDocument(), patience);
  });
});
