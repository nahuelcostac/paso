// A hidden Electron window with the packaged page's scheme, CSP and static file handler.
import { app, BrowserWindow, net, protocol, session } from 'electron';
import { APP_SCHEME_PRIVILEGES, APP_URL, appCsp } from '../../lib/app-origin.mjs';
import { serveApp, staticPage } from '../../lib/app-protocol.mjs';

app.setPath('userData', process.env.PASO_TEST_PROFILE);
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);
app.dock?.hide();
app.whenReady().then(async () => {
  const requests = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    requests.push(details.url); callback({ cancel: !details.url.startsWith(APP_URL) });
  });
  serveApp({ session: session.defaultSession, net, serviceUrl: 'http://127.0.0.1:9', page: staticPage({ webRoot: process.env.PASO_TEST_WEB, csp: appCsp(9) }) });
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadURL(APP_URL);
  const moduleUrl = JSON.stringify(`/assets/${process.env.PASO_TEST_EXCALIDRAW}`);
  const result = await window.webContents.executeJavaScript(`(async () => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', e => violations.push({directive: e.violatedDirective, blocked: e.blockedURI}));
    const sources = [];
    const Original = window.FontFace;
    window.FontFace = class extends Original { constructor(family, source, descriptors) { sources.push(String(source)); super(family, source, descriptors); } };
    const m = await import(${moduleUrl});
    const families = [1, 2, 3, 5, 6, 7, 8, 9];
    const elements = m.restoreElements(families.map((fontFamily, i) => ({ id: 'font-' + i, type: 'text', x: 0, y: i * 50, width: 150, height: 25, fontSize: 20, fontFamily, text: 'Hello áé', originalText: 'Hello áé', lineHeight: 1.25, version: 1, versionNonce: 1, isDeleted: false })), null, { refreshDimensions: false });
    await m.exportToCanvas({ elements, files: {}, getDimensions: () => ({ width: 400, height: 500, scale: 1 }) });
    const svg = await m.exportToSvg({ elements, appState: {}, files: {} });
    await new Promise(resolve => setTimeout(resolve, 250));
    return { assetPath: window.EXCALIDRAW_ASSET_PATH, violations: violations.filter(v => v.directive === 'font-src'), sources, embedded: svg.outerHTML.includes('data:font/'), remoteSvg: svg.outerHTML.includes('https://esm.sh/') };
  })()`);
  process.stdout.write(`RESULT ${JSON.stringify({ ...result, requests })}\n`);
  app.quit();
}).catch((error) => { process.stdout.write(`ERROR ${error.stack}\n`); app.exit(1); });
