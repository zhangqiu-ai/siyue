import { randomUUID } from 'node:crypto';
// Only a trusted top-level renderer can register an editor or acknowledge its own close request.
export function whiteboardClose(ipcMain, rendererUrl) {
  const active=new Set(), pending=new Map();
  const trusted=event=>event.senderFrame===event.sender.mainFrame&&event.senderFrame.url===rendererUrl;
  ipcMain.on('siyue:whiteboard-active',(event,value)=>{
    if(!trusted(event)||typeof value!=='boolean')return;
    if(value)active.add(event.sender.id);else active.delete(event.sender.id);
  });
  ipcMain.on('siyue:whiteboard-close-result',(event,result)=>{
    if(!trusted(event)||!result||typeof result.id!=='string'||typeof result.ok!=='boolean')return;
    const task=pending.get(event.sender.id);if(task?.id===result.id)task.finish(result.ok);
  });
  return {
    request(win) {
      const key=win.webContents.id;
      if(!active.has(key))return Promise.resolve(true);
      if(pending.has(key))return pending.get(key).promise;
      const id=randomUUID();let finish;
      const promise=new Promise(resolve=>{finish=ok=>{clearTimeout(timer);pending.delete(key);resolve(ok);};});
      const timer=setTimeout(()=>finish(false),35000);
      pending.set(key,{id,promise,finish});win.webContents.send('siyue:whiteboard-close',id);
      return promise;
    },
    dispose(key){active.delete(key);pending.get(key)?.finish(false);},
  };
}
