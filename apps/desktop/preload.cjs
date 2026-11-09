/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pasoDesktop', { token: ipcRenderer.sendSync('paso-session') });
