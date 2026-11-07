import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStep, type Step } from '@paso/shared';
import { ApiRequestError } from '../lib/api';
import { StepStore, type Draft, type Envelope, type Target, type Recovery, type StepTransport, type Session } from './step-store';

const a = { projectId: 'p', sceneId: 's', stepId: 'a' };
const b = { ...a, stepId: 'b' };
const element = (id: string) => ({ id, type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false, x: 0, y: 0, width: 50, height: 50 });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup() {
  const documents = new Map(['a', 'b'].map((id) => [id, { document: createStep({ id }), revision: 'r0' }]));
  const drafts = new Map<string, Draft>();
  const recovery: Recovery = { read: vi.fn(async (key) => drafts.get(key)), write: vi.fn(async (key, draft) => { drafts.set(key, structuredClone(draft)); }), remove: vi.fn(async (key) => { drafts.delete(key); }) };
  const api: StepTransport = {
    getStep: vi.fn(async (target: Target) => structuredClone(documents.get(target.stepId)!)),
    saveStep: vi.fn(async (target: Target, revision: string, document: Step) => {
      expect(revision).toBe(documents.get(target.stepId)!.revision);
      const result = { document: structuredClone(document), revision: `${revision}+` };
      documents.set(target.stepId, result); return result;
    }),
    uploadFiles: vi.fn(async () => {}),
    deleteStep: vi.fn(async (target: Target, revision: string) => { expect(revision).toBe(documents.get(target.stepId)!.revision); documents.delete(target.stepId); }),
  };
  const store = new StepStore(api, recovery, 500);
  return { api, store, recovery, documents, drafts };
}
function mount(store: StepStore) { const session = store.current()!; session.baseline = undefined; store.change(session, session.document.elements, session.document.appState, {}); return session; }
function draw(store: StepStore, session: Session, id: string) { store.change(session, [...session.document.elements, element(id)], { ...session.document.appState, selectedElementIds: { [id]: true }, scrollX: 123, theme: 'dark' }, {}); }
afterEach(() => vi.useRealTimers());

