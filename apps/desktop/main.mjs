import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, screen, session, shell } from 'electron';
import { dataDirectory, startServer } from './service.mjs';
import { join, resolve, dirname } from 'node:path';
import { menuTemplate } from './lib/menu.mjs';
import { placeWindow, readState, trackWindowState } from './lib/window-state.mjs';
import { registerFolderBridge } from './lib/folder-bridge.mjs';
import { claimSingleInstance, configureLoopbackProxy, registerPermissions, windowChrome } from './lib/app-shell.mjs';
import { APP_ORIGIN, APP_SCHEME_PRIVILEGES, APP_URL, appCsp, eventsUrl, hostOf, isAppUrl, isRequestAllowed } from './lib/app-origin.mjs';
import { serveApp, staticPage } from './lib/app-protocol.mjs';

let service;
let closing = false;
const root = app.getAppPath();
const dataDir = dataDirectory({ appData: app.getPath('appData') });
if (process.platform === 'win32') app.setAppUserModelId('org.paso.prototype');
if (process.env.PASO_DATA_DIR) app.setPath('userData', join(dirname(resolve(dataDir)), 'desktop-profile'));
// The lock lives in the profile, so a test instance with its own PASO_DATA_DIR never meets the person's Paso.
if (!claimSingleInstance(app, () => BrowserWindow.getAllWindows()[0])) app.exit(0);
// The page's origin is paso://app on every launch, so what it keeps per origin survives a relaunch (lib/app-origin.mjs).
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);

async function start() {
  await configureLoopbackProxy(session.defaultSession);
  service = await startServer({
    dataDir, port: 0, allowedOrigins: [APP_ORIGIN],
    agent: { mcp: { command: process.execPath, entry: join(root, 'mcp', 'cli.mjs'), electronRunAsNode: true } },
    openFolder: async (path) => { const error = await shell.openPath(path); if (error) throw new Error(error); },
  });
  registerPermissions(session.defaultSession);
  // The page and its API at paso://app, the API forwarded to the service. Only this session.
  serveApp({ session: session.defaultSession, net, serviceUrl: service.url, page: staticPage({ webRoot: join(root, 'web'), csp: appCsp(service.port) }) });
  const fromPage = (event) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame.url);
  ipcMain.on('paso-session', (event) => { if (fromPage(event)) event.returnValue = { token: service.sessionToken, events: eventsUrl(service.url) }; });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({ packaged: app.isPackaged, openDataFolder: () => void shell.openPath(dirname(resolve(dataDir))) })));
  const stateFile = join(app.getPath('userData'), 'window-state.json');
  const placement = placeWindow(readState(stateFile), screen.getAllDisplays(), screen.getPrimaryDisplay());
  const window = new BrowserWindow({ ...placement.bounds, ...windowChrome(process.platform), webPreferences: { preload: join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  if (placement.maximized) window.maximize();
  trackWindowState(window, stateFile);
  registerFolderBridge({ ipcMain, dialog, parent: () => window, trusted: fromPage });
  const external = (url) => { try { const parsed = new URL(url); if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(url); } catch { /* invalid URL */ } };
  window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) { event.preventDefault(); external(url); } });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  // Block all renderer network traffic except the page and this instance's service.
  const hosts = [hostOf(service.url)];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isRequestAllowed(details.url, hosts) }));
  await window.loadURL(APP_URL);
}
app.whenReady().then(start).catch((error) => { console.error('Paso failed to start:', error); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (!closing && service) { event.preventDefault(); closing = true; void service.close().finally(() => app.quit()); }
});
