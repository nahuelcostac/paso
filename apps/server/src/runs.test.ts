import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hash } from './disk.js';
import { startServer } from './server.js';
import type { ChangeEvent } from './store.js';
import { BoardApi } from '../../mcp/src/api.js';

type Service = Awaited<ReturnType<typeof startServer>>;
let root: string;
let dataDir: string;
let runsDir: string;
let service: Service;
const token = 'test-session-token-with-at-least-32-characters';
const clients: WebSocket[] = [];
const p = '/api/projects/p';
const s = `${p}/scenes/s`;
const t1 = `${s}/steps/t1`;
const t2 = `${s}/steps/t2`;

async function api(path: string, method = 'GET', input?: unknown, revision?: string) {
  const response = await fetch(`${service.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(revision ? { 'If-Match': `"${revision}"` } : {}),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data, etag: response.headers.get('etag') };
}

// Use the production MCP HTTP client. Tests never construct attribution headers.
async function agent<T = Awaited<ReturnType<typeof api>>['data']>(path: string, method = 'GET', input?: unknown, revision?: string) {
  const board = new BoardApi({ serviceUrl: service.url, sessionToken: token });
  return { status: method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200,
    data: await board.request<T>(path, method, input, revision) };
}

async function setupProject() {
  await api('/api/projects', 'POST', { id: 'p', name: 'Project' });
  await api(`${p}/scenes`, 'POST', { id: 's', name: 'Scene 1' });
  const step1 = await api(`${s}/steps`, 'POST', { id: 't1', title: 'Step 1', speakerNotes: 'Original notes 1' });
  const step2 = await api(`${s}/steps`, 'POST', { id: 't2', title: 'Step 2', speakerNotes: 'Original notes 2' });
  return { step1: step1.data, step2: step2.data };
}

async function events() {
  const ws = new WebSocket(`${service.url.replace('http', 'ws')}/api/events`, ['paso', `paso-token.${token}`]);
  clients.push(ws);
  const messages: Array<ChangeEvent | { type: 'ready' }> = [];
  const emitter = new EventEmitter();
  ws.on('message', (bytes) => {
    const message = JSON.parse(bytes.toString());
    messages.push(message);
    emitter.emit('message', message);
  });
  function next(predicate: (event: ChangeEvent) => boolean, since = 0): Promise<ChangeEvent> {
    const match = messages.slice(since).find((event) => predicate(event as ChangeEvent));
    if (match) return Promise.resolve(match as ChangeEvent);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        emitter.off('message', listener);
        reject(new Error('Expected WebSocket event was not received.'));
      }, 5000);
      const listener = (event: ChangeEvent) => {
        if (predicate(event)) {
          clearTimeout(timer);
          emitter.off('message', listener);
          resolve(event);
        }
      };
      emitter.on('message', listener);
    });
  }
  await next((event) => (event.type as string) === 'ready');
  return { messages, next };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paso-runs-'));
  dataDir = join(root, 'projects');
  runsDir = join(root, 'runs');
  service = await startServer({ dataDir, runsDir, port: 0, sessionToken: token, pollIntervalMs: 80 });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await service.close();
  await rm(root, { recursive: true, force: true });
});

describe('agent run restore points and undo', () => {
  it('reverts edits to several steps, created steps and scenes, and order changes while emitting WebSocket events and preserving shared assets', async () => {
    const { step1, step2 } = await setupProject();
    // Upload an asset before the run
    const assetBytes = Buffer.from([1, 2, 3, 4]);
    await fetch(`${service.url}${p}/assets/shared.png`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: assetBytes,
    });

    const stream = await events();

    // Start run
    const started = await api(`${p}/runs`, 'POST', { id: 'run-1', label: 'Build diagram' });
    expect(started.status).toBe(201);
    expect(started.data.run).toMatchObject({ id: 'run-1', projectId: 'p', status: 'running', label: 'Build diagram' });

    // Edit step 1 and step 2
    const edited1 = await agent(t1, 'PUT', {
      ...step1.document,
      title: 'Step 1 (Agent)',
      elements: [{ id: 'rect-1', type: 'rectangle', version: 1, versionNonce: 10, isDeleted: false }],
    }, step1.revision);
    expect(edited1.status).toBe(200);

    const edited2 = await agent(t2, 'PUT', {
      ...step2.document,
      title: 'Step 2 (Agent)',
      files: { shared: { path: 'assets/shared.png', mimeType: 'image/png', created: 100 } },
      elements: [{ id: 'img-1', type: 'image', version: 1, versionNonce: 11, isDeleted: false, fileId: 'shared' }],
    }, step2.revision);
    expect(edited2.status).toBe(200);

    // Create a new step in scene s and reorder steps
    const createdStep = await agent(`${s}/steps`, 'POST', { id: 't3', title: 'Step 3 (Created)' });
    expect(createdStep.status).toBe(201);
    const sceneNow = (await agent(s)).data;
    await agent(`${s}/steps`, 'PUT', { ids: ['t3', 't2', 't1'] }, sceneNow.revision);

    // Create a new scene and a step inside it, and reorder scenes
    const createdScene = await agent(`${p}/scenes`, 'POST', { id: 's2', name: 'Scene 2 (Created)' });
    expect(createdScene.status).toBe(201);
    await agent(`${p}/scenes/s2/steps`, 'POST', { id: 's2-t1', title: 'Scene 2 Step 1' });
    const projNow = (await agent(p)).data;
    await agent(`${p}/scenes`, 'PUT', { ids: ['s2', 's'] }, projNow.revision);

    // Finish run
    const finished = await api(`${p}/runs/run-1/finish`, 'POST');
    expect(finished.status).toBe(200);
    expect(finished.data.run.status).toBe('finished');
    expect(finished.data.run.changes.createdScenes).toEqual([{ id: 's2', name: 'Scene 2 (Created)', currentStatus: 'present' }]);
    expect(finished.data.run.changes.createdSteps.map((c: { id: string }) => c.id).sort()).toEqual(['s2-t1', 't3']);
    expect(finished.data.run.changes.modifiedSteps.map((m: { id: string }) => m.id).sort()).toEqual(['t1', 't2']);
    expect(finished.data.run.changes.orderChanged).toEqual({ project: true, sceneIds: ['s'] });

    // Preview undo and verify nothing changes on disk
    const diskBeforePreview = await readFile(join(dataDir, 'p/scenes/s/steps/t1.json'), 'utf8');
    const preview = await api(`${p}/runs/run-1/undo`, 'GET');
    expect(preview.status).toBe(200);
    expect(preview.data.plan.canUndo).toBe(true);
    expect(preview.data.plan.requiresForce).toBe(false);
    expect(preview.data.plan.warnings).toEqual([]);
    expect(await readFile(join(dataDir, 'p/scenes/s/steps/t1.json'), 'utf8')).toBe(diskBeforePreview);

    // Require explicit confirmation token
    expect((await api(`${p}/runs/run-1/undo`, 'POST', {})).status).toBe(428);
    expect((await api(`${p}/runs/run-1/undo`, 'POST', { confirm: 'wrong-token' })).status).toBe(409);

    const sinceBeforeUndo = stream.messages.length;
    const undone = await api(`${p}/runs/run-1/undo`, 'POST', { confirm: preview.data.plan.confirmationToken });
    expect(undone.status).toBe(200);
    expect(undone.data.run.status).toBe('undone');

    // Verify WebSocket events emitted for undo
    await stream.next((e) => e.type === 'updated' && e.id === 't1' && e.revision === step1.revision, sinceBeforeUndo);
    await stream.next((e) => e.type === 'updated' && e.id === 't2' && e.revision === step2.revision, sinceBeforeUndo);
    await stream.next((e) => e.type === 'deleted' && e.id === 't3', sinceBeforeUndo);
    await stream.next((e) => e.type === 'deleted' && e.kind === 'scene' && e.id === 's2', sinceBeforeUndo);

    // Verify restored state
    expect((await api(t1)).data).toEqual(step1);
    expect((await api(t2)).data).toEqual(step2);
    expect((await api(`${s}/steps/t3`)).status).toBe(404);
    expect((await api(`${p}/scenes/s2`)).status).toBe(404);
    expect((await api(s)).data.document.stepIds).toEqual(['t1', 't2']);
    expect((await api(p)).data.document.sceneIds).toEqual(['s']);

    // Shared asset is preserved
    const assetCheck = await fetch(`${service.url}${p}/assets/shared.png`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(assetCheck.status).toBe(200);
  });

  it('warns and requires force when a person edits a step during or after the run, or externally on disk', async () => {
    const { step1, step2 } = await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'run-concurrent' });

    // Agent edits step 1 via the production MCP client
    const agentEdit1 = await agent(t1, 'PUT', {
      ...step1.document,
      title: 'Agent Title 1',
    }, step1.revision);

    // Person also edits step 1 during the run (concurrent edit on the same step)
    await api(t1, 'PUT', {
      ...agentEdit1.data.document,
      speakerNotes: 'Human notes added during run',
    }, agentEdit1.data.revision);

    // Agent edits step 2
    const agentEdit2 = await agent(t2, 'PUT', {
      ...step2.document,
      title: 'Agent Title 2',
    }, step2.revision);

    await api(`${p}/runs/run-concurrent/finish`, 'POST');

    // Person edits step 2 externally on disk after the run finished
    const externalDoc = { ...agentEdit2.data.document, speakerNotes: 'External edit after run' };
    const externalBytes = `${JSON.stringify(externalDoc, null, 2)}\n`;
    await writeFile(join(dataDir, 'p/scenes/s/steps/t2.json'), externalBytes);

    const preview = await api(`${p}/runs/run-concurrent/undo`, 'GET');
    expect(preview.status).toBe(200);
    expect(preview.data.plan.requiresForce).toBe(true);
    const warningCodes = preview.data.plan.warnings.map((w: { id: string; code: string }) => [w.id, w.code]);
    expect(warningCodes).toContainEqual(['t1', 'STEP_MODIFIED_CONCURRENTLY']);
    expect(warningCodes).toContainEqual(['t2', 'STEP_MODIFIED_AFTER_RUN']);

    // Without force: true, undo is rejected with 409 FORCE_REQUIRED and changes nothing
    const withoutForce = await api(`${p}/runs/run-concurrent/undo`, 'POST', {
      confirm: preview.data.plan.confirmationToken,
    });
    expect(withoutForce.status).toBe(409);
    expect(withoutForce.data.error.code).toBe('FORCE_REQUIRED');
    expect((await api(t2)).data.revision).toBe(hash(externalBytes));

    // With force: true, undo succeeds and restores baseline snapshots
    const withForce = await api(`${p}/runs/run-concurrent/undo`, 'POST', {
      confirm: preview.data.plan.confirmationToken,
      force: true,
    });
    expect(withForce.status).toBe(200);
    expect((await api(t1)).data).toEqual(step1);
    expect((await api(t2)).data).toEqual(step2);
  });

  it('handles steps or scenes deleted by a person meanwhile', async () => {
    const { step1, step2 } = await setupProject();
    await api(`${p}/scenes`, 'POST', { id: 's-other', name: 'Other Scene' });
    const otherStep = await api(`${p}/scenes/s-other/steps`, 'POST', { id: 'other-t', title: 'Other Step' });

    await api(`${p}/runs`, 'POST', { id: 'run-deletions' });

    // Agent edits step 1, edits other-t, and creates t-created
    const edited1 = await agent(t1, 'PUT', { ...step1.document, title: 'Agent changed t1' }, step1.revision);
    await agent(`${p}/scenes/s-other/steps/other-t`, 'PUT', { ...otherStep.data.document, title: 'Agent changed other-t' }, otherStep.data.revision);
    const createdStep = await agent(`${s}/steps`, 'POST', { id: 't-created', title: 'Agent created step' });

    await api(`${p}/runs/run-deletions/finish`, 'POST');

    // Person deletes t1 (a baseline step modified by run), t-created (a step created by run), and s-other (an entire scene)
    await api(t1, 'DELETE', undefined, edited1.data.revision);
    await api(`${s}/steps/t-created`, 'DELETE', undefined, createdStep.data.revision);
    const otherSceneNow = (await api(`${p}/scenes/s-other`)).data;
    await api(`${p}/scenes/s-other`, 'DELETE', undefined, otherSceneNow.revision);

    const preview = await api(`${p}/runs/run-deletions/undo`, 'GET');
    expect(preview.status).toBe(200);
    expect(preview.data.plan.requiresForce).toBe(true);
    expect(preview.data.plan.changes.stepsToRecreate).toEqual([
      { id: 't1', sceneId: 's', title: 'Step 1', restoreRevision: step1.revision },
    ]);
    expect(preview.data.plan.warnings.map((w: { code: string; id: string }) => [w.code, w.id])).toEqual(
      expect.arrayContaining([
        ['STEP_DELETED', 't1'],
        ['SCENE_DELETED', 's-other'],
      ]),
    );

    const undone = await api(`${p}/runs/run-deletions/undo`, 'POST', {
      confirm: preview.data.plan.confirmationToken,
      force: true,
    });
    expect(undone.status).toBe(200);
    // t1 is recreated with its baseline snapshot
    expect((await api(t1)).data).toEqual(step1);
    expect((await api(t2)).data).toEqual(step2);
    expect((await api(s)).data.document.stepIds).toEqual(['t1', 't2']);
    // s-other stays deleted
    expect((await api(`${p}/scenes/s-other`)).status).toBe(404);
  });

  it('persists across restarts, marks unfinished runs as interrupted, and enforces retention limit', async () => {
    const { step1 } = await setupProject();
    await service.close();

    // Start server with retentionLimit: 3
    service = await startServer({ dataDir, runsDir, runRetentionLimit: 3, port: 0, sessionToken: token, pollIntervalMs: 80 });

    // Create 4 finished runs; only the latest 3 should be retained
    for (let i = 1; i <= 4; i++) {
      await api(`${p}/runs`, 'POST', { id: `run-${i}` });
      await api(`${p}/runs/run-${i}/finish`, 'POST');
    }
    const listedAfter4 = await api(`${p}/runs`);
    expect(listedAfter4.data.runs.map((r: { id: string }) => r.id)).toEqual(['run-4', 'run-3', 'run-2']);
    expect((await api(`${p}/runs/run-1`)).status).toBe(404);

    // Start an unfinished run, edit step 1, then stop the server without finishing the run
    await api(`${p}/runs`, 'POST', { id: 'run-unfinished' });
    const currentStep1 = (await api(t1)).data;
    await agent(t1, 'PUT', { ...currentStep1.document, title: 'Edited before crash' }, currentStep1.revision);

    await service.close();
    service = await startServer({ dataDir, runsDir, runRetentionLimit: 3, port: 0, sessionToken: token, pollIntervalMs: 80 });

    // Unfinished run should now be marked interrupted and can be undone
    const recovered = await api(`${p}/runs/run-unfinished`);
    expect(recovered.status).toBe(200);
    expect(recovered.data.run.status).toBe('interrupted');

    const preview = await api(`${p}/runs/run-unfinished/undo`, 'GET');
    expect(preview.data.plan.canUndo).toBe(true);
    const undone = await api(`${p}/runs/run-unfinished/undo`, 'POST', {
      confirm: preview.data.plan.confirmationToken,
    });
    expect(undone.status).toBe(200);
    expect((await api(t1)).data).toEqual(step1);
  });

  it('refuses a second concurrent run on the same project and refuses undoing an older run until newer runs are undone', async () => {
    const { step1 } = await setupProject();

    await api(`${p}/runs`, 'POST', { id: 'run-a' });
    // Second run while run-a is running is refused
    const second = await api(`${p}/runs`, 'POST', { id: 'run-b' });
    expect(second.status).toBe(409);
    expect(second.data.error.code).toBe('RUN_IN_PROGRESS');

    const editA = await agent(t1, 'PUT', { ...step1.document, title: 'After Run A' }, step1.revision);
    await api(`${p}/runs/run-a/finish`, 'POST');

    // Start and finish a second run-b
    await api(`${p}/runs`, 'POST', { id: 'run-b' });
    await agent(t1, 'PUT', { ...editA.data.document, title: 'After Run B' }, editA.data.revision);
    await api(`${p}/runs/run-b/finish`, 'POST');

    // Trying to undo older run-a while run-b is not undone is refused with 409 NEWER_RUN_EXISTS
    const undoOld = await api(`${p}/runs/run-a/undo`, 'GET');
    expect(undoOld.status).toBe(409);
    expect(undoOld.data.error.code).toBe('NEWER_RUN_EXISTS');

    // Undo run-b first
    const previewB = await api(`${p}/runs/run-b/undo`, 'GET');
    expect((await api(`${p}/runs/run-b/undo`, 'POST', { confirm: previewB.data.plan.confirmationToken })).status).toBe(200);
    expect((await api(t1)).data.document.title).toBe('After Run A');

    // Now run-a can be undone cleanly
    const previewA = await api(`${p}/runs/run-a/undo`, 'GET');
    expect(previewA.status).toBe(200);
    expect((await api(`${p}/runs/run-a/undo`, 'POST', { confirm: previewA.data.plan.confirmationToken })).status).toBe(200);
    expect((await api(t1)).data).toEqual(step1);
  });

  it('keeps restore points out of project listings, project folders, and watcher events', async () => {
    await setupProject();
    const stream = await events();
    const beforeCount = stream.messages.length;

    await api(`${p}/runs`, 'POST', { id: 'run-isolation' });
    await api(`${p}/runs/run-isolation/finish`, 'POST');

    const projects = (await api('/api/projects')).data.projects;
    expect(projects.map((proj: { id: string }) => proj.id)).toEqual(['p']);

    const projectFiles = await readdir(join(dataDir, 'p'), { recursive: true });
    expect(projectFiles.some((f) => f.includes('run-isolation'))).toBe(false);

    const runFiles = await readdir(join(runsDir, 'p'));
    expect(runFiles).toEqual(['run-isolation.json']);

    // Trigger a watcher barrier on project p and verify no run-related events were ever emitted
    const current = (await api(t1)).data;
    const barrierBytes = JSON.stringify({ ...current.document, title: 'Watcher barrier' });
    await writeFile(join(dataDir, 'p/scenes/s/steps/t1.json'), barrierBytes);
    await stream.next((e) => e.id === 't1' && e.revision === hash(barrierBytes), beforeCount);

    const newEvents = stream.messages.slice(beforeCount) as ChangeEvent[];
    expect(newEvents.every((e) => e.projectId === 'p' && !e.id.includes('run'))).toBe(true);
  });
  it('preserves a person-only step and two agent edits undo without a false warning', async () => {
    const { step1, step2 } = await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'mixed' });
    const human = await api(t1, 'PUT', { ...step1.document, speakerNotes: 'Human only' }, step1.revision);
    const first = await agent(t2, 'PUT', { ...step2.document, title: 'Agent first' }, step2.revision);
    await agent(t2, 'PUT', { ...first.data.document, title: 'Agent second' }, first.data.revision);
    await api(`${p}/runs/mixed/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/mixed/undo`)).data;
    expect(plan.requiresForce).toBe(false);
    expect(plan.warnings).toEqual([]);
    expect(plan.changes.stepsToRestore.map((step: { id: string }) => step.id)).toEqual(['t2']);
    await api(`${p}/runs/mixed/undo`, 'POST', { confirm: plan.confirmationToken });
    expect((await api(t1)).data).toEqual(human.data);
    expect((await api(t2)).data).toEqual(step2);
  });

  it.each(['person-first', 'agent-first', 'person-between-agent-writes'])('requires force for both authors on one step, %s', async (sequence) => {
    const { step1 } = await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'both' });
    let current = step1;
    const person = async () => { current = (await api(t1, 'PUT', { ...current.document, speakerNotes: 'Human notes' }, current.revision)).data; };
    const machine = async () => { current = (await agent(t1, 'PUT', { ...current.document, title: `Agent ${current.revision}` }, current.revision)).data; };
    if (sequence === 'person-first') { await person(); await machine(); }
    else { await machine(); await person(); if (sequence === 'person-between-agent-writes') await machine(); }
    await api(`${p}/runs/both/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/both/undo`)).data;
    expect(plan.requiresForce).toBe(true);
    expect(plan.warnings).toEqual([expect.objectContaining({ code: 'STEP_MODIFIED_CONCURRENTLY', id: 't1', title: current.document.title, message: expect.stringMatching(/revert.*human|revert.*person/) })]);
    expect((await api(`${p}/runs/both/undo`, 'POST', { confirm: plan.confirmationToken })).data.error.code).toBe('FORCE_REQUIRED');
    expect((await api(t1)).data).toEqual(current);
    await api(`${p}/runs/both/undo`, 'POST', { confirm: plan.confirmationToken, force: true });
    expect((await api(t1)).data).toEqual(step1);
  });

  it('preserves person-only creations, deletions and order while removing agent-created items', async () => {
    const { step1, step2 } = await setupProject();
    await api(`${p}/scenes`, 'POST', { id: 'other', name: 'Other' });
    await api(`${p}/runs`, 'POST', { id: 'human-structure' });
    const humanScene = (await api(`${p}/scenes`, 'POST', { id: 'human', name: 'Human scene' })).data;
    const humanStep = (await api(`${s}/steps`, 'POST', { id: 'human-step', title: 'Human step' })).data;
    await agent(`${s}/steps`, 'POST', { id: 'agent-step', title: 'Agent step' });
    await api(t1, 'DELETE', undefined, step1.revision);
    const scene = (await api(s)).data;
    await api(`${s}/steps`, 'PUT', { ids: ['human-step', 't2', 'agent-step'] }, scene.revision);
    const project = (await api(p)).data;
    await api(`${p}/scenes`, 'PUT', { ids: ['human', 'other', 's'] }, project.revision);
    await agent(t2, 'PUT', { ...step2.document, title: 'Agent' }, step2.revision);
    await api(`${p}/runs/human-structure/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/human-structure/undo`)).data;
    expect(plan.requiresForce).toBe(false);
    expect(plan.warnings).toEqual([]);
    await api(`${p}/runs/human-structure/undo`, 'POST', { confirm: plan.confirmationToken });
    expect((await api(t1)).status).toBe(404);
    expect((await api(t2)).data).toEqual(step2);
    expect((await api(`${s}/steps/human-step`)).data).toEqual(humanStep);
    expect((await api(`${p}/scenes/human`)).data).toEqual(humanScene);
    expect((await api(s)).data.document.stepIds).toEqual(['human-step', 't2']);
    expect((await api(p)).data.document.sceneIds).toEqual(['human', 'other', 's']);
  });

  it.each(['person-first', 'agent-first', 'after-run'])('requires force for mixed step and scene order changes, %s', async (sequence) => {
    await setupProject();
    await api(`${p}/scenes`, 'POST', { id: 'other', name: 'Other' });
    await api(`${p}/runs`, 'POST', { id: 'order' });
    const reorder = async (person: boolean, reversed: boolean) => {
      const scene = (await api(s)).data;
      const write = person ? api : agent;
      await write(`${s}/steps`, 'PUT', { ids: reversed ? ['t2', 't1'] : ['t1', 't2'] }, scene.revision);
      const project = (await api(p)).data;
      await write(`${p}/scenes`, 'PUT', { ids: reversed ? ['other', 's'] : ['s', 'other'] }, project.revision);
    };
    if (sequence === 'person-first') { await reorder(true, true); await reorder(false, false); }
    else { await reorder(false, true); if (sequence === 'agent-first') await reorder(true, false); }
    await api(`${p}/runs/order/finish`, 'POST');
    if (sequence === 'after-run') await reorder(true, false);
    const { plan } = (await api(`${p}/runs/order/undo`)).data;
    expect(plan.requiresForce).toBe(true);
    expect(plan.warnings.map((w: { code: string }) => w.code)).toEqual([sequence === 'after-run' ? 'ORDER_MODIFIED_AFTER_RUN' : 'ORDER_MODIFIED_CONCURRENTLY', sequence === 'after-run' ? 'ORDER_MODIFIED_AFTER_RUN' : 'ORDER_MODIFIED_CONCURRENTLY']);
    expect((await api(`${p}/runs/order/undo`, 'POST', { confirm: plan.confirmationToken })).data.error.code).toBe('FORCE_REQUIRED');
    expect((await api(`${p}/runs/order/undo`, 'POST', { confirm: plan.confirmationToken, force: true })).status).toBe(200);
  });

  it('keeps a scene created by the agent when a person adds a step during the run', async () => {
    await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'scene' });
    await agent(`${p}/scenes`, 'POST', { id: 'agent-scene', name: 'Agent scene' });
    const scene = `${p}/scenes/agent-scene`;
    const human = (await api(`${scene}/steps`, 'POST', { id: 'human-step', title: 'Human step' })).data;
    await agent(`${scene}/steps`, 'POST', { id: 'agent-step', title: 'Agent step' });
    await api(`${p}/runs/scene/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/scene/undo`)).data;
    expect(plan.requiresForce).toBe(false);
    expect(plan.warnings).toEqual([expect.objectContaining({ code: 'SCENE_HAS_POST_RUN_STEPS', id: 'agent-scene' })]);
    expect(plan.changes.scenesToKeepWithPostRunSteps[0].retainedStepIds).toEqual(['human-step']);
    await api(`${p}/runs/scene/undo`, 'POST', { confirm: plan.confirmationToken });
    expect((await api(`${scene}/steps/human-step`)).data).toEqual(human);
    expect((await api(scene)).data.document.stepIds).toEqual(['human-step']);
  });

  it('requires force when a person edits an agent-created step before another agent edit', async () => {
    await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'created-both' });
    const created = (await agent(`${s}/steps`, 'POST', { id: 'new', title: 'Agent' })).data;
    const human = (await api(`${s}/steps/new`, 'PUT', { ...created.document, speakerNotes: 'Human' }, created.revision)).data;
    await agent(`${s}/steps/new`, 'PUT', { ...human.document, title: 'Agent again' }, human.revision);
    await api(`${p}/runs/created-both/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/created-both/undo`)).data;
    expect(plan.requiresForce).toBe(true);
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'STEP_MODIFIED_CONCURRENTLY', id: 'new' }));
  });

  it.each(['during', 'after'])('warns before recreating a step a person deleted %s the run', async (when) => {
    const { step1, step2 } = await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'delete' });
    const changed = (await agent(t1, 'PUT', { ...step1.document, title: 'Agent' }, step1.revision)).data;
    if (when === 'after') await api(`${p}/runs/delete/finish`, 'POST');
    await api(t1, 'DELETE', undefined, changed.revision);
    await api(t2, 'DELETE', undefined, step2.revision);
    if (when === 'during') await api(`${p}/runs/delete/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/delete/undo`)).data;
    expect(plan.requiresForce).toBe(true);
    expect(plan.warnings).toEqual([expect.objectContaining({ code: 'STEP_DELETED', id: 't1' })]);
    await api(`${p}/runs/delete/undo`, 'POST', { confirm: plan.confirmationToken, force: true });
    expect((await api(t1)).data).toEqual(step1);
    expect((await api(t2)).status).toBe(404);
  });

  it('restores agent-deleted steps and scenes while preserving human order among live items', async () => {
    const { step1 } = await setupProject();
    await api(`${s}/steps`, 'POST', { id: 't3', title: 'Three' });
    const other = `${p}/scenes/other`;
    await api(`${p}/scenes`, 'POST', { id: 'other', name: 'Other' });
    const otherStep = (await api(`${other}/steps`, 'POST', { id: 'other-step', title: 'Other step' })).data;
    await api(`${p}/runs`, 'POST', { id: 'agent-delete' });
    await agent(t1, 'DELETE', undefined, step1.revision);
    const otherScene = (await api(other)).data;
    await agent(other, 'DELETE', undefined, otherScene.revision);
    const scene = (await api(s)).data;
    await api(`${s}/steps`, 'PUT', { ids: ['t3', 't2'] }, scene.revision);
    await api(`${p}/runs/agent-delete/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/agent-delete/undo`)).data;
    expect(plan.requiresForce).toBe(false);
    expect(plan.warnings).toEqual([]);
    expect(plan.changes.scenesToRecreate).toEqual([{ id: 'other', name: 'Other' }]);
    expect((await api(`${p}/runs/agent-delete/undo`, 'POST', { confirm: plan.confirmationToken })).status).toBe(200);
    expect((await api(t1)).data).toEqual(step1);
    expect((await api(`${other}/steps/other-step`)).data).toEqual(otherStep);
    expect((await api(s)).data.document.stepIds.filter((id: string) => id !== 't1')).toEqual(['t3', 't2']);
  });

  it('tracks external edits before an agent write and human-created steps later edited by the agent', async () => {
    const { step1 } = await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'external' });
    const external = { ...step1.document, speakerNotes: 'External human edit' };
    await writeFile(join(dataDir, 'p/scenes/s/steps/t1.json'), JSON.stringify(external));
    const current = (await api(t1)).data;
    await agent(t1, 'PUT', { ...current.document, title: 'Agent' }, current.revision);
    const created = (await api(`${s}/steps`, 'POST', { id: 'human-step', title: 'Human created' })).data;
    await agent(`${s}/steps/human-step`, 'PUT', { ...created.document, title: 'Agent changed' }, created.revision);
    await api(`${p}/runs/external/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/external/undo`)).data;
    expect(plan.requiresForce).toBe(true);
    expect(plan.warnings.map((w: { id: string; code: string }) => [w.id, w.code])).toEqual([['t1', 'STEP_MODIFIED_CONCURRENTLY'], ['human-step', 'STEP_MODIFIED_CONCURRENTLY']]);
    await api(`${p}/runs/external/undo`, 'POST', { confirm: plan.confirmationToken, force: true });
    expect((await api(`${s}/steps/human-step`)).data).toEqual(created);
  });

  it('warns about human changes to an agent-created empty scene', async () => {
    await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'scene-rename' });
    const scene = (await agent(`${p}/scenes`, 'POST', { id: 'new', name: 'Agent' })).data;
    await api(`${p}/scenes/new`, 'PATCH', { name: 'Human' }, scene.revision);
    await api(`${p}/runs/scene-rename/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/scene-rename/undo`)).data;
    expect(plan.requiresForce).toBe(true);
    expect(plan.warnings).toContainEqual(expect.objectContaining({ code: 'SCENE_MODIFIED_CONCURRENTLY', id: 'new' }));
  });

  it('does not attach agent writes outside a run to the next run', async () => {
    const { step1 } = await setupProject();
    const changed = (await agent(t1, 'PUT', { ...step1.document, title: 'Agent outside a run' }, step1.revision)).data;
    await api(`${p}/runs`, 'POST', { id: 'empty' });
    await api(`${p}/runs/empty/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/empty/undo`)).data;
    expect(plan.changes.stepsToRestore).toEqual([]);
    await api(`${p}/runs/empty/undo`, 'POST', { confirm: plan.confirmationToken });
    expect((await api(t1)).data).toEqual(changed);
  });

  it('refuses undo for legacy restore points whose authors cannot be recovered', async () => {
    await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'legacy' });
    await api(`${p}/runs/legacy/finish`, 'POST');
    const path = join(runsDir, 'p/legacy.json');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    delete stored.attributionVersion;
    delete stored.observedState;
    await writeFile(path, JSON.stringify(stored));
    expect((await api(`${p}/runs/legacy`)).status).toBe(200);
    expect((await api(`${p}/runs/legacy/undo`)).data.error.code).toBe('RUN_ATTRIBUTION_UNKNOWN');
    expect((await api(`${p}/runs/legacy/undo`, 'POST', { confirm: 'old', force: true })).data.error.code).toBe('RUN_ATTRIBUTION_UNKNOWN');
  });

  it('does not attribute a no-op agent order request to the run', async () => {
    await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'no-op' });
    const scene = (await api(s)).data;
    const reordered = (await api(`${s}/steps`, 'PUT', { ids: ['t2', 't1'] }, scene.revision)).data;
    await agent(`${s}/steps`, 'PUT', { ids: ['t2', 't1'] }, reordered.revision);
    await api(`${p}/runs/no-op/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/no-op/undo`)).data;
    expect(plan.requiresForce).toBe(false);
    expect(plan.warnings).toEqual([]);
    expect(plan.changes.orderChanges).toEqual([]);
    await api(`${p}/runs/no-op/undo`, 'POST', { confirm: plan.confirmationToken });
    expect((await api(s)).data.document.stepIds).toEqual(['t2', 't1']);
  });

  it('restores the placement of human-created items moved by an agent reorder', async () => {
    await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'human-additions' });
    await api(`${s}/steps`, 'POST', { id: 'human', title: 'Human step' });
    await api(`${p}/scenes`, 'POST', { id: 'human-scene', name: 'Human scene' });
    const scene = (await api(s)).data;
    await agent(`${s}/steps`, 'PUT', { ids: ['human', 't2', 't1'] }, scene.revision);
    const project = (await api(p)).data;
    await agent(`${p}/scenes`, 'PUT', { ids: ['human-scene', 's'] }, project.revision);
    await api(`${p}/runs/human-additions/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/human-additions/undo`)).data;
    expect(plan.requiresForce).toBe(false);
    expect(plan.warnings).toEqual([]);
    await api(`${p}/runs/human-additions/undo`, 'POST', { confirm: plan.confirmationToken });
    expect((await api(s)).data.document.stepIds).toEqual(['t1', 't2', 'human']);
    expect((await api(p)).data.document.sceneIds).toEqual(['s', 'human-scene']);
  });

  it('undoes agent order in a retained agent-created scene without losing human steps', async () => {
    await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'retained-order' });
    const createdScene = `${p}/scenes/created`;
    await agent(`${p}/scenes`, 'POST', { id: 'created', name: 'Agent scene' });
    await api(`${createdScene}/steps`, 'POST', { id: 'human-a', title: 'A' });
    await api(`${createdScene}/steps`, 'POST', { id: 'human-b', title: 'B' });
    const scene = (await api(createdScene)).data;
    await agent(`${createdScene}/steps`, 'PUT', { ids: ['human-b', 'human-a'] }, scene.revision);
    await api(`${p}/runs/retained-order/finish`, 'POST');
    const { plan } = (await api(`${p}/runs/retained-order/undo`)).data;
    expect(plan.requiresForce).toBe(false);
    expect(plan.warnings).toEqual([expect.objectContaining({ code: 'SCENE_HAS_POST_RUN_STEPS' })]);
    await api(`${p}/runs/retained-order/undo`, 'POST', { confirm: plan.confirmationToken });
    expect((await api(createdScene)).data.document.stepIds).toEqual(['human-a', 'human-b']);
  });

  it('preserves attribution across interruption and warns about subsequent order and step edits', async () => {
    const { step1, step2 } = await setupProject();
    await api(`${p}/runs`, 'POST', { id: 'interrupted' });
    const changed = (await agent(t1, 'PUT', { ...step1.document, title: 'Agent' }, step1.revision)).data;
    const human = (await api(t2, 'PUT', { ...step2.document, speakerNotes: 'Human only' }, step2.revision)).data;
    const scene = (await api(s)).data;
    await agent(`${s}/steps`, 'PUT', { ids: ['t2', 't1'] }, scene.revision);
    await service.close();
    service = await startServer({ dataDir, runsDir, port: 0, sessionToken: token });
    await api(t1, 'PUT', { ...changed.document, speakerNotes: 'Human after interruption' }, changed.revision);
    const currentScene = (await api(s)).data;
    await api(`${s}/steps`, 'PUT', { ids: ['t1', 't2'] }, currentScene.revision);
    const { plan } = (await api(`${p}/runs/interrupted/undo`)).data;
    expect(plan.requiresForce).toBe(true);
    expect(plan.warnings.map((w: { code: string }) => w.code)).toEqual(['STEP_MODIFIED_AFTER_RUN', 'ORDER_MODIFIED_AFTER_RUN']);
    await api(`${p}/runs/interrupted/undo`, 'POST', { confirm: plan.confirmationToken, force: true });
    expect((await api(t1)).data).toEqual(step1);
    expect((await api(t2)).data).toEqual(human);
  });

});
