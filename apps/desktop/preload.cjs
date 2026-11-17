/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pasoDesktop', {
  token: ipcRenderer.sendSync('paso-session'),
  // “New workspace…” with the system's folder dialog. Resolves to the picked folder, or null when cancelled.
  chooseFolder: (near) => ipcRenderer.invoke('paso-choose-folder', typeof near === 'string' ? near : undefined),
});
