import { describe, expect, it } from 'vitest';
import { app } from './server';

describe('GET /api/health', () => {
  it('returns a successful health response', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
