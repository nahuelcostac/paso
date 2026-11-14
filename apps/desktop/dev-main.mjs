import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { startServer } from '@paso/server';
import { homedir } from 'node:os';
import { createServer as createSocket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { isDevRequestAllowed } from './dev-network.mjs';
import { registerFolderBridge } from './lib/folder-bridge.mjs';
import { createServer as createVite } from '../web/node_modules/vite/dist/node/index.js';

const root = resolve(import.meta.dirname, '../..');
const dataDir = process.env.PASO_DATA_DIR ?? (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Paso', 'projects')
  : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Paso', 'projects')
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'paso', 'projects'));
if (process.env.PASO_DATA_DIR) app.setPath('userData', join(dirname(resolve(dataDir)), 'desktop-profile'));
let service;
let vite;
let closing = false;

async function freePort() {
  const socket = createSocket();
  await new Promise((resolvePromise, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolvePromise); });
  const port = socket.address().port;
  await new Promise((resolvePromise, reject) => socket.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}
async function start() {
  const port = await freePort();
  service = await startServer({
    dataDir, port: 0, allowedOrigins: [`http://127.0.0.1:${port}`],
    agent: { mcp: { command: process.env.PASO_DEV_NODE, entry: join(root, 'apps/mcp/dist/cli.js') } },
    openFolder: async (path) => { const error = await shell.openPath(path); if (error) throw new Error(error); },
  });
  process.env.PASO_WEB_PORT = String(port);
  process.env.PASO_PORT = String(service.port);
  process.env.PASO_DESKTOP_DEV = '1';
  vite = await createVite({ configFile: join(root, 'apps/web/vite.config.ts'), root: join(root, 'apps/web') });
  await vite.listen();
  const origin = `http://127.0.0.1:${port}`;
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const window = new BrowserWindow({ width: 1400, height: 900, webPreferences: { preload: join(root, 'apps/desktop/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  ipcMain.on('paso-session', (event) => { if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) event.returnValue = service.sessionToken; });
  registerFolderBridge({ ipcMain, dialog, parent: () => window, trusted: (event) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin });
  const external = (url) => { try { const parsed = new URL(url); if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(url); } catch { /* invalid URL */ } };
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) { event.preventDefault(); external(url); } });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isDevRequestAllowed(details.url, origin) }));
  console.log(`Desktop development UI listening on ${origin}; service on ${service.url}`);
  await window.loadURL(origin);
}
app.whenReady().then(start).catch((error) => { console.error('Paso failed to start:', error); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (!closing) { event.preventDefault(); closing = true; void (async () => { await vite?.close(); await service?.close(); })().finally(() => app.quit()); }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.quit());
