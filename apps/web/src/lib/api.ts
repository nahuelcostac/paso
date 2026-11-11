import type { Project, Scene, Step } from '@paso/shared';
import type { Target, Binaries } from '../editor/step-store';

export type ClientConfig = { baseUrl: string; token: string };

/** The service cannot be reached, or rejected this session. The UI offers a retry. */
export class UnavailableError extends Error {
  constructor(readonly reason: 'network' | 'session' | 'server') {
    super(reason);
  }
}
/** The service answered with an error for this one request. */
export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type ProjectEnvelope = { document: Project; revision: string };
export type ProjectListItem = ({ id: string } & ProjectEnvelope) | { id: string; error: { code: string; message: string } };

/** A folder of projects. `default` is the service's own folder, always listed. */
export type WorkspaceInfo = { id: string; name: string; path: string; default: boolean; available: boolean };
export type WorkspaceListing = { activeId: string; workspaces: WorkspaceInfo[] };
export type FolderListing = { path: string; parent: string | null; home: string; folders: Array<{ name: string; path: string }>; projects: number; crumbs: Array<{ name: string; path: string }> };

export const harnessIds = ['claude', 'codex', 'agy'] as const;
export type HarnessId = (typeof harnessIds)[number];
export type HarnessSessionStatus = 'signed_in' | 'signed_out' | 'unknown';
export type DetectedHarness = {
  id: HarnessId;
  found: boolean;
  path: string | null;
  version: string | null;
  session: HarnessSessionStatus;
  message?: string;
};

export type ToolTarget = { projectId?: string; sceneId?: string; stepId?: string };
export type AgentEvent =
  | { type: 'started' }
  /** The person's message, added by the service right after `started`. */
  | { type: 'message'; text: string }
  | { type: 'session'; resumeToken: string; model?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; tool: string; readOnly: boolean; target?: ToolTarget }
  | { type: 'tool_result'; id: string; ok: boolean }
  | { type: 'finished'; reason: 'completed' | 'cancelled' }
  | { type: 'failed'; code: string; message: string };

export type AgentSessionInfo = {
  id: string;
  harness: HarnessId;
  projectId: string;
  sceneId?: string;
  model?: string;
  state: 'idle' | 'running';
  resumable: boolean;
  createdAt: string;
  updatedAt: string;
  /** The start of the first message. */
  title?: string;
  /** How many messages the conversation has. */
  turns: number;
};

export type AgentSessionEvent = {
  sessionId: string;
  runId: string;
  seq: number;
  at: string;
  event: AgentEvent;
};

export type UndoWarning = {
  code: 'STEP_MODIFIED_CONCURRENTLY' | 'STEP_MODIFIED_AFTER_RUN' | 'STEP_DELETED' | 'SCENE_DELETED' | 'SCENE_HAS_POST_RUN_STEPS' | 'ORDER_MODIFIED_AFTER_RUN';
  kind: 'project' | 'scene' | 'step';
  id: string;
  sceneId?: string;
  title?: string;
  message: string;
};

export type UndoPlan = {
  runId: string;
  projectId: string;
  status: 'running' | 'finished' | 'interrupted' | 'undone';
  canUndo: boolean;
  requiresForce: boolean;
  confirmationToken: string;
  changes: {
    stepsToRestore: Array<{ id: string; sceneId: string; title?: string; currentRevision: string; restoreRevision: string }>;
    stepsToRecreate: Array<{ id: string; sceneId: string; title?: string; restoreRevision: string }>;
    stepsToDelete: Array<{ id: string; sceneId: string; title?: string; currentRevision: string }>;
    scenesToDelete: Array<{ id: string; name: string; currentRevision: string }>;
    scenesToKeepWithPostRunSteps: Array<{ id: string; name: string; retainedStepIds: string[] }>;
    orderChanges: Array<{ kind: 'project' | 'scene'; id: string; currentIds: string[]; restoredIds: string[] }>;
  };
  warnings: UndoWarning[];
};

export type RunSummary = {
  id: string;
  projectId: string;
  status: 'running' | 'finished' | 'interrupted' | 'undone';
  label?: string;
  startedAt: string;
  finishedAt: string | null;
  undoneAt: string | null;
  changes: {
    createdScenes: Array<{ id: string; name?: string; currentStatus: 'present' | 'deleted' }>;
    createdSteps: Array<{ id: string; sceneId: string; title?: string; currentStatus: 'present' | 'modified_after_run' | 'deleted' }>;
    modifiedSteps: Array<{ id: string; sceneId: string; title?: string; baselineRevision: string; runRevision: string; currentRevision: string | null; currentStatus: 'unchanged_since_run' | 'modified_concurrently' | 'modified_after_run' | 'deleted' }>;
    orderChanged: { project: boolean; sceneIds: string[] };
  };
  warnings: UndoWarning[];
};

