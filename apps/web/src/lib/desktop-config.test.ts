// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient, configFromPage } from './api';

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
  it('takes the event stream’s address from the desktop app, whose page is not on the service', () => {
    (window as Window & { pasoDesktop?: { token: string; events?: string } }).pasoDesktop = { token: 'desktop-token', events: 'ws://127.0.0.1:50124/api/events' };
    const config = configFromPage();
    expect(config).toEqual({ baseUrl: window.location.origin, token: 'desktop-token', eventsUrl: 'ws://127.0.0.1:50124/api/events' });
    expect(new ApiClient(config).eventsTarget()).toEqual({ url: 'ws://127.0.0.1:50124/api/events', protocols: ['paso', 'paso-token.desktop-token'] });
    expect(new ApiClient({ baseUrl: 'http://127.0.0.1:3001', token: 't' }).eventsTarget().url).toBe('ws://127.0.0.1:3001/api/events');
  });
});
