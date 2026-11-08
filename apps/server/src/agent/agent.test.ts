import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type AgentOptions } from '../server.js';
import { ClaudeStream, claudeArguments, classifyClaudeFailure } from './claude.js';
import { harnessEnvironment } from './process.js';
import { checkWorkDir } from './sessions.js';
import type { AgentEvent, AgentRunHooks } from './types.js';

const token = 'test-session-token-with-at-least-32-characters';
const fixture = join(import.meta.dirname, 'testing', 'fake-claude.mjs');
type Service = Awaited<ReturnType<typeof startServer>>;
let root: string;
let service: Service;
let secretsInEnvironment: Record<string, string | undefined>;
const polluted = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outer-session', ANTHROPIC_API_KEY: 'sk-ant-LEAK', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-LEAK', OPENAI_API_KEY: 'sk-LEAK', T3CODE_THREAD_ID: 'thread' };

async function install(id = 'claude') {
  await mkdir(join(root, 'bin'), { recursive: true });
  const file = join(root, 'bin', id);
  await writeFile(file, `#!/bin/sh\nFAKE_DIR='${root}' exec '${process.execPath}' '${fixture}' "$@"\n`);
  await chmod(file, 0o755);
}
async function start(agent: AgentOptions = {}) {
  service = await startServer({
    dataDir: join(root, 'projects'), port: 0, sessionToken: token,
    harnessDetection: { searchPaths: [join(root, 'bin')], loginShell: false, timeoutMs: 2000 },
    agent: { mcp: { entry: '/fake/mcp/cli.js' }, idleTimeoutMs: 5000, maxRunMs: 20_000, ...agent },
  });
}
async function api(path: string, method = 'GET', payload?: unknown, authenticated = true) {
  const res = await fetch(service.url + path, {
    method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
}
async function project(name = 'Prueba', scene = true) {
  const created = await api('/api/projects', 'POST', { name });
  const id = created.data.document.id as string;
  if (scene) await api(`/api/projects/${id}/scenes`, 'POST', { name: 'Escena', id: 's1' });
  return id;
}
async function session(projectId: string, extra: Record<string, unknown> = {}) {
  const created = await api('/api/agent/sessions', 'POST', { harness: 'claude', projectId, ...extra });
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
/** Sends a message and returns the events of that run, ending with its terminal event. */
async function run(id: string, text: string) {
  const sent = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text });
  expect(sent.status).toBe(202);
  const runId = sent.data.runId as string;
  const events = await waitFor(async () => {
    const all = (await api(`/api/agent/sessions/${id}/events`)).data.events as { runId: string; event: AgentEvent }[];
    const mine = all.filter((e) => e.runId === runId).map((e) => e.event);
    return mine.some((e) => e.type === 'finished' || e.type === 'failed') ? mine : undefined;
  }, 'the run to end');
  // The session is idle again shortly after its terminal event (after the run hooks).
  await waitFor(async () => (await api(`/api/agent/sessions/${id}`)).data.state === 'idle' || undefined, 'idle');
  return { runId, events, end: events.at(-1)! };
}
const runs = () => (existsSync(join(root, 'runs.jsonl')) ? readFileSync(join(root, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string>; cwd: string; stdin: string; pid: number }) : []);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paso-agent-'));
  secretsInEnvironment = Object.fromEntries(Object.keys(polluted).map((k) => [k, process.env[k]]));
  Object.assign(process.env, polluted);
  await install();
  await start();
});
afterEach(async () => {
  await service.close();
  for (const [key, value] of Object.entries(secretsInEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
});

describe('Claude Code session: arguments, environment and isolation', () => {
  it('passes exactly the board-only arguments, keeps text and token out of argv and cleans the environment', async () => {
    const p = await project();
    const id = await session(p, { sceneId: 's1' });
    const text = 'Dibuja una caja; $(touch /tmp/pwned) `id` "quotes" --model evil -p';
    const { end } = await run(id, text);
    expect(end).toEqual({ type: 'finished', reason: 'completed' });
    const [call] = runs();
    const mcpIndex = call.argv.indexOf('--mcp-config');
    const mcp = JSON.parse(call.argv[mcpIndex + 1]);
    expect(mcp).toEqual({ mcpServers: { paso: { type: 'stdio', command: process.execPath, args: ['/fake/mcp/cli.js'], env: { PASO_SERVICE_URL: '${PASO_SERVICE_URL}', PASO_SESSION_TOKEN: '${PASO_SESSION_TOKEN}' } } } });
    // The complete list, in order. Anything added or loosened must change this test.
    expect(call.argv.map((a, i) => i === mcpIndex + 1 ? '<mcp>' : a.startsWith('Eres el asistente') ? '<prompt>' : a)).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '',
      '--strict-mcp-config', '--mcp-config', '<mcp>',
      '--allowedTools', 'mcp__paso__*',
      '--disallowedTools', 'Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
      'Agent', 'Task', 'Skill', 'Monitor', 'ToolSearch', 'RemoteTrigger', 'CronCreate', 'EnterWorktree',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--append-system-prompt', '<prompt>',
    ]);
    for (const forbidden of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions', '--model', '--resume', '--no-session-persistence', '--add-dir', '--settings', '--plugin-dir']) {
      expect(call.argv).not.toContain(forbidden);
    }
    // The prompt names the project and scene as data; the user's text is only on stdin.
    expect(call.argv.join('\n')).not.toContain(token);
    expect(call.argv.join('\n')).not.toContain('pwned');
    expect(call.argv.join('\n')).toContain(p);
    expect(JSON.parse(call.stdin.split('\n')[0])).toEqual({ type: 'user', message: { role: 'user', content: text } });
    // Environment: the token only through the environment, nothing from the outer agent or API keys.
    expect(call.env.PASO_SESSION_TOKEN).toBe(token);
    expect(call.env.PASO_SERVICE_URL).toBe(service.url);
    for (const name of Object.keys(polluted)) expect(call.env[name]).toBeUndefined();
    expect(Object.values(call.env).join('\n')).not.toMatch(/LEAK/);
    expect(call.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    expect(call.env.HOME).toBe(process.env.HOME);
    // A neutral, empty working directory that is not the repository or the home folder.
    expect(await realpath(call.cwd)).toBe(await realpath(join(root, 'agent-workspace')));
    expect(await realpath(call.cwd)).not.toBe(await realpath(homedir()));
    expect((await stat(call.cwd)).mode & 0o777).toBe(0o700);
  });
  it('passes the model only when requested, validates it, and uses the stored token to resume', async () => {
    const p = await project();
    const plain = await session(p);
    await run(plain, 'hola');
    expect(runs()[0].argv).not.toContain('--model');
    expect((await api('/api/agent/sessions', 'POST', { harness: 'claude', projectId: p, model: '--evil' })).status).toBe(400);
    expect((await api('/api/agent/sessions', 'POST', { harness: 'claude', projectId: p, model: 'a b' })).status).toBe(400);
    const withModel = await session(p, { model: 'haiku' });
    await run(withModel, 'hola');
    const argv = runs()[1].argv;
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
    expect(argv).not.toContain('claude-fable-5-1');
    // Second turn of the same session continues the conversation the first one reported.
    const { events } = await run(withModel, 'otra vez');
    const session1 = (events.find((e) => e.type === 'session') as Extract<AgentEvent, { type: 'session' }>).resumeToken;
    expect(session1).toMatch(/^fake-session-/);
    const second = runs()[2].argv;
    expect(second[second.indexOf('--resume') + 1]).toBe(session1);
  });
  it('builds the same arguments without a scene and with browser support', () => {
    const args = claudeArguments({ context: { projectId: 'p' }, board: { serviceUrl: 'http://127.0.0.1:1', sessionToken: 'x'.repeat(40), mcp: { command: 'node', args: ['a'], browserExecutable: '/b' } } });
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.paso.env.PASO_MCP_BROWSER_EXECUTABLE).toBe('${PASO_MCP_BROWSER_EXECUTABLE}');
    expect(args.join(' ')).not.toContain('x'.repeat(40));
  });
  it('whitelists the harness environment', () => {
    const env = harnessEnvironment({ A: '1' }, { PATH: '/bin', HOME: '/h', USER: 'u', LC_ALL: 'C', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', AWS_SECRET_ACCESS_KEY: 's', HTTPS_PROXY: 'p' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', USER: 'u', LC_ALL: 'C', HTTPS_PROXY: 'p', A: '1' });
  });
  it('refuses unsafe work directories', () => {
    expect(() => checkWorkDir(homedir(), '/data/projects')).toThrow();
    expect(() => checkWorkDir(process.cwd(), '/data/projects')).toThrow();
    expect(() => checkWorkDir('/data/projects/agent', '/data/projects')).toThrow();
    expect(() => checkWorkDir('/data', '/data/projects')).toThrow();
    expect(checkWorkDir('/data/agent-workspace', '/data/projects')).toBe('/data/agent-workspace');
  });
  it('does not run when the working directory is not empty', async () => {
    await mkdir(join(root, 'agent-workspace'));
    await writeFile(join(root, 'agent-workspace', 'notes.txt'), 'x');
    const { end } = await run(await session(await project()), 'hola');
    expect(end).toMatchObject({ type: 'failed', code: 'unsafe_configuration' });
    expect(runs()).toHaveLength(0);
  });
});

