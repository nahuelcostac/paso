import { useSyncExternalStore } from 'react';
import { LOOSE_PROJECT_ID, isLooseProject, type Project, type Scene } from '@paso/shared';
import { ApiClient, ApiRequestError, UnavailableError, type AgentEvent, type ProjectListItem, type WorkspaceListing } from '../lib/api';

export type ProjectRow =
  /** `sceneList` holds the scenes in order, so the sidebar can show them under the row without opening the project. */
  | { kind: 'ok'; id: string; project: Project; revision: string; scenes: number; steps: number; sceneList: Scene[] }
  | { kind: 'error'; id: string; message: string };

/** A loose diagram: one scene, with its steps, that belongs to no project. Its ID is the scene's. */
export type LooseDiagram = { id: string; scene: Scene; revision: string; steps: number };
/** The workspace's reserved project of loose diagrams, or null while it has none. */
export type LooseState = { project: Project; revision: string; diagrams: LooseDiagram[] } | null;

export type StoreState = {
  /** loading: nothing known yet. ready: rows are valid. unavailable: nothing to show and no connection. */
  phase: 'loading' | 'ready' | 'unavailable';
  /** False while the event stream is down. With rows already loaded they stay on screen, marked as possibly stale. */
  connected: boolean;
  /** Why the service cannot be reached, when it cannot. */
  reason: 'network' | 'session' | 'server' | null;
  rows: ProjectRow[];
  /** The loose diagrams, newest first. They are never project rows. */
  loose: LooseState;
  /** The workspaces and the open one. Null until the first read. */
  workspaces: WorkspaceListing | null;
};

/** A failed action. `message` is the reason, a sentence that follows "No se pudo …". */
export class ActionError extends Error {}

// Most recently changed first, as the sidebar groups them by when they last changed.
const sortRows = (rows: ProjectRow[]) => [...rows].sort((a, b) => {
  if (a.kind !== b.kind) return a.kind === 'ok' ? -1 : 1;
  if (a.kind === 'ok' && b.kind === 'ok' && a.project.updatedAt !== b.project.updatedAt) return a.project.updatedAt < b.project.updatedAt ? 1 : -1;
  return a.id < b.id ? -1 : 1;
});

export type ServiceEvent = {
  type: string;
  activeId?: string;
  kind?: string;
  projectId?: string;
  sceneId?: string;
  id?: string;
  revision?: string | null;
  message?: string;
  sessionId?: string;
  runId?: string;
  seq?: number;
  at?: string;
  event?: AgentEvent;
};

/**
 * Keeps the project list in step with the service. It opens the event stream first, waits for
 * `ready`, then reads everything, and applies later events by re-reading only the project they name.
 */
export class ProjectsStore {
  private eventListeners = new Set<(event: ServiceEvent) => void>();
  subscribeEvents = (listener: (event: ServiceEvent) => void) => { this.eventListeners.add(listener); return () => { this.eventListeners.delete(listener); }; };
  private state: StoreState = { phase: 'loading', connected: false, reason: null, rows: [], loose: null, workspaces: null };
  private listeners = new Set<() => void>();
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private dirty = new Set<string>();
  private versions = new Map<string, number>();
  private disposed = false;
  private loading?: number;

  constructor(private readonly api: ApiClient) {}

  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<StoreState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private setRows(update: (rows: ProjectRow[]) => ProjectRow[]) { this.set({ rows: sortRows(update(this.state.rows)) }); }

  start() { this.disposed = false; this.connect(); }
  dispose() {
    this.disposed = true;
    clearTimeout(this.reconnectTimer); clearTimeout(this.flushTimer);
    this.release();
  }
  /** Drops the current socket without reacting to it. One still connecting is closed as soon as it opens, which keeps the console quiet. */
  private release() {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    if (socket.readyState === WebSocket.CONNECTING) socket.onopen = () => socket.close();
    else socket.close();
  }
  /** The retry button: try again now instead of waiting for the next automatic attempt. */
  retry() {
    clearTimeout(this.reconnectTimer);
    if (this.state.phase === 'unavailable') this.set({ phase: 'loading' });
    this.connect();
  }

