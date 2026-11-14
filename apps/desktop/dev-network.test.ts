import { describe, expect, it } from 'vitest';
import { isDevRequestAllowed } from './dev-network.mjs';

describe('desktop development network boundary', () => {
  const origin = 'http://127.0.0.1:50123';
  it('permits local Vite and its HMR socket', () => {
    expect(isDevRequestAllowed(`${origin}/src/main.tsx`, origin)).toBe(true);
    expect(isDevRequestAllowed('ws://127.0.0.1:50123/', origin)).toBe(true);
    expect(isDevRequestAllowed('blob:http://127.0.0.1:50123/id', origin)).toBe(true);
  });
  it('blocks external requests, other ports, and malformed URLs', () => {
    for (const url of ['https://example.com/', 'http://127.0.0.1:3001/', 'ws://localhost:50123/', 'file:///etc/passwd', 'invalid']) {
      expect(isDevRequestAllowed(url, origin)).toBe(false);
    }
  });
});