describe('event normalization', () => {
  it('turns Claude output into normalized events without arguments, results or Claude fields', async () => {
    const { events } = await run(await session(await project()), 'SCENARIO:ok');
    // The replay log leaves out text_delta (the live stream has them, see the WebSocket test).
    expect(events.map((e) => e.type)).toEqual(['started', 'session', 'text', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'text', 'finished']);
    expect(events[1]).toMatchObject({ type: 'session', resumeToken: expect.stringMatching(/^fake-session-/), model: 'fake-model' });
    expect(events[3]).toEqual({ type: 'tool_use', id: 't1', tool: 'read_step', readOnly: true, target: { projectId: 'p1', sceneId: 's1', stepId: 'st1' } });
    expect(events[4]).toEqual({ type: 'tool_result', id: 't1', ok: true });
    expect(events[5]).toMatchObject({ type: 'tool_use', tool: 'add_elements', readOnly: false });
    expect(events[6]).toEqual({ type: 'tool_result', id: 't2', ok: false });
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'completed' });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/ARGUMENT-SECRET|RESULT-SECRET|mcp__|session_id|stream_event/);
  });
  it('copes with split lines, noise, unknown message types and a missing final newline', async () => {
    const { events } = await run(await session(await project()), 'SCENARIO:partial');
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'Partido ✓' }]);
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'completed' });
  });
  it('fails clearly on output that is not a protocol', async () => {
    const { end } = await run(await session(await project()), 'SCENARIO:malformed');
    expect(end).toMatchObject({ type: 'failed', code: 'protocol', message: expect.stringContaining('Claude Code') });
  });
  it('ignores sub-agent traffic and treats API errors as failures, not speech', () => {
    const stream = new ClaudeStream();
    expect(stream.line(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'hidden' }] } }))).toEqual([]);
    expect(stream.line(JSON.stringify({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'limit' }] } }))).toEqual([]);
    expect(stream.line(JSON.stringify({ type: 'result', is_error: true }))).toEqual([{ type: 'failed', code: 'quota', message: expect.any(String) }]);
  });
  it('classifies failures from what Claude says', () => {
    expect(classifyClaudeFailure({ apiError: 'authentication_failed' })).toBe('signed_out');
    expect(classifyClaudeFailure({ text: 'Please run /login' })).toBe('signed_out');
    expect(classifyClaudeFailure({ text: "You've hit your limit · resets 3pm" })).toBe('quota');
    expect(classifyClaudeFailure({ limitRejected: true })).toBe('quota');
    expect(classifyClaudeFailure({ httpStatus: 429 })).toBe('quota');
    expect(classifyClaudeFailure({ text: 'There is an issue with the selected model. It may not exist' })).toBe('model_unavailable');
    expect(classifyClaudeFailure({ stderr: "error: unknown option '--x'" })).toBe('unsupported_version');
    expect(classifyClaudeFailure({ text: 'something odd' })).toBe('harness_error');
  });
});

