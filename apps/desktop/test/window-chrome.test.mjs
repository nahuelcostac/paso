import { describe, expect, it } from 'vitest';
import { windowChrome } from '../lib/app-shell.mjs';

describe('the window frame', () => {
  it('drops the title bar on macOS and places the window buttons at the top of the activity bar', () => {
    expect(windowChrome('darwin')).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: { x: 10, y: 14 } });
  });
  it('keeps the system frame elsewhere', () => {
    expect(windowChrome('win32')).toEqual({});
    expect(windowChrome('linux')).toEqual({});
  });
});
