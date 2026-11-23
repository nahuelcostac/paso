// @vitest-environment jsdom
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
function editsStepOne(text = 'Step 1 updated.') {
  return async function* (): AsyncIterable<AgentEvent> {
    yield { type: 'session', resumeToken: 'tok' };
    yield { type: 'tool_use', id: `edit-${Math.random()}`, tool: 'add_elements', readOnly: false, target: { projectId: 'p', sceneId: 's1', stepId: 'step1' } };
    await agentEdits('/projects/p/scenes/s1/steps/step1', (document) => ({ ...document, title: 'Edited by the agent', elements: [...document.elements, rect(`agent-${Math.random()}`, 60)] }));
    yield { type: 'text', text };
    yield { type: 'finished', reason: 'completed' };
  };
}

/** The chat's button in the activity bar. */
const chatButton = () => within(screen.getByRole('toolbar', { name: 'Activity bar' })).getByRole('button', { name: 'Agent chat' });
/** Opens the app in the Studio with the chat in the left spot: from the bar, unless it is remembered open. */
async function openPanel() {
  render(<App config={config} />);
  const button = await waitFor(chatButton, patience);
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
  return screen.findByRole('complementary', { name: 'Agent' }, patience);
}
/**
 * Picks a scene in the projects panel, which takes the left spot from the chat, then brings the chat back: one panel at
 * a time. Returns the chat's panel.
 */
async function pickScene(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(screen.getByRole('toolbar', { name: 'Activity bar' })).getByRole('button', { name: 'Projects' }));
  expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();
  await user.click(within(await screen.findByRole('list', { name: 'Scenes of Búsqueda binaria' }, patience)).getByRole('button', { name }));
  await user.click(chatButton());
  expect(screen.queryByRole('complementary', { name: 'Projects and diagrams' })).not.toBeInTheDocument();
  return screen.findByRole('complementary', { name: 'Agent' }, patience);
}
async function send(panel: HTMLElement, user: ReturnType<typeof userEvent.setup>, text: string) {
  const input = within(panel).getByRole('textbox', { name: 'Message to the agent' });
  await user.type(input, text);
  await waitFor(() => expect(within(panel).getByRole('button', { name: 'Send' })).toBeEnabled(), patience);
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
  window.localStorage.removeItem('paso.side-panel');
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

describe('agent message drafts', () => {
  it('keeps separate diagram drafts through view and scene changes, and clears on send', async () => {
    await call('POST', '/projects', { id: 'q', name: 'Otro diagrama' });
    await call('POST', '/projects/q/scenes', { id: 'q1', name: 'Otra escena' });
    await call('POST', '/projects/q/scenes/q1/steps', { id: 'qstep', elements: [] });
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup();
    let panel = await openPanel();
    const input = () => within(panel).getByRole('textbox', { name: 'Message to the agent' });
    await user.type(input(), 'Borrador uno');
    panel = await pickScene(user, 'Scene 2: Partir en dos');
    expect(input()).toHaveValue('Borrador uno');
    // The Studio's button again goes back to the Canvas, where the chat is not; once more, and the chat is back.
    await user.click(screen.getByRole('button', { name: 'Studio' }));
    expect(await screen.findByRole('main', { name: 'Canvas' }, patience)).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Studio' }, patience));
    panel = await screen.findByRole('complementary', { name: 'Agent' }, patience);
    expect(input()).toHaveValue('Borrador uno');

    window.location.hash = '#/q/storyboard/q1/qstep';
    await waitFor(() => expect(input()).toHaveValue(''), patience);
    await user.type(input(), 'Borrador dos');
    window.location.hash = '#/p/storyboard/s1/step1';
    await waitFor(() => expect(input()).toHaveValue('Borrador uno'), patience);
    window.location.hash = '#/q/storyboard/q1/qstep';
    await waitFor(() => expect(input()).toHaveValue('Borrador dos'), patience);
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Send' })).toBeEnabled(), patience);
    await user.click(within(panel).getByRole('button', { name: 'Send' }));
    expect(input()).toHaveValue('');
  });
});

describe('agent composer', () => {
  it('grows with its text and shrinks back when it is sent', async () => {
    // jsdom lays nothing out: the text's height is taken from its line count.
    const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLTextAreaElement) { return 22 * Math.max(2, this.value.split('\n').length); });
    try {
      const user = userEvent.setup();
      const panel = await openPanel();
      const input = within(panel).getByRole('textbox', { name: 'Message to the agent' });
      await waitFor(() => expect(input.style.height).toBe('44px'), patience);
      await user.type(input, 'one{Shift>}{Enter}{/Shift}two{Shift>}{Enter}{/Shift}three{Shift>}{Enter}{/Shift}four');
      expect(input.style.height).toBe('88px');
      await user.clear(input);
      expect(input.style.height).toBe('44px');
    } finally {
      scrollHeight.mockRestore();
    }
  });
});

