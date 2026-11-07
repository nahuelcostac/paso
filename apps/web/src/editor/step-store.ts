import { parseStep, persistedAppStateSchema, type Step, type ExcalidrawElement } from '@paso/shared';
import { ApiRequestError } from '../lib/api';

export type Target = { projectId: string; sceneId: string; stepId: string };
export type Envelope = { document: Step; revision: string };
export type Binary = { id: string; dataURL: string; mimeType: string; created: number; version?: number };
export type Binaries = Record<string, Binary>;
export type Draft = { document: Step; revision: string; binaries: Binaries };
export interface Recovery {
  read(key: string): Promise<Draft | undefined>;
  write(key: string, draft: Draft): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface StepTransport {
  getStep(target: Target): Promise<Envelope>;
  saveStep(target: Target, revision: string, document: Step, keepalive?: boolean): Promise<Envelope>;
  uploadFiles(target: Target, document: Step, binaries: Binaries, keepalive?: boolean): Promise<void>;
  deleteStep(target: Target, revision: string): Promise<void>;
}
export type SaveState = 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict';
export type Session = Draft & { target: Target; status: SaveState; generation: number; canvasVersion: number; baseline?: string; error?: string };
export const targetKey = (target: Target) => `${target.projectId}/${target.sceneId}/${target.stepId}`;
const signature = (step: Step) => JSON.stringify([step.elements, step.appState, step.files]);

/** Canvas-independent owner of detached snapshots. An async operation captures its session,
 * target, revision and document. It never looks up the active step to finish a write. */
export class StepStore {
  private sessions = new Map<string, Session>();
  private saves = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private recoveries = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private active?: string;
  private version = 0;
  private loads = new Map<string, number>();
  private eventVersions = new Map<string, number>();
  private deferredEvents = new Map<string, string | null>();
  /** Steps deleted through remove(). Late callbacks from their old canvas must not bring them back. */
  private removed = new Set<string>();
  /** Revisions this client wrote, per step. The service echoes each write as an event, and an echo
   * that arrives late must never look like somebody else's edit. */
  private written = new Map<string, Set<string>>();
  constructor(private api: StepTransport, private recovery: Recovery, private debounceMs = 500) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.version;
  current = () => this.active ? this.sessions.get(this.active) : undefined;
  all = () => [...this.sessions.values()];
  session = (target: Target) => this.sessions.get(targetKey(target));
  /** Steps whose local work is not on the service: a failed save or a conflict. Clean steps never appear here. */
  unresolved = () => this.all().filter((session) => !this.removed.has(targetKey(session.target)) && (session.status === 'failed' || session.status === 'conflict'));
  private wrote(key: string, revision: string) {
    const set = this.written.get(key) ?? new Set<string>();
    set.add(revision); this.written.set(key, set);
  }
  private emit() { this.version++; this.listeners.forEach((listener) => listener()); }
  private persist(session: Session) {
    const key = targetKey(session.target);
    const draft = structuredClone({ document: session.document, revision: session.revision, binaries: session.binaries });
    const pending = (this.recoveries.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.recovery.write(key, draft));
    this.recoveries.set(key, pending);
    // Local storage failure is visible and leaves the in-memory drawing intact.
    void pending.catch(() => { session.error = 'No se pudo guardar la copia de recuperación en este navegador.'; this.emit(); });
  }
  async select(target: Target) {
    const previous = this.current();
    if (previous && targetKey(previous.target) !== targetKey(target)) void this.flush(previous.target);
    this.active = targetKey(target);
    this.emit();
    const existing = this.current();
    // Coming back to a step whose save failed is a good moment to try again: the service may be back.
    if (existing?.status === 'failed') void this.flush(target);
    if (existing && existing.status !== 'saved') return;
    await this.refresh(target, true);
  }
  private async refresh(target: Target, recover = false) {
    const key = targetKey(target);
    const load = (this.loads.get(key) ?? 0) + 1;
    this.loads.set(key, load);
    try {
      const fresh = await this.api.getStep(target);
      const draft = recover && !this.sessions.has(key) ? await this.recovery.read(key) : undefined;
      if (this.loads.get(key) !== load) return;
      const current = this.sessions.get(key);
      // Edits made while GET was in flight win over the GET.
      if (current && current.status !== 'saved') {
        if (fresh.revision !== current.revision) {
          if (this.saves.has(key)) this.deferredEvents.set(key, fresh.revision);
          else { current.status = 'conflict'; this.persist(current); this.emit(); }
        }
        return;
      }
      if (current?.revision === fresh.revision) return;
      const restored = draft && signature(draft.document) !== signature(fresh.document) ? draft : undefined;
      const session: Session = {
        ...(restored ?? { document: parseStep(fresh.document), revision: fresh.revision, binaries: {} }),
        target: { ...target }, status: restored ? (restored.revision === fresh.revision ? 'dirty' : 'conflict') : 'saved',
        generation: 0, canvasVersion: (current?.canvasVersion ?? 0) + 1,
      };
      this.sessions.set(key, session);
      this.emit();
      if (session.status === 'dirty') this.schedule(session);
      if (this.deferredEvents.has(key)) {
        const revision = this.deferredEvents.get(key)!; this.deferredEvents.delete(key);
        await this.external(target, revision);
      }
    } catch (error) {
      const current = this.sessions.get(key);
      if (current) { current.error = String(error); this.emit(); }
      else throw error;
    }
  }
  /** First onChange is Excalidraw restoring the document. It establishes the render baseline,
   * without writing normalization or selection state back to disk. */
  change(session: Session, elements: readonly ExcalidrawElement[], appState: unknown, binaries: Binaries) {
    if (this.removed.has(targetKey(session.target))) return;
    const originals = new Map(session.document.elements.map((element) => [element.id, element]));
    const files = { ...session.document.files };
    const retained = { ...session.binaries };
    for (const element of elements) {
      const id = element.fileId;
      if (!id || files[id]) continue;
      const binary = binaries[id];
      if (!binary) throw new Error('Faltan los datos de una imagen.');
      const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' } as Record<string, string>)[binary.mimeType];
      if (!ext) throw new Error('Formato de imagen no compatible.');
      files[id] = { path: `assets/${id}.${ext}`, mimeType: binary.mimeType, created: binary.created, ...(binary.version === undefined ? {} : { version: binary.version }) };
      retained[id] = structuredClone(binary);
    }
    const candidate = parseStep({ ...session.document, elements: elements.map((element) => ({ ...originals.get(element.id), ...element })), appState: persistedAppStateSchema.parse(appState), files });
    const next = signature(candidate);
    if (session.baseline === undefined) { session.baseline = next; return; }
    if (session.baseline === next) return;
    session.baseline = next;
    // A clean external reload can finish just before React unmounts the old canvas.
    // Preserve an edit from that canvas as a conflict instead of losing it.
    if (this.sessions.get(targetKey(session.target)) !== session) {
      session.status = 'conflict'; session.canvasVersion++;
      this.sessions.set(targetKey(session.target), session);
    }
    session.document = candidate;
    session.binaries = retained;
    session.generation++;
    if (session.status !== 'conflict') session.status = 'dirty';
    this.persist(session);
    this.emit();
    this.schedule(session);
  }
  fail(session: Session, message: string) { session.status = 'failed'; session.error = message; this.emit(); }
  private schedule(session: Session) {
    const key = targetKey(session.target);
    if (this.removed.has(key)) return;
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.flush(session.target); }, this.debounceMs));
  }
  async flush(target: Target, keepalive = false): Promise<void> {
    const key = targetKey(target);
    if (this.removed.has(key)) return;
    clearTimeout(this.timers.get(key)); this.timers.delete(key);
    const inflight = this.saves.get(key);
    if (inflight) { await inflight; const next = this.sessions.get(key); if (next?.status === 'dirty') return this.flush(target, keepalive); return; }
    const session = this.sessions.get(key);
    if (!session || session.status === 'saved' || session.status === 'conflict') return;
    const document = structuredClone(session.document);
    const binaries = structuredClone(session.binaries);
    const revision = session.revision;
    const generation = session.generation;
    session.status = 'saving'; this.emit();
    const operation = (async () => {
      try {
        await this.api.uploadFiles(session.target, document, binaries, keepalive);
        const result = await this.api.saveStep(session.target, revision, document, keepalive);
        session.revision = result.revision;
        this.wrote(key, result.revision);
        for (const id of Object.keys(binaries)) {
          if (session.binaries[id]?.dataURL === binaries[id].dataURL) delete session.binaries[id];
        }
        if (session.status !== 'conflict') session.status = session.generation === generation ? 'saved' : 'dirty';
        session.error = undefined;
        // Serialize recovery removal with writes from newer edits.
        const pending = (this.recoveries.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
          if (session.status === 'saved') await this.recovery.remove(key);
          else await this.recovery.write(key, structuredClone({ document: session.document, revision: session.revision, binaries: session.binaries }));
        });
        this.recoveries.set(key, pending);
        await pending;
      } catch (error) {
        session.status = error instanceof ApiRequestError && error.status === 409 ? 'conflict' : 'failed';
        session.error = session.status === 'failed' ? 'No se pudo guardar. Tu trabajo sigue en este navegador.' : undefined;
        this.persist(session);
      } finally { this.saves.delete(key); this.emit(); }
      if (this.deferredEvents.has(key)) {
        const event = this.deferredEvents.get(key)!; this.deferredEvents.delete(key);
        await this.external(session.target, event);
      }
    })();
    this.saves.set(key, operation);
    await operation;
    if (this.sessions.get(key)?.status === 'dirty') await this.flush(target, keepalive);
  }
  /** Call on hidden/pagehide and on leaving the editor. A rejected request retains its draft. */
  flushAll = async (keepalive = false) => { await Promise.all(this.all().map((session) => this.flush(session.target, keepalive))); };
  hasUnsaved = () => this.all().some((session) => session.status !== 'saved');
  async external(target: Target, revision: string | null) {
    const key = targetKey(target);
    this.eventVersions.set(key, (this.eventVersions.get(key) ?? 0) + 1);
    const session = this.sessions.get(key);
    if (!session) {
      if (this.loads.has(key)) this.deferredEvents.set(key, revision);
      return;
    }
    if (session.revision === revision || (revision !== null && this.written.get(key)?.has(revision))) return;
    if (this.saves.has(key)) { this.deferredEvents.set(key, revision); return; }
    // A clean step that vanished has no local work to protect: forget it instead of warning about it.
    if (revision === null && session.status === 'saved') { this.forget(key); return; }
    if (session.status !== 'saved') { session.status = 'conflict'; this.persist(session); this.emit(); return; }
    await this.refresh(target);
  }
  private forget(key: string) {
    this.sessions.delete(key); this.loads.delete(key); this.eventVersions.delete(key); this.deferredEvents.delete(key); this.written.delete(key);
    clearTimeout(this.timers.get(key)); this.timers.delete(key);
    if (this.active === key) this.active = undefined;
    this.emit();
  }
  /** Deletes a step on the service. Pending edits to it are discarded (the person confirmed), but a save already
   * on its way is awaited first, so the delete carries the revision that save produced. If the delete fails,
   * the step stays as it was and any pending edits are scheduled again. */
  async remove(target: Target) {
    const key = targetKey(target);
    this.removed.add(key);
    clearTimeout(this.timers.get(key)); this.timers.delete(key);
    try {
      await this.saves.get(key)?.catch(() => {});
      const session = this.sessions.get(key);
      const revision = session?.status === 'conflict' || !session ? (await this.api.getStep(target)).revision : session.revision;
      try { await this.api.deleteStep(target, revision); }
      catch (error) { if (!(error instanceof ApiRequestError && error.status === 404)) throw error; }
    } catch (error) {
      this.removed.delete(key);
      const session = this.sessions.get(key);
      if (session?.status === 'dirty') this.schedule(session);
      throw error;
    }
    this.forget(key);
    await (this.recoveries.get(key) ?? Promise.resolve()).catch(() => {});
    await this.recovery.remove(key).catch(() => {});
  }
  /** The UI downloads the local document before the person explicitly chooses the server copy. */
  async useServer(session: Session) {
    const key = targetKey(session.target);
    const generation = session.generation;
    const events = this.eventVersions.get(key);
    // Invalidate a GET started before this explicit choice.
    this.loads.set(key, (this.loads.get(key) ?? 0) + 1);
    const unchanged = () => session.generation === generation && this.sessions.get(key) === session && this.eventVersions.get(key) === events;
    const changed = () => new Error('El dibujo cambió durante la carga. Descarga una copia nueva e inténtalo de nuevo.');
    const fresh = await this.api.getStep(session.target);
    if (!unchanged()) throw changed();
    const removal = (this.recoveries.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!unchanged()) throw changed();
      await this.recovery.remove(key);
    });
    this.recoveries.set(key, removal);
    await removal;
    if (!unchanged()) { this.persist(session); throw changed(); }
    this.sessions.set(key, { target: session.target, ...fresh, binaries: {}, status: 'saved', generation: 0, canvasVersion: session.canvasVersion + 1 });
    this.emit();
  }
  stopTimers() { this.timers.forEach(clearTimeout); this.timers.clear(); }
}
