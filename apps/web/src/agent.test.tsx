// @vitest-environment jsdom
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer, type AgentEvent, type AgentRunRequest, type HarnessAdapter } from '@paso/server';
import { App } from './App';
import { ApiClient, type ClientConfig } from './lib/api';
import { AgentStore } from './state/agent-store';
import { fakePath, writeLauncher } from '../../server/src/agent/testing/launcher.js';

// Each test starts real processes: a fake harness and the board MCP. On Windows one turn takes about 2 s, so a test
// with two or three turns needs more than the default 5 s for a whole test.
vi.setConfig({ testTimeout: 30_000 });

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
let afterRun: (() => void) | undefined;

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
  await writeLauncher(fakePath(join(binDir, id)), `
    if (process.argv[2] === '--version') console.log(${JSON.stringify(version)});
    if (process.argv[2] === 'auth') console.log(JSON.stringify({ loggedIn: ${loggedIn} }));
    if (process.argv[2] === 'login') console.log('Logged in');
  `);
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

/** The sidebar's panel buttons, which choose only what the sidebar shows. */
const agentButton = () => within(screen.getByRole('toolbar', { name: 'Sidebar panels' })).getByRole('button', { name: 'Agent' });
const projectsButton = () => within(screen.getByRole('toolbar', { name: 'Sidebar panels' })).getByRole('button', { name: 'Projects' });
/** The view switch in the main view's corner, which chooses only the view. */
const viewButton = (name: 'Diagram' | 'Studio') => within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name });
/** Opens the app in the Studio with the chat in the left spot: the view from its switch, then the panel from the bar, unless it is remembered open. */
async function openPanel() {
  render(<App config={config} />);
  const studio = await waitFor(() => viewButton('Studio'), patience);
  if (studio.getAttribute('aria-pressed') !== 'true') fireEvent.click(studio);
  await screen.findByRole('main', { name: 'Studio' }, patience);
  const button = agentButton();
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
  return screen.findByRole('complementary', { name: 'Agent' }, patience);
}
/**
 * Picks a scene in the projects panel, which takes the left spot from the chat, then brings the chat back: one panel at
 * a time. Returns the chat's panel.
 */
