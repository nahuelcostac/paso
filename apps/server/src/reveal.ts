import { spawn } from 'node:child_process';

/** Shows a folder to the person. */
export type OpenFolder = (path: string) => Promise<void>;

/**
 * Opens a folder in the system's file manager: Finder, Explorer, or the desktop's default on Linux. The path is passed
 * as an argument, never through a shell. It resolves once the file manager has started; its exit code is not waited
 * for, because Explorer reports 1 even when it opened the folder.
 */
export const openInFileManager: OpenFolder = (path) => new Promise((resolve, reject) => {
  const [command, args] = process.platform === 'darwin' ? ['open', [path]]
    : process.platform === 'win32' ? ['explorer.exe', [path]] : ['xdg-open', [path]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.once('error', reject);
  child.once('spawn', () => { child.unref(); resolve(); });
});
