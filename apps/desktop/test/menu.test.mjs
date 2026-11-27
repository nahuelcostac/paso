import { describe, expect, it, vi } from 'vitest';
import { menuTemplate } from '../lib/menu.mjs';
import { allowsPermission, claimSingleInstance, focusWindow, registerPermissions, registerSessionBridge } from '../lib/app-shell.mjs';

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

  it('opens the log folder from Help, on every platform', () => {
    for (const platform of ['darwin', 'win32']) {
      const openLogFolder = vi.fn();
      const help = menuTemplate({ platform, openLogFolder }).find((menu) => menu.label === 'Help');
      const item = help.submenu.find((candidate) => candidate.label === 'Open Log Folder');
      expect(item.enabled).toBe(true);
      item.click();
      expect(openLogFolder).toHaveBeenCalledOnce();
    }
    expect(menuTemplate({ platform: 'win32' }).at(-1).submenu[1]).toMatchObject({ label: 'Open Log Folder', enabled: false });
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

describe('the session bridge', () => {
  const bridge = (trusted) => {
    const ipcMain = { on: vi.fn() };
    const log = vi.fn();
    registerSessionBridge({ ipcMain, trusted, session: () => ({ token: 'secret', events: 'ws://127.0.0.1:50124/api/events' }), log });
    expect(ipcMain.on).toHaveBeenCalledWith('paso-session', expect.any(Function));
    return { answer: ipcMain.on.mock.calls[0][1], log };
  };

  it('gives the app’s own page its session', () => {
    const { answer, log } = bridge(() => true);
    const event = { senderFrame: { url: 'paso://app/' } };
    answer(event);
    expect(event.returnValue).toEqual({ token: 'secret', events: 'ws://127.0.0.1:50124/api/events' });
    expect(log).not.toHaveBeenCalled();
  });

  it('answers anything else with null, so the synchronous request can never freeze the window', () => {
    const { answer, log } = bridge(() => false);
    const event = { senderFrame: { url: 'https://example.com/' } };
    answer(event);
    expect(Object.hasOwn(event, 'returnValue')).toBe(true);
    expect(event.returnValue).toBeNull();
    expect(log).toHaveBeenCalledWith('Refused the session to a frame', { url: 'https://example.com/' });
    const gone = { senderFrame: null };
    answer(gone);
    expect(gone.returnValue).toBeNull();
  });
});

describe('permissions', () => {
  it('checks both Electron permission paths and fails closed', () => {
    const session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
    registerPermissions(session);
    const request = session.setPermissionRequestHandler.mock.calls[0][0];
    const check = session.setPermissionCheckHandler.mock.calls[0][0];
    const contents = { mainFrame: { url: 'paso://app/' } };
    const details = { requestingUrl: 'paso://app/', isMainFrame: true };
    const result = vi.fn();
    for (const permission of ['clipboard-sanitized-write', 'fullscreen']) {
      request(contents, permission, result, details);
      expect(result).toHaveBeenLastCalledWith(true);
      expect(check(contents, permission, 'paso://app', details)).toBe(true);
    }
    for (const [candidate, origin, frame] of [
      [{}, 'paso://app', details],
      [contents, 'https://example.com', details],
      [contents, 'paso://app', { ...details, isMainFrame: false }],
      [contents, 'paso://app', { ...details, requestingUrl: 'paso://other/' }],
      [contents, 'paso://app', { ...details, requestingUrl: undefined }],
    ]) {
      expect(check(candidate, 'clipboard-sanitized-write', origin, frame)).toBe(false);
      if (origin === 'paso://app') {
        request(candidate, 'clipboard-sanitized-write', result, frame);
        expect(result).toHaveBeenLastCalledWith(false);
      }
    }
    expect(check(contents, 'clipboard-read', 'paso://app', details)).toBe(false);
    request(contents, 'clipboard-read', result, details);
    expect(result).toHaveBeenLastCalledWith(false);
  });
  it('lets only the app’s own page go full screen', () => {
    expect(allowsPermission('fullscreen', 'paso://app/#/p/canvas', true)).toBe(true);
    expect(allowsPermission('clipboard-sanitized-write', 'paso://app/', true)).toBe(true);
    expect(allowsPermission('clipboard-sanitized-write', 'paso://app/', false)).toBe(false);
    expect(allowsPermission('clipboard-sanitized-write', 'paso://app/')).toBe(false);
    for (const url of ['http://127.0.0.1:52001/', 'paso://other/', 'https://example.com/', undefined, 'not a url']) {
      expect(allowsPermission('fullscreen', url, true)).toBe(false);
      expect(allowsPermission('clipboard-sanitized-write', url, true)).toBe(false);
    }
    for (const permission of ['media', 'notifications', 'geolocation', 'clipboard-read', 'deprecated-sync-clipboard-read', 'openExternal']) expect(allowsPermission(permission, 'paso://app/', true)).toBe(false);
  });
});
