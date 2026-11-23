/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');
// The session token, and the event stream's address: the page is at paso://app, the service on a loopback port.
const session = ipcRenderer.sendSync('paso-session') ?? {};
contextBridge.exposeInMainWorld('pasoDesktop', {
  // macOS draws the window's buttons over the page, in the sidebar's head: the page leaves them room.
  windowControls: process.platform === 'darwin' ? 'mac' : undefined,
  token: session.token,
  events: session.events,
  // “New workspace…” with the system's folder dialog. Resolves to the picked folder, or null when cancelled.
  chooseFolder: (near) => ipcRenderer.invoke('paso-choose-folder', typeof near === 'string' ? near : undefined),
});
