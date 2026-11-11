import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { idSchema } from '@paso/shared';
import { z } from 'zod';
import { ApiError, isMissing } from '../errors.js';
import { claudeAdapter, failureMessage } from './claude.js';
import { codexAdapter } from './codex.js';
import { effortLevels, harnessIds, type AgentEvent, type AgentRunHooks, type AgentRunRequest, type FailureCode, type HarnessAdapter, type HarnessId } from './types.js';

export type SessionInfo = {
  id: string; harness: HarnessId; projectId: string; sceneId?: string; model?: string;
  state: 'idle' | 'running'; resumable: boolean; createdAt: string; updatedAt: string;
  /** The start of the first message, for the history. Absent until a message was sent. */
  title?: string;
  /** How many messages the conversation has. */
  turns: number;
};
/** What listeners and the event log receive: an adapter event with its place in the session. */
export type SessionEvent = { sessionId: string; runId: string; seq: number; at: string; event: AgentEvent };

export type SessionManagerOptions = {
  /** Adapters by harness. A harness with no adapter cannot start sessions yet. */
  adapters?: Partial<Record<HarnessId, HarnessAdapter>>;
  detect(id: HarnessId): Promise<{ found: boolean; path: string | null; session: string }>;
  /** Throws an ApiError (404) if the project or scene does not exist. */
  validateTarget(projectId: string, sceneId?: string): Promise<void>;
  board(): AgentRunRequest['board'];
  /** Neutral, empty directory the harness runs in. */
  workDir: string;
  dataDir: string;
  /** Index of sessions: IDs, resume tokens, title and size. Must be outside the data directory. */
  sessionsPath: string;
  /** One file per conversation with its messages and events, for the history. Defaults to `agent-transcripts` next to the index. */
  transcriptsDir?: string;
  hooks?: AgentRunHooks;
  maxRunsPerProject?: number;
  maxRuns?: number;
  maxSessions?: number;
  idleTimeoutMs?: number;
  maxRunMs?: number;
  eventLogSize?: number;
};

const recordSchema = z.object({
  id: z.string().uuid(), harness: z.enum(harnessIds), projectId: idSchema, sceneId: idSchema.optional(),
  model: z.string().optional(), resumeToken: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
  title: z.string().max(200).optional(), turns: z.number().int().nonnegative().optional(),
});
type Record_ = z.infer<typeof recordSchema>;
type Session = Record_ & {
  state: 'idle' | 'running'; seq: number; log: SessionEvent[];
  /** Whether `log` holds the stored history yet. It is read when the conversation is first opened or continued. */
  historyLoaded: boolean;
  run?: { id: string; controller: AbortController; finished: Promise<void> };
};

const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/;
const tokenPattern = /^[A-Za-z0-9._:-]{1,200}$/;
const maxMessageChars = 32_000;
const titleChars = 120;
const transcriptEntrySchema = z.object({ sessionId: z.string(), runId: z.string(), seq: z.number().int().positive(), at: z.string(), event: z.object({ type: z.string() }).passthrough() });
const emptyDirNames = new Set(['.DS_Store']);

