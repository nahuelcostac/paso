// A minimal Electron main for test/startup.test.mjs: the app's scheme, handler and CSP, a hidden sandboxed window, and
// the startup watch from lib/startup.mjs on one load of the page in PASO_TEST_WEB. The profile is the test's.
import { app, BrowserWindow, net, protocol, session } from 'electron';
import { APP_SCHEME_PRIVILEGES, APP_URL, appCsp } from '../../lib/app-origin.mjs';
import { serveApp, staticPage } from '../../lib/app-protocol.mjs';
import { RENDERED_CHECK, watchPage } from '../../lib/startup.mjs';

app.setPath('userData', process.env.PASO_TEST_PROFILE);
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);
app.dock?.hide();

app.whenReady().then(async () => {
  serveApp({ session: session.defaultSession, net, serviceUrl: 'http://127.0.0.1:9', page: staticPage({ webRoot: process.env.PASO_TEST_WEB, csp: appCsp(9) }) });
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const lines = [];
  const finish = (result) => { process.stdout.write(`RESULT ${JSON.stringify({ ...result, lines })}\n`); app.exit(0); };
  watchPage(window.webContents, {
    timeoutMs: Number(process.env.PASO_TEST_TIMEOUT),
    isRendered: () => window.webContents.executeJavaScript(RENDERED_CHECK),
    log: { write: (message) => lines.push(message) },
    onReady: () => finish({ outcome: 'ready' }),
    onFailure: (reason) => finish({ outcome: 'failed', reason }),
  });
  window.loadURL(APP_URL).catch(() => { /* reported by the watch */ });
}).catch((error) => { process.stdout.write(`ERROR ${error}\n`); app.exit(1); });
