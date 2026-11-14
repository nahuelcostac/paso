import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SIZE, parseState, placeWindow, readState, writeState } from '../lib/window-state.mjs';

const display = (x, y, width, height) => ({ workArea: { x, y, width, height } });
// A laptop screen with the menu bar taking the top 25px, and an external display to its right.
const laptop = display(0, 25, 1512, 957);
const external = display(1512, 0, 2560, 1415);

describe('window placement', () => {
  it('opens a first window at the default size, centred on the primary display', () => {
    expect(placeWindow(null, [laptop], laptop)).toEqual({ bounds: { x: 56, y: 54, ...DEFAULT_SIZE }, maximized: false });
  });

  it('shrinks the default size to a small display', () => {
    const small = display(0, 25, 1280, 775);
    expect(placeWindow(null, [small], small).bounds).toEqual({ x: 0, y: 25, width: 1280, height: 775 });
  });

  it('restores the saved bounds and maximized state on a display that still exists', () => {
    const saved = { bounds: { x: 1700, y: 120, width: 1600, height: 1000 }, maximized: true };
    expect(placeWindow(saved, [laptop, external], laptop)).toEqual(saved);
  });

  it('keeps a window whose title bar is partly on screen, pulled in to fit', () => {
    const saved = { bounds: { x: -300, y: 400, width: 1000, height: 700 }, maximized: false };
    expect(placeWindow(saved, [laptop], laptop).bounds).toEqual({ x: 0, y: 282, width: 1000, height: 700 });
  });

  it('centres the window on the primary display when its display was removed', () => {
    const saved = { bounds: { x: 1700, y: 120, width: 1600, height: 1000 }, maximized: false };
    expect(placeWindow(saved, [laptop], laptop)).toEqual({ bounds: { x: 0, y: 25, width: 1512, height: 957 }, maximized: false });
    const modest = { bounds: { x: 2000, y: 300, width: 1000, height: 700 }, maximized: true };
    expect(placeWindow(modest, [laptop], laptop)).toEqual({ bounds: { x: 256, y: 154, width: 1000, height: 700 }, maximized: true });
  });

  it('does not count a sliver of window on a display as reachable', () => {
    // Only 40px of the title bar would show at the right edge, too little to grab.
    const saved = { bounds: { x: 1472, y: 100, width: 900, height: 600 }, maximized: false };
    expect(placeWindow(saved, [laptop], laptop).bounds).toEqual({ x: 306, y: 204, width: 900, height: 600 });
  });

  it('brings back a window whose title bar ended up above the screen', () => {
    const saved = { bounds: { x: 100, y: -800, width: 900, height: 900 }, maximized: false };
    expect(placeWindow(saved, [laptop], laptop).bounds).toEqual({ x: 306, y: 54, width: 900, height: 900 });
  });
});

describe('the saved state', () => {
  let folder;
  afterEach(async () => { if (folder) await rm(folder, { recursive: true, force: true }); folder = undefined; });

  it('accepts only what Paso writes', () => {
    expect(parseState({ bounds: { x: 10.4, y: 20, width: 800, height: 600 }, maximized: true })).toEqual({ bounds: { x: 10, y: 20, width: 800, height: 600 }, maximized: true });
    expect(parseState({ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: 'yes' })?.maximized).toBe(false);
    expect(parseState(null)).toBeNull();
    expect(parseState({ bounds: { x: 0, y: 0, width: 800 } })).toBeNull();
    expect(parseState({ bounds: { x: Number.NaN, y: 0, width: 800, height: 600 } })).toBeNull();
    expect(parseState({ bounds: { x: 0, y: 0, width: 50, height: 600 } })).toBeNull();
    expect(parseState({ bounds: { x: '0', y: 0, width: 800, height: 600 } })).toBeNull();
  });

  it('round-trips through its file and ignores a broken one', async () => {
    folder = await mkdtemp(join(tmpdir(), 'paso-window-state-'));
    const file = join(folder, 'window-state.json');
    expect(readState(file)).toBeNull();
    const state = { bounds: { x: 40, y: 60, width: 1200, height: 800 }, maximized: false };
    writeState(file, state);
    expect(readState(file)).toEqual(state);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(state);
    await writeFile(file, '{ not json');
    expect(readState(file)).toBeNull();
  });
});
