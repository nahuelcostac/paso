import { ApiError } from '../errors.js';
import type { SessionManager } from './sessions.js';

type Reply = { status: number; data?: unknown };

/**
 * Routes under /api/agent. Returns null for paths that are not agent routes.
 * Authentication, Host and Origin checks already happened in the server.
 */
export async function handleAgentRoute(manager: SessionManager, parts: string[], method: string | undefined, url: URL, json: () => Promise<unknown>): Promise<Reply | null> {
  if (parts[0] !== 'api' || parts[1] !== 'agent') return null;
  if (parts[2] !== 'sessions') throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
  const notAllowed = () => new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method.');
  if (parts.length === 3) {
    if (method === 'GET') return { status: 200, data: { sessions: await manager.list(url.searchParams.get('projectId') ?? undefined) } };
    if (method === 'POST') {
      const input = await json();
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ApiError(400, 'INVALID_BODY', 'Se esperaba un objeto JSON.');
      return { status: 201, data: await manager.create(input as { harness: unknown; projectId: unknown; sceneId?: unknown; model?: unknown }) };
    }
    throw notAllowed();
  }
  const id = parts[3];
  if (parts.length === 4) {
    if (method === 'GET') return { status: 200, data: await manager.read(id) };
    if (method === 'DELETE') { await manager.remove(id); return { status: 204 }; }
    throw notAllowed();
  }
  if (parts.length === 5) {
    const action = parts[4];
    if (action === 'messages' && method === 'POST') {
      const input = await json() as { text?: unknown } | null;
      return { status: 202, data: await manager.send(id, input?.text) };
    }
    if (action === 'cancel' && method === 'POST') return { status: 200, data: await manager.cancel(id) };
    if (action === 'resume' && method === 'POST') return { status: 200, data: await manager.resume(id) };
    if (action === 'events' && method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? 0);
      return { status: 200, data: await manager.events(id, Number.isInteger(after) && after >= 0 ? after : 0) };
    }
    if (['messages', 'cancel', 'resume', 'events'].includes(action)) throw notAllowed();
  }
  throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
}
