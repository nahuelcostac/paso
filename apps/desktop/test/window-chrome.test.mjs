import { describe, expect, it, vi } from 'vitest';
import { configureLoopbackProxy, windowChrome } from '../lib/app-shell.mjs';

describe('the window frame', () => {
  it('drops the title bar on macOS and places the window buttons at the top of the activity bar', () => {
    expect(windowChrome('darwin')).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: { x: 10, y: 14 } });
  });
  it('keeps the system frame elsewhere', () => {
    expect(windowChrome('win32')).toEqual({});
    expect(windowChrome('linux')).toEqual({});
  });
});

it('connects directly to the loopback service in the Windows desktop session', async () => {
  const session = { setProxy: vi.fn() };
  await configureLoopbackProxy(session, 'darwin');
  expect(session.setProxy).not.toHaveBeenCalled();
  await configureLoopbackProxy(session, 'win32');
  expect(session.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'direct' });
});
