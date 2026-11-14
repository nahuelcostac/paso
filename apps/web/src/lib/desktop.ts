/** What the desktop app's preload exposes to the page. The browser version has none of it. */
export type DesktopBridge = {
  token?: string;
  /** The system's folder dialog. Resolves to the folder the person picked, or null when they cancelled. */
  chooseFolder?: (near?: string) => Promise<string | null>;
};

const bridge = () => (window as Window & { pasoDesktop?: DesktopBridge }).pasoDesktop;

/** The native folder dialog when Paso runs as the desktop app, or null in a browser, which uses the in-app explorer. */
export function nativeFolderChooser(): ((near?: string) => Promise<string | null>) | null {
  const choose = bridge()?.chooseFolder;
  return typeof choose === 'function' ? choose : null;
}
