// A minimal Electron main for test/relaunch.test.mjs: the app's own scheme and handler, a hidden window, one read and
// one write of localStorage, then quit. The profile is the test's, never the person's.
import { app, BrowserWindow, net, protocol, session } from 'electron';
import { APP_SCHEME_PRIVILEGES, APP_URL, appCsp } from '../../lib/app-origin.mjs';
import { serveApp, staticPage } from '../../lib/app-protocol.mjs';

app.setPath('userData', process.env.PASO_TEST_PROFILE);
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);
app.dock?.hide();

app.whenReady().then(async () => {
  serveApp({ session: session.defaultSession, net, serviceUrl: 'http://127.0.0.1:9', page: staticPage({ webRoot: process.env.PASO_TEST_WEB, csp: appCsp(9) }) });
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadURL(APP_URL);
  const value = JSON.stringify(process.env.PASO_TEST_VALUE);
  const result = await window.webContents.executeJavaScript(`(() => {
    const before = localStorage.getItem('paso.relaunch');
    localStorage.setItem('paso.relaunch', ${value});
    return { origin: location.origin, secure: isSecureContext, title: document.title, before };
  })()`);
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  app.quit();
}).catch((error) => { process.stdout.write(`ERROR ${error}\n`); app.exit(1); });
