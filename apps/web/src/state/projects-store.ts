import { useSyncExternalStore } from 'react';
import type { Project } from '@paso/shared';
import { ApiClient, ApiRequestError, UnavailableError, type ProjectListItem } from '../lib/api';

export type ProjectRow =
  | { kind: 'ok'; id: string; project: Project; revision: string; scenes: number; steps: number }
  | { kind: 'error'; id: string; message: string };

export type StoreState = {
  /** loading: nothing known yet. ready: rows are valid. unavailable: nothing to show and no connection. */
  phase: 'loading' | 'ready' | 'unavailable';
  /** False while the event stream is down. With rows already loaded they stay on screen, marked as possibly stale. */
  connected: boolean;
  /** Why the service cannot be reached, when it cannot. */
  reason: 'network' | 'session' | 'server' | null;
  rows: ProjectRow[];
};

/** A failed action. `message` is the reason, a sentence that follows "No se pudo …". */
export class ActionError extends Error {}

const sortRows = (rows: ProjectRow[]) => [...rows].sort((a, b) => {
  if (a.kind !== b.kind) return a.kind === 'ok' ? -1 : 1;
  if (a.kind === 'ok' && b.kind === 'ok' && a.project.createdAt !== b.project.createdAt) return a.project.createdAt < b.project.createdAt ? 1 : -1;
  return a.id < b.id ? -1 : 1;
});

export type ServiceEvent = { type: string; kind?: string; projectId?: string; sceneId?: string; id?: string; revision?: string | null; message?: string };

/**
 * Keeps the project list in step with the service. It opens the event stream first, waits for
 * `ready`, then reads everything, and applies later events by re-reading only the project they name.
 */
export class ProjectsStore {
  private eventListeners = new Set<(event: ServiceEvent) => void>();
  subscribeEvents = (listener: (event: ServiceEvent) => void) => { this.eventListeners.add(listener); return () => { this.eventListeners.delete(listener); }; };
  private state: StoreState = { phase: 'loading', connected: false, reason: null, rows: [] };
  private listeners = new Set<() => void>();
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private dirty = new Set<string>();
  private versions = new Map<string, number>();
  private disposed = false;

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
      for (const id of ids) void this.refresh(id);
    }, 120);
  }

  private async toRow(item: ProjectListItem): Promise<ProjectRow> {
    if ('error' in item) return { kind: 'error', id: item.id, message: item.error.message };
    const scenes = await this.api.listScenes(item.id);
    const steps = scenes.reduce((total, { document }) => total + document.stepIds.length, 0);
    return { kind: 'ok', id: item.id, project: item.document, revision: item.revision, scenes: scenes.length, steps };
  }

  private async loadAll() {
    try {
      const items = await this.api.listProjects();
      const rows = await Promise.all(items.map((item) => this.toRow(item).catch((error) => {
        // A project that broke between the two requests is shown as a row with its error.
        if (error instanceof ApiRequestError) return { kind: 'error', id: item.id, message: error.message } as ProjectRow;
        throw error;
      })));
      this.attempts = 0;
      this.versions.clear();
      this.set({ phase: 'ready', connected: true, reason: null, rows: sortRows(rows) });
    } catch {
      // Reading failed after the stream opened: treat it like a lost connection.
      this.release();
      void this.lost();
    }
  }

  /** Re-read one project. Older answers never overwrite newer ones. */
  async refresh(id: string) {
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
        throw new ActionError('El proyecto cambió fuera de Paso. Ya está actualizado: inténtalo de nuevo.');
      }
      if (error.status === 404) {
        if (id) await this.refresh(id);
        throw new ActionError('El proyecto ya no existe.');
      }
      if (error.status === 422) {
        if (id) await this.refresh(id);
        throw new ActionError('Los archivos del proyecto no son válidos.');
      }
    }
    throw new ActionError('Inténtalo de nuevo.');
  }

  private okRow(id: string) {
    const row = this.state.rows.find((candidate) => candidate.id === id);
    if (row?.kind !== 'ok') throw new ActionError('Este proyecto no se puede editar.');
    return row;
  }

  async create(name: string) {
    try {
      const { document, revision } = await this.api.createProject({ name });
      this.setRows((rows) => [...rows.filter((row) => row.id !== document.id), { kind: 'ok', id: document.id, project: document, revision, scenes: 0, steps: 0 }]);
      return document.id;
    } catch (error) { return this.fail(error); }
  }
  async update(id: string, input: { name?: string; icon?: string | null }) {
    const row = this.okRow(id);
    try {
      const { document, revision } = await this.api.updateProject(id, row.revision, input);
      this.setRows((rows) => rows.map((existing) => existing.id === id && existing.kind === 'ok' ? { ...existing, project: document, revision } : existing));
    } catch (error) { return this.fail(error, id); }
  }
  async remove(id: string) {
    const row = this.okRow(id);
    try {
      await this.api.deleteProject(id, row.revision);
      this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
      this.setRows((rows) => rows.filter((existing) => existing.id !== id));
    } catch (error) { return this.fail(error, id); }
  }
}

export function useProjects(store: ProjectsStore) {
  return useSyncExternalStore(store.subscribe, store.getState);
}
