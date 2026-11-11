import { useSyncExternalStore } from 'react';
import { ApiClient, ApiRequestError, UnavailableError } from '../lib/api';
import { ActionError, type ServiceEvent } from './projects-store';

export type SceneEntry = { id: string; name: string; revision: string; stepIds: string[] };
/** What the Storyboard shows about a step: its title, and its revision so thumbnails know when to redraw. */
export type StepEntry = { id: string; title?: string; revision: string; /** It has a presentation camera. */ framed?: true };

export type StoryboardState = {
  /** loading: nothing known yet. ready: scenes are listed. error: they could not be read. */
  phase: 'loading' | 'ready' | 'error';
  scenes: SceneEntry[];
  /** Steps are read per scene, once the scene nears the screen. Until then a scene knows only its step IDs. */
  steps: Record<string, StepEntry>;
  stepsLoaded: Record<string, true>;
};

type Subscribe = (listener: (event: ServiceEvent) => void) => () => void;

/** The thumbnail key of a scene: every step revision, or null while any is still unknown. */
export function sceneKey(state: StoryboardState, scene: SceneEntry): string | null {
  if (!state.stepsLoaded[scene.id] || scene.stepIds.length === 0) return null;
  const revisions: string[] = [];
  for (const id of scene.stepIds) {
    const step = state.steps[id];
    if (!step) return null;
    revisions.push(step.revision);
  }
  return revisions.join('|');
}

/**
 * Keeps one project's scenes and steps in step with the service. Scenes are read when it starts;
 * a scene's steps are read when asked for. Events from the stream, including edits made outside the
 * app, re-read only what they name. Changes made here show at once and are confirmed by the service.
 */
export class StoryboardStore {
  private state: StoryboardState = { phase: 'loading', scenes: [], steps: {}, stepsLoaded: {} };
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private structureDirty = false;
  private dirtyScenes = new Set<string>();
  private sceneVersion = 0;
  private stepVersions = new Map<string, number>();
  /** While a change of ours is in flight, reading the service would show the old order for a moment. */
  private inflight = 0;
  private disposed = false;

  constructor(private readonly api: ApiClient, readonly projectId: string, private readonly events: Subscribe) {}

  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<StoryboardState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  start() {
    this.disposed = false;
    this.unsubscribe = this.events((event) => this.onEvent(event));
    void this.loadScenes();
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined;
  }
  /** The retry button after a failed first read. */
  retry() { this.set({ phase: 'loading' }); void this.loadScenes(); }

