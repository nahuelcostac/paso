/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pasoDesktop', {
  // macOS draws the window's buttons over the page, in the sidebar's head: the page leaves them room.
  windowControls: process.platform === 'darwin' ? 'mac' : undefined,
  token: ipcRenderer.sendSync('paso-session'),
  // “New workspace…” with the system's folder dialog. Resolves to the picked folder, or null when cancelled.
  chooseFolder: (near) => ipcRenderer.invoke('paso-choose-folder', typeof near === 'string' ? near : undefined),
});