describe('agent and model picker', () => {
  it('asks once to add Claude Code, shows Codex as available, and passes the chosen model', async () => {
    await installHarness('codex', 'codex-cli 0.80.0');
    const user = userEvent.setup();
    const panel = await openPanel();

    // Not added yet: the panel says what adding means, and nothing can be sent.
    const add = await within(panel).findByRole('button', { name: 'Add Claude Code' }, patience);
    expect(within(panel).getByText(/with your own session and quota/)).toBeInTheDocument();
    await user.type(within(panel).getByRole('textbox', { name: 'Message to the agent' }), 'Hola');
    expect(within(panel).getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.click(add);
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Send' })).toBeEnabled(), patience);
    expect(within(panel).queryByText(/with your own session and quota/)).not.toBeInTheDocument();
    expect(JSON.parse(await readFile(harnessRegistryPath, 'utf8'))).toEqual(['claude']);

    // One picker for agent, model and reasoning, on the body: agents in a rail, the models of the one in view, the levels.
    const trigger = () => within(panel).getByRole('button', { name: /^Agent and model: / });
    expect(trigger()).toHaveAccessibleName('Agent and model: Claude Code, Default');
    await user.click(trigger());
    let picker = await screen.findByRole('dialog', { name: 'Choose agent and model' });
    expect(panel.contains(picker)).toBe(false);
    const agents = within(picker).getByRole('radiogroup', { name: 'Agent' });
    expect(within(agents).getAllByRole('radio').map((item) => item.getAttribute('aria-label'))).toEqual(['Claude Code', 'Codex', 'Antigravity']);
    expect(within(agents).getByRole('radio', { name: 'Claude Code' })).toHaveAttribute('aria-checked', 'true');
    // Models: the account's own, without Fable. The chosen one has the focus.
    const models = within(picker).getByRole('radiogroup', { name: 'Model' });
    expect(within(models).getAllByRole('radio').map((item) => item.textContent)).toEqual(['Default', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(within(models).getByRole('radio', { name: 'Default' })).toHaveFocus();
    expect(picker).not.toHaveTextContent(/Fable/i);
    // Reasoning: Claude Code's own levels, automatic by default.
    const reasoning = within(picker).getByRole('radiogroup', { name: 'Reasoning' });
    expect(within(reasoning).getAllByRole('radio').map((item) => item.textContent)).toEqual(['Automatic', 'Low', 'Medium', 'High', 'Very high', 'Maximum']);
    expect(within(reasoning).getByRole('radio', { name: 'Automatic' })).toHaveAttribute('aria-checked', 'true');
    // Antigravity is not installed: its column says so instead of listing models.
    await user.click(within(agents).getByRole('radio', { name: 'Antigravity' }));
    expect(picker).toHaveTextContent("Antigravity isn't on this computer.");
    expect(within(picker).getByRole('button', { name: 'Detect again' })).toBeInTheDocument();
    // Codex is available: picking one of its models makes it the agent, and the panel asks to add it.
    await user.click(within(agents).getByRole('radio', { name: 'Codex' }));
    expect(picker).toHaveTextContent('0.80.0');
    expect(within(within(picker).getByRole('radiogroup', { name: 'Model' })).getByRole('radio', { name: 'GPT-6.1-Sol' })).toBeInTheDocument();
    await user.click(within(within(picker).getByRole('radiogroup', { name: 'Model' })).getByRole('radio', { name: 'Default' }));
    expect(trigger()).toHaveAccessibleName('Agent and model: Codex, Default');
    expect(within(panel).getByRole('button', { name: 'Add Codex' })).toBeInTheDocument();
    // Back to Claude Code, with Haiku: the popup stays open on the levels, and a level closes it.
    await user.click(within(within(picker).getByRole('radiogroup', { name: 'Agent' })).getByRole('radio', { name: 'Claude Code' }));
    await user.click(within(within(picker).getByRole('radiogroup', { name: 'Model' })).getByRole('radio', { name: 'Haiku 5.5' }));
    picker = screen.getByRole('dialog', { name: 'Choose agent and model' });
    await waitFor(() => expect(within(within(picker).getByRole('radiogroup', { name: 'Reasoning' })).getByRole('radio', { name: 'Automatic' })).toHaveFocus());
    await user.click(within(within(picker).getByRole('radiogroup', { name: 'Reasoning' })).getByRole('radio', { name: 'High' }));
    expect(screen.queryByRole('dialog', { name: 'Choose agent and model' })).not.toBeInTheDocument();
    expect(trigger()).toHaveAccessibleName('Agent and model: Claude Code, Haiku 5.5, high reasoning');
    expect(trigger()).toHaveFocus();
    expect(trigger().querySelector('.effort-bars')).not.toBeNull();   // the level as bars, as in T3 Code

    await user.clear(within(panel).getByRole('textbox', { name: 'Message to the agent' }));
    await send(panel, user, 'Hola');
    expect(await within(panel).findByText('Step 1 updated.', {}, patience)).toBeInTheDocument();
    expect(requests[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' });
  });

  it('adds Codex and sends a turn through the common panel', async () => {
    await installHarness('codex', 'codex-cli 0.166.0');
    const user = userEvent.setup();
    const panel = await openPanel();
    await user.click(within(panel).getByRole('button', { name: /^Agent and model: / }));
    const picker = await screen.findByRole('dialog', { name: 'Choose agent and model' });
    await waitFor(() => expect(within(picker).getByRole('radio', { name: 'Codex' })).toBeInTheDocument(), patience);
    await user.click(within(picker).getByRole('radio', { name: 'Codex' }));
    await user.click(await within(within(picker).getByRole('radiogroup', { name: 'Model' })).findByRole('radio', { name: 'Default' }, patience));
    await user.keyboard('{Escape}');
    await user.click(await within(panel).findByRole('button', { name: 'Add Codex' }, patience));
    await send(panel, user, 'Draw with Codex');
    expect(await within(panel).findByText('Step 1 updated.', {}, patience)).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(await within(panel).findByRole('button', { name: 'Undo run' }, patience)).toBeInTheDocument();
    expect(JSON.parse(await readFile(harnessRegistryPath, 'utf8'))).toEqual(['codex']);
  });

  it('says so when Claude Code is signed out', async () => {
    await installHarness('claude', '2.1.40 (Claude Code)', false);
    await call('POST', '/harnesses', { id: 'claude' });
    const panel = await openPanel();
    expect(await within(panel).findByText(/isn't signed in/, {}, patience)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Send' })).toBeDisabled();
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
      yield { type: 'text_delta', text: 'Changing step 1 ' };
      yield { type: 'tool_use', id: 'edit', tool: 'add_elements', readOnly: false, target: { projectId: 'p', sceneId: 's2', stepId: 'step2' } };
      await gate;
      await agentEdits('/projects/p/scenes/s2/steps/step2', (document) => ({ ...document, elements: [...document.elements, rect('r2-agent', 80)] }));
      yield { type: 'tool_result', id: 'edit', ok: true };
      // create_step names no step: the new one is the step the service reports.
      yield { type: 'tool_use', id: 'create', tool: 'create_step', readOnly: false, target: { projectId: 'p', sceneId: 's2' } };
      await call('POST', '/projects/p/scenes/s2/steps', { id: 'step3', title: 'Created by the agent', elements: [rect('r3-agent', 120)] });
      yield { type: 'tool_result', id: 'create', ok: true };
      yield { type: 'text', text: 'Done: check steps 1 and 2.' };
      yield { type: 'finished', reason: 'completed' };
    };
    const user = userEvent.setup();
    let panel = await openPanel();

    // The panel starts with the app's icon and name, as the projects do.
    expect(panel.querySelector('.panel-brand')).toHaveTextContent('Paso');
    // The target is the scene selected in the sidebar; the panel's head names it, and there is nothing to pick there.
    // The log starts empty.
    expect(within(panel).getByRole('log', { name: 'Conversation with the agent' })).toBeEmptyDOMElement();
    await waitFor(() => expect(within(panel).getByRole('heading', { level: 2 })).toHaveTextContent('01El problema'), patience);
    panel = await pickScene(user, 'Scene 2: Partir en dos');
    await waitFor(() => expect(within(panel).getByRole('heading', { level: 2 })).toHaveTextContent('02Partir en dos'), patience);
    expect(screen.getByRole('main', { name: 'Studio' })).toBeInTheDocument();   // selecting keeps the Studio
    const scene2 = await screen.findByRole('region', { name: 'Scene 2: Partir en dos' }, patience);   // which shows that scene

    await send(panel, user, 'Expand scene 2');
    expect(await within(panel).findByText('Expand scene 2')).toBeInTheDocument();
    // Streaming: the partial text and the running tool, with its step chip.
    expect(await within(panel).findByText('Changing step 1', { exact: false }, patience)).toBeInTheDocument();
    expect(await within(panel).findByText('Changing the step', {}, patience)).toBeInTheDocument();
    expect(within(panel).getByText('Read scene 2')).toBeInTheDocument();
    expect(within(panel).getByText('1 step')).toBeInTheDocument();
    expect(within(panel).getByText(/Working ·/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(requests[0].context).toEqual({ projectId: 'p', sceneId: 's2' });

    // The step being changed: an agent edge and "changing…".
    await waitFor(() => {
      const frame = within(scene2).getByRole('button', { name: /Step 1/ });
      expect(frame).toHaveClass('frame--agent-working');
      expect(within(frame).getByText('changing…')).toBeInTheDocument();
    }, patience);

    release();
    expect(await within(panel).findByText('Done: check steps 1 and 2.', {}, patience)).toBeInTheDocument();
    expect(within(panel).getByText('Changed the step')).toBeInTheDocument();
    expect(within(panel).getByText('Created the step')).toBeInTheDocument();
    // Both steps carry the agent chip, and their thumbnails were drawn again from the new content.
    await waitFor(() => {
      const one = within(scene2).getByRole('button', { name: 'Step 1: Mitad' });
      const two = within(scene2).getByRole('button', { name: 'Step 2: Created by the agent' });
      expect(one).not.toHaveClass('frame--agent-working');
      expect(within(one).getByText('agent')).toBeInTheDocument();
      expect(within(two).getByText('agent')).toBeInTheDocument();
      expect(drawn.calls).toContain('+r2+r2-agent');
      expect(drawn.calls).toContain('+r3-agent');
    }, patience);
    await waitFor(() => expect(within(panel).getByText(/· 2 changes/)).toBeInTheDocument(), patience);

    // A step chip jumps to that step.
    await user.click(await within(panel).findByRole('button', { name: 'Go to step 2 of scene 2' }, patience));
    expect(await screen.findByRole('main', { name: 'Canvas' }, patience)).toBeInTheDocument();
    expect(window.location.hash).toBe('#/p/canvas/s2/step3');
  });

  it('shows a failed turn with its message and still closes its restore point', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    adapterImpl = async function* () {
      yield { type: 'tool_use', id: 'edit', tool: 'add_elements', readOnly: false, target: { projectId: 'p', sceneId: 's1', stepId: 'step1' } };
      await agentEdits('/projects/p/scenes/s1/steps/step1', (document) => ({ ...document, elements: [...document.elements, rect('half', 5)] }));
      yield { type: 'failed', code: 'quota', message: "You've reached your account's usage limit." };
    };
    const user = userEvent.setup();
    const panel = await openPanel();
    await send(panel, user, 'Algo largo');
    expect(await within(panel).findByText("You've reached your account's usage limit.", {}, patience)).toBeInTheDocument();
    // A failed run's changes can still be undone.
    expect(await within(panel).findByRole('button', { name: 'Undo run' }, patience)).toBeInTheDocument();
    expect(within(panel).getByText(/Failed · .* · 1 change/)).toBeInTheDocument();
    const { runs } = await call<{ runs: Array<{ status: string }> }>('GET', '/projects/p/runs');
    expect(runs.map((run) => run.status)).toEqual(['finished']);
  });

  it('stops a run from the Canvas, where the top bar says who is changing which step', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    adapterImpl = async function* (_request, signal) {
      yield { type: 'tool_use', id: 'slow', tool: 'update_elements', readOnly: false, target: { projectId: 'p', sceneId: 's1', stepId: 'step1' } };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'finished', reason: 'cancelled' };
    };
    const user = userEvent.setup();
    const panel = await openPanel();
    await send(panel, user, 'Cambio lento');
    expect(await within(panel).findByText('Changing the step', {}, patience)).toBeInTheDocument();
    // With the panel in view, the top bar says nothing.
    expect(screen.queryByRole('status', { name: 'Agent working' })).not.toBeInTheDocument();

    // Folded, the panel leaves it to a small floating status, and a pink dot on the chat's button in the activity bar.
    const toggle = chatButton();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'agent-panel');
    expect(toggle.querySelector('.activity-bar__badge')).toBeNull();
    await user.click(toggle);
    expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.app')).not.toHaveClass('app--agent');
    expect(toggle.querySelector('.activity-bar__badge')).not.toBeNull();
    const status = await screen.findByRole('status', { name: 'Agent working' }, patience);
    expect(status).toHaveTextContent('Claude Code is changing a step');
    expect(within(status).getByRole('button', { name: 'Go to step 1 of scene 1' })).toHaveTextContent('1');
    await user.click(within(status).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Agent working' })).not.toBeInTheDocument(), patience);

    await user.click(chatButton());
    const after = await screen.findByRole('complementary', { name: 'Agent' }, patience);
    expect(await within(after).findByText(/^Stopped · /, {}, patience)).toBeInTheDocument();
    expect(within(after).getByRole('button', { name: 'Send' })).toBeInTheDocument();
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
    const scene1 = await screen.findByRole('region', { name: 'Scene 1: El problema' }, patience);
    await waitFor(() => expect(within(panel).getByRole('heading', { level: 2 })).toHaveTextContent('01El problema'), patience);
    await send(panel, user, 'Update step 1');
    await user.click(await within(panel).findByRole('button', { name: 'Undo run' }, patience));

    const dialog = await screen.findByRole('alertdialog', { name: 'Undo this run?' }, patience);
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('list', { name: 'Warnings' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Undo run' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(within(panel).getByText(/· Undone/)).toBeInTheDocument();
      expect(within(scene1).getByRole('button', { name: 'Step 1: Inicio' })).toBeInTheDocument();
    }, patience);
    // The other scene keeps the person's edit.
    await pickScene(user, 'Scene 2: Partir en dos');
    const scene2 = await screen.findByRole('region', { name: 'Scene 2: Partir en dos' }, patience);
    await within(scene2).findByRole('button', { name: 'Step 1: Trabajo de la persona' }, patience);
    expect(humanStep).toBeDefined();
    expect(await call<StepEnvelope>('GET', humanPath)).toEqual(humanStep);
  });

  it('previews, then undoes on confirmation', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup();
    const panel = await openPanel();
    const scene1 = await screen.findByRole('region', { name: 'Scene 1: El problema' }, patience);
    await send(panel, user, 'Update step 1');
    await user.click(await within(panel).findByRole('button', { name: 'Undo run' }, patience));

    const dialog = await screen.findByRole('alertdialog', { name: 'Undo this run?' }, patience);
    expect(dialog).toHaveTextContent('One step gets back its previous content, title and notes.');
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(), patience);
    // Nothing changes until it is confirmed.
    expect(await within(scene1).findByRole('button', { name: 'Step 1: Edited by the agent' }, patience)).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Undo run' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(within(panel).getByText(/· Undone/)).toBeInTheDocument();
      expect(within(scene1).getByRole('button', { name: 'Step 1: Inicio' })).toBeInTheDocument();
    }, patience);
    expect(within(panel).queryByRole('button', { name: 'Undo run' })).not.toBeInTheDocument();
  });

  it('shows the warnings plainly and needs an explicit confirmation when a person edited a step afterwards', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup();
    const panel = await openPanel();
    const scene1 = await screen.findByRole('region', { name: 'Scene 1: El problema' }, patience);
    await send(panel, user, 'Update step 1');
    const undo = await within(panel).findByRole('button', { name: 'Undo run' }, patience);
    await personEdits('/projects/p/scenes/s1/steps/step1', (document) => ({ ...document, title: 'Editado por persona' }));
    await within(scene1).findByRole('button', { name: 'Step 1: Editado por persona' }, patience);

    await user.click(undo);
    const dialog = await screen.findByRole('alertdialog', { name: 'Undo this run?' }, patience);
    expect(within(dialog).getByRole('list', { name: 'Warnings' })).toHaveTextContent('Step 1 of “El problema” was edited after the run. Undoing loses those edits.');
    const confirm = within(dialog).getByRole('button', { name: 'Undo and lose the edits' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /I understand that edits made by people will be lost/ }));
    expect(confirm).toBeEnabled();

    // Another change after the preview: the plan is read again and asked again.
    await personEdits('/projects/p/scenes/s1/steps/step1', (document) => ({ ...document, speakerNotes: 'otra' }));
    await user.click(confirm);
    expect(await within(dialog).findByText(/The project changed while you were reading the summary/, {}, patience)).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox')).not.toBeChecked();
    expect(within(scene1).getByRole('button', { name: 'Step 1: Editado por persona' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Undo and lose the edits' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(within(scene1).getByRole('button', { name: 'Step 1: Inicio' })).toBeInTheDocument();
    }, patience);
  });

  it('is not blocked by a later run that changed nothing, such as a question', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup();
    const panel = await openPanel();
    const scene1 = await screen.findByRole('region', { name: 'Scene 1: El problema' }, patience);
    await send(panel, user, 'Update step 1');
    await within(panel).findByRole('button', { name: 'Undo run' }, patience);

    adapterImpl = async function* () {
      yield { type: 'tool_use', id: 'look', tool: 'read_scene', readOnly: true, target: { projectId: 'p', sceneId: 's1' } };
      yield { type: 'tool_result', id: 'look', ok: true };
      yield { type: 'text', text: 'Scene 1 has one step.' };
      yield { type: 'finished', reason: 'completed' };
    };
    await send(panel, user, "What's in scene 1?");
    await within(panel).findByText('Scene 1 has one step.', {}, patience);
    await waitFor(() => expect(within(panel).getByText(/· No changes/)).toBeInTheDocument(), patience);
    // The button stays on the run with changes.
    const buttons = within(panel).getAllByRole('button', { name: 'Undo run' });
    expect(buttons).toHaveLength(1);

    await user.click(buttons[0]);
    const dialog = await screen.findByRole('alertdialog', { name: 'Undo this run?' }, patience);
    await user.click(within(dialog).getByRole('button', { name: 'Undo run' }));
    await waitFor(() => expect(within(scene1).getByRole('button', { name: 'Step 1: Inicio' })).toBeInTheDocument(), patience);
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
    await send(panel, user, 'Update step 1');
    await within(panel).findByRole('button', { name: 'Undo run' }, patience);

    cleanup();
    panel = await openPanel();
    expect(await within(panel).findByText('Step 1 updated.', {}, patience)).toBeInTheDocument();
    expect(within(panel).getAllByText('Changed the step')).toHaveLength(2);
    expect(await within(panel).findByRole('button', { name: 'Go to step 1 of scene 1' }, patience)).toBeInTheDocument();
    // The step it created is found again from the restore point, since creation events are not replayed.
    await waitFor(() => expect(within(panel).getAllByRole('button', { name: 'Go to step 2 of scene 1' })).toHaveLength(2), patience);
    // The service keeps the conversation's history, the person's message included.
    expect(await within(panel).findByText('Update step 1', {}, patience)).toBeInTheDocument();
    expect(await within(panel).findByRole('button', { name: 'Undo run' }, patience)).toBeInTheDocument();

    // A new conversation still reaches the last run's undo.
    await user.click(within(panel).getByRole('button', { name: 'New conversation' }));
    expect(within(panel).queryByText('Step 1 updated.')).not.toBeInTheDocument();
    expect(within(panel).getByText(/Last run · .* · 2 changes/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Undo run' })).toBeInTheDocument();
  });
});

