/**
 * Small pieces of desktop behaviour kept out of main.mjs: one instance at a time, and the only permission the page
 * gets. This module does not import Electron so it can be tested in Node.
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
 * The page may only go full screen, which Present asks for, and only from the app's own origin. Every other
 * permission, such as the camera or notifications, is denied.
 */
export function allowsPermission(permission, requestingUrl, origin) {
  if (permission !== 'fullscreen' || typeof requestingUrl !== 'string') return false;
  try { return new URL(requestingUrl).origin === origin; } catch { return false; }
}

/** Where macOS draws the window's close, minimise and zoom buttons: in the sidebar's head, its centre 30px down. */
export const TRAFFIC_LIGHTS = { x: 16, y: 24 };

/**
 * The window's frame. On macOS it has no title bar: the window's buttons sit in the sidebar's head, with the sidebar's
 * toggle after them, and the page leaves them room (see “Sidebar” in docs/design/direction.md). Elsewhere the system's
 * frame stays.
 * @param {NodeJS.Platform} platform
 * @returns {Partial<import('electron').BrowserWindowConstructorOptions>}
 */
export function windowChrome(platform) {
  return platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHTS } : {};
}
