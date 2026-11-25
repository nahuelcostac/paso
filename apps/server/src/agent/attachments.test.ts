import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fakePath, windows, writeFixture, writeLauncher } from './testing/launcher.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type AgentOptions } from '../server.js';
import { maxImageBytes, parseAttachments, sniffImage } from './attachments.js';
import { claudeInput } from './claude.js';
import { codexInput } from './codex.js';
import type { AgentEvent, HarnessAdapter } from './types.js';

const token = 'attachments-test-token-with-at-least-32-characters';
const fixture = join(import.meta.dirname, 'testing', 'fake-claude.mjs');
type Service = Awaited<ReturnType<typeof startServer>>;
let root: string;
let service: Service;

/** A real 1×1 PNG, and files that only carry the other formats' signatures: the service checks signatures, not pixels. */
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30, 2)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(30, 3)]);
const image = (bytes: Buffer, mediaType: string, name?: string) => ({ kind: 'image', mediaType, data: bytes.toString('base64'), ...(name ? { name } : {}) });

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
async function project() {
  const created = await api('/api/projects', 'POST', { name: 'Prueba' });
  const id = created.data.document.id as string;
  await api(`/api/projects/${id}/scenes`, 'POST', { name: 'Escena', id: 's1' });
  return id;
}
async function session(projectId: string, harness = 'claude') {
  const created = await api('/api/agent/sessions', 'POST', { harness, projectId, sceneId: 's1' });
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
const stored = async (sessionId: string) => readdir(join(root, 'agent-attachments', sessionId)).catch(() => [] as string[]);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paso-attach-'));
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFixture(fakePath(join(root, 'bin', 'claude')), fixture, { FAKE_DIR: root });
  await start();
});
afterEach(async () => {
  await service.close();
  await rm(root, { recursive: true, force: true });
});