export function configFromPage(): ClientConfig {
  const token = document.querySelector<HTMLMetaElement>('meta[name="paso-session-token"]')?.content ?? '';
  return { baseUrl: window.location.origin, token };
}

export class ApiClient {
  constructor(readonly config: ClientConfig) {}

  private async request<T>(path: string, init: { method?: string; body?: unknown; revision?: string; keepalive?: boolean } = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/api${path}`, {
        method: init.method ?? 'GET',
        keepalive: init.keepalive,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init.revision ? { 'If-Match': `"${init.revision}"` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new UnavailableError('network');
    }
    if (response.status === 401 || response.status === 403) throw new UnavailableError('session');
    // The dev proxy answers 5xx when the service is down. The service itself uses 500 for its own failures.
    if (response.status === 502 || response.status === 503 || response.status === 504) throw new UnavailableError('network');
    if (response.status === 204) return undefined as T;
    let data: unknown;
    try { data = await response.json(); } catch { data = undefined; }
    if (!response.ok) {
      const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      if (response.status >= 500 && !error) throw new UnavailableError('server');
      throw new ApiRequestError(response.status, error?.code ?? 'ERROR', error?.message ?? `Error ${response.status}`);
    }
    return data as T;
  }

  async health() { await this.request<{ status: 'ok' }>('/health'); }
  async listProjects() { return (await this.request<{ projects: ProjectListItem[] }>('/projects')).projects; }
  getProject(id: string) { return this.request<ProjectEnvelope>(`/projects/${encodeURIComponent(id)}`); }
  async listScenes(id: string) { return (await this.request<{ scenes: Array<{ document: Scene; revision: string }> }>(`/projects/${encodeURIComponent(id)}/scenes`)).scenes; }
  createProject(input: { name: string; icon?: string }) { return this.request<ProjectEnvelope>('/projects', { method: 'POST', body: input }); }
  updateProject(id: string, revision: string, input: { name?: string; icon?: string | null }) {
    return this.request<ProjectEnvelope>(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: input, revision });
  }
  /** «Abrir carpeta»: the service opens the project's folder in the system's file manager. */
  revealProject(id: string) {
    return this.request<void>(`/projects/${encodeURIComponent(id)}/reveal`, { method: 'POST' });
  }
  deleteProject(id: string, revision: string) {
    return this.request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE', revision });
  }

  listWorkspaces() { return this.request<WorkspaceListing>('/workspaces'); }
  addWorkspace(path: string) { return this.request<WorkspaceInfo>('/workspaces', { method: 'POST', body: { path } }); }
  /** Opens a workspace: every project route then works in its folder. */
  activateWorkspace(id: string) { return this.request<WorkspaceListing>('/workspaces/active', { method: 'PUT', body: { id } }); }
  /** Takes a workspace off the list. Its folder and files stay. */
  removeWorkspace(id: string) { return this.request<void>(`/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  revealWorkspace(id: string) { return this.request<void>(`/workspaces/${encodeURIComponent(id)}/reveal`, { method: 'POST' }); }
  /** The folder explorer: folder names only. With no path it starts in the person's home folder. */
  listFolders(path?: string) { return this.request<FolderListing>(`/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`); }
  createFolder(parent: string, name: string) { return this.request<{ path: string }>('/folders', { method: 'POST', body: { parent, name } }); }

  private stepPath(target: Target) {
    return `/projects/${encodeURIComponent(target.projectId)}/scenes/${encodeURIComponent(target.sceneId)}/steps/${encodeURIComponent(target.stepId)}`;
  }
  getStep(target: Target) { return this.request<{ document: Step; revision: string }>(this.stepPath(target)); }
  saveStep(target: Target, revision: string, document: Step, keepalive = false) {
    return this.request<{ document: Step; revision: string }>(this.stepPath(target), { method: 'PUT', body: document, revision, keepalive });
  }
  async listSteps(projectId: string, sceneId: string) {
    return (await this.request<{ steps: Array<{ document: Step; revision: string }> }>(`/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/steps`)).steps;
  }
  createScene(projectId: string, name: string) {
    return this.request<{ document: Scene; revision: string }>(`/projects/${encodeURIComponent(projectId)}/scenes`, { method: 'POST', body: { name } });
  }
  private scenePath(projectId: string, sceneId: string) { return `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}`; }
  getScene(projectId: string, sceneId: string) { return this.request<{ document: Scene; revision: string }>(this.scenePath(projectId, sceneId)); }
  renameScene(projectId: string, sceneId: string, revision: string, name: string) {
    return this.request<{ document: Scene; revision: string }>(this.scenePath(projectId, sceneId), { method: 'PATCH', body: { name }, revision });
  }
  deleteScene(projectId: string, sceneId: string, revision: string) {
    return this.request<void>(this.scenePath(projectId, sceneId), { method: 'DELETE', revision });
  }
  /** Scene order lives in the project document, so this is guarded by the project's revision. */
  reorderScenes(projectId: string, revision: string, ids: string[]) {
    return this.request<ProjectEnvelope>(`/projects/${encodeURIComponent(projectId)}/scenes`, { method: 'PUT', body: { ids }, revision });
  }
  /** Appends a step. With no content it is blank; with a body it is a snapshot of that content, element IDs included. */
  createStep(projectId: string, sceneId: string, body: Partial<Pick<Step, 'title' | 'speakerNotes' | 'camera' | 'elements' | 'appState' | 'files'>> = {}) {
    return this.request<{ document: Step; revision: string }>(`${this.scenePath(projectId, sceneId)}/steps`, { method: 'POST', body });
  }
  /** The copy is appended to the scene. `revision` is the revision of the step being copied. */
  duplicateStep(target: Target, revision: string) {
    return this.request<{ document: Step; revision: string }>(`${this.stepPath(target)}/duplicate`, { method: 'POST', body: {}, revision });
  }
  deleteStep(target: Target, revision: string) {
    return this.request<void>(this.stepPath(target), { method: 'DELETE', revision });
  }
  /** `revision` is the scene's. `ids` must be exactly the scene's current steps. */
  reorderSteps(projectId: string, sceneId: string, revision: string, ids: string[]) {
    return this.request<{ document: Scene; revision: string }>(`${this.scenePath(projectId, sceneId)}/steps`, { method: 'PUT', body: { ids }, revision });
  }
  async asset(projectId: string, path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.config.baseUrl}/api/projects/${encodeURIComponent(projectId)}/${path}`, {
      ...init, headers: { ...init.headers, Authorization: `Bearer ${this.config.token}` },
    });
    if (!response.ok) throw new ApiRequestError(response.status, 'ASSET', 'No se pudo cargar o guardar una imagen.');
    return response;
  }
  async uploadFiles(target: Target, document: Step, binaries: Binaries, keepalive = false) {
    for (const [id, binary] of Object.entries(binaries)) {
      const entry = document.files[id];
      if (!entry) continue;
      const blob = await (await fetch(binary.dataURL)).blob();
      await this.asset(target.projectId, entry.path, { method: 'PUT', body: blob, keepalive });
    }
  }

  async detectHarnesses() {
    return (await this.request<{ harnesses: DetectedHarness[] }>('/harnesses/detect')).harnesses;
  }
  async listHarnesses() {
    return (await this.request<{ harnesses: DetectedHarness[] }>('/harnesses')).harnesses;
  }
  addHarness(id: HarnessId) {
    return this.request<DetectedHarness>('/harnesses', { method: 'POST', body: { id } });
  }
  removeHarness(id: HarnessId) {
    return this.request<void>(`/harnesses/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  createAgentSession(input: { harness: HarnessId; projectId: string; sceneId?: string; model?: string }) {
    return this.request<AgentSessionInfo>('/agent/sessions', { method: 'POST', body: input });
  }
  async listAgentSessions(projectId?: string) {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return (await this.request<{ sessions: AgentSessionInfo[] }>(`/agent/sessions${query}`)).sessions;
  }
  getAgentSession(id: string) {
    return this.request<AgentSessionInfo>(`/agent/sessions/${encodeURIComponent(id)}`);
  }
  deleteAgentSession(id: string) {
    return this.request<void>(`/agent/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  sendAgentMessage(id: string, text: string, effort?: string) {
    return this.request<{ runId: string }>(`/agent/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { text, ...(effort ? { effort } : {}) } });
  }
  cancelAgentSession(id: string) {
    return this.request<{ cancelled: boolean }>(`/agent/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }
  resumeAgentSession(id: string) {
    return this.request<AgentSessionInfo>(`/agent/sessions/${encodeURIComponent(id)}/resume`, { method: 'POST' });
  }
  getAgentSessionEvents(id: string, after = 0) {
    return this.request<{ events: AgentSessionEvent[]; next: number }>(`/agent/sessions/${encodeURIComponent(id)}/events?after=${after}`);
  }

  async listProjectRuns(projectId: string) {
    return (await this.request<{ runs: RunSummary[] }>(`/projects/${encodeURIComponent(projectId)}/runs`)).runs;
  }
  async getProjectRun(projectId: string, runId: string) {
    return (await this.request<{ run: RunSummary }>(`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`)).run;
  }
  async previewUndoRun(projectId: string, runId: string) {
    return (await this.request<{ plan: UndoPlan }>(`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/undo`)).plan;
  }
  executeUndoRun(projectId: string, runId: string, confirm: string, force?: boolean) {
    return this.request<{ run: RunSummary; plan: UndoPlan }>(
      `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/undo`,
      { method: 'POST', body: { confirm, ...(force ? { force: true } : {}) } },
    );
  }

  /** WebSocket URL and subprotocols. The token never goes in the URL. */
  eventsTarget() {
    return { url: `${this.config.baseUrl.replace(/^http/, 'ws')}/api/events`, protocols: ['paso', `paso-token.${this.config.token}`] };
  }
}
