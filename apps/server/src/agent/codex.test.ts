import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../server.js';
import { codexAdapter } from './codex.js';
import { codexCatalog, codexConfiguration } from './codex-policy.js';
import type { AgentEvent, AgentRunRequest } from './types.js';

let root: string;
let server: Awaited<ReturnType<typeof startServer>>;
let request: AgentRunRequest;
const token = 'codex-test-session-token-with-32-characters';
const fixture = join(import.meta.dirname, 'testing', 'fake-codex.mjs');
const collect = async (text = 'ok', extra: Partial<AgentRunRequest> = {}, signal = new AbortController().signal) => {
  const events: AgentEvent[] = [];
  for await (const e of codexAdapter.run({ ...request, text, ...extra }, signal)) events.push(e);
  return events;
};
const records = async () => (await readFile(join(root, 'records.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paso-codex-'));
  server = await startServer({ dataDir: join(root, 'projects'), port: 0, sessionToken: token });
  const api = async (path: string, body: unknown) => fetch(server.url + '/api' + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await api('/projects', { id: 'p', name: 'Prueba' });
  await api('/projects/p/scenes', { id: 's', name: 'Escena' });
  await api('/projects/p/scenes/s/steps', { id: 'st', title: 'Paso' });
  const executable = join(root, 'codex');
  await writeFile(executable, `#!/bin/sh\nFAKE_RECORD='${root}/records.jsonl' exec '${process.execPath}' '${fixture}' "$@"\n`);
  await chmod(executable, 0o755);
  const workDir = join(root, 'work'); await mkdir(workDir);
  request = { executable, workDir, text: 'ok', context: { projectId: 'p', sceneId: 's' },
    board: { serviceUrl: server.url, sessionToken: token, mcp: { command: process.execPath, args: [join(import.meta.dirname, '../../../mcp/dist/cli.js')] } },
    limits: { idleTimeoutMs: 5000, maxRunMs: 15000 } };
});
afterEach(async () => { await server?.close(); await rm(root, { recursive: true, force: true }); });

describe('Codex app-server adapter with a simulated harness and real board MCP', () => {
  it('streams text, targets and successful/failed tool results without exposing arguments', async () => {
    const events = await collect();
    expect(events).toContainEqual({ type: 'text_delta', text: 'Ho' });
    expect(events).toContainEqual({ type: 'text', text: 'Hola' });
    expect(events).toContainEqual({ type: 'tool_use', id: 'read', tool: 'read_step', readOnly: true, target: { projectId: 'p', sceneId: 's', stepId: 'st' } });
    expect(events).toContainEqual({ type: 'tool_result', id: 'read', ok: true });
    expect(events).toContainEqual({ type: 'tool_result', id: 'write', ok: false });
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'completed' });
    expect(events.filter((e) => e.type === 'finished' || e.type === 'failed')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('invalid');
  });
  it('isolates config, removes native tools and gives the service token only to MCP', async () => {
    await collect('prompt; $(touch /tmp/unsafe)');
    const [call, thread, turn] = await records();
    expect(call.args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(JSON.stringify(call)).not.toContain(token);
    expect(call.env.PASO_SESSION_TOKEN).toBeUndefined();
    expect(call.env.OPENAI_API_KEY).toBeUndefined();
    expect(call.env.CODEX_HOME).toBe(join(root, 'codex-home'));
    expect(await realpath(call.cwd)).toBe(await realpath(request.workDir));
    expect(await readdir(request.workDir)).toEqual([]);
    expect(thread.params.environments).toEqual([]);
    expect(thread.params.approvalPolicy).toBe('never');
    expect(thread.params.dynamicTools).toHaveLength(11);
    expect(turn.params.input[0].text).toBe('prompt; $(touch /tmp/unsafe)');
    expect(call.args.join(' ')).not.toContain('touch');
    expect(codexCatalog('model').models[0]).toMatchObject({ shell_type: 'disabled', apply_patch_tool_type: null, tool_mode: 'direct', multi_agent_version: null, node_repl_disabled: true, experimental_supported_tools: [] });
    expect(codexConfiguration('/catalog')).toMatchObject({ forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file', 'features.shell_tool': false, 'features.apps': false, 'features.plugins': false, web_search: 'disabled', project_doc_max_bytes: 0, approval_policy: 'never', sandbox_mode: 'read-only' });
  });
  it('resumes the same conversation with the same restrictions', async () => {
    await collect();
    const resumed = await collect('ok', { resumeToken: 'fake-codex-thread' });
    expect(resumed.at(-1)).toEqual({ type: 'finished', reason: 'completed' });
    const thread = (await records()).find((r) => r.method === 'thread/resume');
    expect(thread.params.threadId).toBe('fake-codex-thread');
    expect(thread.params.sandbox).toBe('read-only');
    expect(thread.params.config['features.shell_tool']).toBe(false);
  });
  it.each([
    ['signed-out', 'signed_out'], ['quota', 'quota'], ['model', 'model_unavailable'],
    ['unsupported', 'unsupported_version'], ['crash', 'crashed'], ['protocol', 'protocol'],
    ['unsafe-mode', 'unsafe_configuration'], ['unsafe-server', 'unsafe_configuration'],
    ['unsafe-use', 'unsafe_configuration'], ['unsafe-call', 'unsafe_configuration'], ['approval', 'unsafe_configuration'],
  ])('maps %s to %s and stops the process', async (scenario, code) => {
    const events = await collect(scenario);
    expect(events.at(-1)).toMatchObject({ type: 'failed', code });
    expect(events.filter((e) => e.type === 'failed' || e.type === 'finished')).toHaveLength(1);
  });
  it('rejects an unverified CLI version before submitting a turn', async () => {
    await writeFile(request.executable, `#!/bin/sh\nFAKE_CODEX_VERSION='0.165.0' FAKE_RECORD='${root}/records.jsonl' exec '${process.execPath}' '${fixture}' "$@"\n`);
    expect((await collect()).at(-1)).toMatchObject({ type: 'failed', code: 'unsupported_version' });
    expect((await records()).some((r) => r.method === 'turn/start')).toBe(false);
  });
  it('refuses config injected into its isolated home', async () => {
    await collect();
    await writeFile(join(root, 'codex-home', 'config.toml'), '[mcp_servers.evil]\ncommand="evil"');
    expect((await collect()).at(-1)).toMatchObject({ type: 'failed', code: 'unsafe_configuration' });
    expect((await records()).filter((r) => r.method === 'turn/start')).toHaveLength(1);
    expect(await readlink(join(root, 'codex-home', 'auth.json'))).toMatch(/auth\.json$/);
  });
  it('reports a board process that cannot start', async () => {
    expect((await collect('ok', { board: { ...request.board, mcp: { command: join(root, 'missing-mcp'), args: [] } } })).at(-1)).toMatchObject({ type: 'failed', code: 'board_unavailable' });
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
    expect((await collect('hang', { limits: { idleTimeoutMs: 500, maxRunMs: 5000 } })).at(-1)).toMatchObject({ type: 'failed', code: 'timeout' });
  });
});
