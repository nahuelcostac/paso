import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fakePath, writeFixture } from './testing/launcher.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer, type AgentOptions } from '../server.js';
import { agyAdapter, agyInput } from './agy.js';
import { claudeArguments } from './claude.js';
import { codexAdapter } from './codex.js';
import { maxSteps, parseStepAttachments } from './steps.js';
import { describeSteps } from './where.js';
import type { AgentEvent, AgentRunRequest, HarnessAdapter } from './types.js';

// Each test starts real processes: a fake harness and the board MCP. On Windows one turn takes about 2 s, so a test
// with two or three turns needs more than the default 5 s for a whole test.
vi.setConfig({ testTimeout: 30_000 });

const token = 'steps-to-chat-test-token-with-at-least-32-characters';
const fakeClaude = join(import.meta.dirname, 'testing', 'fake-claude.mjs');
const fakeCodex = join(import.meta.dirname, 'testing', 'fake-codex.mjs');
const fakeAgy = join(import.meta.dirname, 'testing', 'fake-agy.mjs');
type Service = Awaited<ReturnType<typeof startServer>>;
let root: string;
let service: Service;

async function start(agent: AgentOptions = {}) {
  service = await startServer({
    dataDir: join(root, 'projects'), port: 0, sessionToken: token,
    harnessDetection: { searchPaths: [join(root, 'bin')], loginShell: false, timeoutMs: 2000 },
    agent: { mcp: { entry: '/fake/mcp/cli.js' }, idleTimeoutMs: 5000, maxRunMs: 20_000, ...agent },
  });
}
async function api(path: string, method = 'GET', payload?: unknown, revision?: string) {
  const res = await fetch(service.url + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(revision ? { 'If-Match': `"${revision}"` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
}
/** A project with two scenes: “Intro” with three steps and “Final” with one. */
async function project(id = 'p', name = 'Prueba') {
  await api('/api/projects', 'POST', { id, name });
  await api(`/api/projects/${id}/scenes`, 'POST', { id: `${id}-intro`, name: 'Intro' });
  for (const [step, title] of [['a', 'Entrada'], ['b', 'Proceso'], ['c', '']]) {
    await api(`/api/projects/${id}/scenes/${id}-intro/steps`, 'POST', { id: `${id}-${step}`, ...(title ? { title } : {}) });
  }
  await api(`/api/projects/${id}/scenes`, 'POST', { id: `${id}-final`, name: 'Final' });
  await api(`/api/projects/${id}/scenes/${id}-final/steps`, 'POST', { id: `${id}-z`, title: 'Cierre' });
  return id;
}
async function session(projectId: string, sceneId?: string, harness = 'claude') {
  const created = await api('/api/agent/sessions', 'POST', { harness, projectId, ...(sceneId ? { sceneId } : {}) });
  expect(created.status).toBe(201);
  return created.data.id as string;
}
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function finish(id: string, runId: string) {
  const events = await waitFor(async () => {
    const all = (await api(`/api/agent/sessions/${id}/events`)).data.events as { runId: string; event: AgentEvent }[];
    const mine = all.filter((e) => e.runId === runId).map((e) => e.event);
    return mine.some((e) => e.type === 'finished' || e.type === 'failed') ? mine : undefined;
  }, 'the run to end');
  await waitFor(async () => (await api(`/api/agent/sessions/${id}`)).data.state === 'idle' || undefined, 'idle');
  return events;
}
const runs = () => (existsSync(join(root, 'runs.jsonl')) ? readFileSync(join(root, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; stdin: string }) : []);
const systemPrompt = (argv: string[]) => argv[argv.indexOf('--append-system-prompt') + 1];
const step = (stepId: string) => ({ kind: 'step', stepId });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paso-steps-'));
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFixture(fakePath(join(root, 'bin', 'claude')), fakeClaude, { FAKE_DIR: root });
  await start();
});
afterEach(async () => {
  await service.close();
  await rm(root, { recursive: true, force: true });
});

describe('steps attached to a message', () => {
  it('reach the harness as IDs in the turn context, said in its instructions, with no path or file', async () => {
    const p = await project();
    const id = await session(p, 'p-intro');
    const sent = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'Make these bolder', attachments: [step('p-b'), step('p-c')] });
    expect(sent.status).toBe(202);
    // The service names each step from the project itself: its scene, place and title as they are now.
    expect(sent.data.attachments).toEqual([
      { id: 'p-b', kind: 'step', sceneId: 'p-intro', stepId: 'p-b', number: 2, sceneName: 'Intro', title: 'Proceso' },
      { id: 'p-c', kind: 'step', sceneId: 'p-intro', stepId: 'p-c', number: 3, sceneName: 'Intro' },
    ]);
    const events = await finish(id, sent.data.runId);
    expect(events[1]).toEqual({ type: 'message', text: 'Make these bolder', attachments: sent.data.attachments });

    const [call] = runs();
    const prompt = systemPrompt(call.argv);
    expect(prompt).toContain('You are working in the project "p", scene "p-intro" (service IDs).');
    expect(prompt).toContain('The person attached 2 steps to this message: step "p-b" in scene "p-intro", step "p-c" in scene "p-intro".');
    expect(prompt).toContain('Work on those steps with the board tools');
    // The message itself is the person's text only: the steps travel in the context.
    expect(JSON.parse(call.stdin.split('\n')[0]).message.content).toBe('Make these bolder');
    for (const part of [call.stdin, ...call.argv]) {
      expect(part).not.toContain(root);
      expect(part).not.toContain('.json');
      expect(part).not.toContain('Proceso'); // The title is the person's text, not an instruction.
    }

    // The next message without steps says nothing of them.
    const next = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'Thanks' });
    await finish(id, next.data.runId);
    expect(systemPrompt(runs()[1].argv)).not.toContain('attached');

    // The history keeps them, after a restart too.
    await service.close();
    await start();
    const replay = (await api(`/api/agent/sessions/${id}/events`)).data.events as { event: AgentEvent }[];
    expect(replay.find((entry) => entry.event.type === 'message')?.event).toEqual({ type: 'message', text: 'Make these bolder', attachments: sent.data.attachments });
  });

  it('may be sent alone, with images, and from another scene of the project; each step goes once', async () => {
    const p = await project();
    const id = await session(p, 'p-intro');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
    const sent = await api(`/api/agent/sessions/${id}/messages`, 'POST', {
      text: '', attachments: [step('p-z'), { kind: 'image', mediaType: 'image/png', data: png.toString('base64') }, step('p-z')],
    });
    expect(sent.status).toBe(202);
    expect((sent.data.attachments as { kind: string }[]).map((item) => item.kind)).toEqual(['step', 'image']);
    await finish(id, sent.data.runId);
    expect(systemPrompt(runs()[0].argv)).toContain('The person attached a step to this message: step "p-z" in scene "p-final". Work on that step');
    expect((await api(`/api/agent/sessions/${id}`)).data.title).toBe('Step');
  });

  it('are refused, and nothing is sent, when a step is gone or belongs elsewhere', async () => {
    const p = await project();
    await project('q', 'Otro');
    const id = await session(p, 'p-intro');
    const send = (attachments: unknown) => api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'Hola', attachments });
    // A step deleted after it was attached.
    const doomed = await api('/api/projects/p/scenes/p-intro/steps/p-a');
    expect((await api('/api/projects/p/scenes/p-intro/steps/p-a', 'DELETE', undefined, doomed.data.revision)).status).toBe(204);
    const cases: [unknown, number, string][] = [
      [[step('p-a')], 422, 'STEP_NOT_FOUND'],
      [[step('p-b'), step('p-a')], 422, 'STEP_NOT_FOUND'], // One gone refuses the whole message.
      [[step('q-a')], 422, 'STEP_NOT_FOUND'], // A step of another project.
      [[step('../p-b')], 400, 'INVALID_ATTACHMENT'],
      [[{ kind: 'step' }], 400, 'INVALID_ATTACHMENT'],
      [[{ kind: 'step', stepId: 'p-b/../../etc' }], 400, 'INVALID_ATTACHMENT'],
      [Array.from({ length: maxSteps + 1 }, (_, i) => step(`s${i}`)), 400, 'TOO_MANY_STEPS'],
    ];
    for (const [attachments, status, code] of cases) {
      const reply = await send(attachments);
      expect([reply.status, reply.data.error.code], JSON.stringify(attachments).slice(0, 80)).toEqual([status, code]);
    }
    expect(runs()).toEqual([]);
    expect((await api(`/api/agent/sessions/${id}/events`)).data.events).toEqual([]);
  });

  it('in a loose diagram, must be steps of that diagram', async () => {
    await api('/api/projects/_loose/scenes', 'POST', { id: 'one', name: 'Uno' });
    await api('/api/projects/_loose/scenes/one/steps', 'POST', { id: 'one-a' });
    await api('/api/projects/_loose/scenes', 'POST', { id: 'two', name: 'Dos' });
    await api('/api/projects/_loose/scenes/two/steps', 'POST', { id: 'two-a' });
    const id = await session('_loose', 'one');
    const other = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'Hola', attachments: [step('two-a')] });
    expect([other.status, other.data.error.code]).toEqual([422, 'STEP_NOT_FOUND']);
    const own = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'Hola', attachments: [step('one-a')] });
    expect(own.status).toBe(202);
    await finish(id, own.data.runId);
    expect(systemPrompt(runs()[0].argv)).toContain('step "one-a" in scene "one"');
  });

  it('are handed to the adapter in the request context, exactly as resolved', async () => {
    const seen: AgentRunRequest[] = [];
    const recording: HarnessAdapter = {
      id: 'claude',
      async *run(request) { seen.push(request); yield { type: 'finished', reason: 'completed' }; },
    };
    await service.close();
    await start({ adapters: { claude: recording } });
    const p = await project();
    const id = await session(p, 'p-intro');
    const sent = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'Go', attachments: [step('p-c'), step('p-a')] });
    await finish(id, sent.data.runId);
    expect(seen[0].context).toEqual({ projectId: 'p', sceneId: 'p-intro', steps: [{ sceneId: 'p-intro', stepId: 'p-c' }, { sceneId: 'p-intro', stepId: 'p-a' }] });
    expect(seen[0].text).toBe('Go');
    expect(seen[0].images).toBeUndefined();
  });
});

