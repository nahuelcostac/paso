/**
 * The application menu, in Spanish. Standard items use Electron roles, so macOS handles them natively: Edición's
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
      { role: 'about', label: `Acerca de ${appName}` },
      separator,
      { role: 'services', label: 'Servicios' },
      separator,
      { role: 'hide', label: `Ocultar ${appName}` },
      { role: 'hideOthers', label: 'Ocultar otros' },
      { role: 'unhide', label: 'Mostrar todo' },
      separator,
      { role: 'quit', label: `Salir de ${appName}` },
    ],
  };
  const file = {
    label: 'Archivo',
    submenu: [
      { role: 'close', label: 'Cerrar ventana' },
      ...(mac ? [] : [separator, { role: 'quit', label: 'Salir' }]),
    ],
  };
  const edit = {
    label: 'Edición',
    submenu: [
      { role: 'undo', label: 'Deshacer' },
      { role: 'redo', label: 'Rehacer' },
      separator,
      { role: 'cut', label: 'Cortar' },
      { role: 'copy', label: 'Copiar' },
      { role: 'paste', label: 'Pegar' },
      ...(mac ? [{ role: 'pasteAndMatchStyle', label: 'Pegar y adaptar estilo' }] : []),
      { role: 'delete', label: 'Eliminar' },
      { role: 'selectAll', label: 'Seleccionar todo' },
    ],
  };
  const view = {
    label: 'Visualización',
    submenu: [
      { role: 'togglefullscreen', label: 'Pantalla completa' },
      // Reloading and the developer tools are for working on Paso, not for using it.
      ...(packaged ? [] : [separator, { role: 'reload', label: 'Volver a cargar' }, { role: 'toggleDevTools', label: 'Herramientas para desarrolladores' }]),
    ],
  };
  const windowMenu = {
    label: 'Ventana',
    role: 'window',
    submenu: [
      { role: 'minimize', label: 'Minimizar' },
      { role: 'zoom', label: 'Zoom' },
      ...(mac ? [separator, { role: 'front', label: 'Traer todo al frente' }] : []),
    ],
  };
  const help = {
    label: 'Ayuda',
    role: 'help',
    submenu: [
      { label: 'Abrir la carpeta de datos', enabled: typeof openDataFolder === 'function', click: () => openDataFolder?.() },
    ],
  };
  return [...(mac ? [appMenu] : []), file, edit, view, windowMenu, help];
}