describe('failures surface as failed events with Spanish messages', () => {
  it.each([
    ['signed-out', 'signed_out', /sesión/], ['quota', 'quota', /límite/], ['model', 'model_unavailable', /modelo/],
    ['crash', 'crashed', /inesperada/], ['silent-exit', 'crashed', /inesperada/], ['unknown-flag', 'unsupported_version', /Actualiza/],
  ] as const)('%s -> %s', async (scenario, code, message) => {
    const { end } = await run(await session(await project()), `SCENARIO:${scenario}`);
    expect(end).toMatchObject({ type: 'failed', code });
    expect((end as { message: string }).message).toMatch(message);
  });
  it('never forwards stderr or harness error text to the client', async () => {
    const { events } = await run(await session(await project()), 'SCENARIO:crash');
    expect(JSON.stringify(events)).not.toContain('internal failure');
    const quota = await run(await session(await project('Otro')), 'SCENARIO:quota');
    expect(JSON.stringify(quota.events)).not.toContain('resets');
  });
  it('stops a harness that hangs', async () => {
    await service.close(); await start({ idleTimeoutMs: 400 });
    const started = Date.now();
    const { end } = await run(await session(await project()), 'SCENARIO:hang');
    expect(end).toMatchObject({ type: 'failed', code: 'timeout', message: expect.stringMatching(/dejó de responder/) });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(alive(runs()[0].pid)).toBe(false);
  });
  it('stops a harness that runs for too long', async () => {
    await service.close(); await start({ maxRunMs: 500, idleTimeoutMs: 60_000 });
    const { end } = await run(await session(await project()), 'SCENARIO:slow');
    expect(end).toMatchObject({ type: 'failed', code: 'timeout' });
  });
  it.each(['unsafe-tools', 'unsafe-mode', 'unsafe-server', 'unsafe-use'])('stops a session that is not board-only (%s)', async (scenario) => {
    const { end } = await run(await session(await project()), `SCENARIO:${scenario}`);
    expect(end).toMatchObject({ type: 'failed', code: 'unsafe_configuration' });
    await waitFor(() => !alive(runs()[0].pid) || undefined, 'the unsafe process to be stopped');
  });
  it('fails when the board tools did not start', async () => {
    expect((await run(await session(await project()), 'SCENARIO:no-board')).end).toMatchObject({ type: 'failed', code: 'board_unavailable' });
  });
  it('does not start a signed-out harness, and reports a missing one', async () => {
    const p = await project();
    const id = await session(p);
    await writeFile(join(root, 'auth.json'), '{"loggedIn":false}');
    expect((await run(id, 'hola')).end).toMatchObject({ type: 'failed', code: 'signed_out' });
    expect(runs()).toHaveLength(0);
    await rm(join(root, 'bin', 'claude'));
    expect((await run(id, 'hola')).end).toMatchObject({ type: 'failed', code: 'not_installed' });
    expect((await api('/api/agent/sessions', 'POST', { harness: 'claude', projectId: p })).status).toBe(422);
  });
});

