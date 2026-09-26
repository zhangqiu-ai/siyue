import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {whiteboardClose} from './whiteboard-close.mjs';

test('close coordinator accepts only same-window trusted acknowledgements and preserves failed editor',async()=>{
 const ipc=new EventEmitter(),coordinator=whiteboardClose(ipc,'file:///app/index.html');
 const frame={url:'file:///app/index.html'}, sent=[];
 const sender={id:7,mainFrame:frame,send:(_channel,id)=>sent.push(id)},event={sender,senderFrame:frame},win={webContents:sender};
 ipc.emit('siyue:whiteboard-active',{sender,senderFrame:{url:frame.url}},true);
 assert.equal(await coordinator.request(win),true);assert.equal(sent.length,0);
 ipc.emit('siyue:whiteboard-active',event,true);
 const first=coordinator.request(win);assert.equal(coordinator.request(win),first);
 ipc.emit('siyue:whiteboard-active',{sender,senderFrame:{url:frame.url}},false);
 assert.equal(coordinator.request(win),first);
 ipc.emit('siyue:whiteboard-close-result',event,{id:'wrong',ok:true});
 ipc.emit('siyue:whiteboard-close-result',event,{id:sent[0],ok:false});assert.equal(await first,false);
 const retry=coordinator.request(win);ipc.emit('siyue:whiteboard-close-result',event,{id:sent[1],ok:true});assert.equal(await retry,true);
 const disposed=coordinator.request(win);coordinator.dispose(7);assert.equal(await disposed,false);
});

test('a trusted editor that finished saving and unmounted resolves an in-flight close',async()=>{
 const ipc=new EventEmitter(),coordinator=whiteboardClose(ipc,'file:///app/index.html');
 const frame={url:'file:///app/index.html'},sender={id:8,mainFrame:frame,send(){}},event={sender,senderFrame:frame};
 ipc.emit('siyue:whiteboard-active',event,true);
 const closing=coordinator.request({webContents:sender});
 ipc.emit('siyue:whiteboard-active',event,false);
 let timer;
 try{assert.equal(await Promise.race([closing,new Promise(resolve=>{timer=setTimeout(()=>resolve('still waiting'),50);})]),true);}
 finally{clearTimeout(timer);coordinator.dispose(sender.id);}
});
