import { describe, expect, it } from 'vitest';
import { windowChrome } from '../lib/app-shell.mjs';

describe('the window frame', () => {
  it('drops the title bar on macOS and places the window buttons in the sidebar head', () => {
    expect(windowChrome('darwin')).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 24 } });
  });
  it('keeps the system frame elsewhere', () => {
    expect(windowChrome('win32')).toEqual({});
    expect(windowChrome('linux')).toEqual({});
  });
});
