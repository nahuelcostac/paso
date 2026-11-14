import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ handlers: new Map(), windows: [], showOpenDialog: vi.fn(), listen: vi.fn() }));

vi.mock('electron', () => ({
  app: { setPath: vi.fn(), whenReady: () => Promise.resolve(), on: vi.fn(), quit: vi.fn() },
  BrowserWindow: class {
    constructor() {
      this.webContents = { mainFrame: {}, on: vi.fn(), setWindowOpenHandler: vi.fn() };
      mocks.windows.push(this);
    }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
  },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: { on: vi.fn(), handle: (channel, handler) => mocks.handlers.set(channel, handler) },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } } },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));
vi.mock('@paso/server', () => ({ startServer: async () => ({ url: 'http://127.0.0.1:50124', port: 50124, sessionToken: 'test' }) }));
vi.mock('../../web/node_modules/vite/dist/node/index.js', () => ({ createServer: async () => ({ listen: mocks.listen }) }));
vi.mock('node:net', () => ({ createServer: () => ({
  once() {}, listen(_port, _host, ready) { ready(); }, address: () => ({ port: 50123 }), close(done) { done(); },
}) }));

describe('desktop development folder picker', () => {
  const signals = ['SIGINT', 'SIGTERM'];
  let originalListeners;
  let originalEnv;

  beforeAll(async () => {
    originalListeners = signals.map((signal) => process.listeners(signal));
    originalEnv = { ...process.env };
    await import('../dev-main.mjs');
    await vi.waitFor(() => expect(mocks.windows[0]?.webContents.mainFrame.url).toBe('http://127.0.0.1:50123'));
  });

  afterAll(() => {
    signals.forEach((signal, index) => {
      for (const listener of process.listeners(signal)) if (!originalListeners[index].includes(listener)) process.removeListener(signal, listener);
    });
    process.env = originalEnv;
  });

  it('answers the shared preload in the Vite window with a native folder dialog', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/paso-workspace'] });
    const window = mocks.windows[0];
    const choose = mocks.handlers.get('paso-choose-folder');
    await expect(choose({ sender: window.webContents, senderFrame: window.webContents.mainFrame })).resolves.toBe('/tmp/paso-workspace');
    expect(mocks.showOpenDialog).toHaveBeenCalledWith(window, expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }));
    expect(mocks.listen).toHaveBeenCalledOnce();
  });

  it('refuses other windows, subframes and a navigated main frame', async () => {
    mocks.showOpenDialog.mockClear();
    const { webContents } = mocks.windows[0];
    const choose = mocks.handlers.get('paso-choose-folder');
    await expect(choose({ sender: {}, senderFrame: webContents.mainFrame })).rejects.toThrow('Not allowed.');
    await expect(choose({ sender: webContents, senderFrame: { url: webContents.mainFrame.url } })).rejects.toThrow('Not allowed.');
    const url = webContents.mainFrame.url;
    try {
      webContents.mainFrame.url = 'https://example.com';
      await expect(choose({ sender: webContents, senderFrame: webContents.mainFrame })).rejects.toThrow('Not allowed.');
    } finally { webContents.mainFrame.url = url; }
    expect(mocks.showOpenDialog).not.toHaveBeenCalled();
  });
});