  private onEvent(event: ServiceEvent) {
    if (event.type === 'ready') {
      // A reconnect: there is no replay log, so everything that was read is read again.
      this.structureDirty = true;
      for (const id of Object.keys(this.state.stepsLoaded)) this.dirtyScenes.add(id);
      this.schedule(0);
      return;
    }
    if (event.projectId !== this.projectId || event.kind === 'asset' || event.type === 'project-error') return;
    if (event.kind === 'step') {
      if (event.sceneId) this.dirtyScenes.add(event.sceneId);
      // A step's own edit changes no scene; creating, removing or reordering one does.
      if (event.type !== 'updated') this.structureDirty = true;
    } else if (event.type !== 'deleted' || event.kind !== 'project') this.structureDirty = true;
    this.schedule(100);
  }
  private schedule(delay: number) {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), delay);
  }
  private async flush() {
    this.flushTimer = undefined;
    if (this.disposed) return;
    if (this.inflight > 0) return; // The change in flight schedules this again when it ends.
    const structure = this.structureDirty;
    const scenes = [...this.dirtyScenes];
    this.structureDirty = false; this.dirtyScenes.clear();
    if (structure) await this.loadScenes();
    for (const id of scenes) if (this.state.stepsLoaded[id] && this.state.scenes.some((scene) => scene.id === id)) void this.refreshSteps(id);
  }

  private async loadScenes() {
    const version = ++this.sceneVersion;
    try {
      const listed = await this.api.listScenes(this.projectId);
      if (version !== this.sceneVersion || this.disposed) return;
      const scenes = listed.map(({ document, revision }): SceneEntry => ({ id: document.id, name: document.name, revision, stepIds: document.stepIds }));
      const before = new Map(this.state.scenes.map((scene) => [scene.id, scene]));
      const keep = new Set(scenes.map((scene) => scene.id));
      const stepsLoaded = Object.fromEntries(Object.keys(this.state.stepsLoaded).filter((id) => keep.has(id)).map((id) => [id, true as const]));
      this.set({ phase: 'ready', scenes, stepsLoaded });
      // A scene that gained or lost steps needs its steps read again.
      for (const scene of scenes) {
        const previous = before.get(scene.id);
        if (previous && stepsLoaded[scene.id] && previous.stepIds.join() !== scene.stepIds.join()) void this.refreshSteps(scene.id);
      }
    } catch {
      if (version !== this.sceneVersion || this.disposed) return;
      // With scenes on screen, a failed re-read keeps them: the project list reports the lost connection.
      if (this.state.phase !== 'ready') this.set({ phase: 'error' });
    }
  }

  /** Read a scene's steps once. Asked for by a scene that is near the screen. */
  ensureSteps(sceneId: string) {
    if (this.state.stepsLoaded[sceneId] || this.stepVersions.has(sceneId)) return;
    void this.refreshSteps(sceneId);
  }
  private async refreshSteps(sceneId: string) {
    const version = (this.stepVersions.get(sceneId) ?? 0) + 1;
    this.stepVersions.set(sceneId, version);
    try {
      const listed = await this.api.listSteps(this.projectId, sceneId);
      if (this.stepVersions.get(sceneId) !== version || this.disposed) return;
      const steps = { ...this.state.steps };
      for (const { document, revision } of listed) steps[document.id] = { id: document.id, revision, ...(document.title ? { title: document.title } : {}), ...(document.camera ? { framed: true as const } : {}) };
      this.set({ steps, stepsLoaded: { ...this.state.stepsLoaded, [sceneId]: true } });
    } catch {
      // The scene may have been deleted meanwhile, or the service is away. Asking again after the next event is enough.
      if (this.stepVersions.get(sceneId) === version) this.stepVersions.delete(sceneId);
    }
  }

  /** Runs a change of ours. It then reads the service again, so what is shown is what was saved. */
  private async change<T>(action: () => Promise<T>): Promise<T> {
    this.inflight += 1;
    try { return await action(); }
    catch (error) { return await this.fail(error); }
    finally {
      this.inflight -= 1;
      this.structureDirty = true;
      this.schedule(0);
    }
  }
  /** Turns a failure into words for the person, and reads the project again when it was out of date. */
  private async fail(error: unknown): Promise<never> {
    if (error instanceof UnavailableError) throw new ActionError('No hay conexión con el servicio local.');
    if (error instanceof ApiRequestError) {
      if (error.status === 409 || error.status === 428 || error.status === 400) throw new ActionError('La escena cambió fuera de Paso. Ya está actualizada: inténtalo de nuevo.');
      if (error.status === 404) throw new ActionError('La escena ya no existe.');
      if (error.status === 422) throw new ActionError('Los archivos del diagrama no son válidos.');
    }
    throw new ActionError('Inténtalo de nuevo.');
  }

  /** A title saved from here shows at once; the service's event confirms it. */
  showTitle(stepId: string, title: string) {
    const step = this.state.steps[stepId];
    if (!step) return;
    const named: StepEntry = { ...step };
    if (title.trim()) named.title = title.trim(); else delete named.title;
    this.set({ steps: { ...this.state.steps, [stepId]: named } });
  }

  /** Appends a scene and returns its ID. The caller can then offer its name for editing. */
  createScene() {
    return this.change(async () => {
      const { document, revision } = await this.api.createScene(this.projectId, `Escena ${this.state.scenes.length + 1}`);
      const entry: SceneEntry = { id: document.id, name: document.name, revision, stepIds: document.stepIds };
      if (!this.state.scenes.some((scene) => scene.id === entry.id)) this.set({ scenes: [...this.state.scenes, entry], stepsLoaded: { ...this.state.stepsLoaded, [entry.id]: true } });
      return entry.id;
    });
  }
  renameScene(id: string, name: string) {
    return this.change(async () => {
      // The scene's own revision, read now: it may have changed since the list was read.
      const { revision } = await this.api.getScene(this.projectId, id);
      const result = await this.api.renameScene(this.projectId, id, revision, name);
      this.set({ scenes: this.state.scenes.map((scene) => scene.id === id ? { ...scene, name: result.document.name, revision: result.revision } : scene) });
    });
  }
  deleteScene(id: string) {
    return this.change(async () => {
      const { revision } = await this.api.getScene(this.projectId, id);
      await this.api.deleteScene(this.projectId, id, revision);
      this.stepVersions.delete(id);
      this.set({ scenes: this.state.scenes.filter((scene) => scene.id !== id) });
    });
  }
  /** `ids` is the new order of all scenes. It shows at once and is saved after. */
  reorderScenes(ids: string[]) {
    const byId = new Map(this.state.scenes.map((scene) => [scene.id, scene]));
    const ordered = ids.map((id) => byId.get(id)).filter((scene): scene is SceneEntry => !!scene);
    if (ordered.length !== this.state.scenes.length) return Promise.resolve();
    this.set({ scenes: ordered });
    return this.change(async () => {
      const { revision } = await this.api.getProject(this.projectId);
      await this.api.reorderScenes(this.projectId, revision, ids);
    });
  }
  /** A step added at the end of a scene, blank. Its frame appears through the events that follow. */
  createStep(sceneId: string) {
    return this.change(async () => {
      const { document } = await this.api.createStep(this.projectId, sceneId);
      this.dirtyScenes.add(sceneId);
      return document.id;
    });
  }
}

export function useStoryboard(store: StoryboardStore) {
  return useSyncExternalStore(store.subscribe, store.getState);
}
