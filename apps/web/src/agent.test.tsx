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
  window.innerWidth = 1024;
  requests = [];
  rootDir = await mkdtemp(join(tmpdir(), 'paso-agent-web-'));
  binDir = join(rootDir, 'bin');
  harnessRegistryPath = join(rootDir, 'state', 'harnesses.json');
  await mkdir(join(rootDir, 'projects'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await installHarness('claude', '2.1.40 (Claude Code)');

  window.history.replaceState(null, '', '#/p/storyboard');
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, addEventListener() {}, removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  adapterImpl = editsStepOne();
  const adapter: HarnessAdapter = { id: 'claude', run: (request, signal) => { requests.push(request); return adapterImpl(request, signal); } };
  service = await startServer({
    dataDir: join(rootDir, 'projects'), port: 0, sessionToken: token, allowedOrigins: [window.location.origin], pollIntervalMs: 80,
    harnessRegistryPath, runsDir: join(rootDir, 'runs'),
    harnessDetection: { searchPaths: [binDir], loginShell: false },
    agent: { workDir: join(rootDir, 'work'), sessionsPath: join(rootDir, 'state', 'sessions.json'), adapters: { claude: adapter, codex: { ...adapter, id: 'codex' } } },
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
  it('asks once to add Claude Code, shows Codex as available, and passes the chosen model', async () => {
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

    // One picker for agent, model and reasoning, on the body: agents in a rail, the models of the one in view, the levels.
    const trigger = () => within(panel).getByRole('button', { name: /^Agente y modelo: / });
    expect(trigger()).toHaveAccessibleName('Agente y modelo: Claude Code, Predeterminado');
    await user.click(trigger());
    let picker = await screen.findByRole('dialog', { name: 'Elegir agente y modelo' });
    expect(panel.contains(picker)).toBe(false);
    const agents = within(picker).getByRole('radiogroup', { name: 'Agente' });
    expect(within(agents).getAllByRole('radio').map((item) => item.getAttribute('aria-label'))).toEqual(['Claude Code', 'Codex', 'Antigravity']);
    expect(within(agents).getByRole('radio', { name: 'Claude Code' })).toHaveAttribute('aria-checked', 'true');
    // Models: the account's own, without Fable. The chosen one has the focus.
    const models = within(picker).getByRole('radiogroup', { name: 'Modelo' });
    expect(within(models).getAllByRole('radio').map((item) => item.textContent)).toEqual(['Predeterminado', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(within(models).getByRole('radio', { name: 'Predeterminado' })).toHaveFocus();
    expect(picker).not.toHaveTextContent(/Fable/i);
    // Reasoning: Claude Code's own levels, automatic by default.
    const reasoning = within(picker).getByRole('radiogroup', { name: 'Razonamiento' });
    expect(within(reasoning).getAllByRole('radio').map((item) => item.textContent)).toEqual(['Automático', 'Bajo', 'Medio', 'Alto', 'Muy alto', 'Máximo']);
    expect(within(reasoning).getByRole('radio', { name: 'Automático' })).toHaveAttribute('aria-checked', 'true');
    // Antigravity is not installed: its column says so instead of listing models.
    await user.click(within(agents).getByRole('radio', { name: 'Antigravity' }));
    expect(picker).toHaveTextContent('No se encuentra Antigravity en este equipo.');
    expect(within(picker).getByRole('button', { name: 'Detectar de nuevo' })).toBeInTheDocument();
    // Codex is available: picking one of its models makes it the agent, and the panel asks to add it.
    await user.click(within(agents).getByRole('radio', { name: 'Codex' }));
    expect(picker).toHaveTextContent('0.80.0');
    await user.click(within(within(picker).getByRole('radiogroup', { name: 'Modelo' })).getByRole('radio', { name: 'Predeterminado' }));
    expect(trigger()).toHaveAccessibleName('Agente y modelo: Codex, Predeterminado');
    expect(within(panel).getByRole('button', { name: 'Añadir Codex' })).toBeInTheDocument();
    // Back to Claude Code, with Haiku: the popup stays open on the levels, and a level closes it.
    await user.click(within(within(picker).getByRole('radiogroup', { name: 'Agente' })).getByRole('radio', { name: 'Claude Code' }));
    await user.click(within(within(picker).getByRole('radiogroup', { name: 'Modelo' })).getByRole('radio', { name: 'Haiku 5.5' }));
    picker = screen.getByRole('dialog', { name: 'Elegir agente y modelo' });
    await waitFor(() => expect(within(within(picker).getByRole('radiogroup', { name: 'Razonamiento' })).getByRole('radio', { name: 'Automático' })).toHaveFocus());
    await user.click(within(within(picker).getByRole('radiogroup', { name: 'Razonamiento' })).getByRole('radio', { name: 'Alto' }));
    expect(screen.queryByRole('dialog', { name: 'Elegir agente y modelo' })).not.toBeInTheDocument();
    expect(trigger()).toHaveAccessibleName('Agente y modelo: Claude Code, Haiku 5.5, razonamiento alto');
    expect(trigger()).toHaveFocus();
    expect(trigger().querySelector('.effort-bars')).not.toBeNull();   // the level as bars, as in T3 Code

    await user.clear(within(panel).getByRole('textbox', { name: 'Mensaje para el agente' }));
    await send(panel, user, 'Hola');
    expect(await within(panel).findByText('Paso 1 actualizado.', {}, patience)).toBeInTheDocument();
    expect(requests[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' });
  });

  it('adds Codex and sends a turn through the common panel', async () => {
    await installHarness('codex', 'codex-cli 0.166.0');
    const user = userEvent.setup();
    const panel = await openPanel();
    await user.click(within(panel).getByRole('button', { name: /^Agente y modelo: / }));
    const picker = await screen.findByRole('dialog', { name: 'Elegir agente y modelo' });
    await waitFor(() => expect(within(picker).getByRole('radio', { name: 'Codex' })).toBeInTheDocument(), patience);
    await user.click(within(picker).getByRole('radio', { name: 'Codex' }));
    await user.click(await within(within(picker).getByRole('radiogroup', { name: 'Modelo' })).findByRole('radio', { name: 'Predeterminado' }, patience));
    await user.keyboard('{Escape}');
    await user.click(await within(panel).findByRole('button', { name: 'Añadir Codex' }, patience));
    await send(panel, user, 'Dibuja con Codex');
    expect(await within(panel).findByText('Paso 1 actualizado.', {}, patience)).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(await within(panel).findByRole('button', { name: 'Deshacer ejecución' }, patience)).toBeInTheDocument();
    expect(JSON.parse(await readFile(harnessRegistryPath, 'utf8'))).toEqual(['codex']);
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

    // The target is the scene selected in the sidebar; the panel's head names it, and there is nothing to pick there.
    // The log starts empty.
    expect(within(panel).getByRole('log', { name: 'Conversación con el agente' })).toBeEmptyDOMElement();
    await waitFor(() => expect(within(panel).getByRole('heading', { level: 2 })).toHaveTextContent('01El problema'), patience);
    await user.click(within(screen.getByRole('list', { name: 'Escenas de Búsqueda binaria' })).getByRole('button', { name: 'Escena 2: Partir en dos' }));
    await waitFor(() => expect(within(panel).getByRole('heading', { level: 2 })).toHaveTextContent('02Partir en dos'), patience);
    expect(screen.getByRole('main', { name: 'Estudio' })).toBeInTheDocument();   // selecting keeps the Estudio
    const scene2 = await screen.findByRole('region', { name: 'Escena 2: Partir en dos' }, patience);   // which shows that scene

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

    // Folded, the panel leaves it to its rail.
    await user.click(within(panel).getByRole('button', { name: 'Ocultar el agente' }));
    expect(screen.queryByRole('complementary', { name: 'Agente' })).not.toBeInTheDocument();
    const status = await screen.findByRole('status', { name: 'Agente trabajando' }, patience);
    expect(status).toHaveTextContent('Claude Code está cambiando el paso');
    expect(within(status).getByRole('button', { name: 'Ir al paso 1 de la escena 1' })).toHaveTextContent('1');
    await user.click(within(status).getByRole('button', { name: 'Detener' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Agente trabajando' })).not.toBeInTheDocument(), patience);

    await user.click(screen.getByRole('button', { name: 'Mostrar el agente' }));
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
  it('keeps a person edit made during the turn when undoing the agent edit on another step', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const humanPath = '/projects/p/scenes/s2/steps/step2';
    let humanStep: StepEnvelope | undefined;
    adapterImpl = async function* () {
      // The session has opened its restore point before the harness starts.
      await personEdits(humanPath, (document) => ({ ...document, title: 'Trabajo de la persona' }));
      humanStep = await call<StepEnvelope>('GET', humanPath);
      yield* editsStepOne()();
    };
    const user = userEvent.setup();
    const panel = await openPanel();
    const scene1 = await screen.findByRole('region', { name: 'Escena 1: El problema' }, patience);
    await waitFor(() => expect(within(panel).getByRole('heading', { level: 2 })).toHaveTextContent('01El problema'), patience);
    await send(panel, user, 'Actualiza el paso 1');
    await user.click(await within(panel).findByRole('button', { name: 'Deshacer ejecución' }, patience));

    const dialog = await screen.findByRole('alertdialog', { name: '¿Deshacer esta ejecución?' }, patience);
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('list', { name: 'Avisos' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Deshacer ejecución' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(within(panel).getByText(/· Deshecha/)).toBeInTheDocument();
      expect(within(scene1).getByRole('button', { name: 'Paso 1: Inicio' })).toBeInTheDocument();
    }, patience);
    // The other scene keeps the person's edit.
    await user.click(within(screen.getByRole('list', { name: 'Escenas de Búsqueda binaria' })).getByRole('button', { name: 'Escena 2: Partir en dos' }));
    const scene2 = await screen.findByRole('region', { name: 'Escena 2: Partir en dos' }, patience);
    await within(scene2).findByRole('button', { name: 'Paso 1: Trabajo de la persona' }, patience);
    expect(humanStep).toBeDefined();
    expect(await call<StepEnvelope>('GET', humanPath)).toEqual(humanStep);
  });

  it('previews, then undoes on confirmation', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup();
    const panel = await openPanel();
    const scene1 = await screen.findByRole('region', { name: 'Escena 1: El problema' }, patience);
    await send(panel, user, 'Actualiza el paso 1');
    await user.click(await within(panel).findByRole('button', { name: 'Deshacer ejecución' }, patience));

    const dialog = await screen.findByRole('alertdialog', { name: '¿Deshacer esta ejecución?' }, patience);
    expect(dialog).toHaveTextContent('Un paso recupera su contenido, título y notas anteriores.');
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus(), patience);
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
    expect(await within(dialog).findByText(/El diagrama cambió mientras mirabas el resumen/, {}, patience)).toBeInTheDocument();
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
    // The service keeps the conversation's history, the person's message included.
    expect(await within(panel).findByText('Actualiza el paso 1', {}, patience)).toBeInTheDocument();
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
    await user.click(within(panel).getByRole('button', { name: /^Agente y modelo: / }));
    await user.click(within(within(await screen.findByRole('dialog', { name: 'Elegir agente y modelo' })).getByRole('radiogroup', { name: 'Modelo' })).getByRole('radio', { name: 'Haiku 5.5' }));
    await user.keyboard('{Escape}');
    await send(panel, user, 'Primero');
    await within(panel).findByText(/· 1 cambio/, {}, patience);

    cleanup();
    panel = await openPanel();
    await within(panel).findByText('Paso 1 actualizado.', {}, patience);
    expect(within(panel).getByRole('button', { name: 'Agente y modelo: Claude Code, Haiku 5.5' })).toBeInTheDocument();
    await send(panel, user, 'Segundo');
    await waitFor(() => expect(requests).toHaveLength(2), patience);
    expect(requests[1]).toMatchObject({ model: 'claude-haiku-5-5', resumeToken: 'tok' });
    await waitFor(() => expect(within(panel).queryByText(/Trabajando ·/)).not.toBeInTheDocument(), patience);

    await user.click(within(panel).getByRole('button', { name: 'Agente y modelo: Claude Code, Haiku 5.5' }));
    await user.click(within(within(await screen.findByRole('dialog', { name: 'Elegir agente y modelo' })).getByRole('radiogroup', { name: 'Modelo' })).getByRole('radio', { name: 'Predeterminado' }));
    await user.keyboard('{Escape}');
    expect(within(panel).queryByText('Paso 1 actualizado.')).not.toBeInTheDocument();
    await send(panel, user, 'Tercero');
    await waitFor(() => expect(requests).toHaveLength(3), patience);
    expect(requests[2].model).toBeUndefined();
    expect(requests[2].resumeToken).toBeUndefined();
  });
});

describe('the history of conversations', () => {
  it('lists the scene\'s conversations, reopens one to continue it, and deletes one after asking', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    // Each conversation gets its own resume token, so continuing the right one can be told apart.
    adapterImpl = async function* (request) {
      yield { type: 'session', resumeToken: request.resumeToken ?? `tok-${requests.length}` };
      yield { type: 'text', text: `Respuesta a «${request.text}».` };
      yield { type: 'finished', reason: 'completed' };
    };
    const user = userEvent.setup();
    const panel = await openPanel();
    await send(panel, user, 'Primero');
    await within(panel).findByText('Respuesta a «Primero».', {}, patience);
    await user.click(within(panel).getByRole('button', { name: 'Nueva conversación' }));
    await send(panel, user, 'Segundo');
    await within(panel).findByText('Respuesta a «Segundo».', {}, patience);

    // Newest first, each by its first message; the open one is marked.
    await user.click(within(panel).getByRole('button', { name: 'Historial de conversaciones' }));
    let history = await screen.findByRole('dialog', { name: 'Historial de conversaciones' });
    const titles = () => within(history).getAllByRole('button', { name: /^(Primero|Segundo)/ }).map((item) => item.querySelector('.history__title')?.textContent);
    await waitFor(() => expect(titles()).toEqual(['Segundo', 'Primero']));
    expect(within(history).getAllByRole('button', { name: /^Segundo/ })[0]).toHaveAttribute('aria-current', 'true');
    expect(history).toHaveTextContent(/Claude Code · 1 mensaje · hoy, \d\d:\d\d/);

    // Reopening the first shows its messages, and the next message continues it.
    await user.click(within(history).getAllByRole('button', { name: /^Primero/ })[0]);
    expect(await within(panel).findByText('Respuesta a «Primero».', {}, patience)).toBeInTheDocument();
    expect(within(panel).getByText('Primero')).toBeInTheDocument();
    expect(within(panel).queryByText('Respuesta a «Segundo».')).not.toBeInTheDocument();
    await send(panel, user, 'Tercero');
    await within(panel).findByText('Respuesta a «Tercero».', {}, patience);
    expect(requests.at(-1)).toMatchObject({ text: 'Tercero', resumeToken: 'tok-1' });

    // Deleting asks first; then the conversation and its history are gone from the service too.
    await user.click(within(panel).getByRole('button', { name: 'Historial de conversaciones' }));
    history = await screen.findByRole('dialog', { name: 'Historial de conversaciones' });
    await waitFor(() => expect(titles()).toEqual(['Primero', 'Segundo']));
    expect(history).toHaveTextContent('2 mensajes');
    await user.click(within(history).getByRole('button', { name: 'Borrar la conversación «Segundo»' }));
    const confirm = await screen.findByRole('alertdialog', { name: '¿Borrar esta conversación?' });
    expect(confirm).toHaveTextContent('la copia que guarda Claude Code');
    await user.click(within(confirm).getByRole('button', { name: 'Borrar conversación' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    const left = await call<{ sessions: Array<{ title?: string }> }>('GET', '/agent/sessions?projectId=p');
    expect(left.sessions.map((session) => session.title)).toEqual(['Primero']);
    await user.click(within(panel).getByRole('button', { name: 'Historial de conversaciones' }));
    history = await screen.findByRole('dialog', { name: 'Historial de conversaciones' });
    expect(titles()).toEqual(['Primero']);
  });
});

describe('narrow windows', () => {
  it('opens the panel as a drawer from its rail, and shows the agent status there while it is closed', async () => {
    window.innerWidth = 900;
    await call('POST', '/harnesses', { id: 'claude' });
    adapterImpl = async function* (_request, signal) {
      yield { type: 'tool_use', id: 'slow', tool: 'update_elements', readOnly: false, target: { projectId: 'p', sceneId: 's1', stepId: 'step1' } };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'finished', reason: 'cancelled' };
    };
    const user = userEvent.setup();
    render(<App config={config} />);
    const toggle = await screen.findByRole('button', { name: 'Mostrar el agente' }, patience);
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