describe('continuing a conversation', () => {
  it('keeps the conversation’s session and model after a reload, and starts a new one only when the model changes', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup();
    let panel = await openPanel();
    await user.click(within(panel).getByRole('button', { name: /^Agent and model: / }));
    await user.click(within(within(await screen.findByRole('dialog', { name: 'Choose agent and model' })).getByRole('radiogroup', { name: 'Model' })).getByRole('radio', { name: 'Haiku 5.5' }));
    await user.keyboard('{Escape}');
    await send(panel, user, 'Primero');
    await within(panel).findByText(/· 1 change/, {}, patience);

    cleanup();
    panel = await openPanel();
    await within(panel).findByText('Step 1 updated.', {}, patience);
    expect(within(panel).getByRole('button', { name: 'Agent and model: Claude Code, Haiku 5.5' })).toBeInTheDocument();
    await send(panel, user, 'Segundo');
    await waitFor(() => expect(requests).toHaveLength(2), patience);
    expect(requests[1]).toMatchObject({ model: 'claude-haiku-5-5', resumeToken: 'tok' });
    await waitFor(() => expect(within(panel).queryByText(/Working ·/)).not.toBeInTheDocument(), patience);

    await user.click(within(panel).getByRole('button', { name: 'Agent and model: Claude Code, Haiku 5.5' }));
    await user.click(within(within(await screen.findByRole('dialog', { name: 'Choose agent and model' })).getByRole('radiogroup', { name: 'Model' })).getByRole('radio', { name: 'Default' }));
    await user.keyboard('{Escape}');
    expect(within(panel).queryByText('Step 1 updated.')).not.toBeInTheDocument();
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
      yield { type: 'text', text: `Respuesta a “${request.text}”.` };
      yield { type: 'finished', reason: 'completed' };
    };
    const user = userEvent.setup();
    const panel = await openPanel();
    await send(panel, user, 'Primero');
    await within(panel).findByText('Respuesta a “Primero”.', {}, patience);
    await user.click(within(panel).getByRole('button', { name: 'New conversation' }));
    await send(panel, user, 'Segundo');
    await within(panel).findByText('Respuesta a “Segundo”.', {}, patience);

    // Newest first, each by its first message; the open one is marked.
    await user.click(within(panel).getByRole('button', { name: 'Conversation history' }));
    let history = await screen.findByRole('dialog', { name: 'Conversation history' });
    const titles = () => within(history).getAllByRole('button', { name: /^(Primero|Segundo)/ }).map((item) => item.querySelector('.history__title')?.textContent);
    await waitFor(() => expect(titles()).toEqual(['Segundo', 'Primero']));
    expect(within(history).getAllByRole('button', { name: /^Segundo/ })[0]).toHaveAttribute('aria-current', 'true');
    expect(history).toHaveTextContent(/Claude Code · 1 message · today, \d\d:\d\d/);

    // Reopening the first shows its messages, and the next message continues it.
    await user.click(within(history).getAllByRole('button', { name: /^Primero/ })[0]);
    expect(await within(panel).findByText('Respuesta a “Primero”.', {}, patience)).toBeInTheDocument();
    expect(within(panel).getByText('Primero')).toBeInTheDocument();
    expect(within(panel).queryByText('Respuesta a “Segundo”.')).not.toBeInTheDocument();
    await send(panel, user, 'Tercero');
    await within(panel).findByText('Respuesta a “Tercero”.', {}, patience);
    expect(requests.at(-1)).toMatchObject({ text: 'Tercero', resumeToken: 'tok-1' });

    // Deleting asks first; then the conversation and its history are gone from the service too.
    await user.click(within(panel).getByRole('button', { name: 'Conversation history' }));
    history = await screen.findByRole('dialog', { name: 'Conversation history' });
    await waitFor(() => expect(titles()).toEqual(['Primero', 'Segundo']));
    expect(history).toHaveTextContent('2 messages');
    await user.click(within(history).getByRole('button', { name: 'Delete the conversation “Segundo”' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete this conversation?' });
    expect(confirm).toHaveTextContent('the copy Claude Code keeps');
    await user.click(within(confirm).getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    const left = await call<{ sessions: Array<{ title?: string }> }>('GET', '/agent/sessions?projectId=p');
    expect(left.sessions.map((session) => session.title)).toEqual(['Primero']);
    await user.click(within(panel).getByRole('button', { name: 'Conversation history' }));
    history = await screen.findByRole('dialog', { name: 'Conversation history' });
    expect(titles()).toEqual(['Primero']);
  });
});

describe('narrow windows', () => {
  it('opens the panel as a drawer from the activity bar, and shows the agent status while it is closed', async () => {
    window.innerWidth = 900;
    window.matchMedia = ((query: string) => ({
      matches: query === '(max-width: 1063px)', media: query, addEventListener() {}, removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    await call('POST', '/harnesses', { id: 'claude' });
    adapterImpl = async function* (_request, signal) {
      yield { type: 'tool_use', id: 'slow', tool: 'update_elements', readOnly: false, target: { projectId: 'p', sceneId: 's1', stepId: 'step1' } };
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'finished', reason: 'cancelled' };
    };
    const user = userEvent.setup();
    render(<App config={config} />);
    const toggle = await waitFor(chatButton, patience);
    const panel = await screen.findByRole('complementary', { name: 'Agent', hidden: true }, patience);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel).not.toHaveAttribute('data-open');
    // A drawer does not dock: there is no edge to drag, only the bar's button.
    expect(screen.queryByRole('separator', { name: 'Chat width' })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(panel).toHaveAttribute('data-open', 'true');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // A drawer is for the moment: the panel to bring back with room to dock stays the one chosen there.
    expect(window.localStorage.getItem('paso.side-panel')).toBeNull();
    expect(within(panel).getByRole('textbox', { name: 'Message to the agent' })).toHaveFocus();
    await send(panel, user, 'Cambio lento');
    await within(panel).findByText('Changing the step', {}, patience);

    await user.keyboard('{Escape}');
    expect(panel).not.toHaveAttribute('data-open');
    expect(toggle).toHaveFocus();
    const status = await screen.findByRole('status', { name: 'Agent working' }, patience);
    await user.click(within(status).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Agent working' })).not.toBeInTheDocument(), patience);
  });
});
