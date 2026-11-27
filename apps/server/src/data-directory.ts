import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export type DataDirectoryOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** The roaming application data folder, as Electron's `app.getPath('appData')` gives it. Defaults to %APPDATA%. */
  appData?: string;
};

/**
 * Where Paso keeps its projects: `PASO_DATA_DIR` when it is set, otherwise the platform's folder for app data. The
 * desktop app and the service started on its own both use this, so they open the same projects.
 */
export function dataDirectory({ platform = process.platform, env = process.env, home = homedir(), appData }: DataDirectoryOptions = {}) {
  if (env.PASO_DATA_DIR !== undefined) return env.PASO_DATA_DIR;
  if (platform === 'win32') return win32.join(appData ?? env.APPDATA ?? win32.join(home, 'AppData', 'Roaming'), 'Paso', 'projects');
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'Paso', 'projects');
  return posix.join(env.XDG_DATA_HOME ?? posix.join(home, '.local', 'share'), 'paso', 'projects');
}
