// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { markWindowControls } from './desktop';

type WithBridge = Window & { pasoDesktop?: { windowControls?: 'mac' } };

describe('the window buttons over the page', () => {
  afterEach(() => { delete (window as WithBridge).pasoDesktop; delete document.documentElement.dataset.windowControls; });

  it("marks the page in the desktop app on macOS, so the activity bar leaves them room", () => {
    (window as WithBridge).pasoDesktop = { windowControls: 'mac' };
    markWindowControls();
    expect(document.documentElement.dataset.windowControls).toBe('mac');
  });
  it('leaves the page alone in a browser or on another system', () => {
    markWindowControls();
    expect(document.documentElement.dataset.windowControls).toBeUndefined();
    (window as WithBridge).pasoDesktop = {};
    markWindowControls();
    expect(document.documentElement.dataset.windowControls).toBeUndefined();
  });
});
