import { describe, expect, it } from 'vitest';
import { CHOOSE_FOLDER, dialogOptions, folderRequest, pickedFolder, registerFolderBridge } from '../lib/folder-bridge.mjs';

function setup({ trusted = true, result = { canceled: false, filePaths: ['/Users/ana/Clases'] } } = {}) {
  const handlers = new Map();
  const calls = [];
  let release;
  const dialog = {
    showOpenDialog: (...args) => {
      calls.push(args);
      return result === 'wait' ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(result);
    },
  };
  const window = { id: 1 };
  registerFolderBridge({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, dialog, trusted: () => trusted, parent: () => window });
  return { choose: (near) => handlers.get(CHOOSE_FOLDER)({}, near), calls, window, release: (value) => release(value) };
}

describe('the folder bridge', () => {
  it('opens the system dialog on the window and returns the picked folder', async () => {
    const bridge = setup();
    await expect(bridge.choose()).resolves.toBe('/Users/ana/Clases');
    expect(bridge.calls).toHaveLength(1);
    const [parent, options] = bridge.calls[0];
    expect(parent).toBe(bridge.window);
    expect(options).toEqual(dialogOptions());
    expect(options.properties).toEqual(['openDirectory', 'createDirectory']);
    expect(options.defaultPath).toBeUndefined();
  });

  it('opens beside the open workspace', async () => {
    const bridge = setup();
    await bridge.choose('/Users/ana/Clases/Tema');
    expect(bridge.calls[0][1].defaultPath).toBe('/Users/ana/Clases');
  });

  it('gives the renderer nothing when the person cancels', async () => {
    await expect(setup({ result: { canceled: true, filePaths: [] } }).choose()).resolves.toBeNull();
    await expect(setup({ result: { canceled: false, filePaths: [] } }).choose()).resolves.toBeNull();
    await expect(setup({ result: { canceled: false, filePaths: ['/a', '/b'] } }).choose()).resolves.toBeNull();
    await expect(setup({ result: { canceled: false, filePaths: ['relative/path'] } }).choose()).resolves.toBeNull();
  });

  it('refuses a page that is not the app, before any dialog opens', async () => {
    const bridge = setup({ trusted: false });
    await expect(bridge.choose()).rejects.toThrow('Not allowed.');
    expect(bridge.calls).toHaveLength(0);
  });

  it('refuses anything but an absolute path as the starting folder', async () => {
    for (const near of ['relative', '', 42, { path: '/x' }, ['/x'], '/x\0y', `/${'a'.repeat(5000)}`]) {
      const bridge = setup();
      await expect(bridge.choose(near)).rejects.toThrow(TypeError);
      expect(bridge.calls).toHaveLength(0);
    }
    expect(folderRequest(undefined)).toEqual({});
    expect(folderRequest(null)).toEqual({});
    expect(folderRequest('/Users/ana')).toEqual({ near: '/Users/ana' });
  });

  it('keeps to one dialog at a time', async () => {
    const bridge = setup({ result: 'wait' });
    const first = bridge.choose();
    await expect(bridge.choose()).resolves.toBeNull();
    bridge.release({ canceled: false, filePaths: ['/Users/ana/Charlas'] });
    await expect(first).resolves.toBe('/Users/ana/Charlas');
    expect(bridge.calls).toHaveLength(1);
  });

  it('reads only a well-formed dialog result', () => {
    expect(pickedFolder(undefined)).toBeNull();
    expect(pickedFolder({ canceled: false })).toBeNull();
    expect(pickedFolder({ canceled: false, filePaths: [7] })).toBeNull();
    expect(pickedFolder({ canceled: false, filePaths: ['/Users/ana'] })).toBe('/Users/ana');
  });
});