async function pickScene(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(projectsButton());
  expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();
  await user.click(within(await screen.findByRole('list', { name: 'Scenes of Búsqueda binaria' }, patience)).getByRole('button', { name }));
  await user.click(agentButton());
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
  afterRun = undefined;
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
  const adapter: HarnessAdapter = { id: 'claude', acceptsImages: true, run: (request, signal) => { requests.push(request); return adapterImpl(request, signal); } };
  service = await startServer({
    dataDir: join(rootDir, 'projects'), port: 0, sessionToken: token, allowedOrigins: [window.location.origin], pollIntervalMs: 80,
    harnessRegistryPath, runsDir: join(rootDir, 'runs'),
    harnessDetection: { searchPaths: [binDir], loginShell: false },
    agent: {
      workDir: join(rootDir, 'work'), sessionsPath: join(rootDir, 'state', 'sessions.json'),
      adapters: { claude: adapter, codex: { ...adapter, id: 'codex' } },
      hooks: { afterRun: async () => { afterRun?.(); } },
    },
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
    // Diagram opens the Canvas and the chat stays beside it with its draft, and so it does back in the Studio.
    await user.click(viewButton('Diagram'));
    expect(await screen.findByRole('main', { name: 'Canvas' }, patience)).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Agent' })).toBe(panel);
    expect(input()).toHaveValue('Borrador uno');
    await user.click(await waitFor(() => viewButton('Studio'), patience));
    expect(await screen.findByRole('main', { name: 'Studio' }, patience)).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Agent' })).toBe(panel);
    // Hidden behind Projects and shown again, it keeps the draft too.
    await user.click(projectsButton());
    expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();
    await user.click(agentButton());
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

describe('folding the sidebar', () => {
  it('brings back the panel that was open, the chat as well as the projects', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup();
    await openPanel();
    await user.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(await screen.findByRole('complementary', { name: 'Agent' }, patience)).toBeInTheDocument();
    expect(agentButton()).toHaveAttribute('aria-expanded', 'true');

    await user.click(projectsButton());
    await user.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(screen.getByRole('complementary', { name: 'Projects and diagrams' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();
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

    expect(panel.closest('.sidebar')?.querySelector('.panel-brand')).toHaveTextContent('Paso');
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

  it('shows the running agent on the Agent button while the chat is out of view', async () => {
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

    // On the Canvas the chat stays in view, so nothing else marks the agent.
    const toggle = agentButton();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'agent-panel');
    expect(toggle.querySelector('.sidebar__badge')).toBeNull();
    await user.click(viewButton('Diagram'));
    await waitFor(() => viewButton('Studio'), patience);
    expect(screen.getByRole('complementary', { name: 'Agent' })).toBe(panel);
    expect(toggle.querySelector('.sidebar__badge')).toBeNull();
    // Projects take the left spot: the Agent button marks the running agent. The Canvas's strip marks its step, so
    // there is no pill on it.
    await user.click(projectsButton());
    expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.app')).not.toHaveClass('app--agent');
    expect(toggle.querySelector('.sidebar__badge')).not.toBeNull();
    expect(toggle).toHaveAttribute('title', 'Agent (working)');
    expect(screen.queryByRole('status', { name: 'Agent working' })).not.toBeInTheDocument();
    // In the Studio, with the sidebar folded, the pill says it.
    await user.click(await waitFor(() => viewButton('Studio'), patience));
    await screen.findByRole('main', { name: 'Studio' }, patience);
    await user.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    const status = await screen.findByRole('status', { name: 'Agent working' }, patience);
    await user.click(screen.getByRole('button', { name: 'Show sidebar' }));
    expect(status).toHaveTextContent('Claude Code is changing a step');
    expect(within(status).getByRole('button', { name: 'Go to step 1 of scene 1' })).toHaveTextContent('1');
    await user.click(within(status).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Agent working' })).not.toBeInTheDocument(), patience);

    await user.click(agentButton());
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
    const firstRun = new Promise<void>((resolve) => { afterRun = resolve; });
    await send(panel, user, 'Primero');
    await firstRun;
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
    const sidebarToggle = screen.getByRole('button', { name: 'Show sidebar' });
    expect(document.querySelector('.sidebar')).not.toBeInTheDocument();
    // A drawer does not dock and has no edge to drag.
    expect(screen.queryByRole('separator', { name: 'Chat width' })).not.toBeInTheDocument();

    await user.click(sidebarToggle);
    // The chat needs an open diagram: until one opens its button says so and does nothing.
    const toggle = await waitFor(agentButton, patience);
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'), patience);
    await user.click(toggle);
    const panel = await screen.findByRole('complementary', { name: 'Agent' }, patience);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // A drawer is for the moment: the panel to bring back with room to dock stays the one chosen there.
    expect(window.localStorage.getItem('paso.side-panel')).toBeNull();
    expect(within(panel).getByRole('textbox', { name: 'Message to the agent' })).toHaveFocus();
    await send(panel, user, 'Cambio lento');
    await within(panel).findByText('Changing the step', {}, patience);

    await user.keyboard('{Escape}');
    expect(panel).not.toBeInTheDocument();
    expect(document.querySelector('.sidebar')).not.toBeInTheDocument();
    expect(sidebarToggle).toHaveAccessibleName('Show sidebar');
    expect(sidebarToggle).toHaveFocus();
    // Opening and closing the panel never changed the view: the Studio is still open, and a pill says the agent works.
    expect(screen.getByRole('main', { name: 'Studio' })).toBeInTheDocument();
    const status = await screen.findByRole('status', { name: 'Agent working' }, patience);
    await user.click(within(status).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Agent working' })).not.toBeInTheDocument(), patience);

    // The drawer comes back with the chat that was closed.
    await user.click(sidebarToggle);
    const again = await screen.findByRole('complementary', { name: 'Agent' }, patience);
    expect(screen.queryByRole('complementary', { name: 'Projects and diagrams' })).not.toBeInTheDocument();
    await user.click(sidebarToggle);
    expect(again).not.toBeInTheDocument();
    expect(sidebarToggle).toHaveFocus();
    expect(window.localStorage.getItem('paso.side-panel')).toBeNull();
  });
});

describe('images in the chat', () => {
  const pngBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const png = (name = 'shot.png') => new File([pngBytes], name, { type: 'image/png' });
  const base64 = btoa(String.fromCharCode(...pngBytes));
  let urls = 0;
  beforeEach(() => {
    // jsdom has no object URLs.
    urls = 0;
    URL.createObjectURL = vi.fn(() => `blob:test/${++urls}`);
    URL.revokeObjectURL = vi.fn();
  });
  const composer = (panel: HTMLElement) => within(panel).getByRole('textbox', { name: 'Message to the agent' });
  const draftRow = (panel: HTMLElement) => within(panel).queryByRole('list', { name: 'Attachments' });
  const filePicker = (panel: HTMLElement) => panel.querySelector<HTMLInputElement>('input[type="file"]')!;
  /** The chat, once it knows its scene: images go with that scene's conversation. */
  const ready = async () => {
    const panel = await openPanel();
    await within(panel).findByRole('heading', { name: /El problema/ }, patience);
    return panel;
  };

  it('attaches by the paperclip, sends the images to the harness and keeps them in the history, also after a reload', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup();
    let panel = await ready();
    const picker = filePicker(panel);
    expect(picker).toHaveAttribute('accept', 'image/png,image/jpeg,image/gif,image/webp');
    expect(within(panel).getByRole('button', { name: 'Attach images' })).toBeEnabled();
    await user.upload(picker, [png('one.png'), png('two.png')]);
    const row = await within(panel).findByRole('list', { name: 'Attachments' }, patience);
    await waitFor(() => expect(within(row).getAllByRole('img')).toHaveLength(2), patience);
    expect(within(row).getAllByRole('img').map((img) => img.getAttribute('alt'))).toEqual(['one.png', 'two.png']);
    // × takes one off.
    await user.click(within(row).getByRole('button', { name: 'Remove two.png' }));
    expect(within(row).getAllByRole('img')).toHaveLength(1);

    // Images alone can be sent: the text is optional.
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Send' })).toBeEnabled(), patience);
    await user.type(composer(panel), 'What is this?{Enter}');
    await waitFor(() => expect(requests).toHaveLength(1), patience);
    expect(requests[0].text).toBe('What is this?');
    expect(requests[0].images).toEqual([{ mediaType: 'image/png', data: base64 }]);
    expect(draftRow(panel)).not.toBeInTheDocument();
    const sent = await within(panel).findByRole('list', { name: 'Attached to this message' }, patience);
    await waitFor(() => expect(within(sent).getByRole('img', { name: 'one.png' }).getAttribute('src')).toMatch(/^blob:test\//), patience);
    expect(within(sent).queryByRole('button')).not.toBeInTheDocument();

    // After a reload they are read back from the service.
    cleanup();
    panel = await ready();
    const replayed = await within(panel).findByRole('list', { name: 'Attached to this message' }, patience);
    await waitFor(() => expect(within(replayed).getByRole('img', { name: 'one.png' }).getAttribute('src')).toMatch(/^blob:test\//), patience);
  });

  it('attaches a pasted image and leaves pasted text alone', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const panel = await ready();
    fireEvent.paste(composer(panel), { clipboardData: { files: [png('image.png')], getData: () => '' } });
    expect(await within(panel).findByRole('img', { name: 'image.png' }, patience)).toBeInTheDocument();
    const text = fireEvent.paste(composer(panel), { clipboardData: { files: [], getData: () => 'hola' } });
    expect(text).toBe(true); // Not prevented: the browser pastes the text.
    expect(within(draftRow(panel)!).getAllByRole('img')).toHaveLength(1);
  });

  it('takes images dropped anywhere on the chat, with a hint while they are dragged over it', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const panel = await ready();
    const dataTransfer = { types: ['Files'], files: [png('dropped.png')], dropEffect: 'none' };
    fireEvent.dragEnter(within(panel).getByRole('log'), { dataTransfer });
    expect(within(panel).getByText('Drop images to attach them')).toBeInTheDocument();
    fireEvent.dragOver(within(panel).getByRole('log'), { dataTransfer });
    expect(fireEvent.drop(within(panel).getByRole('log'), { dataTransfer })).toBe(false); // Prevented: the file is not opened.
    expect(within(panel).queryByText('Drop images to attach them')).not.toBeInTheDocument();
    expect(await within(panel).findByRole('img', { name: 'dropped.png' }, patience)).toBeInTheDocument();
    // Text dragged inside the page is not taken.
    expect(fireEvent.drop(within(panel).getByRole('log'), { dataTransfer: { types: ['text/plain'], files: [] } })).toBe(true);
  });

  it('says plainly what was left out: other types, over 5 MB, more than five', async () => {
    await call('POST', '/harnesses', { id: 'claude' });
    const user = userEvent.setup({ applyAccept: false });
    const panel = await ready();
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' });
    await user.upload(filePicker(panel), [new File(['x'], 'notes.txt', { type: 'text/plain' }), big, png('ok.png')]);
    expect(await within(panel).findByRole('alert', {}, patience)).toHaveTextContent('“notes.txt” isn\'t a PNG, JPEG, GIF or WebP image. “huge.png” is larger than 5 MB.');
    expect(within(draftRow(panel)!).getAllByRole('img')).toHaveLength(1);
    await user.click(within(within(panel).getByRole('alert')).getByRole('button', { name: 'Dismiss notice' }));
    await user.upload(filePicker(panel), Array.from({ length: 6 }, (_, i) => png(`n${i}.png`)));
    await waitFor(() => expect(within(draftRow(panel)!).getAllByRole('img')).toHaveLength(5), patience);
    expect(within(panel).getByRole('alert')).toHaveTextContent('A message can have up to 5 images.');
  });

  it('says before sending that an agent cannot read images', async () => {
    const store = new AgentStore(new ApiClient(config), () => () => {});
    await store.attach('p', 's1', [png()], 'agy');
    expect(store.getState().drafts['p:s1']).toBeUndefined();
    expect(store.getState().attachNotice['p:s1']).toBe("Antigravity can't read images. Pick another agent to send them.");
  });
});

describe('steps in the chat', () => {
  /** The Studio on scene 1, whose three steps are Inicio, Medio and an untitled one, with the chat hidden. */
  async function studio() {
    await call('POST', '/projects/p/scenes/s1/steps', { id: 'step1b', title: 'Medio', elements: [rect('r3', 30)] });
    await call('POST', '/projects/p/scenes/s1/steps', { id: 'step1c', elements: [rect('r4', 40)] });
    await call('POST', '/harnesses', { id: 'claude' });
    window.history.replaceState(null, '', '#/p/storyboard/s1/step1');
    window.localStorage.setItem('paso.side-panel', 'none');
    render(<App config={config} />);
    const board = await screen.findByRole('main', { name: 'Studio' }, patience);
    const steps = await within(board).findByRole('group', { name: 'Steps of El problema' }, patience);
    await within(steps).findByRole('button', { name: 'Step 3' }, patience);
    await within(steps).findByRole('button', { name: 'Step 2: Medio' }, patience);
    return { board, steps };
  }
  const card = (steps: HTMLElement, name: RegExp) => within(steps).getByRole('button', { name });
  const chips = (panel: HTMLElement) => within(within(panel).getByRole('list', { name: 'Attachments' })).getAllByRole('listitem').map((item) => item.textContent);

  it('adds one step from its card and several selected with ⌘/Ctrl-click and Shift-click, opening the chat; the harness gets their IDs', async () => {
    const user = userEvent.setup();
    const { steps } = await studio();
    expect(screen.queryByRole('complementary', { name: 'Agent' })).not.toBeInTheDocument();

    // One step: its card's own button. The chat opens with the step as a chip.
    await user.hover(card(steps, /^Step 2: Medio/));
    await user.click(within(steps).getByRole('button', { name: 'Add step 2 to chat' }));
    const panel = await screen.findByRole('complementary', { name: 'Agent' }, patience);
    expect(chips(panel)).toEqual(['El problema·02Medio']);
    // The card stayed in the Studio: a plain click there still opens a step, so nothing else was selected.
    expect(within(steps).queryByRole('group', { name: 'Selected steps' })).not.toBeInTheDocument();

    // Several: ⌘-click one, Shift-click to extend the range, and one action adds them all.
    await user.keyboard('{Meta>}');
    await user.click(card(steps, /^Step 1: Inicio/));
    await user.keyboard('{/Meta}');
    expect(card(steps, /^Step 1: Inicio/)).toHaveAccessibleName('Step 1: Inicio, selected');
    expect(screen.getByRole('main', { name: 'Studio' })).toBeInTheDocument(); // Selecting does not open the step.
    await user.keyboard('{Shift>}');
    await user.click(card(steps, /^Step 3/));
    await user.keyboard('{/Shift}');
    const selection = within(steps.parentElement!).getByRole('group', { name: 'Selected steps' });
    expect(selection).toHaveTextContent('3 steps selected');
    // Ctrl-click takes one out again.
    fireEvent.click(card(steps, /^Step 2: Medio/), { ctrlKey: true });
    expect(selection).toHaveTextContent('2 steps selected');
    await user.click(within(selection).getByRole('button', { name: 'Add to chat' }));
    expect(chips(panel)).toEqual(['El problema·02Medio', 'El problema·01Inicio', 'El problema·03Untitled']);
    expect(within(steps.parentElement!).queryByRole('group', { name: 'Selected steps' })).not.toBeInTheDocument();
    // Adding one that is there already does not repeat it.
    await user.click(within(steps).getByRole('button', { name: 'Add step 1 to chat' }));
    expect(chips(panel)).toHaveLength(3);

    // × takes one off; the message goes with the others, as IDs in the turn's context and nothing else.
    await user.click(within(panel).getByRole('button', { name: 'Remove step El problema · 03 Untitled' }));
    await send(panel, user, 'Hazlos más claros');
    await waitFor(() => expect(requests).toHaveLength(1), patience);
    expect(requests[0].text).toBe('Hazlos más claros');
    expect(requests[0].context).toEqual({ projectId: 'p', sceneId: 's1', steps: [{ sceneId: 's1', stepId: 'step1b' }, { sceneId: 's1', stepId: 'step1' }] });
    expect(requests[0].images).toBeUndefined();
    expect(within(panel).queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();

    // The sent message keeps its chips, after a reload too, and a chip opens its step on the Canvas.
    const sent = await within(panel).findByRole('list', { name: 'Attached to this message' }, patience);
    expect(within(sent).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Open step El problema · 02 Medio', 'Open step El problema · 01 Inicio']);
    cleanup();
    window.localStorage.setItem('paso.side-panel', 'agent');
    render(<App config={config} />);
    const again = await screen.findByRole('complementary', { name: 'Agent' }, patience);
    const replayed = await within(again).findByRole('list', { name: 'Attached to this message' }, patience);
    await user.click(within(replayed).getByRole('button', { name: 'Open step El problema · 02 Medio' }));
    expect(await screen.findByRole('main', { name: 'Canvas' }, patience)).toBeInTheDocument();
    expect(window.location.hash).toBe('#/p/canvas/s1/step1b');
  });

  it('selects and adds with the keyboard', async () => {
    const user = userEvent.setup();
    const { steps } = await studio();
    card(steps, /^Step 1: Inicio/).focus();
    // Shift and the arrows extend the selection; ⌘/Ctrl+Space takes one in or out; Escape lets it go, not the Studio.
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}');
    expect(card(steps, /^Step 3/)).toHaveFocus();
    const group = () => within(steps.parentElement!).queryByRole('group', { name: 'Selected steps' });
    expect(group()).toHaveTextContent('3 steps selected');
    await user.keyboard('{Control>} {/Control}');
    expect(group()).toHaveTextContent('2 steps selected');
    await user.keyboard('{Escape}');
    expect(group()).not.toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'Studio' })).toBeInTheDocument();
    await user.keyboard('{Meta>}a{/Meta}');
    expect(group()).toHaveTextContent('3 steps selected');
    // Tab from the card reaches its “Add to chat”, which adds the whole selection.
    await user.tab();
    expect(within(steps).getByRole('button', { name: 'Add step 3 and the 2 other selected steps to chat' })).toHaveFocus();
    await user.keyboard('{Enter}');
    const panel = await screen.findByRole('complementary', { name: 'Agent' }, patience);
    expect(chips(panel)).toEqual(['El problema·01Inicio', 'El problema·02Medio', 'El problema·03Untitled']);
    expect(screen.getByText('3 steps added to the chat.')).toBeInTheDocument();
  });

  it('says on its chip that a step was deleted, and does not send it', async () => {
    const user = userEvent.setup();
    const { steps } = await studio();
    await user.hover(card(steps, /^Step 2: Medio/));
    await user.click(within(steps).getByRole('button', { name: 'Add step 2 to chat' }));
    const panel = await screen.findByRole('complementary', { name: 'Agent' }, patience);
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Send' })).toBeEnabled(), patience);

    const step = await call<StepEnvelope>('GET', '/projects/p/scenes/s1/steps/step1b');
    await call('DELETE', '/projects/p/scenes/s1/steps/step1b', undefined, step.revision);
    const gone = await within(panel).findByRole('img', { name: "step El problema · Medio (deleted, it won't be sent)" }, patience);
    expect(gone).toHaveTextContent('Deleted');
    // A deleted step alone is not a message.
    expect(within(panel).getByRole('button', { name: 'Send' })).toBeDisabled();
    await send(panel, user, 'Solo texto');
    await waitFor(() => expect(requests).toHaveLength(1), patience);
    expect(requests[0].context).toEqual({ projectId: 'p', sceneId: 's1' });
    expect(within(panel).queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });
});
