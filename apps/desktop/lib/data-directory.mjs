import { homedir } from 'node:os';
import { join } from 'node:path';

export function desktopDataDirectory(appData, platform = process.platform, env = process.env, home = homedir()) {
  if (env.PASO_DATA_DIR !== undefined) return env.PASO_DATA_DIR;
  if (platform === 'win32') return join(appData, 'Paso', 'projects');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Paso', 'projects');
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'paso', 'projects');
}
