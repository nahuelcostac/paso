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
  deleteProject(id: string, revision: string) {
    return this.request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE', revision });
  }

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
  createStep(projectId: string, sceneId: string) {
    return this.request<{ document: Step; revision: string }>(`/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/steps`, { method: 'POST', body: {} });
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

  /** WebSocket URL and subprotocols. The token never goes in the URL. */
  eventsTarget() {
    return { url: `${this.config.baseUrl.replace(/^http/, 'ws')}/api/events`, protocols: ['paso', `paso-token.${this.config.token}`] };
  }
}