describe('cancel, shutdown and process trees', () => {
  it('cancels a running turn and kills the whole process tree', async () => {
    const id = await session(await project());
    const pidFile = join(root, 'grandchild.pid');
    const sent = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: `SCENARIO:tree:${pidFile}` });
    const grandchild = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') || undefined, 'the grandchild'));
    const harness = runs()[0].pid;
    expect(alive(grandchild)).toBe(true);
    expect(alive(harness)).toBe(true);
    expect((await api(`/api/agent/sessions/${id}/cancel`, 'POST')).data).toEqual({ cancelled: true });
    const events = await waitFor(async () => {
      const all = (await api(`/api/agent/sessions/${id}/events`)).data.events as { runId: string; event: AgentEvent }[];
      return all.some((e) => e.runId === sent.data.runId && e.event.type === 'finished') ? all : undefined;
    }, 'cancellation');
    expect(events.at(-1)!.event).toEqual({ type: 'finished', reason: 'cancelled' });
    await waitFor(() => (!alive(grandchild) && !alive(harness)) || undefined, 'the tree to stop', 5000);
    expect((await api(`/api/agent/sessions/${id}/cancel`, 'POST')).data).toEqual({ cancelled: false });
    // The session can be used again afterwards.
    expect((await run(id, 'SCENARIO:ok')).end).toEqual({ type: 'finished', reason: 'completed' });
  });
  it('leaves no process behind when the service closes', async () => {
    const id = await session(await project());
    const pidFile = join(root, 'grandchild.pid');
    await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: `SCENARIO:tree:${pidFile}` });
    const grandchild = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') || undefined, 'the grandchild'));
    const harness = runs()[0].pid;
    await service.close();
    expect(alive(grandchild)).toBe(false);
    expect(alive(harness)).toBe(false);
    await start();
  });
});

