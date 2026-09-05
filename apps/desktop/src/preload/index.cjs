const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('siyueDesktop', Object.freeze({
  platform: process.platform,
  runtime: 'electron',
}));
