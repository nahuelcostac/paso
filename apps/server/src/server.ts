import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { HealthResponse } from '@paso/shared';

export const app = new Hono();

app.get('/api/health', (context) => {
  const response: HealthResponse = { status: 'ok' };
  return context.json(response);
});

export function startServer({ port }: { port: number }) {
  return serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
}