describe('images attached to a message', () => {
  it('reach Claude Code as base64 image blocks on stdin, never as a path, and stay with the conversation', async () => {
    const p = await project();
    const id = await session(p);
    const sent = await api(`/api/agent/sessions/${id}/messages`, 'POST', {
      text: 'What is in these?', attachments: [image(png, 'image/png', '/Users/someone/Desktop/shot.png'), image(jpeg, 'image/jpeg')],
    });
    expect(sent.status).toBe(202);
    const refs = sent.data.attachments as { id: string; kind: string; mediaType: string; size: number; name?: string }[];
    expect(refs.map(({ kind, mediaType, size, name }) => ({ kind, mediaType, size, name }))).toEqual([
      { kind: 'image', mediaType: 'image/png', size: png.length, name: 'shot.png' }, // The name, never the folder it came from.
      { kind: 'image', mediaType: 'image/jpeg', size: jpeg.length, name: undefined },
    ]);
    const events = await finish(id, sent.data.runId);
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'completed' });
    expect(events[1]).toEqual({ type: 'message', text: 'What is in these?', attachments: refs });

    const [call] = runs();
    expect(JSON.parse(call.stdin.split('\n')[0])).toEqual({ type: 'user', message: { role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
      { type: 'text', text: 'What is in these?' },
    ] } });
    // Nothing handed to the harness names the stored files or their folder.
    for (const part of [call.stdin, ...call.argv]) {
      expect(part).not.toContain('agent-attachments');
      expect(part).not.toContain(root);
      for (const ref of refs) expect(part).not.toContain(ref.id);
    }

    // Kept in the service's data folder, private, outside the project folder.
    const files = await stored(id);
    expect(files.sort()).toEqual([`${refs[0].id}.png`, `${refs[1].id}.jpg`].sort());
    if (!windows) {
      expect((await stat(join(root, 'agent-attachments', id, `${refs[0].id}.png`))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, 'agent-attachments', id))).mode & 0o777).toBe(0o700);
    }
    expect(JSON.stringify(await readdir(join(root, 'projects'), { recursive: true }))).not.toMatch(/\.png|\.jpg/);

    // Shown again in the history: the bytes, typed as the image they are, and only with the token.
    const response = await fetch(`${service.url}/api/agent/sessions/${id}/attachments/${refs[0].id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
    expect((await fetch(`${service.url}/api/agent/sessions/${id}/attachments/${refs[0].id}`)).status).toBe(401);
    expect((await api(`/api/agent/sessions/${id}/attachments/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await api(`/api/agent/sessions/${id}/attachments/..%2F..%2Fagent-sessions.json`)).status).toBe(404);
    expect((await api(`/api/agent/sessions/${id}/attachments/${refs[0].id}`, 'DELETE')).status).toBe(405);

    // The replay has them too, after a restart.
    await service.close();
    await start();
    const replay = (await api(`/api/agent/sessions/${id}/events`)).data.events as { event: AgentEvent }[];
    expect(replay.find((entry) => entry.event.type === 'message')?.event).toEqual({ type: 'message', text: 'What is in these?', attachments: refs });
    expect((await fetch(`${service.url}/api/agent/sessions/${id}/attachments/${refs[1].id}`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('may be sent without text, and the history names the conversation after them', async () => {
    const id = await session(await project());
    const sent = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: '', attachments: [image(gif, 'image/gif'), image(webp, 'image/webp')] });
    expect(sent.status).toBe(202);
    await finish(id, sent.data.runId);
    const content = JSON.parse(runs()[0].stdin.split('\n')[0]).message.content as { type: string; source?: { media_type: string } }[];
    expect(content.map((block) => block.source?.media_type ?? block.type)).toEqual(['image/gif', 'image/webp']);
    expect((await api(`/api/agent/sessions/${id}`)).data.title).toBe('2 images');
  });

  it('are checked on the server: type, signature, size and count, and nothing is kept when refused', async () => {
    const id = await session(await project());
    const send = (attachments: unknown, text = 'Hola') => api(`/api/agent/sessions/${id}/messages`, 'POST', { text, attachments });
    const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(40)]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const cases: [unknown, number, string][] = [
      [[image(bmp, 'image/png')], 400, 'INVALID_ATTACHMENT'], // Declared PNG, but the bytes are not.
      [[image(svg, 'image/svg+xml')], 400, 'INVALID_ATTACHMENT'],
      [[image(png, 'image/jpeg')], 400, 'INVALID_ATTACHMENT'], // A real image of another type than declared.
      [[{ kind: 'image', mediaType: 'image/png', data: 'not base64!' }], 400, 'INVALID_ATTACHMENT'],
      [[{ kind: 'image', mediaType: 'image/png', data: '' }], 400, 'INVALID_ATTACHMENT'],
      [[{ kind: 'file', mediaType: 'image/png', data: png.toString('base64') }], 400, 'INVALID_ATTACHMENT'],
      [[{ kind: 'image', mediaType: 'image/png', path: '/etc/passwd' }], 400, 'INVALID_ATTACHMENT'],
      ['/etc/passwd', 400, 'INVALID_ATTACHMENT'],
      [Array.from({ length: 6 }, () => image(png, 'image/png')), 400, 'TOO_MANY_ATTACHMENTS'],
      [[image(Buffer.concat([png, Buffer.alloc(maxImageBytes)]), 'image/png')], 413, 'ATTACHMENT_TOO_LARGE'],
    ];
    for (const [attachments, status, code] of cases) {
      const reply = await send(attachments);
      expect([reply.status, reply.data.error.code], JSON.stringify(attachments).slice(0, 80)).toEqual([status, code]);
    }
    // Five images of the largest size fit in one request.
    const largest = Buffer.concat([png, Buffer.alloc(maxImageBytes - png.length)]);
    const full = await send(Array.from({ length: 5 }, () => image(largest, 'image/png')));
    expect(full.status).toBe(202);
    await finish(id, full.data.runId);
    expect(await stored(id)).toHaveLength(5);
    expect((await send([], '')).status).toBe(400); // Neither text nor an image.
    expect(runs()).toHaveLength(1);
  });

  it('are refused before sending by a harness that cannot take images', async () => {
    const textOnly: HarnessAdapter = {
      id: 'claude',
      async *run() { yield { type: 'finished', reason: 'completed' }; },
    };
    await service.close();
    await start({ adapters: { claude: textOnly } });
    const id = await session(await project());
    const reply = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'Mira', attachments: [image(png, 'image/png')] });
    expect([reply.status, reply.data.error.code]).toEqual([422, 'IMAGES_NOT_SUPPORTED']);
    expect(await stored(id)).toEqual([]);
    expect((await api(`/api/agent/sessions/${id}/events`)).data.events).toEqual([]);
  });

  it('are refused before sending to Antigravity, whose print mode takes text only', async () => {
    await writeLauncher(fakePath(join(root, 'bin', 'agy')), "console.log('1.5.16')");
    const id = await session(await project(), 'agy');
    const reply = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'Mira', attachments: [image(png, 'image/png')] });
    expect([reply.status, reply.data.error.code]).toEqual([422, 'IMAGES_NOT_SUPPORTED']);
    expect(await stored(id)).toEqual([]);
    expect((await api(`/api/agent/sessions/${id}/events`)).data.events).toEqual([]);
  });

  it('are not kept when the message is refused because the agent is busy', async () => {
    const id = await session(await project());
    const first = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'SCENARIO:slow' });
    expect(first.status).toBe(202);
    const busy = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'Otra', attachments: [image(png, 'image/png')] });
    expect(busy.data.error.code).toBe('SESSION_BUSY');
    expect(await stored(id)).toEqual([]);
    await finish(id, first.data.runId);
  });

  it('are deleted with their conversation, and ones of forgotten conversations at the next start', async () => {
    const id = await session(await project());
    const sent = await api(`/api/agent/sessions/${id}/messages`, 'POST', { text: 'Hola', attachments: [image(png, 'image/png')] });
    await finish(id, sent.data.runId);
    expect(await stored(id)).toHaveLength(1);
    expect((await api(`/api/agent/sessions/${id}`, 'DELETE')).status).toBe(204);
    expect(existsSync(join(root, 'agent-attachments', id))).toBe(false);

    // A conversation the index no longer has, such as one that never reached the harness before a restart.
    const orphan = join(root, 'agent-attachments', '11111111-2222-4333-8444-555555555555');
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'x.png'), png);
    const kept = await session(await project());
    const again = await api(`/api/agent/sessions/${kept}/messages`, 'POST', { text: 'Hola', attachments: [image(png, 'image/png')] });
    await finish(kept, again.data.runId);
    await service.close();
    await start();
    await api('/api/agent/sessions');
    await waitFor(() => !existsSync(orphan) || undefined, 'the orphan to go');
    expect(await stored(kept)).toHaveLength(1);
  });
});

describe('attachment helpers', () => {
  it('recognize the four formats by signature only', () => {
    expect([png, jpeg, gif, webp].map(sniffImage)).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    expect(sniffImage(Buffer.from('<svg/>'))).toBeUndefined();
    expect(sniffImage(Buffer.from('RIFF0000WAVE'))).toBeUndefined();
    expect(parseAttachments(undefined)).toEqual([]);
  });
  it('build the Codex turn input with data URLs and never a local path', () => {
    const input = codexInput({ text: 'Describe it', images: [{ mediaType: 'image/png', data: png.toString('base64') }] });
    expect(input).toEqual([{ type: 'text', text: 'Describe it' }, { type: 'image', url: `data:image/png;base64,${png.toString('base64')}` }]);
    expect(JSON.stringify(input)).not.toContain('localImage');
    expect(codexInput({ text: 'Solo texto' })).toEqual([{ type: 'text', text: 'Solo texto' }]);
  });
  it('keep a plain message a string for Claude Code', () => {
    expect(JSON.parse(claudeInput({ text: 'Hola' }))).toEqual({ type: 'user', message: { role: 'user', content: 'Hola' } });
  });
});