describe('step isolation and autosave', () => {
  it('flushes on switch, survives rapid switching, and ignores late loads', async () => {
    const { store, api, documents } = setup();
    await store.select(a); const sa = mount(store); draw(store, sa, 'only-a');
    await store.select(b); const sb = mount(store); draw(store, sb, 'only-b');
    await store.select(a); mount(store); await store.select(b); mount(store);
    await store.flushAll();
    expect(documents.get('a')!.document.elements.map((e) => e.id)).toEqual(['only-a']);
    expect(documents.get('b')!.document.elements.map((e) => e.id)).toEqual(['only-b']);
    const loading = deferred<Envelope>();
    vi.mocked(api.getStep).mockImplementationOnce(() => loading.promise);
    const selectA = store.select(a); await store.select(b);
    loading.resolve(documents.get('a')!); await selectA;
    expect(store.current()!.target).toEqual(b);
    store.stopTimers();
  });
  it('binds a slow write to its original step and saves edits made during that write', async () => {
    const { store, api, documents } = setup();
    await store.select(a); const sa = mount(store); draw(store, sa, 'first');
    const slow = deferred<Envelope>();
    const normalSave = api.saveStep;
    vi.mocked(api.saveStep).mockImplementationOnce(() => slow.promise);
    const saving = store.flush(a); await Promise.resolve();
    await store.select(b); const sb = mount(store); draw(store, sb, 'b');
    draw(store, sa, 'second');
    const result = { document: { ...sa.document, elements: [element('first')] }, revision: 'r1' };
    documents.set('a', result); slow.resolve(result);
    await saving; await store.flushAll();
    expect(api.saveStep).toBe(normalSave);
    expect(documents.get('a')!.document.elements.map((e) => e.id)).toEqual(['first', 'second']);
    expect(documents.get('b')!.document.elements.map((e) => e.id)).toEqual(['b']);
    store.stopTimers();
  });
  it('does not save restore normalization, selection, zoom, scroll or theme; debounces actual edits', async () => {
    vi.useFakeTimers();
    const { store, api } = setup(); await store.select(a); const sa = mount(store);
    store.change(sa, [], { ...sa.document.appState, zoom: { value: 2 }, scrollX: 5, selectedElementIds: { x: true }, theme: 'dark' }, {});
    await vi.advanceTimersByTimeAsync(1000); expect(api.saveStep).not.toHaveBeenCalled();
    draw(store, sa, 'x'); await vi.advanceTimersByTimeAsync(300); draw(store, sa, 'y');
    await vi.advanceTimersByTimeAsync(499); expect(api.saveStep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(api.saveStep).toHaveBeenCalledTimes(1);
    expect(sa.document.appState).toEqual({ viewBackgroundColor: '#ffffff' });
  });
  it('retains unknown nested fields and deleted-element tombstones', async () => {
    const { store, documents } = setup();
    documents.get('a')!.document.elements = [{ ...element('gone'), isDeleted: true, future: { nested: ['kept'] } }];
    await store.select(a); const sa = mount(store);
    store.change(sa, [{ ...element('gone'), isDeleted: true }, element('new')], {}, {}); await store.flushAll();
    expect(documents.get('a')!.document.elements[0]).toMatchObject({ isDeleted: true, future: { nested: ['kept'] } });
  });
  it('keeps local work on 409 and never retries over the new revision', async () => {
    const { store, api, drafts } = setup(); await store.select(a); const sa = mount(store); draw(store, sa, 'mine');
    vi.mocked(api.saveStep).mockRejectedValue(new ApiRequestError(409, 'CONFLICT', 'changed'));
    await store.flushAll(); await store.flushAll();
    expect(sa.status).toBe('conflict'); expect(sa.document.elements[0].id).toBe('mine');
    expect(api.saveStep).toHaveBeenCalledTimes(1); expect(drafts.get('p/s/a')!.document.elements[0].id).toBe('mine');
    store.stopTimers();
  });
  it('reloads an external update when clean and keeps local edits when dirty', async () => {
    const { store, documents } = setup(); await store.select(a);
    documents.set('a', { document: { ...createStep({ id: 'a' }), elements: [element('external')] }, revision: 'r1' });
    await store.external(a, 'r1'); expect(store.current()!.document.elements[0].id).toBe('external');
    const sa = mount(store); draw(store, sa, 'mine');
    documents.set('a', { document: createStep({ id: 'a' }), revision: 'r2' });
    await store.external(a, 'r2'); expect(sa.status).toBe('conflict'); expect(sa.document.elements.map((e) => e.id)).toContain('mine');
    store.stopTimers();
  });
  it('ignores its own event arriving before the PUT response, but detects a later external revision', async () => {
    const { store, api } = setup(); await store.select(a); const sa = mount(store); draw(store, sa, 'mine');
    const slow = deferred<Envelope>(); vi.mocked(api.saveStep).mockImplementationOnce(() => slow.promise);
    const save = store.flush(a); await Promise.resolve(); await store.external(a, 'r1');
    slow.resolve({ document: sa.document, revision: 'r1' }); await save; expect(sa.status).toBe('saved');
    draw(store, sa, 'more'); const next = deferred<Envelope>(); vi.mocked(api.saveStep).mockImplementationOnce(() => next.promise);
    const save2 = store.flush(a); await Promise.resolve(); await store.external(a, 'external');
    draw(store, sa, 'pending'); next.resolve({ document: sa.document, revision: 'r2' }); await save2;
    expect(sa.status).toBe('conflict'); store.stopTimers();
  });
  it('protects edits made while refreshing a clean step', async () => {
    const { store, api } = setup(); await store.select(a); const sa = mount(store);
    const slow = deferred<Envelope>(); vi.mocked(api.getStep).mockImplementationOnce(() => slow.promise);
    const refresh = store.external(a, 'other'); draw(store, sa, 'during-get');
    slow.resolve({ document: createStep({ id: 'a' }), revision: 'other' }); await refresh;
    expect(sa.status).toBe('conflict'); expect(sa.document.elements[0].id).toBe('during-get'); store.stopTimers();
  });
  it('keeps a failed save and lets the person retry; uploads images before the snapshot', async () => {
    const { store, api, drafts } = setup(); await store.select(a); const sa = mount(store);
    const binary = { id: 'image', mimeType: 'image/png', created: 1, dataURL: 'data:image/png;base64,eA==' };
    store.change(sa, [{ ...element('picture'), type: 'image', fileId: 'image' }], {}, { image: binary });
    vi.mocked(api.saveStep).mockRejectedValueOnce(new Error('offline')); await store.flushAll();
    expect(sa.status).toBe('failed'); expect(drafts.get('p/s/a')!.binaries.image).toEqual(binary);
    await store.flushAll(); expect(sa.status).toBe('saved'); expect(drafts.size).toBe(0);
    expect(sa.document.files.image.path).toBe('assets/image.png');
    expect(vi.mocked(api.uploadFiles).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.saveStep).mock.invocationCallOrder[0]);
  });
  it('recovers across reload, and marks a stale recovered revision as conflict', async () => {
    const { store, api, recovery, documents } = setup(); await store.select(a); const sa = mount(store); draw(store, sa, 'recovered');
    await Promise.resolve(); await Promise.resolve(); store.stopTimers();
    const reload = new StepStore(api, recovery); await reload.select(a); expect(reload.current()!.document.elements[0].id).toBe('recovered');
    expect(reload.current()!.status).toBe('dirty'); reload.stopTimers();
    documents.set('a', { document: createStep({ id: 'a' }), revision: 'other' });
    const stale = new StepStore(api, recovery); await stale.select(a); expect(stale.current()!.status).toBe('conflict'); stale.stopTimers();
  });
});

