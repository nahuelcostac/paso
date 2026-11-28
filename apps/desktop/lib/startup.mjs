import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * What the desktop app does so that its window never stays silently blank: a log the person can find, a watch on the
 * page while it opens, and the error shown when it does not. This module does not import Electron, so it can be
 * tested in Node.
 */

export const LOG_FILE = 'main.log';
const OLD_LOG_FILE = 'main.old.log';

/**
 * Opens the main process's log, `main.log` in `directory`. A log over `maxBytes` is moved to `main.old.log` first, so
 * at most two files are kept. Writing never throws: a log that cannot be written must not stop Paso.
 * @param {string} directory
 * @param {{ maxBytes?: number; now?: () => Date }} [options]
 */
export function openLog(directory, { maxBytes = 1024 * 1024, now = () => new Date() } = {}) {
  const file = join(directory, LOG_FILE);
  try {
    mkdirSync(directory, { recursive: true });
    if (statSync(file, { throwIfNoEntry: false })?.size > maxBytes) renameSync(file, join(directory, OLD_LOG_FILE));
  } catch { /* the writes below fail quietly too */ }
  return {
    file,
    directory: dirname(file),
    /** @param {string} message @param {unknown} [details] */
    write(message, details) {
      const extra = details === undefined ? '' : ` ${describe(details)}`;
      try { appendFileSync(file, `${now().toISOString()} ${message}${extra}\n`); } catch { /* see above */ }
    },
  };
}

/** One line for anything logged: errors with their stack, everything else as JSON. */
export function describe(value) {
  if (value instanceof Error) return (value.stack ?? `${value.name}: ${value.message}`).replace(/\r?\n\s*/g, ' | ');
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Runs in the page: true once React has put the app into `#root` (apps/web/index.html). */
export const RENDERED_CHECK = "(document.getElementById('root')?.childElementCount ?? 0) > 0";

/** How long the page may take to appear before Paso says so. A first launch can be slow while antivirus scans the app. */
export const STARTUP_TIMEOUT_MS = 20_000;

/** Chromium's ERR_ABORTED: a load replaced by another one, which is not a failure. */
const ERR_ABORTED = -3;

/**
 * Watches one load of the page in `contents` (a webContents) until the app has rendered. Calls `onReady` with the time
 * it took, or `onFailure` once with a sentence for the person if the load fails, the page's process stops, the preload
 * fails, or nothing appears within `timeoutMs`. Everything is written to `log`.
 * @param {{ on: Function; off: Function }} contents
 * @param {{ isRendered: () => Promise<boolean>; log: { write: (message: string, details?: unknown) => void };
 *   onReady?: (ms: number) => void; onFailure: (reason: string) => void; timeoutMs?: number; pollMs?: number;
 *   now?: () => number; timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } }} options
 * @returns {() => void} Stops watching.
 */
export function watchPage(contents, { isRendered, log, onReady, onFailure, timeoutMs = STARTUP_TIMEOUT_MS, pollMs = 250, now = Date.now, timers = globalThis }) {
  const started = now();
  let done = false;
  let poll;
  let deadline;
  const stop = () => {
    done = true;
    timers.clearTimeout(deadline);
    timers.clearTimeout(poll);
    for (const [event, listener] of Object.entries(listeners)) contents.off(event, listener);
  };
  const fail = (reason, details) => {
    if (done) return;
    stop();
    log.write(`Startup failed: ${reason}`, details);
    onFailure(reason);
  };
  const check = async () => {
    if (done) return;
    let rendered = false;
    try { rendered = await isRendered(); } catch (error) { log.write('Could not check the page', error); }
    if (done) return;
    if (rendered) { stop(); const ms = now() - started; log.write(`Page ready after ${ms} ms`); onReady?.(ms); }
    else poll = timers.setTimeout(check, pollMs);
  };
  const listeners = {
    'did-finish-load': () => { log.write('Page loaded'); timers.clearTimeout(poll); void check(); },
    // The app's handler answers a missing or unreadable page with an error status rather than a network error.
    'did-navigate': (_event, url, status) => { if (status >= 400) fail(`The page didn't load (status ${status}).`, { url }); },
    'did-fail-load': (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED) fail(`The page didn't load (${description || 'error'} ${code}).`, { url });
    },
    'render-process-gone': (_event, details) => fail(`The page's process stopped (${details?.reason ?? 'unknown'}).`, details),
    'preload-error': (_event, path, error) => fail("The window's connection to Paso failed.", { path, error: describe(error) }),
  };
  for (const [event, listener] of Object.entries(listeners)) contents.on(event, listener);
  deadline = timers.setTimeout(() => fail(`Nothing appeared within ${Math.round(timeoutMs / 1000)} seconds.`), timeoutMs);
  return stop;
}

/**
 * The console messages worth keeping: warnings and errors. Electron passes an event with `level` as a word, older
 * versions as a number.
 */
export function consoleEntry(event) {
  const level = typeof event?.level === 'number' ? ['verbose', 'info', 'warning', 'error'][event.level] : event?.level;
  if (level !== 'warning' && level !== 'error') return null;
  return { level, message: String(event.message ?? '').slice(0, 2000), source: event.sourceId ? `${event.sourceId}:${event.lineNumber ?? 0}` : undefined };
}

export const NOT_OPENED = "Paso didn't finish opening.";
export const STOPPED = "Paso's window stopped working.";

/**
 * The error shown when the window did not open, or stopped working later. The buttons are, in order, `Try Again`,
 * `Open Log Folder` and `Quit`.
 */
export function startupErrorDialog(reason, logFile, message = NOT_OPENED) {
  return {
    type: 'error', title: 'Paso', message,
    detail: `${reason}\n\nThe details are in the log:\n${logFile}`,
    buttons: ['Try Again', 'Open Log Folder', 'Quit'], defaultId: 0, cancelId: 2, noLink: true,
  };
}

/** @returns {'retry' | 'open-log' | 'quit'} */
export const startupErrorChoice = (response) => (response === 0 ? 'retry' : response === 1 ? 'open-log' : 'quit');

/** The error shown when the service could not start, before there is a window. */
export function serviceErrorMessage(error, logFile) {
  return { title: "Paso couldn't start", content: `${error instanceof Error ? error.message : String(error)}\n\nThe details are in the log:\n${logFile}` };
}
