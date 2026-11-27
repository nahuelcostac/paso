import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../server.js';
import { agyAdapter, agyAgentFile, agyArguments, agyFailureMessage, agyVersionSupported, agyWorkspace, classifyAgyFailure } from './agy.js';
import { agyTranscriptPaths, forgetAgy } from './forget.js';
import type { AgentEvent, AgentRunRequest } from './types.js';
import { fakePath, writeFixture, writeLauncher } from './testing/launcher.js';

// Each test starts real processes: a fake harness and the board MCP. On Windows one turn takes about 2 s, so a test
// with two or three turns needs more than the default 5 s for a whole test.
vi.setConfig({ testTimeout: 30_000 });

let root: string;
let server: Awaited<ReturnType<typeof startServer>>;
let request: AgentRunRequest;
const token = 'agy-test-session-token-with-32-characters';
const fixture = join(import.meta.dirname, 'testing', 'fake-agy.mjs');
const collect = async (text = 'ok', extra: Partial<AgentRunRequest> = {}, signal = new AbortController().signal) => {
  const events: AgentEvent[] = [];
  for await (const e of agyAdapter.run({ ...request, text, ...extra }, signal)) events.push(e);
  return events;
};
const records = async () => (await readFile(join(root, 'records.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const fakeAgy = (env: Record<string, string> = {}) =>
  writeFixture(request.executable, fixture, { ...env, FAKE_RECORD: join(root, 'records.jsonl') });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paso-agy-'));
  server = await startServer({ dataDir: join(root, 'projects'), port: 0, sessionToken: token });
  const api = async (path: string, body: unknown) => fetch(server.url + '/api' + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await api('/projects', { id: 'p', name: 'Prueba' });
  await api('/projects/p/scenes', { id: 's', name: 'Escena' });
  await api('/projects/p/scenes/s/steps', { id: 'st', title: 'Paso' });
  const workDir = join(root, 'work'); await mkdir(workDir);
  request = { executable: fakePath(join(root, 'agy')), workDir, text: 'ok', context: { projectId: 'p', sceneId: 's' },
    board: { serviceUrl: server.url, sessionToken: token, mcp: { command: process.execPath, args: [join(import.meta.dirname, '../../../mcp/dist/cli.js')] } },
    limits: { idleTimeoutMs: 5000, maxRunMs: 15000 } };
  await fakeAgy();
});
afterEach(async () => { await server?.close(); await rm(root, { recursive: true, force: true }); });

describe('agy adapter with a simulated harness and real board MCP', () => {
  it('streams text, board tool targets and results without exposing arguments', async () => {
    const events = await collect();
    expect(events[0]).toEqual({ type: 'session', resumeToken: 'fake-agy-conversation' });
    expect(events).toContainEqual({ type: 'text_delta', text: 'Ho' });
    expect(events).toContainEqual({ type: 'text', text: 'Hola' });
    expect(events).toContainEqual({ type: 'text', text: 'Listo.' });
    expect(events).toContainEqual({ type: 'tool_use', id: 'fake-agy-conversation:2', tool: 'read_step', readOnly: true, target: { projectId: 'p', sceneId: 's', stepId: 'st' } });
    expect(events).toContainEqual({ type: 'tool_result', id: 'fake-agy-conversation:2', ok: true });
    expect(events).toContainEqual({ type: 'tool_use', id: 'fake-agy-conversation:3', tool: 'add_elements', readOnly: false, target: { projectId: 'p', sceneId: 's', stepId: 'st' } });
    expect(events).toContainEqual({ type: 'tool_result', id: 'fake-agy-conversation:3', ok: false });
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'completed' });
    expect(events.filter((e) => e.type === 'finished' || e.type === 'failed')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('invalid');
    // The board server the agent file names really ran, with the token it inherited from agy's environment.
    const board = (await records()).find((r) => r.readResult);
    expect(board.readResult.isError).toBeFalsy();
    expect(board.badResult.isError).toBe(true);
  });

  it('runs the board-only agent from its own workspace and gives the token only through the environment', async () => {
    const source = { ...process.env, ANTHROPIC_API_KEY: 'secret-key', GEMINI_API_KEY: 'gemini-key' };
    process.env.ANTHROPIC_API_KEY = source.ANTHROPIC_API_KEY; process.env.GEMINI_API_KEY = source.GEMINI_API_KEY;
    try { await collect('prompt; $(touch /tmp/unsafe)'); } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.GEMINI_API_KEY; }
    const [call, input] = await records();
    expect(await realpath(call.cwd)).toBe(await realpath(agyWorkspace(request.workDir)));
    expect(await readdir(request.workDir)).toEqual([]);
    expect(call.args).toEqual(agyArguments({}));
    expect(call.args).toEqual([
      '--agent', 'paso-board',
      '--settings', JSON.stringify({ permissions: { allow: ['mcp(paso/*)'], deny: ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)'] } }),
      '--disable-slash-commands', '--input-format', 'stream-json', '--output-format', 'stream-json', '-p=',
    ]);
    expect(call.args).not.toContain('--dangerously-skip-permissions');
    expect(call.args.join(' ')).not.toContain(token);
    expect(call.env.PASO_SESSION_TOKEN).toBe(token);
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.env.GEMINI_API_KEY).toBeUndefined();
    // The message is written only after agy said it runs Paso's agent, and only as content.
    expect(input.early).toBe(false);
    expect(JSON.parse(input.stdin).message.content).toEqual([{ type: 'text', text: '[Paso] You are working in the project "p", scene "s" (service IDs).\n\nprompt; $(touch /tmp/unsafe)' }]);
    const agent = await readFile(join(agyWorkspace(request.workDir), '.agents', 'agents', 'paso-board.md'), 'utf8');
    expect(agent).toBe(agyAgentFile(request));
    for (const line of ['tools: []', 'excludeDefaultComponents: true', 'inheritCustomizations: false', 'inheritMcp: false', 'subagent: false', '  - name: paso']) {
      expect(agent.split('\n')).toContain(line);
    }
    expect(agent).not.toContain(token);
    expect(agent).toContain("in the language of the user's message");
    expect(await readdir(join(agyWorkspace(request.workDir), '.agents', 'agents'))).toEqual(['paso-board.md']);
  });

  it('writes paths that YAML cannot misread', () => {
    const file = agyAgentFile({ board: { ...request.board, mcp: { command: '/odd: path/"node"', args: ['--x', 'a: b # c'] } } });
    expect(file).toContain('    command: "/odd: path/\\"node\\""');
    expect(file).toContain('    args: ["--x","a: b # c"]');
  });

  it('resumes the same conversation and passes the model and effort only when set', async () => {
    const events = await collect('ok', { resumeToken: 'fake-agy-conversation', model: 'gemini-3.8-flash', effort: 'high' });
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'completed' });
    const [call] = await records();
    expect(call.args).toEqual(expect.arrayContaining(['--conversation', 'fake-agy-conversation', '--model', 'gemini-3.8-flash', '--effort', 'high']));
    expect(call.args.at(-1)).toBe('-p=');
  });

  it('refuses a resumed session that comes back as another conversation', async () => {
    await fakeAgy({ FAKE_AGY_CONVERSATION: 'other' });
    expect((await collect('ok', { resumeToken: 'fake-agy-conversation' })).at(-1)).toMatchObject({ type: 'failed', code: 'protocol' });
    expect((await records()).some((r) => r.stdin !== undefined)).toBe(false);
  });

  it('never sends the message to a session that is not running the Paso agent', async () => {
    await fakeAgy({ FAKE_AGY_AGENT: '' });
    const events = await collect();
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'unsafe_configuration' });
    expect(events.some((e) => e.type === 'session')).toBe(false);
    expect((await records()).some((r) => r.stdin !== undefined)).toBe(false);
  });

  it.each([
    ['signed-out', 'signed_out'], ['quota', 'quota'], ['model', 'model_unavailable'], ['crash', 'crashed'], ['protocol', 'protocol'],
    ['unsafe-tool', 'unsafe_configuration'], ['other-server', 'unsafe_configuration'], ['unknown-board-tool', 'unsafe_configuration'],
    ['manage-task', 'unsafe_configuration'], ['other-prefix', 'unsafe_configuration'],
  ])('maps %s to %s and stops the process', async (scenario, code) => {
    const events = await collect(scenario);
    expect(events.at(-1)).toMatchObject({ type: 'failed', code, message: agyFailureMessage(code as never) });
    expect(events.filter((e) => e.type === 'failed' || e.type === 'finished')).toHaveLength(1);
    expect(events.some((e) => e.type === 'tool_use')).toBe(false);
  });

  it('says quota and sign-in problems in words a person can act on', () => {
    expect(classifyAgyFailure('RESOURCE_EXHAUSTED (code 429): Individual quota reached')).toBe('quota');
    expect(classifyAgyFailure("Error: authentication required. Run 'agy' to log in, then retry.")).toBe('signed_out');
    expect(classifyAgyFailure('error: unknown agent "paso-board" (no custom agents are available)')).toBe('unsupported_version');
    expect(agyFailureMessage('quota')).toMatch(/usage limit of your Antigravity plan/);
    expect(agyFailureMessage('signed_out')).toMatch(/Run "agy" in a terminal, sign in/);
  });

  it('refuses an agent file the CLI cannot load, without falling back', async () => {
    await writeLauncher(request.executable, `
      if (process.argv[2] === '--version') console.log('1.5.16');
      else {
        console.error('error: unknown agent "paso-board" (no custom agents are available)');
        process.exitCode = 1;
      }`);
    expect((await collect()).at(-1)).toMatchObject({ type: 'failed', code: 'unsupported_version' });
  });

  it('rejects a version older than the verified one before starting a turn', async () => {
    await fakeAgy({ FAKE_AGY_VERSION: '1.5.15' });
    expect((await collect()).at(-1)).toMatchObject({ type: 'failed', code: 'unsupported_version' });
    await expect(readFile(join(root, 'records.jsonl'), 'utf8')).rejects.toThrow();
    expect(agyVersionSupported('1.5.16')).toBe(true);
    expect(agyVersionSupported('1.6.0')).toBe(true);
    expect(agyVersionSupported('2.0.0')).toBe(true);
    expect(agyVersionSupported('1.5.3')).toBe(false);
    expect(agyVersionSupported(null)).toBe(false);
  });

  it('refuses a workspace replaced by a link', async () => {
    const elsewhere = join(root, 'elsewhere'); await mkdir(elsewhere);
    await symlink(elsewhere, agyWorkspace(request.workDir), 'junction');
    expect((await collect()).at(-1)).toMatchObject({ type: 'failed', code: 'unsafe_configuration' });
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('does not take images', () => {
    expect(agyAdapter.acceptsImages).toBe(false);
  });

  it('maps a missing executable', async () => {
    expect((await collect('ok', { executable: join(root, 'missing') })).at(-1)).toMatchObject({ type: 'failed', code: 'not_installed' });
  });

  it('cancels the harness and its child process before the terminal event', async () => {
    const controller = new AbortController();
    const result = collect('tree', {}, controller.signal);
    let pid: number | undefined;
    for (let i = 0; i < 200 && !pid; i++) {
      try { pid = (await records()).find((r) => r.child)?.child; } catch { /* not started yet */ }
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pid).toBeTypeOf('number'); controller.abort();
    expect((await result).at(-1)).toEqual({ type: 'finished', reason: 'cancelled' });
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it('times out an idle harness', async () => {
    expect((await collect('hang', { limits: { idleTimeoutMs: 600, maxRunMs: 5000 } })).at(-1)).toMatchObject({ type: 'failed', code: 'timeout' });
  });

  it('forgets only the files named after the deleted conversation', async () => {
    const env = { HOME: join(root, 'home') };
    const data = join(env.HOME, '.gemini', 'antigravity-cli');
    const id = '751c60d2-5451-4301-a1f2-cef3f9bb597f', other = '012a5581-1bb2-44ca-8421-8815036624b5';
    for (const folder of ['conversations', 'presence', join('brain', id, '.system_generated'), join('brain', other)]) await mkdir(join(data, folder), { recursive: true });
    for (const name of [`${id}.db`, `${id}.pb`, `${other}.db`]) await writeFile(join(data, 'conversations', name), '');
    await writeFile(join(data, 'presence', `${id}.lock`), '');
    expect(agyTranscriptPaths('../../etc/passwd', env)).toEqual([]);
    await forgetAgy(id, env);
    expect(await readdir(join(data, 'conversations'))).toEqual([`${other}.db`]);
    expect(await readdir(join(data, 'presence'))).toEqual([]);
    expect(await readdir(join(data, 'brain'))).toEqual([other]);
  });
});
