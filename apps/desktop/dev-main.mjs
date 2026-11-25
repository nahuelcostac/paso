import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from 'electron';
import { startServer } from '@paso/server';
import { existsSync } from 'node:fs';
import { createServer as createSocket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { registerFolderBridge } from './lib/folder-bridge.mjs';
import { desktopDataDirectory } from './lib/data-directory.mjs';
import { configureLoopbackProxy, registerPermissions, windowChrome } from './lib/app-shell.mjs';
import { APP_ORIGIN, APP_SCHEME_PRIVILEGES, APP_URL, eventsUrl, hostOf, isAppUrl, isRequestAllowed } from './lib/app-origin.mjs';
import { forward, serveApp } from './lib/app-protocol.mjs';
import { createServer as createVite } from '../web/node_modules/vite/dist/node/index.js';

const root = resolve(import.meta.dirname, '../..');
const dataDir = desktopDataDirectory(app.getPath('appData'));
if (process.env.PASO_DATA_DIR) app.setPath('userData', join(dirname(resolve(dataDir)), 'desktop-profile'));
// As in the packaged app, the page is at paso://app on every launch, so what it keeps per origin survives a relaunch.
// Vite still runs on a free port; the page reaches it through the scheme, and its HMR socket directly.
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);
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
// scripts/dev-desktop.mjs draws this from the brand mark, as packaging does for the .app.
const dockIcon = join(root, 'apps/desktop/dist/icon/paso.png');

async function start() {
  await configureLoopbackProxy(session.defaultSession);
  if (app.dock && existsSync(dockIcon)) app.dock.setIcon(dockIcon);
  const port = await freePort();
  service = await startServer({
    dataDir, port: 0, allowedOrigins: [APP_ORIGIN],
    agent: { mcp: { command: process.env.PASO_DEV_NODE, entry: join(root, 'apps/mcp/dist/cli.js') } },
    openFolder: async (path) => { const error = await shell.openPath(path); if (error) throw new Error(error); },
  });
  process.env.PASO_WEB_PORT = String(port);
  process.env.PASO_PORT = String(service.port);
  process.env.PASO_DESKTOP_DEV = '1';
  vite = await createVite({ configFile: join(root, 'apps/web/vite.config.ts'), root: join(root, 'apps/web') });
  await vite.listen();
  const viteUrl = `http://127.0.0.1:${port}`;
  registerPermissions(session.defaultSession);
  serveApp({ session: session.defaultSession, net, serviceUrl: service.url, page: (request, path) => forward(net, request, `${viteUrl}${path}`) });
  const fromPage = (event) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame.url);
  const window = new BrowserWindow({ width: 1400, height: 900, ...windowChrome(process.platform), webPreferences: { preload: join(root, 'apps/desktop/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  ipcMain.on('paso-session', (event) => { if (fromPage(event)) event.returnValue = { token: service.sessionToken, events: eventsUrl(service.url) }; });
  registerFolderBridge({ ipcMain, dialog, parent: () => window, trusted: fromPage });
  const external = (url) => { try { const parsed = new URL(url); if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(url); } catch { /* invalid URL */ } };
  window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) { event.preventDefault(); external(url); } });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  // The page, Vite with its HMR socket, and this instance's service; nothing else.
  const hosts = [hostOf(viteUrl), hostOf(service.url)];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isRequestAllowed(details.url, hosts) }));
  console.log(`Desktop development UI at ${APP_URL} from Vite on ${viteUrl}; service on ${service.url}`);
  await window.loadURL(APP_URL);
}
app.whenReady().then(start).catch((error) => { console.error('Paso failed to start:', error); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (!closing) { event.preventDefault(); closing = true; void (async () => { await vite?.close(); await service?.close(); })().finally(() => app.quit()); }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.quit());
