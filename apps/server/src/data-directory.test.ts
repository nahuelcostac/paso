import { describe, expect, it } from 'vitest';
import { dataDirectory } from './data-directory.js';

describe('the data directory', () => {
  it('is in the roaming app data on Windows, the same folder the desktop app uses', () => {
    const env = { APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' };
    expect(dataDirectory({ platform: 'win32', env, home: 'C:\\Users\\Ana' })).toBe('C:\\Users\\Ana\\AppData\\Roaming\\Paso\\projects');
    // The desktop app passes Electron's own path for it.
    expect(dataDirectory({ platform: 'win32', env, home: 'C:\\Users\\Ana', appData: 'D:\\Roaming' })).toBe('D:\\Roaming\\Paso\\projects');
    // Without APPDATA, where Windows keeps it.
    expect(dataDirectory({ platform: 'win32', env: {}, home: 'C:\\Users\\Ana' })).toBe('C:\\Users\\Ana\\AppData\\Roaming\\Paso\\projects');
  });
  it('is in Application Support on macOS and in the XDG data folder elsewhere', () => {
    expect(dataDirectory({ platform: 'darwin', env: {}, home: '/Users/ana' })).toBe('/Users/ana/Library/Application Support/Paso/projects');
    expect(dataDirectory({ platform: 'linux', env: {}, home: '/home/ana' })).toBe('/home/ana/.local/share/paso/projects');
    expect(dataDirectory({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, home: '/home/ana' })).toBe('/data/paso/projects');
  });
  it('is PASO_DATA_DIR when it is set, on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(dataDirectory({ platform, env: { PASO_DATA_DIR: 'test projects', APPDATA: 'C:\\Roaming' }, home: '/home/ana', appData: 'C:\\Roaming' })).toBe('test projects');
    }
  });
});
