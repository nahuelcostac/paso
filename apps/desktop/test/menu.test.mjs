import { describe, expect, it, vi } from 'vitest';
import { menuTemplate } from '../lib/menu.mjs';
import { allowsPermission, claimSingleInstance, focusWindow } from '../lib/app-shell.mjs';

const items = (menu) => menu.submenu.filter((item) => item.type !== 'separator');
const byRole = (template, role) => template.flatMap((menu) => menu.submenu).find((item) => item.role === role);

describe('the application menu', () => {
  it('has the English menus, in macOS order', () => {
    expect(menuTemplate({ platform: 'darwin' }).map((menu) => menu.label)).toEqual(['Paso', 'File', 'Edit', 'View', 'Window', 'Help']);
  });

  it('labels every item itself, with no Electron default left to the system language', () => {
    for (const menu of menuTemplate({ platform: 'darwin', packaged: false })) {
      for (const item of items(menu)) expect(item.label, `${menu.label} › ${item.role}`).toMatch(/^[A-Z][A-Za-z ]+$/);
    }
    expect(items(menuTemplate({ platform: 'darwin' })[0]).map((item) => item.label)).toEqual(['About Paso', 'Services', 'Hide Paso', 'Hide Others', 'Show All', 'Quit Paso']);
  });

  it('quits with ⌘Q and closes the window with ⌘W through their native roles', () => {
    const template = menuTemplate({ platform: 'darwin' });
    // The roles carry macOS's own accelerators; setting none keeps them.
    expect(byRole(template, 'quit')).toEqual({ role: 'quit', label: 'Quit Paso' });
    expect(byRole(template, 'close')).toEqual({ role: 'close', label: 'Close Window' });
    expect(template[1].label).toBe('File');
    expect(template[1].submenu).toContain(byRole(template, 'close'));
  });

  it('edits through native roles, so Excalidraw and text fields keep their own copy, paste and undo', () => {
    const edit = menuTemplate({ platform: 'darwin' }).find((menu) => menu.label === 'Edit');
    expect(items(edit).map((item) => item.role)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']);
    // No custom accelerator and no click handler: nothing here can take a key from the page.
    for (const item of items(edit)) { expect(item.accelerator).toBeUndefined(); expect(item.click).toBeUndefined(); }
  });

  it('does not bind page zoom, whose ⌘+, ⌘− and ⌘0 are Excalidraw’s zoom on the canvas', () => {
    const roles = menuTemplate({ platform: 'darwin', packaged: false }).flatMap((menu) => menu.submenu).map((item) => item.role);
    for (const role of ['zoomIn', 'zoomOut', 'resetZoom']) expect(roles).not.toContain(role);
    const accelerators = menuTemplate({ platform: 'darwin' }).flatMap((menu) => menu.submenu).map((item) => item.accelerator).filter(Boolean);
    expect(accelerators).toEqual([]);
  });

  it('offers full screen, and reload and developer tools only outside the packaged app', () => {
    const view = (packaged) => menuTemplate({ platform: 'darwin', packaged }).find((menu) => menu.label === 'View');
    expect(items(view(true)).map((item) => item.role)).toEqual(['togglefullscreen']);
    expect(items(view(false)).map((item) => item.role)).toEqual(['togglefullscreen', 'reload', 'toggleDevTools']);
  });

  it('marks Window and Help for macOS and opens the data folder from Help', () => {
    const openDataFolder = vi.fn();
    const template = menuTemplate({ platform: 'darwin', openDataFolder });
    expect(template[4]).toMatchObject({ label: 'Window', role: 'window' });
    expect(template[5]).toMatchObject({ label: 'Help', role: 'help' });
    const open = template[5].submenu[0];
    expect(open.enabled).toBe(true);
    open.click();
    expect(openDataFolder).toHaveBeenCalledOnce();
    expect(menuTemplate({ platform: 'darwin' })[5].submenu[0].enabled).toBe(false);
  });

  it('has no app menu elsewhere and quits from File', () => {
    const template = menuTemplate({ platform: 'win32' });
    expect(template.map((menu) => menu.label)).toEqual(['File', 'Edit', 'View', 'Window', 'Help']);
    expect(items(template[0]).map((item) => item.role)).toEqual(['close', 'quit']);
  });
});

describe('one instance', () => {
  const fakeWindow = (minimized = false) => ({ isDestroyed: () => false, isMinimized: () => minimized, restore: vi.fn(), show: vi.fn(), focus: vi.fn() });

  it('focuses the existing window when Paso is launched again', () => {
    const listeners = {};
    const app = { requestSingleInstanceLock: () => true, on: (event, listener) => { listeners[event] = listener; } };
    const window = fakeWindow(true);
    expect(claimSingleInstance(app, () => window)).toBe(true);
    listeners['second-instance']();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it('tells the second instance to leave', () => {
    const app = { requestSingleInstanceLock: () => false, on: vi.fn() };
    expect(claimSingleInstance(app, () => undefined)).toBe(false);
    expect(app.on).not.toHaveBeenCalled();
  });

  it('ignores a launch before the window exists', () => {
    expect(() => focusWindow(undefined)).not.toThrow();
    const window = fakeWindow();
    focusWindow(window);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledOnce();
  });
});

describe('permissions', () => {
  it('lets only the app’s own page go full screen', () => {
    expect(allowsPermission('fullscreen', 'paso://app/#/p/canvas')).toBe(true);
    expect(allowsPermission('fullscreen', 'http://127.0.0.1:52001/')).toBe(false);
    expect(allowsPermission('fullscreen', 'paso://other/')).toBe(false);
    expect(allowsPermission('fullscreen', 'https://example.com/')).toBe(false);
    expect(allowsPermission('fullscreen', undefined)).toBe(false);
    expect(allowsPermission('fullscreen', 'not a url')).toBe(false);
    for (const permission of ['media', 'notifications', 'geolocation', 'clipboard-read', 'openExternal']) expect(allowsPermission(permission, 'paso://app/')).toBe(false);
  });
});
