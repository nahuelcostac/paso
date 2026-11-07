import { resolve } from 'node:path';
import type { Step } from '@paso/shared';
import type { Target } from './input.js';

export type Configuration = { serviceUrl: string; sessionToken: string; browserExecutable?: string };
export type Envelope<T> = { document: T; revision: string };
export function configuration(env: NodeJS.ProcessEnv): Configuration {
  let url: URL;
  try { url = new URL(env.PASO_SERVICE_URL ?? 'http://127.0.0.1:3001'); }
  catch { throw new Error('Invalid PASO_SERVICE_URL. Use http://127.0.0.1:<port> for the running local Paso service.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid PASO_SERVICE_URL. Only an HTTP loopback service origin is allowed, with no credentials, path, query or fragment.');
  }
  if (!env.PASO_SESSION_TOKEN || !/^[A-Za-z0-9_-]{32,256}$/.test(env.PASO_SESSION_TOKEN)) {
    throw new Error('PASO_SESSION_TOKEN is required. Obtain the 32 to 256 character session token from the trusted Paso service host. Never put it in tool arguments.');
  }
  const browserExecutable = env.PASO_MCP_BROWSER_EXECUTABLE;
  if (browserExecutable && resolve(browserExecutable) !== browserExecutable) throw new Error('PASO_MCP_BROWSER_EXECUTABLE must be an absolute path supplied by the host. No browser is downloaded.');
  return { serviceUrl: url.origin, sessionToken: env.PASO_SESSION_TOKEN, browserExecutable };
}
export const scenePath = (projectId: string, sceneId?: string) => `/api/projects/${projectId}/scenes${sceneId ? `/${sceneId}` : ''}`;
export const stepPath = (target: Target) => `${scenePath(target.projectId, target.sceneId)}/steps/${target.stepId}`;

export class BoardApi {
  constructor(readonly config: Configuration) {}
  async request<T>(path: string, method = 'GET', input?: unknown, revision?: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.config.serviceUrl}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${this.config.sessionToken}`, 'X-Paso-Actor': 'mcp', ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(revision ? { 'If-Match': `"${revision}"` } : {}) },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
    } catch { throw new Error('SERVICE_UNAVAILABLE. Start the local Paso service and check PASO_SERVICE_URL. The request was not retried. Read current state before retrying a write with an unknown outcome.'); }
    const data = await response.json() as { error?: { code?: string; message?: string } };
    if (!response.ok) {
      if (response.status === 401) throw new Error('UNAUTHORIZED. PASO_SESSION_TOKEN does not match the running service. Ask the host to refresh the MCP environment.');
      if (data.error?.code === 'REVISION_CONFLICT') throw new Error('REVISION_CONFLICT. The step changed. Call read_step again and reconsider your edits using its new revision. No change was written and no automatic retry was attempted.');
      throw new Error(`${data.error?.code ?? 'SERVICE_ERROR'}. ${data.error?.message ?? 'The local service rejected this request.'}`);
    }
    return data as T;
  }
  readStep(target: Target) { return this.request<Envelope<Step>>(stepPath(target)); }
  async asset(projectId: string, path: string) {
    if (!/^assets\/[A-Za-z0-9_-]{1,128}\.[a-z0-9]+$/.test(path)) throw new Error('INVALID_ASSET. The step has an invalid asset reference.');
    const response = await fetch(`${this.config.serviceUrl}/api/projects/${projectId}/${path}`, {
      headers: { Authorization: `Bearer ${this.config.sessionToken}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('IMAGE_UNAVAILABLE. A referenced Paso asset could not be read through the service.');
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 50 * 1024 * 1024) throw new Error('IMAGE_UNAVAILABLE. An asset exceeds the 50 MiB render limit.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks).toString('base64');
  }
}