describe('sessions, limits and resume', () => {
  it('allows one run per project by default and refuses clearly above that', async () => {
    const p = await project();
    const a = await session(p); const b = await session(p);
    await api(`/api/agent/sessions/${a}/messages`, 'POST', { text: 'SCENARIO:slow' });
    expect((await api(`/api/agent/sessions/${a}/messages`, 'POST', { text: 'otra' })).data.error.code).toBe('SESSION_BUSY');
    const refused = await api(`/api/agent/sessions/${b}/messages`, 'POST', { text: 'hola' });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatchObject({ code: 'PROJECT_BUSY', message: expect.stringMatching(/Ya hay un asistente/) });
    // Another project is independent.
    const other = await session(await project('Otro'));
    expect((await api(`/api/agent/sessions/${other}/messages`, 'POST', { text: 'SCENARIO:slow' })).status).toBe(202);
    await api(`/api/agent/sessions/${a}/cancel`, 'POST'); await api(`/api/agent/sessions/${other}/cancel`, 'POST');
    await waitFor(async () => (await api(`/api/agent/sessions/${a}`)).data.state === 'idle' || undefined, 'idle');
    expect((await run(b, 'hola')).end.type).toBe('finished');
  });
  it('limits the total number of runs', async () => {
    await service.close(); await start({ maxRuns: 1, maxRunsPerProject: 5 });
    const a = await session(await project('A')); const b = await session(await project('B'));
    await api(`/api/agent/sessions/${a}/messages`, 'POST', { text: 'SCENARIO:slow' });
    expect((await api(`/api/agent/sessions/${b}/messages`, 'POST', { text: 'hola' })).data.error.code).toBe('TOO_MANY_RUNS');
    await api(`/api/agent/sessions/${a}/cancel`, 'POST');
  });
  it('keeps a resumable index with no messages in it, and resumes after a restart', async () => {
    const p = await project();
    const id = await session(p, { sceneId: 's1' });
    expect((await api(`/api/agent/sessions/${id}/resume`, 'POST')).status).toBe(409); // Nothing to resume yet.
    const { events } = await run(id, 'SCENARIO:ok un mensaje privado');
    const token_ = (events.find((e) => e.type === 'session') as Extract<AgentEvent, { type: 'session' }>).resumeToken;
    const indexFile = join(root, 'agent-sessions.json');
    const stored = await readFile(indexFile, 'utf8');
    expect(stored).toContain(token_);
    expect(stored).not.toMatch(/privado|ARGUMENT|SECRET|Hola/);
    expect(stored).not.toContain(token);
    expect((await stat(indexFile)).mode & 0o777).toBe(0o600);
    await service.close(); await start();
    const listed = await api(`/api/agent/sessions?projectId=${p}`);
    expect(listed.data.sessions).toMatchObject([{ id, harness: 'claude', projectId: p, sceneId: 's1', state: 'idle', resumable: true }]);
    expect((await api(`/api/agent/sessions/${id}/resume`, 'POST')).data).toMatchObject({ id, resumable: true });
    await run(id, 'continuamos');
    const argv = runs().at(-1)!.argv;
    expect(argv[argv.indexOf('--resume') + 1]).toBe(token_);
    expect((await api('/api/agent/sessions/00000000-0000-4000-8000-000000000000/resume', 'POST')).status).toBe(404);
    // Deleting a session forgets it.
    expect((await api(`/api/agent/sessions/${id}`, 'DELETE')).status).toBe(204);
    expect(JSON.parse(await readFile(indexFile, 'utf8'))).toEqual([]);
  });
  it('rejects resuming into a project that no longer exists', async () => {
    const p = await project();
    const id = await session(p);
    await run(id, 'hola');
    // Remove the directory, as an external tool would.
    await rm(join(root, 'projects', p), { recursive: true, force: true });
    const sent = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'hola' });
    expect(sent.status).toBe(404);
  });
});