/** Resolves to the directory if it is a safe place to run an agent. Throws otherwise. */
export function checkWorkDir(workDir: string, dataDir: string) {
  const dir = resolve(workDir);
  const data = resolve(dataDir);
  const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);
  if (dir === resolve(homedir()) || dir === resolve(process.cwd()) || inside(dir, data) || inside(data, dir)) {
    throw new Error('The agent working directory must be a dedicated empty directory, not the home folder, the current folder or the data directory.');
  }
  return dir;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private listeners = new Set<(event: SessionEvent) => void>();
  private loaded?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private closing = false;
  private readonly adapters: Partial<Record<HarnessId, HarnessAdapter>>;
  private readonly workDir: string;

  constructor(private options: SessionManagerOptions) {
    this.adapters = options.adapters ?? { claude: claudeAdapter, codex: codexAdapter };
    this.workDir = checkWorkDir(options.workDir, options.dataDir);
  }

  subscribe(listener: (event: SessionEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  private info(session: Session): SessionInfo {
    return {
      id: session.id, harness: session.harness, projectId: session.projectId,
      ...(session.sceneId ? { sceneId: session.sceneId } : {}), ...(session.model ? { model: session.model } : {}),
      state: session.state, resumable: Boolean(session.resumeToken), createdAt: session.createdAt, updatedAt: session.updatedAt,
      ...(session.title ? { title: session.title } : {}), turns: session.turns ?? 0,
    };
  }
  private get transcriptsDir() { return this.options.transcriptsDir ?? join(dirname(this.options.sessionsPath), 'agent-transcripts'); }
  private transcriptPath(id: string) { return join(this.transcriptsDir, `${id}.json`); }
  /** Reads a conversation's stored history once, before anything is shown or added. A missing or damaged file is an empty history. */
  private async history(session: Session) {
    if (session.historyLoaded) return;
    session.historyLoaded = true;
    try {
      const value: unknown = JSON.parse(await readFile(this.transcriptPath(session.id), 'utf8'));
      const stored = (Array.isArray(value) ? value : []).flatMap((item) => {
        const parsed = transcriptEntrySchema.safeParse(item);
        return parsed.success && parsed.data.sessionId === session.id ? [parsed.data as unknown as SessionEvent] : [];
      });
      const known = new Set(session.log.map((entry) => entry.seq));
      session.log = [...stored.filter((entry) => !known.has(entry.seq)), ...session.log].sort((a, b) => a.seq - b.seq);
      session.seq = Math.max(session.seq, ...session.log.map((entry) => entry.seq), 0);
    } catch { /* No history yet. */ }
  }
  /** Stores a conversation's history. Only conversations that reached the harness, which are the ones that can be continued. */
  private saveHistory(session: Session) {
    if (!session.resumeToken) return this.writes;
    const file = this.transcriptPath(session.id);
    const data = JSON.stringify(session.log) + '\n';
    const write = () => writePrivate(file, data);
    this.writes = this.writes.then(write, write).catch(() => {});
    return this.writes;
  }
  private dropHistory(id: string) {
    const remove = () => rm(this.transcriptPath(id), { force: true });
    this.writes = this.writes.then(remove, remove).catch(() => {});
    return this.writes;
  }
  private async load() {
    this.loaded ??= (async () => {
      try {
        const value: unknown = JSON.parse(await readFile(this.options.sessionsPath, 'utf8'));
        for (const item of Array.isArray(value) ? value : []) {
          const parsed = recordSchema.safeParse(item);
          if (parsed.success) this.sessions.set(parsed.data.id, { ...parsed.data, state: 'idle', seq: 0, log: [], historyLoaded: false });
        }
      } catch (error) {
        // A missing or damaged index only loses the ability to resume; it must not stop the service.
        if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
      }
    })();
    await this.loaded;
  }
  private persist() {
    const records = [...this.sessions.values()].filter((s) => s.resumeToken).map((s): Record_ => ({
      id: s.id, harness: s.harness, projectId: s.projectId, sceneId: s.sceneId, model: s.model,
      resumeToken: s.resumeToken, createdAt: s.createdAt, updatedAt: s.updatedAt, title: s.title, turns: s.turns,
    }));
    const file = this.options.sessionsPath;
    const write = () => writePrivate(file, JSON.stringify(records) + '\n');
    this.writes = this.writes.then(write, write).catch(() => {});
    return this.writes;
  }
  private get(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'No existe esa sesión del asistente.');
    return session;
  }

  async create(input: { harness: unknown; projectId: unknown; sceneId?: unknown; model?: unknown }): Promise<SessionInfo> {
    await this.load();
    if (typeof input.harness !== 'string' || !(harnessIds as readonly string[]).includes(input.harness)) throw new ApiError(400, 'INVALID_HARNESS', 'Asistente desconocido.');
    const harness = input.harness as HarnessId;
    const projectId = idSchema.parse(input.projectId);
    const sceneId = input.sceneId === undefined ? undefined : idSchema.parse(input.sceneId);
    if (input.model !== undefined && (typeof input.model !== 'string' || !modelPattern.test(input.model))) throw new ApiError(400, 'INVALID_MODEL', 'Nombre de modelo no válido.');
    if (!this.adapters[harness]) throw new ApiError(422, 'HARNESS_NOT_SUPPORTED', 'Este asistente todavía no se puede usar desde Paso.');
    const detected = await this.options.detect(harness);
    if (!detected.found) throw new ApiError(422, 'HARNESS_NOT_FOUND', 'No se ha encontrado el asistente. Instálalo y vuelve a intentarlo.');
    await this.options.validateTarget(projectId, sceneId);
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(), harness, projectId, sceneId, model: input.model as string | undefined,
      createdAt: now, updatedAt: now, state: 'idle', seq: 0, log: [], historyLoaded: true,
    };
    this.sessions.set(session.id, session);
    this.trim();
    return this.info(session);
  }
  /** Keeps memory and the index bounded. Idle sessions are forgotten oldest first. */
  private trim() {
    const limit = this.options.maxSessions ?? 200;
    if (this.sessions.size <= limit) return;
    const idle = [...this.sessions.values()].filter((s) => s.state === 'idle').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const s of idle.slice(0, this.sessions.size - limit)) { this.sessions.delete(s.id); void this.dropHistory(s.id); }
    void this.persist();
  }

  async list(projectId?: string) {
    await this.load();
    return [...this.sessions.values()].filter((s) => !projectId || s.projectId === projectId).map((s) => this.info(s))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async read(id: string) { await this.load(); return this.info(this.get(id)); }
  async events(id: string, after = 0) {
    await this.load();
    const s = this.get(id);
    await this.history(s);
    return { events: s.log.filter((e) => e.seq > after), next: s.seq };
  }

  /** Reopens a stored session, for example after the service restarted. Sending resumes it too. */
  async resume(id: string): Promise<SessionInfo> {
    await this.load();
    const session = this.get(id);
    if (!session.resumeToken) throw new ApiError(409, 'SESSION_NOT_RESUMABLE', 'Esta sesión no tiene una conversación que reanudar.');
    if (!this.adapters[session.harness]) throw new ApiError(422, 'HARNESS_NOT_SUPPORTED', 'Este asistente todavía no se puede usar desde Paso.');
    if (!(await this.options.detect(session.harness)).found) throw new ApiError(422, 'HARNESS_NOT_FOUND', 'No se ha encontrado el asistente. Instálalo y vuelve a intentarlo.');
    await this.options.validateTarget(session.projectId, session.sceneId);
    return this.info(session);
  }

  /**
   * Deletes a conversation: it stops if running, leaves the index, and its history goes, here and in the harness's own
   * copy, so nothing of it stays on this computer.
   */
  async remove(id: string) {
    await this.load();
    const session = this.get(id);
    await this.stop(session);
    this.sessions.delete(id);
    await this.persist();
    await this.dropHistory(id);
    const forget = this.adapters[session.harness]?.forget;
    if (forget && session.resumeToken) {
      try { await forget(session.resumeToken, this.workDir); } catch { /* The conversation is gone from Paso either way. */ }
    }
  }

  async send(id: string, text: unknown, effort?: unknown): Promise<{ runId: string }> {
    await this.load();
    if (typeof text !== 'string' || !text.trim() || text.length > maxMessageChars) {
      throw new ApiError(400, 'INVALID_MESSAGE', `El mensaje debe tener texto y no superar ${maxMessageChars} caracteres.`);
    }
    if (this.closing) throw new ApiError(503, 'SERVICE_CLOSING', 'El servicio se está cerrando.');
    const session = this.get(id);
    if (effort !== undefined && (typeof effort !== 'string' || !effortLevels[session.harness].includes(effort))) {
      throw new ApiError(400, 'INVALID_EFFORT', 'Ese modo de razonamiento no está disponible para este asistente.');
    }
    if (!this.adapters[session.harness]) throw new ApiError(422, 'HARNESS_NOT_SUPPORTED', 'Este asistente todavía no se puede usar desde Paso.');
    await this.options.validateTarget(session.projectId, session.sceneId);
    // A continued conversation adds to its stored history, so its numbering carries on.
    await this.history(session);
    // From here to marking the session as running there is no await, so limits cannot race.
    if (session.state === 'running') throw new ApiError(409, 'SESSION_BUSY', 'El asistente todavía está trabajando en esta sesión.');
    const running = [...this.sessions.values()].filter((s) => s.state === 'running');
    if (running.filter((s) => s.projectId === session.projectId).length >= (this.options.maxRunsPerProject ?? 1)) {
      throw new ApiError(409, 'PROJECT_BUSY', 'Ya hay un asistente trabajando en este diagrama. Espera a que termine o cancélalo.');
    }
    if (running.length >= (this.options.maxRuns ?? 4)) {
      throw new ApiError(409, 'TOO_MANY_RUNS', 'Hay demasiados asistentes trabajando a la vez. Espera a que termine alguno.');
    }
    const controller = new AbortController();
    const runId = randomUUID();
    session.state = 'running';
    session.run = { id: runId, controller, finished: Promise.resolve() };
    session.run.finished = this.execute(session, runId, text, controller.signal, effort as string | undefined);
    return { runId };
  }

  async cancel(id: string) {
    await this.load();
    const session = this.get(id);
    if (!session.run) return { cancelled: false };
    session.run.controller.abort();
    return { cancelled: true };
  }
  private async stop(session: Session) {
    const run = session.run;
    if (run) { run.controller.abort(); await run.finished; }
  }

  private emit(session: Session, runId: string, event: AgentEvent) {
    const entry: SessionEvent = { sessionId: session.id, runId, seq: ++session.seq, at: new Date().toISOString(), event };
    // Deltas are repeated by the `text` event that follows them, so the replay log skips them.
    if (event.type !== 'text_delta') {
      session.log.push(entry);
      const limit = this.options.eventLogSize ?? 5000;
      if (session.log.length > limit) session.log.splice(0, session.log.length - limit);
    }
    for (const listener of this.listeners) {
      try { listener(entry); } catch { /* A broken listener must not stop a run. */ }
    }
  }

  /** The single place where a run starts and ends. Run hooks attach here. */
  private async execute(session: Session, runId: string, text: string, signal: AbortSignal, effort?: string) {
    const context = { sessionId: session.id, runId, harness: session.harness, projectId: session.projectId, sceneId: session.sceneId };
    let terminal: AgentEvent | undefined;
    const emit = (event: AgentEvent) => {
      if (terminal) return;
      if (event.type === 'finished' || event.type === 'failed') terminal = event;
      if (event.type === 'session' && tokenPattern.test(event.resumeToken)) {
        session.resumeToken = event.resumeToken;
        void this.persist();
      }
      this.emit(session, runId, event);
    };
    const fail = (code: FailureCode) => emit({ type: 'failed', code, message: failureMessage(code) });
    emit({ type: 'started' });
    emit({ type: 'message', text });
    session.title ??= text.trim().replace(/\s+/g, ' ').slice(0, titleChars);
    session.turns = (session.turns ?? 0) + 1;
    try {
      let blocked = false;
      try { await this.options.hooks?.beforeRun?.(context); } catch { blocked = true; }
      if (blocked) fail('blocked');
      else if (signal.aborted) emit({ type: 'finished', reason: 'cancelled' });
      else {
        const detected = await this.options.detect(session.harness);
        if (!detected.found || !detected.path) fail('not_installed');
        else if (detected.session === 'signed_out') fail('signed_out');
        else if (signal.aborted) emit({ type: 'finished', reason: 'cancelled' });
        else if (!(await this.prepareWorkDir())) fail('unsafe_configuration');
        else {
          const request: AgentRunRequest = {
            executable: detected.path, workDir: this.workDir, text,
            ...(session.resumeToken && tokenPattern.test(session.resumeToken) ? { resumeToken: session.resumeToken } : {}),
            ...(session.model ? { model: session.model } : {}),
            ...(effort ? { effort } : {}),
            context: { projectId: session.projectId, ...(session.sceneId ? { sceneId: session.sceneId } : {}) },
            board: this.options.board(),
            limits: { idleTimeoutMs: this.options.idleTimeoutMs ?? 120_000, maxRunMs: this.options.maxRunMs ?? 20 * 60_000 },
          };
          for await (const event of this.adapters[session.harness]!.run(request, signal)) emit(event);
        }
      }
    } catch {
      fail('crashed');
    }
    // An adapter must end every turn. If it did not, say so rather than leave the run open.
    if (!terminal) fail('crashed');
    const end = terminal as AgentEvent;
    const outcome = end.type === 'finished' && end.reason === 'completed' ? { status: 'completed' as const }
      : end.type === 'finished' ? { status: 'cancelled' as const }
        : { status: 'failed' as const, failure: end.type === 'failed' ? end.code : undefined };
    // The session stays "running" until the hook is done, so a restore point is closed before the next run opens.
    try { await this.options.hooks?.afterRun?.(context, outcome); } catch { /* The run is over; nothing to undo. */ }
    session.updatedAt = new Date().toISOString();
    // Idle means the index is durable: a restart right after a run can still resume it. The history is queued behind
    // it and does not hold the session, so the next message can start as soon as the run has ended.
    const index = this.persist();
    void this.saveHistory(session);
    await index;
    session.state = 'idle';
    session.run = undefined;
  }

  /** The directory must exist and contain nothing, so the agent never sees local files. */
  private async prepareWorkDir() {
    try {
      await mkdir(this.workDir, { recursive: true, mode: 0o700 });
      const real = await realpath(this.workDir);
      if (real === (await realpath(homedir()))) return false;
      return (await readdir(this.workDir)).every((name) => emptyDirNames.has(name));
    } catch { return false; }
  }

  /** True while any agent is working. The service does not change workspace under a running agent. */
  busy() { return [...this.sessions.values()].some((session) => session.state === 'running'); }

  /** Stops every running harness, with its whole process tree, and waits for them to be gone. */
  async close() {
    this.closing = true;
    const runs = [...this.sessions.values()].flatMap((s) => s.run ? [s.run] : []);
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.finished));
    await this.writes;
  }
}

/** Writes a file only this user can read, through a flushed temporary file and a rename, so a crash never leaves half of it. */
async function writePrivate(file: string, data: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(12).toString('hex')}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}
