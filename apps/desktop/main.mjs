import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, screen, session, shell } from 'electron';
import { dataDirectory, startServer } from './service.mjs';
import { join, resolve, dirname } from 'node:path';
import { menuTemplate } from './lib/menu.mjs';
import { placeWindow, readState, trackWindowState } from './lib/window-state.mjs';
import { registerFolderBridge } from './lib/folder-bridge.mjs';
import { claimSingleInstance, configureLoopbackProxy, registerPermissions, registerSessionBridge, windowChrome } from './lib/app-shell.mjs';
import { APP_ORIGIN, APP_SCHEME_PRIVILEGES, APP_URL, appCsp, eventsUrl, hostOf, isAppUrl, isRequestAllowed } from './lib/app-origin.mjs';
import { serveApp, staticPage } from './lib/app-protocol.mjs';
import { NOT_OPENED, RENDERED_CHECK, STOPPED, consoleEntry, openLog, serviceErrorMessage, startupErrorChoice, startupErrorDialog, watchPage } from './lib/startup.mjs';

let service;
let closing = false;
const root = app.getAppPath();
const dataDir = dataDirectory({ appData: app.getPath('appData') });
if (process.platform === 'win32') app.setAppUserModelId('org.paso.prototype');
if (process.env.PASO_DATA_DIR) app.setPath('userData', join(dirname(resolve(dataDir)), 'desktop-profile'));
// The profile's logs folder on Windows, ~/Library/Logs on macOS; inside the test profile with PASO_DATA_DIR.
app.setAppLogsPath(process.env.PASO_DATA_DIR ? join(app.getPath('userData'), 'logs') : undefined);
const log = openLog(app.getPath('logs'));
process.on('uncaughtExceptionMonitor', (error) => log.write('Uncaught exception', error));
process.on('unhandledRejection', (error) => { log.write('Unhandled rejection', error); console.error('Unhandled rejection:', error); });
// The lock lives in the profile, so a test instance with its own PASO_DATA_DIR never meets the person's Paso.
if (!claimSingleInstance(app, () => BrowserWindow.getAllWindows()[0])) app.exit(0);
// The page's origin is paso://app on every launch, so what it keeps per origin survives a relaunch (lib/app-origin.mjs).
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);
const openLogFolder = () => void shell.openPath(log.directory);

async function start() {
  const started = Date.now();
  log.write('Starting Paso', { version: app.getVersion(), electron: process.versions.electron, platform: `${process.platform}-${process.arch}`, packaged: app.isPackaged, profile: app.getPath('userData'), data: dataDir });
  await configureLoopbackProxy(session.defaultSession);
  service = await startServer({
    dataDir, port: 0, allowedOrigins: [APP_ORIGIN],
    agent: { mcp: { command: process.execPath, entry: join(root, 'mcp', 'cli.mjs'), electronRunAsNode: true } },
    openFolder: async (path) => { const error = await shell.openPath(path); if (error) throw new Error(error); },
  });
  log.write(`Service listening on ${service.url} after ${Date.now() - started} ms`);
  registerPermissions(session.defaultSession);
  // The page and its API at paso://app, the API forwarded to the service. Only this session.
  serveApp({ session: session.defaultSession, net, serviceUrl: service.url, page: staticPage({ webRoot: join(root, 'web'), csp: appCsp(service.port) }) });
  const fromPage = (event) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame.url);
  registerSessionBridge({ ipcMain, trusted: fromPage, session: () => ({ token: service.sessionToken, events: eventsUrl(service.url) }), log: log.write });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({ packaged: app.isPackaged, openDataFolder: () => void shell.openPath(dirname(resolve(dataDir))), openLogFolder })));
  const stateFile = join(app.getPath('userData'), 'window-state.json');
  const placement = placeWindow(readState(stateFile), screen.getAllDisplays(), screen.getPrimaryDisplay());
  // Titled before the page sets its own title, so even a window whose page did not load says what it is.
  const window = new BrowserWindow({ ...placement.bounds, title: 'Paso', ...windowChrome(process.platform), webPreferences: { preload: join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  if (placement.maximized) window.maximize();
  trackWindowState(window, stateFile);
  registerFolderBridge({ ipcMain, dialog, parent: () => window, trusted: fromPage });
  const external = (url) => { try { const parsed = new URL(url); if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(url); } catch { /* invalid URL */ } };
  window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) { event.preventDefault(); external(url); } });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  // Block all renderer network traffic except the page and this instance's service.
  const hosts = [hostOf(service.url)];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const cancel = !isRequestAllowed(details.url, hosts);
    if (cancel) log.write('Blocked a request', { url: details.url.slice(0, 200) });
    callback({ cancel });
  });
  watchWindow(window);
  log.write(`Window created after ${Date.now() - started} ms`);
  openPage(window, { retried: false });
}

/** Everything the page reports that could explain a blank window goes to the log, during startup and after. */
function watchWindow(window) {
  const contents = window.webContents;
  contents.on('console-message', (event) => { const entry = consoleEntry(event); if (entry) log.write('Page console', entry); });
  contents.on('unresponsive', () => log.write('The page stopped responding'));
  contents.on('responsive', () => log.write('The page responds again'));
  contents.on('render-process-gone', (_event, details) => {
    log.write("The page's process stopped", details);
    // During startup the page's watch handles it. Later, say so instead of leaving an empty window.
    if (!opening && !closing && details.reason !== 'clean-exit') void showPageError(window, `The page's process stopped (${details.reason}).`, STOPPED);
  });
}

let opening = false;
/** Loads the page and watches it until it appears. A first failure is retried once, then the person is told. */
function openPage(window, { retried }) {
  if (window.isDestroyed()) return;
  opening = true;
  watchPage(window.webContents, {
    log,
    isRendered: () => window.webContents.executeJavaScript(RENDERED_CHECK),
    onReady: () => { opening = false; },
    onFailure: (reason) => {
      opening = false;
      if (window.isDestroyed()) return;
      if (!retried) { log.write('Loading the page again'); openPage(window, { retried: true }); }
      else void showPageError(window, reason);
    },
  });
  // A failed load is reported through did-fail-load, which the watch handles.
  window.loadURL(APP_URL).catch((error) => { if (error?.code !== 'ERR_ABORTED') log.write('loadURL rejected', error); });
}

let errorShown = false;
async function showPageError(window, reason, message = NOT_OPENED) {
  if (errorShown || window.isDestroyed()) return;
  errorShown = true;
  const { response } = await dialog.showMessageBox(window, startupErrorDialog(reason, log.file, message));
  errorShown = false;
  const choice = startupErrorChoice(response);
  log.write(`Chosen after the error: ${choice}`);
  if (choice === 'retry') openPage(window, { retried: true });
  else if (choice === 'open-log') { openLogFolder(); void showPageError(window, reason, message); }
  else app.quit();
}

app.whenReady().then(start).catch((error) => {
  log.write('Paso failed to start', error);
  console.error('Paso failed to start:', error);
  const { title, content } = serviceErrorMessage(error, log.file);
  dialog.showErrorBox(title, content);
  app.quit();
});
app.on('child-process-gone', (_event, details) => log.write('A child process stopped', details));
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (!closing && service) { event.preventDefault(); closing = true; log.write('Quitting'); void service.close().finally(() => app.quit()); }
});
