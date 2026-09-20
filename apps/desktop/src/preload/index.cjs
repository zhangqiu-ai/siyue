const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siyueDesktop', Object.freeze({
  platform: process.platform,
  whiteboard: (message) => ipcRenderer.invoke('siyue:whiteboard', message),
  onWhiteboardClose: (callback) => {
    const listener=(_event,id)=>callback(id);
    ipcRenderer.on('siyue:whiteboard-close',listener);
    ipcRenderer.send('siyue:whiteboard-active',true);
    return ()=>{ipcRenderer.removeListener('siyue:whiteboard-close',listener);ipcRenderer.send('siyue:whiteboard-active',false);};
  },
  finishWhiteboardClose: (id,ok) => ipcRenderer.send('siyue:whiteboard-close-result',{id,ok}),
  runtime: 'electron',
  invoke: (message) => ipcRenderer.invoke('siyue:local-command', message),
  cancel: (requestId) => ipcRenderer.send('siyue:cancel-proposal', requestId),
}));
