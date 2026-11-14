/**
 * Remembers the window's size, position and maximized state between launches, in a small JSON file in the
 * Electron profile. `placeWindow` is pure: it gets the saved state and the displays as they are now, so a window
 * saved on a display that has since been removed comes back on one that exists.
 *
 * This module does not import Electron so it can be tested in Node.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export const DEFAULT_SIZE = { width: 1400, height: 900 };
/** Smaller than this is not a size anyone left the window at on purpose. */
const MIN_SIZE = { width: 400, height: 300 };
/** How much of the title bar must be on a display for the window to count as reachable. */
const GRAB = { width: 120, height: 24 };

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {{ bounds: Rect, maximized: boolean }} WindowState */

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** The state read from disk, or null when it is missing or not what Paso wrote. */
export function parseState(value) {
  const bounds = value?.bounds;
  if (!bounds || !['x', 'y', 'width', 'height'].every((key) => finite(bounds[key]))) return null;
  if (bounds.width < MIN_SIZE.width || bounds.height < MIN_SIZE.height) return null;
  const round = (key) => Math.round(bounds[key]);
  return { bounds: { x: round('x'), y: round('y'), width: round('width'), height: round('height') }, maximized: value.maximized === true };
}

function overlap(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? { width, height } : null;
}

function centred(size, area) {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height };
}

/**
 * Where to open the window.
 * @param {WindowState | null} saved The state from the last launch, already parsed.
 * @param {{ workArea: Rect }[]} displays The displays now connected.
 * @param {{ workArea: Rect }} primary The primary display.
 * @returns {WindowState}
 */
export function placeWindow(saved, displays, primary) {
  if (!saved) return { bounds: centred(DEFAULT_SIZE, primary.workArea), maximized: false };
  const { bounds } = saved;
  // The title bar has to be on a display, or the window could not be moved back.
  const titleBar = { x: bounds.x, y: bounds.y, width: bounds.width, height: GRAB.height };
  const home = displays.find(({ workArea }) => {
    const shared = overlap(titleBar, workArea);
    return shared && shared.width >= Math.min(GRAB.width, bounds.width) && shared.height >= GRAB.height;
  });
  if (home) {
    const area = home.workArea;
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    // Keep the position, pulled in just enough for a window that shrank to fit.
    const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
    return { bounds: { x, y, width, height }, maximized: saved.maximized };
  }
  // Off every display (one was unplugged, or the arrangement changed): the same size, centred on the primary one.
  return { bounds: centred(bounds, primary.workArea), maximized: saved.maximized };
}

/** @returns {WindowState | null} */
export function readState(file) {
  try { return parseState(JSON.parse(readFileSync(file, 'utf8'))); } catch { return null; }
}

/** Writes the state in one step, so a crash never leaves half a file. */
export function writeState(file, state) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`);
  renameSync(temporary, file);
}

/**
 * Saves the window's state when it settles after a move or resize, and when it closes.
 * @param {import('electron').BrowserWindow} window
 * @param {string} file
 */
export function trackWindowState(window, file) {
  let timer;
  const save = () => {
    clearTimeout(timer);
    if (window.isDestroyed()) return;
    // The normal bounds are the ones to restore to, even while maximized or in full screen.
    try { writeState(file, { bounds: window.getNormalBounds(), maximized: window.isMaximized() }); }
    catch (error) { console.error('Paso could not save the window state:', error); }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
  for (const event of ['resized', 'moved', 'maximize', 'unmaximize']) window.on(event, later);
  window.on('close', save);
}
