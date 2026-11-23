// Exposes a small, fixed API to the window; nothing else from Node or Electron is reachable.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hb', {
  state: () => ipcRenderer.invoke('state'),
  setLogin: (on) => ipcRenderer.invoke('set-login', !!on),
  install: (id) => ipcRenderer.invoke('install', String(id)),
  window: (action) => ipcRenderer.invoke('window', String(action)),
  openUrl: (url) => ipcRenderer.invoke('open-url', String(url)),
  onEvent: (cb) => ipcRenderer.on('event', (e, data) => cb(data)),
});