  private connect() {
    if (this.disposed) return;
    this.release();
    const { url, protocols } = this.api.eventsTarget();
    let socket: WebSocket;
    try { socket = new WebSocket(url, protocols); } catch { void this.lost(); return; }
    this.socket = socket;
    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      try { this.handle(JSON.parse(String(message.data)) as ServiceEvent); } catch { /* Not an event we know. */ }
    };
    socket.onclose = () => { if (this.socket === socket) void this.lost(); };
    socket.onerror = () => { /* onclose follows. */ };
  }

  private async lost() {
    if (this.disposed) return;
    this.socket = undefined;
    let reason: StoreState['reason'] = 'network';
    try { await this.api.health(); } catch (error) { if (error instanceof UnavailableError) reason = error.reason; }
    if (this.disposed || this.socket) return;
    this.set(this.state.phase === 'ready' ? { connected: false, reason } : { phase: 'unavailable', connected: false, reason });
    // Back off up to five seconds. There is no replay log, so a reconnect always re-reads everything.
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), Math.min(5000, 500 * 2 ** (this.attempts - 1)));
  }

  private handle(event: ServiceEvent) {
    this.eventListeners.forEach((listener) => listener(event));
    if (event.type === 'ready') { void this.loadAll(); return; }
    if (event.type === 'workspaces') {
      // Another window, or this one, opened another workspace: its projects replace the list.
      if (event.activeId !== this.state.workspaces?.activeId) void this.loadAll();
      else void this.loadWorkspaces();
      return;
    }
    if (!event.projectId || event.kind === 'asset') return;
    // A step's own edits change nothing the list shows. Creating or removing one is a scene or project event.
    if (event.kind === 'step' && event.type === 'updated') return;
    const known = this.state.rows.find((row) => row.id === event.projectId);
    if (event.kind === 'project' && known?.kind === 'ok' && event.revision === known.revision) return;
    this.dirty.add(event.projectId);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      const ids = [...this.dirty];
      this.dirty.clear();
      for (const id of ids) void (isLooseProject(id) ? this.refreshLoose() : this.refresh(id));
    }, 120);
  }

  private async toRow(item: ProjectListItem): Promise<ProjectRow> {
    if ('error' in item) return { kind: 'error', id: item.id, message: item.error.message };
    const scenes = await this.api.listScenes(item.id);
    const steps = scenes.reduce((total, { document }) => total + document.stepIds.length, 0);
    return { kind: 'ok', id: item.id, project: item.document, revision: item.revision, scenes: scenes.length, steps, sceneList: scenes.map(({ document }) => document) };
  }

  /** The loose diagrams, read from the reserved project. A workspace without any has no such project yet. */
  private async readLoose(): Promise<LooseState> {
    let envelope: { document: Project; revision: string };
    try { envelope = await this.api.getProject(LOOSE_PROJECT_ID); }
    catch (error) { if (error instanceof ApiRequestError && error.status === 404) return null; throw error; }
    const scenes = await this.api.listScenes(LOOSE_PROJECT_ID);
    // Newest first: a new diagram is appended to the reserved project's scene list.
    const diagrams = scenes.map(({ document, revision }) => ({ id: document.id, scene: document, revision, steps: document.stepIds.length })).reverse();
    return { project: envelope.document, revision: envelope.revision, diagrams };
  }
  private looseVersion = 0;
  /** Re-read the loose diagrams. Older answers never overwrite newer ones. */
  async refreshLoose() {
    const version = ++this.looseVersion;
    let loose: LooseState;
    try { loose = await this.readLoose(); }
    catch (error) {
      if (error instanceof UnavailableError) { this.release(); void this.lost(); }
      return;
    }
    if (version !== this.looseVersion || this.disposed) return;
    this.set({ loose });
  }

  private async loadWorkspaces() {
    try { this.set({ workspaces: await this.api.listWorkspaces() }); } catch { /* The next event or reconnect reads it again. */ }
  }

  private async loadAll() {
    const load = (this.loading ?? 0) + 1;
    this.loading = load;
    try {
      const looseVersion = ++this.looseVersion;
      const [items, workspaces, loose] = await Promise.all([this.api.listProjects(), this.api.listWorkspaces(), this.readLoose().catch((error) => {
        if (error instanceof UnavailableError) throw error;
        // Unreadable loose diagrams do not hide the projects; the next change reads them again.
        return null;
      })]);
      const rows = await Promise.all(items.map((item) => this.toRow(item).catch((error) => {
        // A project that broke between the two requests is shown as a row with its error.
        if (error instanceof ApiRequestError) return { kind: 'error', id: item.id, message: error.message } as ProjectRow;
        throw error;
      })));
      // A newer read, after a workspace switch, wins over this one.
      if (this.loading !== load || this.disposed) return;
      this.attempts = 0;
      this.versions.clear();
      this.set({ phase: 'ready', connected: true, reason: null, rows: sortRows(rows), workspaces, ...(looseVersion === this.looseVersion ? { loose } : {}) });
    } catch {
      // Reading failed after the stream opened: treat it like a lost connection.
      this.release();
      void this.lost();
    }
  }

  /** Re-read one project. Older answers never overwrite newer ones. */
  async refresh(id: string) {
    if (isLooseProject(id)) return this.refreshLoose();
    const version = (this.versions.get(id) ?? 0) + 1;
    this.versions.set(id, version);
    let row: ProjectRow | null;
    try {
      const { document, revision } = await this.api.getProject(id);
      row = await this.toRow({ id, document, revision });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) row = null;
      else if (error instanceof ApiRequestError && error.status === 422) row = { kind: 'error', id, message: error.message };
      else if (error instanceof UnavailableError) { this.release(); void this.lost(); return; }
      else return;
    }
    if (this.versions.get(id) !== version || this.disposed) return;
    this.setRows((rows) => [...rows.filter((existing) => existing.id !== id), ...(row ? [row] : [])]);
  }

  /** Turns a failure into words for the person, and re-reads the project when it was out of date. */
  private async fail(error: unknown, id?: string): Promise<never> {
    if (error instanceof UnavailableError) {
      this.release(); void this.lost();
      throw new ActionError('No hay conexión con el servicio local.');
    }
    if (error instanceof ApiRequestError) {
      if (error.status === 409 || error.status === 428) {
        if (id) await this.refresh(id);
        throw new ActionError('El diagrama cambió fuera de Paso. Ya está actualizado: inténtalo de nuevo.');
      }
      if (error.status === 404) {
        if (id) await this.refresh(id);
        throw new ActionError('El diagrama ya no existe.');
      }
      if (error.status === 422) {
        if (id) await this.refresh(id);
        throw new ActionError('Los archivos del diagrama no son válidos.');
      }
    }
    throw new ActionError('Inténtalo de nuevo.');
  }

  /** A write's own answer is newer than any re-read already on its way, which must not overwrite it. */
  private supersede(id: string) { this.versions.set(id, (this.versions.get(id) ?? 0) + 1); }

  private okRow(id: string) {
    const row = this.state.rows.find((candidate) => candidate.id === id);
    if (row?.kind !== 'ok') throw new ActionError('Este diagrama no se puede editar.');
    return row;
  }

  async create(name: string) {
    try {
      const { document, revision } = await this.api.createProject({ name });
      this.supersede(document.id);
      this.setRows((rows) => [...rows.filter((row) => row.id !== document.id), { kind: 'ok', id: document.id, project: document, revision, scenes: 0, steps: 0, sceneList: [] }]);
      return document.id;
    } catch (error) { return this.fail(error); }
  }
  async update(id: string, input: { name?: string; icon?: string | null }) {
    const row = this.okRow(id);
    try {
      const { document, revision } = await this.api.updateProject(id, row.revision, input);
      this.supersede(id);
      this.setRows((rows) => rows.map((existing) => existing.id === id && existing.kind === 'ok' ? { ...existing, project: document, revision } : existing));
    } catch (error) { return this.fail(error, id); }
  }
  private looseDiagram(id: string) {
    const diagram = this.state.loose?.diagrams.find((candidate) => candidate.id === id);
    if (!diagram) throw new ActionError('El diagrama ya no existe.');
    return diagram;
  }
  /** Shows a loose diagram just created elsewhere, such as by the step actions, without waiting for its event. */
  async addedLoose() { await this.refreshLoose(); }
  async renameLoose(id: string, name: string) {
    this.looseDiagram(id);
    try {
      const fresh = await this.api.getScene(LOOSE_PROJECT_ID, id);
      await this.api.renameScene(LOOSE_PROJECT_ID, id, fresh.revision, name);
    } catch (error) { await this.refreshLoose(); return this.fail(error); }
    await this.refreshLoose();
  }
  async removeLoose(id: string) {
    this.looseDiagram(id);
    try {
      const fresh = await this.api.getScene(LOOSE_PROJECT_ID, id);
      await this.api.deleteScene(LOOSE_PROJECT_ID, id, fresh.revision);
    } catch (error) {
      await this.refreshLoose();
      if (error instanceof ApiRequestError && error.status === 404) return;
      return this.fail(error);
    }
    await this.refreshLoose();
  }
  /**
   * Moves a loose diagram into a project as its last scene. The caller saves the open step first. The service copies,
   * checks and only then removes, so a failure leaves the diagram where it was.
   */
  async moveLoose(id: string, projectId: string) {
    this.looseDiagram(id);
    this.okRow(projectId);
    try {
      const fresh = await this.api.getScene(LOOSE_PROJECT_ID, id);
      await this.api.moveScene(LOOSE_PROJECT_ID, id, fresh.revision, projectId);
    } catch (error) {
      await Promise.all([this.refreshLoose(), this.refresh(projectId)]);
      if (error instanceof ApiRequestError && error.code === 'AGENT_RUNNING') throw new ActionError('Espera a que el agente termine.');
      if (error instanceof ApiRequestError && (error.code === 'ID_COLLISION' || error.code === 'ASSET_CONFLICT')) {
        throw new ActionError('El proyecto ya tiene pasos o imágenes con los mismos identificadores.');
      }
      return this.fail(error);
    }
    await Promise.all([this.refreshLoose(), this.refresh(projectId)]);
  }

  /** Opens another workspace and shows its projects. */
  async switchWorkspace(id: string) {
    await this.api.activateWorkspace(id);
    // The list and its projects change together, so nothing shows one workspace's name over another's projects.
    await this.loadAll();
  }
  /** Adds a folder as a workspace and opens it. */
  async addWorkspace(path: string) {
    const added = await this.api.addWorkspace(path);
    await this.switchWorkspace(added.id);
  }
  /** Takes a workspace off the list; the service opens the default one if it was open. Nothing is deleted. */
  async removeWorkspace(id: string) {
    await this.api.removeWorkspace(id);
    await this.loadAll();
  }
  revealWorkspace(id: string) { return this.api.revealWorkspace(id); }
  /** Opens the project's folder in the system's file manager. */
  reveal(id: string) { return this.api.revealProject(id); }
  async remove(id: string) {
    const row = this.okRow(id);
    try {
      await this.api.deleteProject(id, row.revision);
      this.supersede(id);
      this.setRows((rows) => rows.filter((existing) => existing.id !== id));
    } catch (error) { return this.fail(error, id); }
  }
}

/** Words for a failed workspace action, after "No se pudo …". */
export function workspaceErrorText(error: unknown) {
  if (error instanceof UnavailableError) return 'No hay conexión con el servicio local.';
  if (error instanceof ApiRequestError && error.status !== 500) return error.message;
  return 'Inténtalo de nuevo.';
}

export function useProjects(store: ProjectsStore) {
  return useSyncExternalStore(store.subscribe, store.getState);
}
