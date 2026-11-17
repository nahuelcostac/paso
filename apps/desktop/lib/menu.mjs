/**
 * The application menu, in English with macOS's title-style capitals. Standard items use Electron roles, so macOS handles them natively: Edit's
 * roles send the edit command to whatever has focus, which fires the DOM `copy`, `paste` and `cut` events Excalidraw
 * listens to and edits text fields as usual. On macOS the page sees each key first and the menu acts only on keys it
 * did not handle, so Excalidraw keeps its own shortcuts (⌘Z on the canvas, ⌘A, ⌘+ and ⌘− for its zoom).
 * Page zoom is left out on purpose: its ⌘+ and ⌘0 would mean something else outside the canvas.
 *
 * This module does not import Electron so the template can be tested in Node.
 */

/**
 * @param {{ appName?: string, platform?: string, packaged?: boolean, openDataFolder?: () => void }} [options]
 * @returns {Array<Record<string, unknown>>} An Electron menu template.
 */
export function menuTemplate({ appName = 'Paso', platform = process.platform, packaged = true, openDataFolder } = {}) {
  const mac = platform === 'darwin';
  const separator = { type: 'separator' };
  const appMenu = {
    label: appName,
    submenu: [
      { role: 'about', label: `About ${appName}` },
      separator,
      { role: 'services', label: 'Services' },
      separator,
      { role: 'hide', label: `Hide ${appName}` },
      { role: 'hideOthers', label: 'Hide Others' },
      { role: 'unhide', label: 'Show All' },
      separator,
      { role: 'quit', label: `Quit ${appName}` },
    ],
  };
  const file = {
    label: 'File',
    submenu: [
      { role: 'close', label: 'Close Window' },
      ...(mac ? [] : [separator, { role: 'quit', label: 'Quit' }]),
    ],
  };
  const edit = {
    label: 'Edit',
    submenu: [
      { role: 'undo', label: 'Undo' },
      { role: 'redo', label: 'Redo' },
      separator,
      { role: 'cut', label: 'Cut' },
      { role: 'copy', label: 'Copy' },
      { role: 'paste', label: 'Paste' },
      ...(mac ? [{ role: 'pasteAndMatchStyle', label: 'Paste and Match Style' }] : []),
      { role: 'delete', label: 'Delete' },
      { role: 'selectAll', label: 'Select All' },
    ],
  };
  const view = {
    label: 'View',
    submenu: [
      { role: 'togglefullscreen', label: 'Toggle Full Screen' },
      // Reloading and the developer tools are for working on Paso, not for using it.
      ...(packaged ? [] : [separator, { role: 'reload', label: 'Reload' }, { role: 'toggleDevTools', label: 'Toggle Developer Tools' }]),
    ],
  };
  const windowMenu = {
    label: 'Window',
    role: 'window',
    submenu: [
      { role: 'minimize', label: 'Minimize' },
      { role: 'zoom', label: 'Zoom' },
      ...(mac ? [separator, { role: 'front', label: 'Bring All to Front' }] : []),
    ],
  };
  const help = {
    label: 'Help',
    role: 'help',
    submenu: [
      { label: 'Open Data Folder', enabled: typeof openDataFolder === 'function', click: () => openDataFolder?.() },
    ],
  };
  return [...(mac ? [appMenu] : []), file, edit, view, windowMenu, help];
}
