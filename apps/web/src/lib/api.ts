import type { Project, Scene } from '@paso/shared';

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

  private async request<T>(path: string, init: { method?: string; body?: unknown; revision?: string } = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/api${path}`, {
        method: init.method ?? 'GET',
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

  /** WebSocket URL and subprotocols. The token never goes in the URL. */
  eventsTarget() {
    return { url: `${this.config.baseUrl.replace(/^http/, 'ws')}/api/events`, protocols: ['paso', `paso-token.${this.config.token}`] };
  }
}
