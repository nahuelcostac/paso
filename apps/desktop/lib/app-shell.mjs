import { isAppUrl } from './app-origin.mjs';

/**
 * Small pieces of desktop behaviour kept out of main.mjs. This module does not import Electron so it can be tested in Node.
 */

/** Brings a window to the front, out of the Dock if it was minimized. */
export function focusWindow(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/**
 * Keeps Paso to one instance per profile. Launching it again focuses the existing window instead.
 * @param {import('electron').App} app
 * @param {() => import('electron').BrowserWindow | undefined} current
 * @returns {boolean} False when another instance already runs and this one should leave.
 */
export function claimSingleInstance(app, current) {
  if (!app.requestSingleInstanceLock()) return false;
  app.on('second-instance', () => focusWindow(current()));
  return true;
}

/**
 * Only the app's main frame may go full screen or write sanitized clipboard data.
 */
export function allowsPermission(permission, requestingUrl, isMainFrame) {
  return (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') && isMainFrame === true && isAppUrl(requestingUrl);
}

export function registerPermissions(session) {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(isAppUrl(contents?.mainFrame?.url) && allowsPermission(permission, details.requestingUrl, details.isMainFrame));
  });
  session.setPermissionCheckHandler((contents, permission, origin, details) =>
    isAppUrl(contents?.mainFrame?.url) && isAppUrl(origin) && allowsPermission(permission, details.requestingUrl, details.isMainFrame));
}

/**
 * Gives the page its session token and event stream address. The preload asks with `sendSync`, which blocks the page
 * until it has an answer, so every request is answered: with the session for the app's own page, with null for
 * anything else. Left unanswered, a refused request would freeze the window, blank, with nothing logged.
 * @param {{ ipcMain: { on: Function }; trusted: (event: unknown) => boolean; session: () => { token: string; events: string };
 *   log?: (message: string, details?: unknown) => void }} options
 */
export function registerSessionBridge({ ipcMain, trusted, session, log }) {
  ipcMain.on('paso-session', (event) => {
    if (trusted(event)) { event.returnValue = session(); return; }
    log?.('Refused the session to a frame', { url: event.senderFrame?.url });
    event.returnValue = null;
  });
}

/** The Windows desktop renderer only talks to loopback services. A system proxy or PAC can delay those requests. */
export async function configureLoopbackProxy(session, platform = process.platform) {
  if (platform === 'win32') await session.setProxy({ mode: 'direct' });
}

/** The native buttons start at 10px from the left and 14px from the top. The 14px buttons centre at y=21px. */
export const TRAFFIC_LIGHTS = { x: 10, y: 14 };

/**
 * On macOS the native buttons sit over Paso's own layout. Elsewhere the system's frame stays.
 * @param {NodeJS.Platform} platform
 * @returns {Partial<import('electron').BrowserWindowConstructorOptions>}
 */
export function windowChrome(platform) {
  return platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHTS } : {};
}
