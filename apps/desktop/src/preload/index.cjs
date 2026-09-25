const { contextBridge, ipcRenderer } = require('electron');
let workspaceRevision;
ipcRenderer.on('siyue:workspace-state',(_event,state)=>{workspaceRevision=state.revision;});

contextBridge.exposeInMainWorld('siyueDesktop', Object.freeze({
  platform: process.platform,
  whiteboard: (message,revision=workspaceRevision) => ipcRenderer.invoke('siyue:whiteboard', message,revision),
  workspace: async(message={op:'state'})=>{const result=await ipcRenderer.invoke('siyue:workspace',message);if(result.ok)workspaceRevision=result.value.revision;return result;},
  onWorkspaceState: callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('siyue:workspace-state',listener);return()=>ipcRenderer.removeListener('siyue:workspace-state',listener);},
  onWhiteboardClose: (callback) => {
    const listener=(_event,id)=>callback(id);
    ipcRenderer.on('siyue:whiteboard-close',listener);
    ipcRenderer.send('siyue:whiteboard-active',true);
    return ()=>{ipcRenderer.removeListener('siyue:whiteboard-close',listener);ipcRenderer.send('siyue:whiteboard-active',false);};
  },
  finishWhiteboardClose: (id,ok) => ipcRenderer.send('siyue:whiteboard-close-result',{id,ok}),
  auth: (message) => ipcRenderer.invoke('siyue:auth',message),
  onAuthState: (callback) => {
    const listener=(_event,state)=>callback(state);
    ipcRenderer.on('siyue:auth-state',listener);
    return ()=>ipcRenderer.removeListener('siyue:auth-state',listener);
  },
  runtime: 'electron',
  invoke: (message) => ipcRenderer.invoke('siyue:local-command', {...message,workspaceRevision:message.workspaceRevision??workspaceRevision}),
  cancel: (requestId) => ipcRenderer.send('siyue:cancel-proposal', requestId),
}));
