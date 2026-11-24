import { useSyncExternalStore } from 'react';
import {
  ApiClient,
  ApiRequestError,
  UnavailableError,
  harnessIds,
  type AgentAttachment,
  type AgentEvent,
  type AgentSessionEvent,
  type AgentSessionInfo,
  type DetectedHarness,
  type CodexModel,
  type HarnessId,
  type OutgoingAttachment,
  type RunSummary,
  type UndoPlan,
} from '../lib/api';
import type { ServiceEvent } from './projects-store';

export const HARNESS_NAMES: Record<HarnessId, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' };
/** Harnesses the service can run a session on today. The others are shown as detected but not available. */
export const SUPPORTED_HARNESSES: readonly HarnessId[] = ['claude', 'codex', 'agy'];

export type ModelOption = { id: string; label: string };
/**
 * The models offered per harness. An empty ID leaves the choice to the harness. `claude-fable-5-1` is left
 * out on purpose: this account cannot use it.
 */
export const HARNESS_MODELS: Record<HarnessId, ModelOption[]> = {
  claude: [
    { id: '', label: 'Default' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  ],
  codex: [{ id: '', label: 'Default' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }],
  // agy 1.5.16 lists each model once per level (`gemini-4-neon-high`); Paso picks the model and passes the level as
  // `--effort`, as agy itself allows.
  agy: [
    { id: '', label: 'Default' },
    { id: 'gemini-4-neon', label: 'Gemini 4 Neon' },
    { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon' },
    { id: 'gemini-4-argon', label: 'Gemini 4 Argon' },
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  ],
};

/**
 * How hard the model thinks, per harness: the levels the service accepts (`effortLevels` on the server). An empty ID
 * leaves it to the harness. A harness without levels shows no choice.
 */
export const HARNESS_EFFORTS: Record<HarnessId, ModelOption[]> = {
  claude: [
    { id: '', label: 'Automatic' }, { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Very high' }, { id: 'max', label: 'Maximum' },
  ],
  codex: [
    { id: '', label: 'Automatic' }, { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Very high' }, { id: 'max', label: 'Maximum' }, { id: 'ultra', label: 'Ultra' },
  ],
  agy: [
    { id: '', label: 'Automatic' }, { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Very high' },
  ],
};
/** The agy models that also have a very high level. The others go up to high. */
const AGY_XHIGH_MODELS = new Set(['gemini-4-neon', 'gemini-4-hydrogen']);

/** Harnesses that take images as message content. A harness without it says so before anything is sent. */
export const HARNESS_ACCEPTS_IMAGES: Record<HarnessId, boolean> = { claude: true, codex: true, agy: false };
/** What a message may carry, as the service checks it too. */
export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP' };
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
/** How many steps one message may name, as the service checks it too. */
export const MAX_STEPS = 50;

/** An image attached to the next message, read into memory. */
export type DraftImage = { key: string; kind: 'image'; name: string; mediaType: string; size: number; blob: Blob; url: string };
/**
 * A Studio step attached to the next message: only its IDs go, and the service finds it. Its scene's name, place and
 * title are kept to name its chip, from when it was added.
 */
export type DraftStep = { key: string; kind: 'step'; sceneId: string; stepId: string; sceneName: string; number: number; title?: string };
/** Something attached to the next message, before it is sent. */
export type DraftAttachment = DraftImage | DraftStep;
/** A step to attach, as the Studio sees it. */
export type StepToAttach = Omit<DraftStep, 'key' | 'kind'>;

export type HarnessInfo = DetectedHarness & { added: boolean; supported: boolean; models?: CodexModel[] };
export function modelOptions(harness: HarnessId, info?: HarnessInfo): ModelOption[] {
  return harness === 'codex' && info?.models?.length
    ? [HARNESS_MODELS.codex[0], ...info.models.map((model) => ({ id: model.id, label: model.label + (model.isDefault ? ' (default)' : '') }))]
    : HARNESS_MODELS[harness];
}
export function effortOptions(harness: HarnessId, model: string, info?: HarnessInfo): ModelOption[] {
  const selected = info?.models?.find((item) => item.id === model || (!model && item.isDefault));
  return harness === 'codex' && selected?.efforts.length
    ? HARNESS_EFFORTS.codex.filter((option) => !option.id || selected.efforts.includes(option.id))
    : harness === 'codex' ? HARNESS_EFFORTS.codex.filter((option) => !['max', 'ultra'].includes(option.id))
      : harness === 'agy' ? HARNESS_EFFORTS.agy.filter((option) => option.id !== 'xhigh' || AGY_XHIGH_MODELS.has(model))
        : HARNESS_EFFORTS[harness];
}

export type ToolItem = {
  id: string;
  tool: string;
  readOnly: boolean;
  status: 'running' | 'done' | 'error';
  sceneId?: string;
  /** The step this call changed or created. For a duplicate it is the copy, not the source. */
  stepId?: string;
};
export type TurnEntry =
  | { kind: 'text'; id: string; text: string; streaming: boolean }
  | { kind: 'work'; id: string; items: ToolItem[] };

/** One message and the agent's whole answer to it: a run. */
export type AgentTurn = {
  runId: string;
  sessionId: string;
  projectId: string;
  sceneId?: string;
  harness: HarnessId;
  /** The person's message. The service replays it with the rest of the conversation. */
  userText?: string;
  /** What the person attached to it, kept by the service. */
  userAttachments?: AgentAttachment[];
  entries: TurnEntry[];
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  errorMessage?: string;
  startedAt: number;
  endedAt?: string;
};

export type AgentState = {
  harnesses: { status: 'idle' | 'loading' | 'ready' | 'failed'; list: HarnessInfo[] };
  /** The harness and model for the next conversation. */
  harness: HarnessId;
  model: string;
  /** The reasoning effort for the next message. It does not start a new conversation. */
  effort: string;
  sessions: Record<string, AgentSessionInfo>;
  /** The open conversation (a session ID) per project and scene. */
  conversation: Record<string, string | undefined>;
  turns: AgentTurn[];
  runs: Record<string, RunSummary[]>;
  notice: Record<string, string | undefined>;
  /** What is attached to the next message, per project and scene, like the draft's text. */
  drafts: Record<string, DraftAttachment[] | undefined>;
  /** Why something could not be attached, per project and scene. */
  attachNotice: Record<string, string | undefined>;
};

export const conversationKey = (projectId: string, sceneId?: string | null) => `${projectId}:${sceneId ?? ''}`;

const writeTools = new Set(['create_scene', 'create_step', 'duplicate_step', 'update_step', 'delete_step', 'add_elements', 'update_elements', 'delete_elements']);
const creatingTools = new Set(['create_step', 'duplicate_step']);

/** What a run changed, counted the way a person would: each step or scene once, order only when nothing else explains it. */
export function countRunChanges(run: RunSummary): number {
  const steps = new Set([...run.changes.createdSteps, ...run.changes.modifiedSteps].map((step) => step.id));
  const scenesWithNewSteps = new Set(run.changes.createdSteps.map((step) => step.sceneId));
  const reorderedOnly = run.changes.orderChanged.sceneIds.filter((id) => !scenesWithNewSteps.has(id)).length;
  const projectOrder = run.changes.orderChanged.project && run.changes.createdScenes.length === 0 ? 1 : 0;
  return run.changes.createdScenes.length + steps.size + reorderedOnly + projectOrder;
}

/** The run that "Undo run" acts on: the newest finished run with changes. Newer runs without changes are undone with it. */
export function undoableRun(runs: RunSummary[] | undefined): RunSummary | undefined {
  if (!runs || runs.some((run) => run.status === 'running')) return undefined;
  const newestFirst = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return newestFirst.find((run) => (run.status === 'finished' || run.status === 'interrupted') && countRunChanges(run) > 0);
}

/** Plain words for a failed undo. The service's own messages are in English and name internal IDs. */
export function undoErrorMessage(error: unknown): string {
  if (error instanceof UnavailableError) return 'No connection to the local service.';
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case 'NEWER_RUN_EXISTS': return 'There is a newer run with changes. Undo it first.';
      case 'RUN_IN_PROGRESS': return 'The agent is working on this project. Wait for it to finish, or stop it.';
      case 'RUN_ALREADY_UNDONE': return 'This run was already undone.';
      case 'NOT_FOUND': return "This run's restore point is no longer kept.";
    }
  }
  return "Couldn't undo the run. Try again.";
}

const sendErrorMessage = (error: unknown) => {
  if (error instanceof UnavailableError) return 'No connection to the local service.';
  // The agent routes already answer in words a person can act on.
  if (error instanceof ApiRequestError) return error.message;
  return "Couldn't send the message to the agent.";
};

export class AgentStore {
  private state: AgentState = {
    harnesses: { status: 'idle', list: [] },
    harness: 'claude',
    model: '',
    effort: '',
    sessions: {},
    conversation: {},
    turns: [],
    runs: {},
    notice: {},
    drafts: {},
    attachNotice: {},
  };
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private disposed = false;
  private seen = new Set<string>();
  /** Sessions whose replay is being read: live events wait so they apply in order. */
  private syncing = new Map<string, AgentSessionEvent[]>();
  /** Events for a session this window does not know yet. */
  private orphans = new Map<string, AgentSessionEvent[]>();
  private projects = new Set<string>();
  /** Sessions of projects this window has not opened: their events are not needed until it does. */
  private ignored = new Set<string>();
  private runReloads = new Map<string, ReturnType<typeof setTimeout>>();
  /** Object URLs of the images shown in conversations, read once each. */
  private images = new Map<string, Promise<string>>();
  private draftCount = 0;

  constructor(private readonly api: ApiClient, private readonly subscribeEvents: (listener: (event: ServiceEvent) => void) => () => void) {}

  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<AgentState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private setNotice(projectId: string, message: string | undefined) { this.set({ notice: { ...this.state.notice, [projectId]: message } }); }
  clearNotice(projectId: string) { this.setNotice(projectId, undefined); }

  start() {
    this.disposed = false;
    this.unsubscribe = this.subscribeEvents((event) => this.onEvent(event));
  }
  dispose() {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.runReloads.values()) clearTimeout(timer);
    this.runReloads.clear();
  }

  // Attachments --------------------------------------------------------------------------------------------

  /**
   * Attaches files to the next message of a project and scene. Only PNG, JPEG, GIF and WebP images of up to 5 MB, and
   * five per message: anything else is left out, and the notice says why.
   */
  async attach(projectId: string, sceneId: string | null, files: File[], harness: HarnessId) {
    const key = conversationKey(projectId, sceneId);
    if (!files.length) return;
    if (!HARNESS_ACCEPTS_IMAGES[harness]) {
      this.set({ attachNotice: { ...this.state.attachNotice, [key]: `${HARNESS_NAMES[harness]} can't read images. Pick another agent to send them.` } });
      return;
    }
    const problems: string[] = [];
    const accepted = files.filter((file) => {
      const name = file.name || 'Pasted image';
      if (!IMAGE_TYPES[file.type]) problems.push(`“${name}” isn't a PNG, JPEG, GIF or WebP image.`);
      else if (file.size > MAX_IMAGE_BYTES) problems.push(`“${name}” is larger than 5 MB.`);
      else if (!file.size) problems.push(`“${name}” is empty.`);
      else return true;
      return false;
    });
    // Each image is read now, into memory: what is sent is what was attached, even if the file on disk changes or goes.
    const read = await Promise.all(accepted.map(async (file) => {
      try { return new Blob([await bytesOf(file)], { type: file.type }); }
      catch { problems.push(`“${file.name || 'Pasted image'}” couldn't be read.`); return undefined; }
    }));
    const current = this.state.drafts[key] ?? [];
    const images = current.filter((item) => item.kind === 'image').length;
    const added: DraftAttachment[] = [];
    let overLimit = false;
    accepted.forEach((file, index) => {
      const blob = read[index];
      if (!blob) return;
      if (images + added.length >= MAX_ATTACHMENTS) { overLimit = true; return; }
      added.push({ key: `draft-${++this.draftCount}`, kind: 'image', name: file.name || 'Pasted image', mediaType: file.type, size: blob.size, blob, url: URL.createObjectURL(blob) });
    });
    if (overLimit) problems.push(`A message can have up to ${MAX_ATTACHMENTS} images.`);
    this.set({
      drafts: added.length ? { ...this.state.drafts, [key]: [...current, ...added] } : this.state.drafts,
      attachNotice: { ...this.state.attachNotice, [key]: problems.length ? problems.join(' ') : undefined },
    });
  }

  /**
   * Attaches Studio steps to the next message of a project and scene, after what is already there. A step already
   * attached is not added again; past fifty, the notice says so.
   */
  attachSteps(projectId: string, sceneId: string | null, steps: StepToAttach[]) {
    const key = conversationKey(projectId, sceneId);
    const current = this.state.drafts[key] ?? [];
    const have = new Set(current.flatMap((item) => item.kind === 'step' ? [item.stepId] : []));
    const room = Math.max(0, MAX_STEPS - have.size);
    const fresh: StepToAttach[] = [];
    for (const step of steps) if (!have.has(step.stepId)) { have.add(step.stepId); fresh.push(step); }
    const added: DraftStep[] = fresh.slice(0, room).map((step) => ({ ...step, key: `draft-${++this.draftCount}`, kind: 'step' }));
    // Steps come before images, as the service keeps them.
    const before = current.filter((item) => item.kind === 'step');
    const after = current.filter((item) => item.kind !== 'step');
    this.set({
      drafts: added.length ? { ...this.state.drafts, [key]: [...before, ...added, ...after] } : this.state.drafts,
      attachNotice: { ...this.state.attachNotice, [key]: fresh.length > room ? `A message can name up to ${MAX_STEPS} steps.` : this.state.attachNotice[key] },
    });
    return added.length;
  }

  detach(projectId: string, sceneId: string | null, draftKey: string) {
    const key = conversationKey(projectId, sceneId);
    const current = this.state.drafts[key] ?? [];
    const gone = current.find((item) => item.key === draftKey);
    if (gone?.kind === 'image') URL.revokeObjectURL(gone.url);
    this.set({ drafts: { ...this.state.drafts, [key]: current.filter((item) => item.key !== draftKey) }, attachNotice: { ...this.state.attachNotice, [key]: undefined } });
  }

  clearAttachNotice(projectId: string, sceneId: string | null) {
    this.set({ attachNotice: { ...this.state.attachNotice, [conversationKey(projectId, sceneId)]: undefined } });
  }

  /** An image of a conversation as an object URL, read from the service once. */
  imageUrl(sessionId: string, attachmentId: string) {
    const key = `${sessionId}/${attachmentId}`;
    let url = this.images.get(key);
    if (!url) {
      url = this.api.agentAttachment(sessionId, attachmentId).then((blob) => URL.createObjectURL(blob));
      url.catch(() => { this.images.delete(key); });
      this.images.set(key, url);
    }
    return url;
  }

  // Harnesses ----------------------------------------------------------------------------------------------

  /** Detection runs the harness CLIs, so it happens when the panel is first shown and when asked, not on every load. */
  async loadHarnesses(force = false) {
    if (!force && this.state.harnesses.status !== 'idle') return;
    this.set({ harnesses: { ...this.state.harnesses, status: 'loading' } });
    const modelsRequest = this.api.codexModels(force).catch(() => undefined);
    try {
      const [detected, added] = await Promise.all([this.api.detectHarnesses(), this.api.listHarnesses()]);
      const addedIds = new Set(added.map((harness) => harness.id));
      const list = harnessIds.map((id): HarnessInfo => {
        const found = detected.find((harness) => harness.id === id)
          ?? { id, found: false, path: null, version: null, session: 'unknown' as const };
        return { ...found, models: this.state.harnesses.list.find((item) => item.id === id)?.models, added: addedIds.has(id), supported: SUPPORTED_HARNESSES.includes(id) };
      });
      this.set({ harnesses: { status: 'ready', list } });
      void modelsRequest.then((models) => {
        if (models) this.set({ harnesses: { ...this.state.harnesses, list: this.state.harnesses.list.map((item) => item.id === 'codex' ? { ...item, models } : item) } });
      });
    } catch {
      this.set({ harnesses: { ...this.state.harnesses, status: 'failed' } });
    }
  }

  /** Adding a harness is the person's consent to let Paso run it with their own login. It is asked once. */
  async addHarness(id: HarnessId) {
    const added = await this.api.addHarness(id);
    this.set({
      harness: id,
      harnesses: {
        ...this.state.harnesses,
        list: this.state.harnesses.list.map((harness) => harness.id === id ? { ...harness, ...added, added: true } : harness),
      },
    });
  }

  /**
   * A different harness or model is a different session, so the open conversation of that target ends. The
   * pickers show the open conversation's own harness and model, so a change is measured against those.
   */
  choose(projectId: string, sceneId: string | null, choice: { harness?: HarnessId; model?: string }) {
    const key = conversationKey(projectId, sceneId);
    const open = this.state.conversation[key];
    const session = open ? this.state.sessions[open] : undefined;
    const shown = { harness: session?.harness ?? this.state.harness, model: session ? session.model ?? '' : this.state.model };
    const harness = choice.harness ?? shown.harness;
    const model = choice.model ?? (harness !== shown.harness ? '' : shown.model);
    const changed = harness !== shown.harness || model !== shown.model;
    // A level the new harness does not have goes back to automatic.
    const effort = effortOptions(harness, model, this.state.harnesses.list.find((item) => item.id === harness)).some((option) => option.id === this.state.effort) ? this.state.effort : '';
    this.set({ harness, model, effort, conversation: session && changed ? { ...this.state.conversation, [key]: undefined } : this.state.conversation });
  }

  /** The reasoning effort applies from the next message on, in the same conversation. */
  chooseEffort(effort: string) { this.set({ effort }); }

  /** The conversations of a scene, newest first: the history the panel lists. Ones that never got a message are left out. */
  conversations(projectId: string, sceneId: string | null) {
    return Object.values(this.state.sessions)
      .filter((session) => session.projectId === projectId && (session.sceneId ?? null) === sceneId && session.turns > 0)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Opens an earlier conversation of a scene: its messages are read from the service, and the next message continues it. */
  async openConversation(projectId: string, sceneId: string | null, sessionId: string) {
    const session = this.state.sessions[sessionId];
    if (!session) return;
    this.set({
      conversation: { ...this.state.conversation, [conversationKey(projectId, sceneId)]: sessionId },
      notice: { ...this.state.notice, [projectId]: undefined },
    });
    await this.replay(sessionId);
  }

  /**
   * Deletes a conversation for good: the service drops its history and the harness's own copy. What the agent changed
   * on the board stays, with its restore points.
   */
  async deleteConversation(sessionId: string) {
    await this.api.deleteAgentSession(sessionId);
    const sessions = { ...this.state.sessions };
    delete sessions[sessionId];
    const conversation = Object.fromEntries(Object.entries(this.state.conversation).map(([key, id]) => [key, id === sessionId ? undefined : id]));
    this.ignored.add(sessionId);
    this.set({ sessions, conversation, turns: this.state.turns.filter((turn) => turn.sessionId !== sessionId) });
  }

  newConversation(projectId: string, sceneId: string | null) {
    this.set({
      conversation: { ...this.state.conversation, [conversationKey(projectId, sceneId)]: undefined },
      notice: { ...this.state.notice, [projectId]: undefined },
    });
  }

  // Projects, sessions and replay -------------------------------------------------------------------------

  /**
   * Reads what the service knows about a project: its restore points and its sessions. The newest session of
   * each scene becomes its open conversation, and its events are replayed, so a reload or a second window
   * shows the same runs.
   */
  async openProject(projectId: string, force = false) {
    if (this.projects.has(projectId) && !force) return;
    this.projects.add(projectId);
    void this.loadRuns(projectId);
    let sessions: AgentSessionInfo[];
    try { sessions = await this.api.listAgentSessions(projectId); } catch { return; }
    const conversation = { ...this.state.conversation };
    // Newest first: the first session seen for a scene is its conversation.
    for (const session of sessions) {
      const key = conversationKey(session.projectId, session.sceneId);
      if (!(key in conversation)) conversation[key] = session.id;
    }
    const known = { ...this.state.sessions };
    for (const session of sessions) known[session.id] = session;
    this.set({ sessions: known, conversation });
    const replay = sessions.filter((session) => session.state === 'running' || conversation[conversationKey(session.projectId, session.sceneId)] === session.id);
    await Promise.all(replay.map((session) => this.replay(session.id)));
  }

  /** Reads a session's stored events. Live events that arrive meanwhile wait, so everything applies in order. */
  private async replay(sessionId: string, waiting: AgentSessionEvent[] = []) {
    const pending = this.syncing.get(sessionId);
    if (pending) { pending.push(...waiting); return; }
    this.syncing.set(sessionId, [...waiting]);
    let replayed: AgentSessionEvent[] = [];
    try { replayed = (await this.api.getAgentSessionEvents(sessionId, 0)).events; } catch { /* Gone: live events still apply. */ }
    const live = this.syncing.get(sessionId) ?? [];
    this.syncing.delete(sessionId);
    for (const entry of [...replayed, ...live].sort((a, b) => a.seq - b.seq)) this.apply(entry);
  }

  /** A session this window did not start, such as one from another window: learn it, then replay it. */
  private async adopt(sessionId: string) {
    let session: AgentSessionInfo | undefined;
    try { session = await this.api.getAgentSession(sessionId); } catch { /* Forgotten already. */ }
    const waiting = this.orphans.get(sessionId) ?? [];
    this.orphans.delete(sessionId);
    if (!session || !this.projects.has(session.projectId)) { this.ignored.add(sessionId); return; }
    this.set({ sessions: { ...this.state.sessions, [session.id]: session } });
    await this.replay(sessionId, waiting);
  }

  async loadRuns(projectId: string) {
    try {
      const runs = await this.api.listProjectRuns(projectId);
      this.set({ runs: { ...this.state.runs, [projectId]: runs } });
      this.attachCreatedFromRuns(projectId, runs);
      return runs;
    } catch {
      return undefined;
    }
  }

  /**
   * The restore point is closed just after the turn's last event, so the first read may still say `running`.
   * Read again with a growing pause until it is closed.
   */
  private reloadRunsUntilClosed(projectId: string, runId: string, attempt = 0) {
    clearTimeout(this.runReloads.get(runId));
    this.runReloads.set(runId, setTimeout(async () => {
      this.runReloads.delete(runId);
      if (this.disposed) return;
      const runs = await this.loadRuns(projectId);
      const run = runs?.find((candidate) => candidate.id === runId);
      if ((!run || run.status === 'running') && attempt < 8) this.reloadRunsUntilClosed(projectId, runId, attempt + 1);
    }, Math.min(2000, 60 * 2 ** attempt)));
  }

  // Sending and stopping ------------------------------------------------------------------------------------

  /**
   * Sends the next message with what is attached to it. `stepExists` says which attached steps are still in the project:
   * a deleted one is left out (its chip says so) and leaves the draft with the rest.
   */
  async send(projectId: string, sceneId: string | null, text: string, stepExists: (stepId: string) => boolean = () => true) {
    const trimmed = text.trim();
    const key = conversationKey(projectId, sceneId);
    const drafts = this.state.drafts[key] ?? [];
    const imageDrafts = drafts.filter((draft): draft is DraftImage => draft.kind === 'image');
    const stepDrafts = drafts.filter((draft): draft is DraftStep => draft.kind === 'step' && stepExists(draft.stepId));
    if (!trimmed && !imageDrafts.length && !stepDrafts.length) return false;
    this.setNotice(projectId, undefined);
    try {
      const images: OutgoingAttachment[] = await Promise.all(imageDrafts.map(async (draft) => ({ kind: draft.kind, mediaType: draft.mediaType, data: await base64(draft.blob), name: draft.name })));
      const outgoing: OutgoingAttachment[] = [...stepDrafts.map((draft) => ({ kind: 'step' as const, stepId: draft.stepId })), ...images];
      // The open conversation keeps its own session, harness and model. Changing either ends it (see `choose`).
      let sessionId = this.state.conversation[key];
      if (sessionId && !this.state.sessions[sessionId]) sessionId = undefined;
      let sent: { runId: string; attachments: AgentAttachment[] };
      try {
        if (!sessionId) sessionId = await this.createSession(projectId, sceneId, key);
        sent = await this.deliver(projectId, sessionId, trimmed, outgoing);
      } catch (error) {
        // The service forgets sessions that never reached the harness when it restarts: start a new one.
        if (!(error instanceof ApiRequestError && error.code === 'SESSION_NOT_FOUND')) throw error;
        sessionId = await this.createSession(projectId, sceneId, key);
        sent = await this.deliver(projectId, sessionId, trimmed, outgoing);
      }
      const runId = sent.runId;
      // The images just sent are shown from the files the person picked, unless the live event already read them back.
      sent.attachments.filter((attachment) => attachment.kind === 'image').forEach((attachment, index) => {
        const draft = imageDrafts[index];
        if (!draft) return;
        const cached = `${sessionId}/${attachment.id}`;
        if (this.images.has(cached)) URL.revokeObjectURL(draft.url);
        else this.images.set(cached, Promise.resolve(draft.url));
      });
      const remaining = (this.state.drafts[key] ?? []).filter((item) => !drafts.includes(item));
      this.set({ drafts: { ...this.state.drafts, [key]: remaining }, attachNotice: { ...this.state.attachNotice, [key]: undefined } });
      this.upsertTurn(runId, sessionId, (turn) => ({ ...turn, userText: trimmed, ...(sent.attachments.length ? { userAttachments: sent.attachments } : {}) }));
      return true;
    } catch (error) {
      this.setNotice(projectId, sendErrorMessage(error));
      return false;
    }
  }

  /**
   * Sends one message. The service says a run is over before it has closed its restore point, so for a moment after
   * the last answer it may still be busy: when nothing is running here any more, that is waited out, briefly.
   */
  private async deliver(projectId: string, sessionId: string, text: string, attachments: OutgoingAttachment[]) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.api.sendAgentMessage(sessionId, text, this.effortFor(sessionId), attachments); }
      catch (error) {
        const busy = error instanceof ApiRequestError && (error.code === 'SESSION_BUSY' || error.code === 'PROJECT_BUSY');
        const runningHere = this.state.turns.some((turn) => turn.projectId === projectId && turn.status === 'running');
        if (!busy || runningHere || attempt >= 12) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }

  /** The chosen effort, when the conversation's harness has it. */
  private effortFor(sessionId: string) {
    const harness = this.state.sessions[sessionId]?.harness ?? this.state.harness;
    const effort = this.state.effort;
    const model = this.state.sessions[sessionId]?.model ?? this.state.model;
    return effort && effortOptions(harness, model, this.state.harnesses.list.find((item) => item.id === harness)).some((option) => option.id === effort) ? effort : undefined;
  }

  private async createSession(projectId: string, sceneId: string | null, key: string) {
    const { harness, model } = this.state;
    const created = await this.api.createAgentSession({ harness, projectId, ...(sceneId ? { sceneId } : {}), ...(model ? { model } : {}) });
    this.set({ sessions: { ...this.state.sessions, [created.id]: created }, conversation: { ...this.state.conversation, [key]: created.id } });
    return created.id;
  }

  async stop(projectId: string) {
    const running = this.state.turns.find((turn) => turn.projectId === projectId && turn.status === 'running');
    if (!running) return;
    try { await this.api.cancelAgentSession(running.sessionId); }
    catch (error) { this.setNotice(projectId, error instanceof ApiRequestError ? error.message : "Couldn't stop the agent."); }
  }

  // Undo ---------------------------------------------------------------------------------------------------

  /**
   * Preview of undoing a run. The service refuses while a newer run is not undone, and a newer run without
   * changes (a question, say) would block the undo for no reason, so those are undone first: they change nothing.
   */
  async previewUndo(projectId: string, runId: string): Promise<UndoPlan> {
    const runs = (await this.loadRuns(projectId)) ?? this.state.runs[projectId] ?? [];
    const target = runs.find((run) => run.id === runId);
    const newerEmpty = runs
      .filter((run) => target && run.id !== runId && (run.status === 'finished' || run.status === 'interrupted')
        && Date.parse(run.startedAt) > Date.parse(target.startedAt) && countRunChanges(run) === 0)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    for (const run of newerEmpty) {
      const plan = await this.api.previewUndoRun(projectId, run.id);
      if (plan.requiresForce) break;
      await this.api.executeUndoRun(projectId, run.id, plan.confirmationToken);
    }
    if (newerEmpty.length) void this.loadRuns(projectId);
    return this.api.previewUndoRun(projectId, runId);
  }

  async undo(projectId: string, runId: string, plan: UndoPlan, force: boolean) {
    await this.api.executeUndoRun(projectId, runId, plan.confirmationToken, force);
    await this.loadRuns(projectId);
  }

  // Events -------------------------------------------------------------------------------------------------

  private onEvent(event: ServiceEvent) {
    if (event.type === 'ready') {
      // Reconnected: there is no replay log for the socket, so read everything again.
      for (const projectId of this.projects) void this.openProject(projectId, true);
      return;
    }
    if (event.type === 'created' && event.kind === 'step' && event.projectId && event.sceneId && event.id) {
      this.attachCreatedStep(event.projectId, event.sceneId, event.id);
    }
    if (event.type === 'agent' && event.sessionId && event.runId && typeof event.seq === 'number' && event.event) {
      const entry: AgentSessionEvent = { sessionId: event.sessionId, runId: event.runId, seq: event.seq, at: event.at ?? new Date().toISOString(), event: event.event };
      const waiting = this.syncing.get(entry.sessionId);
      if (waiting) { waiting.push(entry); return; }
      if (!this.state.sessions[entry.sessionId]) {
        if (this.ignored.has(entry.sessionId)) return;
        const orphans = this.orphans.get(entry.sessionId);
        if (orphans) { orphans.push(entry); return; }
        this.orphans.set(entry.sessionId, [entry]);
        void this.adopt(entry.sessionId);
        return;
      }
      this.apply(entry);
    }
  }

  private upsertTurn(runId: string, sessionId: string, update: (turn: AgentTurn) => AgentTurn, at?: string) {
    const index = this.state.turns.findIndex((turn) => turn.runId === runId);
    let turn = index >= 0 ? this.state.turns[index] : undefined;
    if (!turn) {
      const session = this.state.sessions[sessionId];
      if (!session) return undefined;
      turn = {
        runId, sessionId, projectId: session.projectId, ...(session.sceneId ? { sceneId: session.sceneId } : {}),
        harness: session.harness, entries: [], status: 'running', startedAt: at ? Date.parse(at) : Date.now(),
      };
    }
    const next = update(turn);
    const turns = index >= 0 ? this.state.turns.map((existing, i) => i === index ? next : existing) : [...this.state.turns, next];
    this.set({ turns });
    return next;
  }

  private apply({ sessionId, runId, seq, at, event }: AgentSessionEvent) {
    const key = `${sessionId}:${seq}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const turn = this.upsertTurn(runId, sessionId, (current) => reduce(current, event, at), at);
    if (!turn) return;
    if (event.type === 'started' || event.type === 'finished' || event.type === 'failed') {
      const session = this.state.sessions[sessionId];
      if (session) this.set({ sessions: { ...this.state.sessions, [sessionId]: { ...session, state: event.type === 'started' ? 'running' : 'idle', updatedAt: at } } });
    }
    // The history lists a conversation by its first message, and counts its messages.
    if (event.type === 'message') {
      const session = this.state.sessions[sessionId];
      const runs = new Set(this.state.turns.filter((candidate) => candidate.sessionId === sessionId).map((candidate) => candidate.runId));
      if (session) this.set({ sessions: { ...this.state.sessions, [sessionId]: { ...session, title: session.title || messageTitle(event.text, event.attachments ?? []), turns: Math.max(session.turns, runs.size) } } });
    }
    if (event.type === 'finished' || event.type === 'failed') this.reloadRunsUntilClosed(turn.projectId, runId);
  }

  /** `create_step` names no step and `duplicate_step` names the source: the new step is the one the service reports. */
  private attachCreatedStep(projectId: string, sceneId: string, stepId: string) {
    const turns = this.state.turns;
    for (let t = 0; t < turns.length; t++) {
      const turn = turns[t];
      if (turn.projectId !== projectId || turn.status !== 'running') continue;
      for (let e = 0; e < turn.entries.length; e++) {
        const entry = turn.entries[e];
        if (entry.kind !== 'work') continue;
        // The service's event can arrive just after the tool's result, so a finished row still takes it.
        const i = entry.items.findIndex((item) => item.status !== 'error' && creatingTools.has(item.tool) && !item.stepId && (!item.sceneId || item.sceneId === sceneId));
        if (i < 0) continue;
        const items = entry.items.map((item, at) => at === i ? { ...item, sceneId, stepId } : item);
        const entries = turn.entries.map((existing, at) => at === e ? { ...entry, items } : existing);
        this.set({ turns: turns.map((existing, at) => at === t ? { ...turn, entries } : existing) });
        return;
      }
    }
  }

  /** After a reload the creation events are gone: the restore point still lists the steps a run created, in order. */
  private attachCreatedFromRuns(projectId: string, runs: RunSummary[]) {
    let changed = false;
    const turns = this.state.turns.map((turn) => {
      if (turn.projectId !== projectId || turn.status === 'running') return turn;
      const run = runs.find((candidate) => candidate.id === turn.runId);
      if (!run) return turn;
      // Only a creating row claims a step: later edits of the new step name it too.
      const used = new Set(turn.entries.flatMap((entry) => entry.kind === 'work' ? entry.items.filter((item) => creatingTools.has(item.tool)).map((item) => item.stepId) : []));
      const free = run.changes.createdSteps.filter((step) => !used.has(step.id));
      if (!free.length) return turn;
      const entries = turn.entries.map((entry) => {
        if (entry.kind !== 'work') return entry;
        let touched = false;
        const items = entry.items.map((item) => {
          if (!creatingTools.has(item.tool) || item.stepId || item.status !== 'done') return item;
          const at = free.findIndex((step) => !item.sceneId || step.sceneId === item.sceneId);
          if (at < 0) return item;
          const [step] = free.splice(at, 1);
          touched = true;
          return { ...item, sceneId: step.sceneId, stepId: step.id };
        });
        return touched ? { ...entry, items } : entry;
      });
      changed = true;
      return { ...turn, entries };
    });
    if (changed) this.set({ turns });
  }
}

function settle(entries: TurnEntry[], toolStatus: 'done' | 'error'): TurnEntry[] {
  return entries.map((entry) => {
    if (entry.kind === 'text') return entry.streaming ? { ...entry, streaming: false } : entry;
    return { ...entry, items: entry.items.map((item) => item.status === 'running' ? { ...item, status: toolStatus } : item) };
  });
}

/** One event applied to its turn. */
function reduce(turn: AgentTurn, event: AgentEvent, at: string): AgentTurn {
  const entries = [...turn.entries];
  const last = entries[entries.length - 1];
  switch (event.type) {
    case 'started':
      return { ...turn, startedAt: Date.parse(at) || turn.startedAt };
    case 'session':
      return turn;
    case 'message':
      return { ...turn, userText: event.text, ...(event.attachments?.length ? { userAttachments: event.attachments } : {}) };
    case 'text_delta':
      if (last?.kind === 'text' && last.streaming) entries[entries.length - 1] = { ...last, text: last.text + event.text };
      else entries.push({ kind: 'text', id: `text-${entries.length}`, text: event.text, streaming: true });
      return { ...turn, entries };
    case 'text':
      // A complete block repeats the deltas before it.
      if (last?.kind === 'text' && last.streaming) entries[entries.length - 1] = { ...last, text: event.text, streaming: false };
      else entries.push({ kind: 'text', id: `text-${entries.length}`, text: event.text, streaming: false });
      return { ...turn, entries };
    case 'tool_use': {
      const item: ToolItem = {
        id: event.id, tool: event.tool, readOnly: event.readOnly, status: 'running',
        ...(event.target?.sceneId ?? turn.sceneId ? { sceneId: event.target?.sceneId ?? turn.sceneId } : {}),
        // The step a duplicate names is its source, which it does not change.
        ...(event.target?.stepId && event.tool !== 'duplicate_step' ? { stepId: event.target.stepId } : {}),
      };
      // Text before a tool is complete. Earlier tool rows keep their own status until their result.
      const next = entries.map((entry) => entry.kind === 'text' && entry.streaming ? { ...entry, streaming: false } : entry);
      const tail = next[next.length - 1];
      if (tail?.kind === 'work') {
        if (tail.items.some((existing) => existing.id === item.id)) return turn;
        next[next.length - 1] = { ...tail, items: [...tail.items, item] };
      } else {
        next.push({ kind: 'work', id: `work-${next.length}`, items: [item] });
      }
      return { ...turn, entries: next };
    }
    case 'tool_result':
      return {
        ...turn,
        entries: entries.map((entry) => entry.kind !== 'work' ? entry : {
          ...entry, items: entry.items.map((item) => item.id === event.id ? { ...item, status: event.ok ? 'done' : 'error' } : item),
        }),
      };
    case 'finished':
      return { ...turn, status: event.reason === 'completed' ? 'completed' : 'cancelled', endedAt: at, entries: settle(entries, 'done') };
    case 'failed':
      return { ...turn, status: 'failed', errorMessage: event.message, endedAt: at, entries: settle(entries, 'error') };
  }
}

/** How the history names a conversation: its first message, or what it carried when it had no text, as the service does. */
function messageTitle(text: string, attachments: AgentAttachment[]) {
  const named = text.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (named) return named;
  const steps = attachments.filter((item) => item.kind === 'step').length;
  const images = attachments.length - steps;
  if (steps) return steps === 1 ? 'Step' : `${steps} steps`;
  return images === 1 ? 'Image' : images ? `${images} images` : '';
}

/** A file's bytes. */
function bytesOf(file: Blob) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('read'));
    reader.readAsArrayBuffer(file);
  });
}

/** A file's bytes as base64, without the `data:` prefix. */
function base64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('read'));
    reader.readAsDataURL(blob);
  });
}

export function useAgent(store: AgentStore) {
  return useSyncExternalStore(store.subscribe, store.getState);
}

export type StepMark = 'working' | 'changed';

/**
 * How the agent marks each step of a project: `changed` for any step a run that is not undone created or
 * changed, `working` for the step a running turn is changing now (its latest write).
 */
export function stepMarks(turns: AgentTurn[], runs: RunSummary[] | undefined, projectId: string | undefined): Record<string, StepMark> {
  const marks: Record<string, StepMark> = {};
  if (!projectId) return marks;
  const undone = new Set<string>();
  for (const run of runs ?? []) {
    if (run.status === 'undone') { undone.add(run.id); continue; }
    for (const step of [...run.changes.createdSteps, ...run.changes.modifiedSteps]) {
      if (step.currentStatus !== 'deleted') marks[step.id] = 'changed';
    }
  }
  for (const turn of turns) {
    if (turn.projectId !== projectId || undone.has(turn.runId)) continue;
    let latest: string | undefined;
    for (const entry of turn.entries) {
      if (entry.kind !== 'work') continue;
      for (const item of entry.items) {
        if (!item.stepId || !writeTools.has(item.tool) || item.status === 'error') continue;
        marks[item.stepId] = 'changed';
        latest = item.stepId;
      }
    }
    if (turn.status === 'running' && latest) marks[latest] = 'working';
  }
  return marks;
}

/** The running turn of a project, with the step it is changing now, for the Canvas's top bar. */
export function activeTurn(turns: AgentTurn[], projectId: string | undefined) {
  if (!projectId) return undefined;
  const turn = turns.find((candidate) => candidate.projectId === projectId && candidate.status === 'running');
  if (!turn) return undefined;
  let step: { sceneId?: string; stepId: string } | undefined;
  for (const entry of turn.entries) {
    if (entry.kind !== 'work') continue;
    for (const item of entry.items) if (item.stepId && writeTools.has(item.tool)) step = { sceneId: item.sceneId, stepId: item.stepId };
  }
  return { turn, step };
}