it('reconciles an event received during the very first GET', async () => {
  const { store, api, documents } = setup();
  const slow = deferred<Envelope>(); vi.mocked(api.getStep).mockImplementationOnce(() => slow.promise);
  const loading = store.select(a); const old = structuredClone(documents.get('a')!);
  documents.set('a', { document: { ...createStep({ id: 'a' }), elements: [element('after-get')] }, revision: 'new' });
  await store.external(a, 'new'); slow.resolve(old); await loading;
  expect(store.current()!.document.elements[0].id).toBe('after-get');
});
it('defers a GET revision that could be the in-flight save itself', async () => {
  const { store, api } = setup(); await store.select(a); const session = mount(store);
  const get = deferred<Envelope>(); vi.mocked(api.getStep).mockImplementationOnce(() => get.promise);
  const refresh = store.external(a, 'r1'); draw(store, session, 'mine');
  const put = deferred<Envelope>(); vi.mocked(api.saveStep).mockImplementationOnce(() => put.promise);
  const saving = store.flush(a); await Promise.resolve();
  get.resolve({ document: session.document, revision: 'r1' }); await refresh;
  expect(session.status).toBe('saving'); put.resolve({ document: session.document, revision: 'r1' }); await saving;
  expect(session.status).toBe('saved'); store.stopTimers();
});
it('keeps edits made just before the old canvas is unmounted by an external reload', async () => {
  const { store, documents } = setup(); await store.select(a); const old = mount(store);
  documents.set('a', { document: createStep({ id: 'a' }), revision: 'new' }); await store.external(a, 'new');
  draw(store, old, 'last-local-event'); expect(store.current()).toBe(old);
  expect(old.status).toBe('conflict'); expect(old.document.elements[0].id).toBe('last-local-event'); store.stopTimers();
});
it('does not discard edits made while the person loads the server copy after downloading', async () => {
  const { store, api } = setup(); await store.select(a); const session = mount(store); draw(store, session, 'mine');
  await store.external(a, 'new');
  const get = deferred<Envelope>(); vi.mocked(api.getStep).mockImplementationOnce(() => get.promise);
  const replacing = store.useServer(session); draw(store, session, 'during-replace');
  get.resolve({ document: createStep({ id: 'a' }), revision: 'new' }); await expect(replacing).rejects.toThrow(/cambió/);
  expect(store.current()!.document.elements.map((e) => e.id)).toContain('during-replace'); store.stopTimers();
});

