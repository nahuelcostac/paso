import { app, BrowserWindow, dialog, ipcMain, Menu, net, screen, session, shell } from 'electron';
import { startServer } from './service.mjs';
import { homedir } from 'node:os';
import { join, resolve, sep, extname, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { menuTemplate } from './lib/menu.mjs';
import { placeWindow, readState, trackWindowState } from './lib/window-state.mjs';
import { registerFolderBridge } from './lib/folder-bridge.mjs';
import { allowsPermission, claimSingleInstance } from './lib/app-shell.mjs';

let service;
let closing = false;
const root = app.getAppPath();
const dataDir = process.env.PASO_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'Paso', 'projects');
if (process.env.PASO_DATA_DIR) app.setPath('userData', join(dirname(resolve(dataDir)), 'desktop-profile'));
// The lock lives in the profile, so a test instance with its own PASO_DATA_DIR never meets the person's Paso.
if (!claimSingleInstance(app, () => BrowserWindow.getAllWindows()[0])) app.exit(0);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

async function start() {
  service = await startServer({
    dataDir, port: 0,
    agent: { mcp: { command: process.execPath, entry: join(root, 'mcp', 'cli.mjs'), electronRunAsNode: true } },
    openFolder: async (path) => { const error = await shell.openPath(path); if (error) throw new Error(error); },
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => callback(allowsPermission(permission, details.requestingUrl, service.url)));
  const origin = service.url;
  const webRoot = join(root, 'web');
  // Intercept only this session. API requests still go to the authenticated service.
  session.defaultSession.protocol.handle('http', async (request) => {
    const url = new URL(request.url);
    if (url.origin !== origin) return new Response('Blocked', { status: 403 });
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return net.fetch(request, { bypassCustomProtocolHandlers: true });
    if (request.method !== 'GET') return new Response('Blocked', { status: 405 });
    let path;
    try { path = resolve(webRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`); }
    catch { return new Response('Bad request', { status: 400 }); }
    if (!path.startsWith(webRoot + sep)) return new Response('Blocked', { status: 403 });
    try {
      const bytes = await readFile(path);
      return new Response(bytes, { headers: { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:${service.port}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'` } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  ipcMain.on('paso-session', (event) => { if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) event.returnValue = service.sessionToken; });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({ packaged: app.isPackaged, openDataFolder: () => void shell.openPath(dirname(resolve(dataDir))) })));
  const stateFile = join(app.getPath('userData'), 'window-state.json');
  const placement = placeWindow(readState(stateFile), screen.getAllDisplays(), screen.getPrimaryDisplay());
  const window = new BrowserWindow({ ...placement.bounds, webPreferences: { preload: join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  if (placement.maximized) window.maximize();
  trackWindowState(window, stateFile);
  registerFolderBridge({ ipcMain, dialog, parent: () => window, trusted: (event) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin });
  const external = (url) => { try { const parsed = new URL(url); if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(url); } catch { /* invalid URL */ } };
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) { event.preventDefault(); external(url); } });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  // Block all renderer network traffic except this instance's service.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => { const url = new URL(details.url); callback({ cancel: !((url.protocol === 'http:' || url.protocol === 'ws:') && url.host === new URL(origin).host) && !['data:', 'blob:', 'devtools:'].includes(url.protocol) }); });
  await window.loadURL(origin);
}
app.whenReady().then(start).catch((error) => { console.error('Paso failed to start:', error); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (!closing && service) { event.preventDefault(); closing = true; void service.close().finally(() => app.quit()); }
});
