// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { configFromPage } from './api';

describe('session configuration', () => {
  afterEach(() => {
    document.head.querySelector('meta[name="paso-session-token"]')?.remove();
    delete (window as Window & { pasoDesktop?: { token: string } }).pasoDesktop;
  });
  it('uses the isolated desktop token when no development meta tag exists', () => {
    (window as Window & { pasoDesktop?: { token: string } }).pasoDesktop = { token: 'desktop-token' };
    expect(configFromPage()).toEqual({ baseUrl: window.location.origin, token: 'desktop-token' });
  });
  it('keeps the development meta tag as the first choice', () => {
    const meta = document.createElement('meta');
    meta.name = 'paso-session-token'; meta.content = 'dev-token'; document.head.append(meta);
    (window as Window & { pasoDesktop?: { token: string } }).pasoDesktop = { token: 'desktop-token' };
    expect(configFromPage().token).toBe('dev-token');
  });
});
