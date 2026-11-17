/** What the desktop app's preload exposes to the page. The browser version has none of it. */
export type DesktopBridge = {
  token?: string;
  /** The system's folder dialog. Resolves to the folder the person picked, or null when they cancelled. */
  chooseFolder?: (near?: string) => Promise<string | null>;
  /** “mac” when macOS draws the window's close, minimise and zoom buttons over the page, in the sidebar's head. */
  windowControls?: 'mac';
};

const bridge = () => (window as Window & { pasoDesktop?: DesktopBridge }).pasoDesktop;

/** The native folder dialog when Paso runs as the desktop app, or null in a browser, which uses the in-app explorer. */
export function nativeFolderChooser(): ((near?: string) => Promise<string | null>) | null {
  const choose = bridge()?.chooseFolder;
  return typeof choose === 'function' ? choose : null;
}

/**
 * Marks the page when the window's own buttons sit over it, so the sidebar's head and its toggle leave them room
 * (`--window-controls-w` in tokens.css). The browser version has none.
 */
export function markWindowControls(root: HTMLElement = document.documentElement) {
  if (bridge()?.windowControls === 'mac') root.dataset.windowControls = 'mac';
}
