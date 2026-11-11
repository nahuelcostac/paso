import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '@paso/server';
import { createStep, type Step } from '@paso/shared';
import { ApiClient } from '../lib/api';
import { StepActions, StructureError } from './step-actions';
import { StepStore, type Draft, type Recovery, type Session, type Target } from './step-store';

/** The real service on a temporary folder and the real store. Only the canvas is played by the test. */
const token = 'actions-test-session-token-with-32-chars-or-more';
type Service = Awaited<ReturnType<typeof startServer>>;
let service: Service; let dataDir: string; let api: ApiClient; let store: StepStore; let actions: StepActions;
const element = (id: string) => ({ id, type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false, x: 0, y: 0, width: 50, height: 50 });
const memory = (): Recovery => { const drafts = new Map<string, Draft>(); return { read: async (key) => drafts.get(key), write: async (key, draft) => { drafts.set(key, structuredClone(draft)); }, remove: async (key) => { drafts.delete(key); } }; };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'paso-actions-'));
  service = await startServer({ dataDir, port: 0, sessionToken: token, pollIntervalMs: 100 });
  api = new ApiClient({ baseUrl: service.url, token });
  store = new StepStore(api, memory(), 60_000);
  actions = new StepActions(api, store);
  await api.createProject({ name: 'P' }).then(async ({ document }) => { expect(document.id).toBeTruthy(); });
});
afterEach(async () => { store.stopTimers(); await service.close(); await rm(dataDir, { recursive: true, force: true }); });

/** A scene with steps. `first` carries a drawing, a title and speaker notes. */
async function scene(count = 3) {
  const projectId = (await api.listProjects())[0].id;
  const sceneId = (await api.createScene(projectId, 'Escena 1')).document.id;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const created = await api.createStep(projectId, sceneId, i === 0 ? { elements: [element('r1')], title: 'Uno', speakerNotes: 'nota' } : { elements: [element(`e${i}`)] });
    ids.push(created.document.id);
  }
  return { projectId, sceneId, ids, target: (index: number): Target => ({ projectId, sceneId, stepId: ids[index] }) };
}
const order = async (s: { projectId: string; sceneId: string }) => (await api.getScene(s.projectId, s.sceneId)).document.stepIds;
const content = async (s: { projectId: string; sceneId: string }, id: string) => (await api.getStep({ ...s, stepId: id })).document;
const elementIds = (step: Step) => step.elements.map((e) => e.id);
/** What the canvas does: the first onChange is the baseline, later ones are edits. */
function open(session: Session) { session.baseline = undefined; store.change(session, session.document.elements, session.document.appState, {}); return session; }
function drawing(session: Session, id: string) { store.change(session, [...session.document.elements, element(id)], session.document.appState, {}); }

describe('Añadir paso and Duplicar paso', () => {
  it('Añadir: a new step right after the current one, from its latest drawing, with no title or notes', async () => {
    const s = await scene(); await store.select(s.target(0)); const session = open(store.current()!);
    drawing(session, 'late');                       // not saved yet: the debounce has not fired
    expect(session.status).toBe('dirty');
    const id = await actions.add(s.projectId, s.sceneId, s.ids[0]);
    expect(await order(s)).toEqual([s.ids[0], id, s.ids[1], s.ids[2]]);
    const added = await content(s, id);
    expect(elementIds(added)).toEqual(['r1', 'late']);   // the same element IDs, including the edit made just before
    expect(added.title).toBeUndefined(); expect(added.speakerNotes).toBeUndefined();
    expect(elementIds(await content(s, s.ids[0]))).toEqual(['r1', 'late']);   // and the step it came from was saved
    expect(session.status).toBe('saved');
  });
  it('Añadir in an empty scene makes a blank step', async () => {
    const s = await scene(0);
    const id = await actions.add(s.projectId, s.sceneId, undefined);
    expect(await order(s)).toEqual([id]); expect((await content(s, id)).elements).toEqual([]);
  });
  it('adds from the final step even when that step was never opened', async () => {
    const s = await scene();
    await store.select(s.target(0)); open(store.current()!);
    const id = await actions.add(s.projectId, s.sceneId, s.ids[2]);
    expect(await order(s)).toEqual([...s.ids, id]);
    expect(elementIds(await content(s, id))).toEqual(['e2']);
  });
  it('Duplicar with a save pending: the copy has the latest content, title and notes, right after the original', async () => {
    const s = await scene(); await store.select(s.target(0)); const session = open(store.current()!);
    drawing(session, 'late'); drawing(session, 'later');
    const id = await actions.duplicate(s.target(0));
    expect(await order(s)).toEqual([s.ids[0], id, s.ids[1], s.ids[2]]);
    const copy = await content(s, id);
    expect(elementIds(copy)).toEqual(['r1', 'late', 'later']); expect(copy.title).toBe('Uno'); expect(copy.speakerNotes).toBe('nota');
    expect(copy.id).not.toBe(s.ids[0]);
    expect(elementIds(await content(s, s.ids[0]))).toEqual(['r1', 'late', 'later']);
  });
  it('Duplicar a step the store never opened works from the service copy', async () => {
    const s = await scene();
    const id = await actions.duplicate(s.target(2));
    expect(await order(s)).toEqual([s.ids[0], s.ids[1], s.ids[2], id]);
  });
  it('Duplicar retries when an autosave lands between the flush and the copy', async () => {
    const s = await scene(); await store.select(s.target(0)); const session = open(store.current()!);
    const real = api.duplicateStep.bind(api); let calls = 0;
    api.duplicateStep = async (target, revision) => {
      if (calls++ === 0) { drawing(session, 'sneaked'); await store.flush(target); }   // the revision the copy was asked for is now stale
      return real(target, revision);
    };
    const id = await actions.duplicate(s.target(0));
    expect(calls).toBe(2);
    expect(elementIds(await content(s, id))).toEqual(['r1', 'sneaked']);
  });
  it('refuses to copy a step whose changes are not on the service, and changes nothing', async () => {
    const s = await scene(); await store.select(s.target(0)); const session = open(store.current()!);
    drawing(session, 'mine');
    const current = await api.getStep(s.target(0));
    await api.saveStep(s.target(0), current.revision, { ...current.document, title: 'externo' });   // somebody else saved first
    await expect(actions.duplicate(s.target(0))).rejects.toBeInstanceOf(StructureError);
    expect(session.status).toBe('conflict');
    expect(await order(s)).toEqual(s.ids);
    await expect(actions.add(s.projectId, s.sceneId, s.ids[0])).rejects.toThrow('cambios sin guardar');
    expect(await order(s)).toEqual(s.ids);
  });
});