describe('API', () => {
  it('requires the session token on every agent route', async () => {
    const id = await session(await project());
    for (const [method, path] of [['GET', '/api/agent/sessions'], ['POST', '/api/agent/sessions'], ['GET', `/api/agent/sessions/${id}`], ['POST', `/api/agent/sessions/${id}/messages`],
      ['POST', `/api/agent/sessions/${id}/cancel`], ['POST', `/api/agent/sessions/${id}/resume`], ['GET', `/api/agent/sessions/${id}/events`], ['DELETE', `/api/agent/sessions/${id}`]] as const) {
      expect((await api(path, method, method === 'POST' ? {} : undefined, false)).status, `${method} ${path}`).toBe(401);
    }
    expect(runs()).toHaveLength(0);
  });
  it('validates input', async () => {
    const p = await project();
    expect((await api('/api/agent/sessions', 'POST', { harness: 'other', projectId: p })).status).toBe(400);
    expect((await api('/api/agent/sessions', 'POST', { harness: 'agy', projectId: p })).data.error.code).toBe('HARNESS_NOT_SUPPORTED');
    expect((await api('/api/agent/sessions', 'POST', { harness: 'claude', projectId: '../x' })).status).toBe(400);
    expect((await api('/api/agent/sessions', 'POST', { harness: 'claude', projectId: 'missing' })).status).toBe(404);
    expect((await api('/api/agent/sessions', 'POST', { harness: 'claude', projectId: p, sceneId: 'missing' })).status).toBe(404);
    expect((await api('/api/agent/sessions', 'POST', [])).status).toBe(400);
    const id = await session(p);
    for (const text of ['', '   ', 5, 'x'.repeat(32_001)]) expect((await api(`/api/agent/sessions/${id}/messages`, 'POST', { text })).status).toBe(400);
    expect((await api(`/api/agent/sessions/${id}/nope`, 'POST', {})).status).toBe(404);
    expect((await api(`/api/agent/sessions/${id}/messages`, 'GET')).status).toBe(405);
    expect((await api('/api/agent/nope')).status).toBe(404);
    expect(runs()).toHaveLength(0);
  });
  it('streams events over the authenticated WebSocket', async () => {
    const id = await session(await project());
    const socket = new WebSocket(service.url.replace('http', 'ws') + '/api/events', ['paso', `paso-token.${token}`]);
    const received: { type: string; sessionId?: string; seq?: number; event?: AgentEvent }[] = [];
    socket.on('message', (data) => received.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await waitFor(() => received.some((m) => m.type === 'ready') || undefined, 'ready');
    await run(id, 'SCENARIO:ok');
    const agent = await waitFor(() => { const m = received.filter((r) => r.type === 'agent'); return m.some((r) => r.event?.type === 'finished') ? m : undefined; }, 'agent events');
    expect(agent.every((m) => m.sessionId === id)).toBe(true);
    expect(agent.map((m) => m.seq)).toEqual(agent.map((_, i) => i + 1));
    expect(agent[0].event).toEqual({ type: 'started' });
    expect(agent.filter((m) => m.event?.type === 'text_delta').map((m) => (m.event as { text: string }).text)).toEqual(['Ho', 'la']);
    socket.close();
  });
});

describe('run hooks and logging', () => {
  it('calls the hooks once around a run, whatever its outcome', async () => {
    const calls: string[] = [];
    const hooks: AgentRunHooks = {
      beforeRun: (c) => { calls.push(`before:${c.projectId}:${c.sceneId}:${c.harness}`); },
      afterRun: (c, o) => { calls.push(`after:${c.runId.length}:${o.status}:${o.failure ?? ''}`); },
    };
    await service.close(); await start({ hooks });
    const p = await project();
    const id = await session(p, { sceneId: 's1' });
    await run(id, 'SCENARIO:ok'); await run(id, 'SCENARIO:quota');
    expect(calls).toEqual([`before:${p}:s1:claude`, 'after:36:completed:', `before:${p}:s1:claude`, 'after:36:failed:quota']);
  });
  it('can record and undo a session edit through the restore-point API', async () => {
    await service.close();
    await start({
      hooks: {
        beforeRun: async ({ projectId }) => {
          // The server opens the restore point after this custom hook returns.
          const existing = await api(`/api/projects/${projectId}/runs`);
          expect(existing.status).toBe(200);
          expect(existing.data.runs).toEqual([]);
        },
        afterRun: async ({ projectId, runId }) => {
          const finished = await api(`/api/projects/${projectId}/runs/${runId}/finish`, 'POST', {});
          expect(finished.status).toBe(200);
        },
      },
      adapters: {
        claude: {
          id: 'claude',
          async *run(request) {
            const path = `/api/projects/${request.context.projectId}/scenes/s1/steps/step`;
            const original = await api(path);
            const response = await fetch(request.board.serviceUrl + path, {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${request.board.sessionToken}`,
                'Content-Type': 'application/json',
                'If-Match': `"${original.data.revision}"`,
                'X-Paso-Actor': 'mcp',
              },
              body: JSON.stringify({ ...original.data.document, title: 'Cambio del asistente' }),
            });
            expect(response.status).toBe(200);
            yield { type: 'finished', reason: 'completed' };
          },
        },
      },
    });
    const p = await project();
    const path = `/api/projects/${p}/scenes/s1/steps/step`;
    expect((await api(`/api/projects/${p}/scenes/s1/steps`, 'POST', { id: 'step', title: 'Original' })).status).toBe(201);
    const id = await session(p, { sceneId: 's1' });
    const { runId, end } = await run(id, 'Cambia el título');
    expect(end).toEqual({ type: 'finished', reason: 'completed' });
    expect((await api(path)).data.document.title).toBe('Cambio del asistente');
    const runPath = `/api/projects/${p}/runs/${runId}`;
    expect((await api(runPath)).data.run).toMatchObject({ id: runId, status: 'finished' });
    const preview = await api(`${runPath}/undo`);
    expect(preview.status).toBe(200);
    expect(preview.data.plan.requiresForce).toBe(false);
    expect((await api(`${runPath}/undo`, 'POST', { confirm: preview.data.plan.confirmationToken })).status).toBe(200);
    expect((await api(path)).data.document.title).toBe('Original');
    expect((await api(`/api/agent/sessions/${id}`)).data.state).toBe('idle');
  });
  it('does not start the harness when a hook refuses, and still ends the run', async () => {
    const afterRun = vi.fn();
    await service.close(); await start({ hooks: { beforeRun: () => { throw new Error('no restore point'); }, afterRun } });
    const { end } = await run(await session(await project()), 'hola');
    expect(end).toMatchObject({ type: 'failed', code: 'blocked' });
    expect(runs()).toHaveLength(0);
    expect(afterRun).toHaveBeenCalledWith(expect.anything(), { status: 'failed', failure: 'blocked' });
  });
  it('logs nothing: no prompts, responses or tokens', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const writes = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')];
    const seen: string[] = [];
    for (const w of writes) w.mockImplementation(((chunk: unknown) => { seen.push(String(chunk)); return true; }) as never);
    try {
      const id = await session(await project());
      await run(id, 'SCENARIO:ok PROMPT-CANARY'); await run(id, 'SCENARIO:crash PROMPT-CANARY'); await run(id, 'SCENARIO:quota');
    } finally { for (const s of [...spies, ...writes]) s.mockRestore(); }
    expect(spies.flatMap((s) => s.mock.calls)).toEqual([]);
    expect(seen.join('')).not.toMatch(/PROMPT-CANARY|RESULT-SECRET|ARGUMENT-SECRET|test-session-token/);
  });
  it('automatically creates and finishes a RunStore restore point for each session turn and undoes it cleanly', async () => {
    const p = await project();
    const initialStep = await api(`/api/projects/${p}/scenes/s1/steps`, 'POST', { id: 'st1', title: 'Paso original' });
    expect(initialStep.status).toBe(201);
    const id = await session(p, { sceneId: 's1' });
    const { runId, end } = await run(id, 'SCENARIO:edit');
    expect(end).toEqual({ type: 'finished', reason: 'completed' });

    const runRes = await api(`/api/projects/${p}/runs/${runId}`);
    expect(runRes.status).toBe(200);
    expect(runRes.data.run).toMatchObject({
      id: runId,
      projectId: p,
      status: 'finished',
      label: `claude:${id}`,
    });
    expect(runRes.data.run.changes.modifiedSteps).toHaveLength(1);
    expect(runRes.data.run.changes.modifiedSteps[0].id).toBe('st1');
    expect(runRes.data.run.changes.createdSteps).toHaveLength(1);

    const preview = await api(`/api/projects/${p}/runs/${runId}/undo`);
    expect(preview.status).toBe(200);
    expect(preview.data.plan.requiresForce).toBe(false);
    expect(preview.data.plan.warnings).toEqual([]);

    const undone = await api(`/api/projects/${p}/runs/${runId}/undo`, 'POST', { confirm: preview.data.plan.confirmationToken });
    expect(undone.status).toBe(200);
    expect(undone.data.run.status).toBe('undone');

    const stepsAfter = await api(`/api/projects/${p}/scenes/s1/steps`);
    expect(stepsAfter.data.steps).toHaveLength(1);
    expect(stepsAfter.data.steps[0].document.id).toBe('st1');
    expect(stepsAfter.data.steps[0].document.title).toBe('Paso original');
    expect(stepsAfter.data.steps[0].document.elements).toEqual([]);
  });
  it('warns with requiresForce: true when a person edited a step after the session run, and undoes with force: true', async () => {
    const p = await project();
    await api(`/api/projects/${p}/scenes/s1/steps`, 'POST', { id: 'st1', title: 'Paso original' });
    const id = await session(p, { sceneId: 's1' });
    const { runId } = await run(id, 'SCENARIO:edit');

    const stepAfterAgent = await api(`/api/projects/${p}/scenes/s1/steps/st1`);
    const humanEdit = await fetch(`${service.url}/api/projects/${p}/scenes/s1/steps/st1`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'If-Match': `"${stepAfterAgent.data.revision}"`,
      },
      body: JSON.stringify({ ...stepAfterAgent.data.document, title: 'Editado por persona' }),
    });
    expect(humanEdit.status).toBe(200);

    const preview = await api(`/api/projects/${p}/runs/${runId}/undo`);
    expect(preview.status).toBe(200);
    expect(preview.data.plan.requiresForce).toBe(true);
    expect(preview.data.plan.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'STEP_MODIFIED_AFTER_RUN', id: 'st1' })]),
    );

    const withoutForce = await api(`/api/projects/${p}/runs/${runId}/undo`, 'POST', { confirm: preview.data.plan.confirmationToken });
    expect(withoutForce.status).toBe(409);
    expect(withoutForce.data.error.code).toBe('FORCE_REQUIRED');

    const withForce = await api(`/api/projects/${p}/runs/${runId}/undo`, 'POST', { confirm: preview.data.plan.confirmationToken, force: true });
    expect(withForce.status).toBe(200);
    expect(withForce.data.run.status).toBe('undone');

    const restored = await api(`/api/projects/${p}/scenes/s1/steps/st1`);
    expect(restored.data.document.title).toBe('Paso original');
  });
  it('finishes the restore point of a cancelled turn and of a crashed one, so the next turn can start', async () => {
    const p = await project();
    const id = await session(p);
    const sent = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'SCENARIO:hang' });
    const runId = sent.data.runId as string;
    await waitFor(async () => (await api(`/api/projects/${p}/runs/${runId}`)).data.run?.status === 'running' || undefined, 'the run to open');
    await api(`/api/agent/sessions/${id}/cancel`, 'POST');
    await waitFor(async () => (await api(`/api/agent/sessions/${id}`)).data.state === 'idle' || undefined, 'idle');
    expect((await api(`/api/projects/${p}/runs/${runId}`)).data.run.status).toBe('finished');

    const crashed = await run(id, 'SCENARIO:crash');
    expect(crashed.end).toMatchObject({ type: 'failed', code: 'crashed' });
    expect((await api(`/api/projects/${p}/runs/${crashed.runId}`)).data.run.status).toBe('finished');
    expect((await run(id, 'SCENARIO:ok')).end).toEqual({ type: 'finished', reason: 'completed' });
    expect((await api(`/api/projects/${p}/runs`)).data.runs.map((r: { status: string }) => r.status)).toEqual(['finished', 'finished', 'finished']);
  });
  it('refuses a turn while another restore point is open, and leaves that one alone', async () => {
    const p = await project();
    const manual = await api(`/api/projects/${p}/runs`, 'POST', { label: 'otra herramienta' });
    expect(manual.status).toBe(201);
    const id = await session(p);
    const refused = await run(id, 'SCENARIO:ok');
    expect(refused.end).toMatchObject({ type: 'failed', code: 'blocked' });
    expect(runs()).toHaveLength(0);
    const listed = (await api(`/api/projects/${p}/runs`)).data.runs as { id: string; status: string }[];
    expect(listed).toEqual([expect.objectContaining({ id: manual.data.run.id, status: 'running' })]);
    await api(`/api/projects/${p}/runs/${manual.data.run.id}/finish`, 'POST');
    expect((await run(id, 'SCENARIO:ok')).end).toEqual({ type: 'finished', reason: 'completed' });
  });
  it('finishes the restore point when the service closes during a turn', async () => {
    const p = await project();
    const id = await session(p);
    const sent = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'SCENARIO:hang' });
    const runId = sent.data.runId as string;
    await waitFor(async () => (await api(`/api/projects/${p}/runs/${runId}`)).data.run?.status === 'running' || undefined, 'the run to open');
    await waitFor(() => runs().length > 0 || undefined, 'the harness to start');
    await service.close();
    await start();
    // Closed cleanly as part of shutdown, not left to be found "interrupted" at the next start.
    expect((await api(`/api/projects/${p}/runs/${runId}`)).data.run.status).toBe('finished');
  });
});