describe('warnings that must be true: unresolved steps', () => {
  it('lists only steps whose local work is not on the service', async () => {
    const { store, api } = setup();
    await store.select(a); const sa = mount(store); draw(store, sa, 'mine');
    // The save fails, and leaving the step retries it once more, which fails too.
    vi.mocked(api.saveStep).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    await store.flush(a);
    expect(sa.status).toBe('failed'); expect(store.unresolved()).toEqual([sa]);
    await store.select(b); mount(store); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sa.status).toBe('failed');
    expect(store.unresolved().map((session) => session.target.stepId)).toEqual(['a']);
    await store.flush(a); expect(store.unresolved()).toEqual([]);
    store.stopTimers();
  });
  it('treats an echo of its own earlier write as its own, even when it arrives late', async () => {
    const { store } = setup();
    await store.select(a); const sa = mount(store); draw(store, sa, 'one'); await store.flush(a);
    draw(store, sa, 'two'); await store.flush(a);
    expect(sa.revision).toBe('r0++');
    draw(store, sa, 'three');
    // The service reports r0+ (the first write) after the second one was saved and while the person is editing again.
    await store.external(a, 'r0+');
    expect(sa.status).toBe('dirty');
    // A revision this client never wrote is somebody else's edit.
    await store.external(a, 'somebody-else');
    expect(sa.status).toBe('conflict');
    store.stopTimers();
  });
  it('forgets a clean step that was deleted outside the app instead of calling it a conflict', async () => {
    const { store } = setup();
    await store.select(a); await store.select(b);
    await store.external(a, null);
    expect(store.session(a)).toBeUndefined(); expect(store.unresolved()).toEqual([]);
    // With unsaved work the step stays, because that work is the only copy.
    const sb = mount(store); draw(store, sb, 'mine');
    await store.external(b, null);
    expect(sb.status).toBe('conflict'); expect(store.unresolved()).toEqual([sb]);
    store.stopTimers();
  });
  it('tries a failed save again when the person returns to that step', async () => {
    const { store, api, documents } = setup();
    await store.select(a); const sa = mount(store); draw(store, sa, 'mine');
    vi.mocked(api.saveStep).mockRejectedValueOnce(new Error('offline'));
    await store.flush(a); expect(sa.status).toBe('failed');
    await store.select(b); await store.select(a); await store.flushAll();
    expect(sa.status).toBe('saved'); expect(documents.get('a')!.document.elements.map((e) => e.id)).toEqual(['mine']);
    store.stopTimers();
  });
});

describe('removing a step', () => {
  it('discards pending edits, waits for a save in flight and deletes with the revision that save produced', async () => {
    const { store, api, documents } = setup();
    await store.select(a); const sa = mount(store); draw(store, sa, 'first');
    const slow = deferred<Envelope>(); vi.mocked(api.saveStep).mockImplementationOnce(() => slow.promise);
    const saving = store.flush(a); await Promise.resolve();
    draw(store, sa, 'second');
    const removing = store.remove(a);
    const saved = { document: { ...sa.document, elements: [element('first')] }, revision: 'r1' };
    documents.set('a', saved); slow.resolve(saved);
    await removing; await saving;
    expect(api.deleteStep).toHaveBeenCalledWith(a, 'r1');
    expect(documents.has('a')).toBe(false);
    expect(store.session(a)).toBeUndefined(); expect(store.current()).toBeUndefined();
    // The canvas that was on screen is still alive for a moment. Nothing it does comes back to life.
    draw(store, sa, 'late'); await store.flushAll();
    expect(api.saveStep).toHaveBeenCalledTimes(1);
    expect(store.unresolved()).toEqual([]);
    store.stopTimers();
  });
  it('leaves the step and its pending edit alone when the delete fails', async () => {
    const { store, api, documents } = setup();
    await store.select(a); const sa = mount(store); draw(store, sa, 'mine');
    vi.mocked(api.deleteStep).mockRejectedValueOnce(new ApiRequestError(409, 'CONFLICT', 'stale'));
    await expect(store.remove(a)).rejects.toThrow('stale');
    await store.flushAll();
    expect(documents.get('a')!.document.elements.map((e) => e.id)).toEqual(['mine']);
    expect(store.session(a)).toBe(sa);
    store.stopTimers();
  });
});
