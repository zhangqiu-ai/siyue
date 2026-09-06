const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siyueDesktop', Object.freeze({
  platform: process.platform,
  runtime: 'electron',
  invoke: (message) => ipcRenderer.invoke('siyue:local-command', message),
  cancel: (requestId) => ipcRenderer.send('siyue:cancel-proposal', requestId),
}));