describe('steps in the instructions', () => {
  it('are said only when there are some', () => {
    expect(describeSteps(undefined)).toBe('');
    expect(describeSteps([])).toBe('');
    const base = { executable: 'claude', workDir: '/w', text: '', board: { serviceUrl: 'http://127.0.0.1:1', sessionToken: 't', mcp: { command: 'node', args: [] } }, limits: { idleTimeoutMs: 1, maxRunMs: 1 } };
    const without = systemPrompt(claudeArguments({ ...base, context: { projectId: 'p', sceneId: 's' } }));
    const withSteps = systemPrompt(claudeArguments({ ...base, context: { projectId: 'p', sceneId: 's', steps: [{ sceneId: 's', stepId: 'x' }] } }));
    expect(withSteps.startsWith(without)).toBe(true);
    expect(withSteps.slice(without.length)).toBe(' The person attached a step to this message: step "x" in scene "s". Work on that step with the board tools, and leave the other steps as they are unless the message asks for more.');
  });
  it('take only step IDs from the client', () => {
    expect(parseStepAttachments([step('a'), step('b'), step('a')])).toEqual(['a', 'b']);
    expect(() => parseStepAttachments([{ kind: 'step', stepId: 'a b' }])).toThrow();
  });
  it('reach Codex in its developer instructions', async () => {
    const record = join(root, 'records.jsonl');
    const executable = await writeFixture(fakePath(join(root, 'codex')), fakeCodex, { FAKE_RECORD: record });
    await project();
    const workDir = join(root, 'work'); await mkdir(workDir);
    const request: AgentRunRequest = {
      executable, workDir, text: 'ok', context: { projectId: 'p', sceneId: 'p-intro', steps: [{ sceneId: 'p-intro', stepId: 'p-b' }] },
      board: { serviceUrl: service.url, sessionToken: token, mcp: { command: process.execPath, args: [join(import.meta.dirname, '../../../mcp/dist/cli.js')] } },
      limits: { idleTimeoutMs: 5000, maxRunMs: 15000 },
    };
    const events: AgentEvent[] = [];
    for await (const event of codexAdapter.run(request, new AbortController().signal)) events.push(event);
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'completed' });
    const thread = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((r) => r.method === 'thread/start');
    expect(thread.params.developerInstructions).toContain('The person attached a step to this message: step "p-b" in scene "p-intro".');
  });
  it('reach Antigravity in its turn prefix, with or without text', async () => {
    const stepOnly = JSON.parse(agyInput({ text: '', context: { projectId: 'p', sceneId: 'p-intro', steps: [{ sceneId: 'p-intro', stepId: 'p-b' }] } }));
    expect(stepOnly.message.content).toEqual([{
      type: 'text',
      text: '[Paso] You are working in the project "p", scene "p-intro" (service IDs). The person attached a step to this message: step "p-b" in scene "p-intro". Work on that step with the board tools, and leave the other steps as they are unless the message asks for more.',
    }]);
    const record = join(root, 'agy-records.jsonl');
    const executable = await writeFixture(fakePath(join(root, 'agy')), fakeAgy, { FAKE_RECORD: record });
    await project();
    const workDir = join(root, 'agy-work'); await mkdir(workDir);
    const request: AgentRunRequest = {
      executable, workDir, text: 'ok', context: { projectId: 'p', sceneId: 'p-intro', steps: [{ sceneId: 'p-intro', stepId: 'p-b' }] },
      board: { serviceUrl: service.url, sessionToken: token, mcp: { command: process.execPath, args: [join(import.meta.dirname, '../../../mcp/dist/cli.js')] } },
      limits: { idleTimeoutMs: 5000, maxRunMs: 15000 },
    };
    const events: AgentEvent[] = [];
    for await (const event of agyAdapter.run(request, new AbortController().signal)) events.push(event);
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'completed' });
    const input = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((r) => r.stdin !== undefined);
    const text = JSON.parse(input.stdin).message.content[0].text as string;
    expect(text).toContain('The person attached a step to this message: step "p-b" in scene "p-intro".');
    expect(text.endsWith('\n\nok')).toBe(true);
  });
});
