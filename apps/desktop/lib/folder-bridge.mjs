/**
 * The native folder picker behind “New workspace…”. The renderer can only ask for the dialog; it learns a path only
 * when the person picks one, and the service still validates that path when the folder is added as a workspace.
 *
 * This module does not import Electron so it can be tested in Node: `registerFolderBridge` gets what it needs.
 */
import { dirname, isAbsolute } from 'node:path';

export const CHOOSE_FOLDER = 'paso-choose-folder';
const MAX_PATH = 4096;

const isPath = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH && !value.includes('\0') && isAbsolute(value);

/**
 * The renderer may pass the open workspace's folder, so the dialog opens beside it. Anything else is refused.
 * @returns {{ near?: string }}
 */
export function folderRequest(near) {
  if (near === undefined || near === null) return {};
  if (!isPath(near)) throw new TypeError('Expected the absolute path of a folder, or nothing.');
  return { near };
}

/** The options for `dialog.showOpenDialog`. */
export function dialogOptions({ near } = {}) {
  return {
    title: 'New Workspace',
    message: "Choose a folder. Its projects appear in the sidebar; Paso doesn't move or delete anything.",
    buttonLabel: 'Use This Folder',
    properties: ['openDirectory', 'createDirectory'],
    ...(near ? { defaultPath: dirname(near) } : {}),
  };
}

/** The one folder the person picked, or null when they cancelled. */
export function pickedFolder(result) {
  if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length !== 1) return null;
  const [path] = result.filePaths;
  return isPath(path) ? path : null;
}

/**
 * Answers the renderer's request for a folder. Only the app's own page, in the main frame of its window, may ask, and
 * only one dialog is open at a time.
 * @param {{ ipcMain: import('electron').IpcMain, dialog: Pick<import('electron').Dialog, 'showOpenDialog'>, trusted: (event: import('electron').IpcMainInvokeEvent) => boolean, parent: () => import('electron').BrowserWindow | undefined }} deps
 */
export function registerFolderBridge({ ipcMain, dialog, trusted, parent }) {
  let open = false;
  const choose = async (event, near) => {
    if (!trusted(event)) throw new Error('Not allowed.');
    const request = folderRequest(near);
    if (open) return null;
    open = true;
    try {
      const window = parent();
      const options = dialogOptions(request);
      return pickedFolder(window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options));
    } finally { open = false; }
  };
  ipcMain.handle(CHOOSE_FOLDER, choose);
  return choose;
}
