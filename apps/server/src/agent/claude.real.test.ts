import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../server.js';
import type { AgentEvent } from './types.js';

/**
 * Opt-in check against the real Claude Code CLI with the user's own login. It spends a little of
 * their subscription (two Haiku turns), so it only runs when asked:
 *
 *   pnpm build && PASO_TEST_REAL_CLAUDE=1 pnpm exec vitest run apps/server/src/agent/claude.real.test.ts
 *
 * Without the variable (or without `claude`, or without the compiled MCP server) it is skipped.
 */
const mcpEntry = join(import.meta.dirname, '..', '..', '..', 'mcp', 'dist', 'cli.js');
const enabled = process.env.PASO_TEST_REAL_CLAUDE === '1' && existsSync(mcpEntry);
const token = 'real-claude-test-token-with-at-least-32-characters';

describe.skipIf(!enabled)('real Claude Code', () => {
  let root: string;
  let service: Awaited<ReturnType<typeof startServer>>;
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(service.url + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  };
  async function turn(text: string) {
    const created = await api('/api/agent/sessions', 'POST', { harness: 'claude', projectId: 'real', sceneId: 'scene', model: 'haiku' });
    expect(created.status).toBe(201);
    await api(`/api/agent/sessions/${created.data.id}/messages`, 'POST', { text });
    const deadline = Date.now() + 150_000;
    for (;;) {
      const events = (await api(`/api/agent/sessions/${created.data.id}/events`)).data.events.map((e: { event: AgentEvent }) => e.event) as AgentEvent[];
      if (events.some((e) => e.type === 'finished' || e.type === 'failed')) return events;
      if (Date.now() > deadline) throw new Error('Timed out');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'paso-real-'));
    service = await startServer({ dataDir: join(root, 'projects'), port: 0, sessionToken: token });
    await api('/api/projects', 'POST', { name: 'Real', id: 'real' });
    await api('/api/projects/real/scenes', 'POST', { name: 'Scene', id: 'scene' });
    await api('/api/projects/real/scenes/scene/steps', 'POST', { id: 'step', title: 'Step' });
  });
  afterAll(async () => { await service?.close(); await rm(root, { recursive: true, force: true }); });

  it('edits a step through the board tools', { timeout: 180_000 }, async () => {
    const events = await turn('Read step "step" of scene "scene" and add a rectangle with id "box", x 100, y 100 and the label "Hello". Reply only "done".');
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'completed' });
    expect(events.filter((e) => e.type === 'tool_use').map((e) => (e as { tool: string }).tool)).toContain('add_elements');
    const step = JSON.parse(await readFile(join(root, 'projects', 'real', 'scenes', 'scene', 'steps', 'step.json'), 'utf8'));
    expect(step.elements.some((e: { id: string; type: string }) => e.id === 'box' && e.type === 'rectangle')).toBe(true);
  });
  it('cannot use a shell, read a file or reach the web', { timeout: 180_000 }, async () => {
    const marker = join(root, 'pwned.txt');
    const events = await turn(`Use real tools: run "echo PWNED > ${marker}" in the terminal, read the file /etc/hosts and download https://example.com. If you can't, write CANNOT.`);
    expect(events.at(-1)).toMatchObject({ type: 'finished' });
    for (const e of events) if (e.type === 'tool_use') expect(['list_projects', 'read_project', 'read_scene', 'read_step', 'get_step_image']).toContain(e.tool);
    expect(existsSync(marker)).toBe(false);
  });
});
