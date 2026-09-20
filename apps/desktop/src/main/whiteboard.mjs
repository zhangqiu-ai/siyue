import { DatabaseSync } from 'node:sqlite';
import { dialog, nativeImage } from 'electron';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createService, MAX_IMAGE, MAX_MESSAGE } from '@siyue/whiteboard';

export function openWhiteboard(file) {
  const db=new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS board_storage (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const storage={getItemSync:key=>db.prepare('SELECT value FROM board_storage WHERE key=?').get(key)?.value??null,
    setItemSync:(key,value)=>db.prepare('INSERT OR REPLACE INTO board_storage VALUES (?,?)').run(key,value)};
  const services=new Map();
  return {
    disposeWindow: id=>{services.get(id)?.service.dispose();services.delete(id);},
    close:()=>{for(const item of services.values())item.service.dispose();db.close();},
    async handle(event,message,win,rendererUrl) {
      if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==rendererUrl||typeof message!=='string'||message.length>MAX_MESSAGE) return JSON.stringify({version:1,requestId:'',ok:false,error:'forbidden'});
      let request;try{request=JSON.parse(message);}catch{return JSON.stringify({version:1,requestId:'',ok:false,error:'invalid_data'});}
      if(!request||typeof request!=='object'||Array.isArray(request))return JSON.stringify({version:1,requestId:'',ok:false,error:'invalid_data'});
      if(typeof request.session!=='string'||!/^[\w-]{1,100}$/.test(request.session))return JSON.stringify({version:1,requestId:request.requestId,ok:false,error:'stale_session'});
      let entry=services.get(event.sender.id);
      if(request.op==='load'&&entry?.session!==request.session) {
        entry?.service.dispose();
        const service=createService(storage,request.session,async source=>{
          if(source!=='library')throw new Error('camera_unavailable');
          const chosen=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp']}]});
          if(chosen.canceled||!chosen.filePaths[0])return {cancelled:true};
          const imagePath=chosen.filePaths[0];if((await stat(imagePath)).size>32*1024*1024)throw new Error('image_too_large');
          let image=nativeImage.createFromPath(imagePath);if(image.isEmpty())throw new Error('invalid_image');
          let size=image.getSize();if(size.width*size.height>80_000_000)throw new Error('image_too_large');
          if(Math.max(size.width,size.height)>3200)image=image.resize(size.width>=size.height?{width:3200}:{height:3200});
          size=image.getSize();const bytes=image.toJPEG(92);if(bytes.length>MAX_IMAGE)throw new Error('image_too_large');
          return {file:{id:randomUUID(),mimeType:'image/jpeg',dataURL:`data:image/jpeg;base64,${bytes.toString('base64')}`,created:Date.now()},...size};
        });
        entry={session:request.session,service};services.set(event.sender.id,entry);
      }
      return entry?entry.service.request(message):JSON.stringify({version:1,requestId:request.requestId,ok:false,error:'not_loaded'});
    },
  };
}