describe('reordering', () => {
  it('moves one place, runs held-down presses one after another, and stops at the ends', async () => {
    const s = await scene(4);
    const results = await Promise.all([actions.nudge(s.projectId, s.sceneId, s.ids[3], -1), actions.nudge(s.projectId, s.sceneId, s.ids[3], -1), actions.nudge(s.projectId, s.sceneId, s.ids[3], -1), actions.nudge(s.projectId, s.sceneId, s.ids[3], -1)]);
    expect(await order(s)).toEqual([s.ids[3], s.ids[0], s.ids[1], s.ids[2]]);
    expect(results.map((r) => r.index)).toEqual([2, 1, 0, 0]);
  });
  it('moves a step to a position and keeps the others in order', async () => {
    const s = await scene(4);
    expect(await actions.move(s.projectId, s.sceneId, s.ids[0], 2)).toEqual([s.ids[1], s.ids[2], s.ids[0], s.ids[3]]);
    expect(await order(s)).toEqual([s.ids[1], s.ids[2], s.ids[0], s.ids[3]]);
  });
  it('keeps a pending edit in its own step while the order changes', async () => {
    const s = await scene(3); await store.select(s.target(1)); const session = open(store.current()!);
    drawing(session, 'pending');
    await actions.nudge(s.projectId, s.sceneId, s.ids[1], -1);
    await store.flush(s.target(1));
    expect(await order(s)).toEqual([s.ids[1], s.ids[0], s.ids[2]]);
    expect(elementIds(await content(s, s.ids[1]))).toEqual(['e1', 'pending']);
    expect(elementIds(await content(s, s.ids[0]))).toEqual(['r1']);
  });
  it('recovers from a scene that changed outside: reads it again and applies the move', async () => {
    const s = await scene(3);
    await api.createStep(s.projectId, s.sceneId, {});      // somebody else adds a step, so any scene revision held earlier is stale
    const ids = await actions.move(s.projectId, s.sceneId, s.ids[2], 0);
    expect(ids[0]).toBe(s.ids[2]); expect(ids).toHaveLength(4);
  });
});

describe('deleting a step', () => {
  it('moves to the next step, or to the previous one when it was the last, and ends with an empty scene', async () => {
    const s = await scene(3); await store.select(s.target(1)); open(store.current()!);
    expect(await actions.remove(s.target(1))).toBe(s.ids[2]);
    expect(await order(s)).toEqual([s.ids[0], s.ids[2]]);
    expect(await actions.remove(s.target(2))).toBe(s.ids[0]);
    expect(await actions.remove(s.target(0))).toBeUndefined();
    expect(await order(s)).toEqual([]);
    expect(await readdir(join(dataDir, s.projectId, 'scenes', s.sceneId, 'steps'))).toEqual([]);
  });
  it('deleting the current step with edits pending leaves no file, no warning and nothing that comes back', async () => {
    const s = await scene(2); await store.select(s.target(0)); const session = open(store.current()!);
    drawing(session, 'doomed');
    expect(await actions.remove(s.target(0))).toBe(s.ids[1]);
    drawing(session, 'from the old canvas'); await store.flushAll();   // the canvas is still mounted for a moment
    expect(await order(s)).toEqual([s.ids[1]]);
    expect(await readdir(join(dataDir, s.projectId, 'scenes', s.sceneId, 'steps'))).toEqual([`${s.ids[1]}.json`]);
    expect(store.unresolved()).toEqual([]); expect(store.current()).toBeUndefined();
  });
  it('says so and keeps the step when it changed outside in the meantime', async () => {
    const s = await scene(2); await store.select(s.target(0)); open(store.current()!);
    const current = await api.getStep(s.target(0));
    await api.saveStep(s.target(0), current.revision, { ...current.document, title: 'externo' });
    await expect(actions.remove(s.target(0))).rejects.toThrow('cambió fuera de Paso');
    expect(await order(s)).toEqual(s.ids);
  });
});

describe('scenes', () => {
  it('creates a scene with one blank step', async () => {
    const s = await scene(1);
    const created = await actions.createScene(s.projectId, 'Escena 2');
    const scenes = await api.listScenes(s.projectId);
    expect(scenes.map(({ document }) => document.name)).toEqual(['Escena 1', 'Escena 2']);
    expect(scenes[1].document.stepIds).toEqual([created.stepId]);
    expect(createStep().elements).toEqual((await content({ projectId: s.projectId, sceneId: created.sceneId }, created.stepId)).elements);
  });
});
