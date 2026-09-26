// The desktop board backend against a real temp SQLite file, plus the Electron-facing picker with
// stubbed dialog/nativeImage. Nothing here needs the Electron runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {boardKey,INDEX_KEY,KEY,MAX_IMAGE,parseBoard,parseIndex} from '@siyue/whiteboard';
import {createBoardStorage,openBoardBackend,pickDesktopImage} from './whiteboard-store.mjs';

const rendererUrl='file:///app/index.html';
const body=id=>JSON.stringify({schemaVersion:2,editor:'excalidraw-0.18.1',id,revision:6,activePageId:'page-1',
  pages:[{id:'page-1',elements:[],appState:{viewBackgroundColor:'#fffefa',scrollX:0,scrollY:0,zoom:{value:1}}}],files:{}});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=','base64');
const later=()=>new Promise(resolve=>setImmediate(resolve));

function workspace() {
  const dir=mkdtempSync(path.join(tmpdir(),'siyue-whiteboard-'));
  const file=path.join(dir,'siyue-whiteboard.sqlite');
  return {dir,file,seed(rows){const db=new DatabaseSync(file);db.exec('CREATE TABLE IF NOT EXISTS board_storage (key TEXT PRIMARY KEY,value TEXT NOT NULL)');for(const [key,value] of rows)db.prepare('INSERT OR REPLACE INTO board_storage VALUES (?,?)').run(key,value);db.close();},
    read(){const db=new DatabaseSync(file,{readOnly:true});try{return Object.fromEntries(db.prepare('SELECT key,value FROM board_storage').all().map(row=>[row.key,row.value]));}finally{db.close();}},
    done(){rmSync(dir,{recursive:true,force:true});}};
}
function host(file,pick) {
  const board=openBoardBackend(file,pick??(()=>async source=>{throw Error(source==='camera'?'camera_unavailable':'invalid_data');}));
  const frame={url:rendererUrl};
  const webContents={id:7,mainFrame:frame};
  const win={webContents};
  const event={sender:webContents,senderFrame:frame};
  const raw=(message,target=win)=>board.handle(event,message,target,rendererUrl);
  const call=async(session,op,payload)=>JSON.parse(await raw(JSON.stringify({version:1,session,requestId:crypto.randomUUID(),op,...(payload===undefined?{}:{payload})})));
  return {board,raw,call,win,webContents,event};
}

test('the desktop library adopts the legacy board, then serves list/create/save/rename/delete',async()=>{
  const legacy=body('local-whiteboard');
  const space=workspace();
  space.seed([[KEY,legacy]]);
  const engine=host(space.file);
  try {
    const listed=await engine.call('session-a','list',{defaultTitle:'我的白板'});
    assert.deepEqual(listed.value.boards.map(entry=>[entry.id,entry.title,entry.pageCount]),[['local-whiteboard','我的白板',1]]);
    assert.equal(space.read()[KEY],legacy);
    assert.equal(space.read()[boardKey('local-whiteboard')],legacy);
    const created=await engine.call('session-a','create',{title:'数学',start:'blank'});
    const id=created.value.summary.id;
    assert.equal(typeof space.read()[boardKey(id)],'string');
    const loaded=await engine.call('session-a','load',{boardId:id});
    assert.equal(loaded.value.board.revision,0);
    const saved=await engine.call('session-a','save',{boardId:id,baseRevision:0,pages:loaded.value.board.pages,activePageId:'page-1',files:{}});
    assert.deepEqual([saved.value.revision,saved.value.fileIds],[1,[]]);
    assert.equal(parseBoard(space.read()[boardKey(id)]).revision,1);
    assert.equal((await engine.call('session-a','save',{boardId:id,baseRevision:0,pages:loaded.value.board.pages,files:{}})).error,'revision_conflict');
    assert.equal((await engine.call('session-a','rename',{boardId:id,title:' 周三数学题 '})).value.summary.title,'周三数学题');
    assert.deepEqual((await engine.call('session-a','delete',{boardId:id})).value,{deleted:true});
    assert.equal(space.read()[boardKey(id)],undefined);
    assert.deepEqual(parseIndex(space.read()[INDEX_KEY]).boards.map(entry=>entry.id),['local-whiteboard']);
  } finally { engine.board.close();space.done(); }
});

test('a new session replaces the running service and untrusted frames never reach storage',async()=>{
  const space=workspace();
  const engine=host(space.file);
  try {
    assert.equal((await engine.call('session-a','list',{defaultTitle:'我的白板'})).ok,true);
    // A fresh session has to list first, so creating a board can never skip a pending migration.
    assert.equal((await engine.call('session-b','create',{title:'数学',start:'blank'})).error,'not_loaded');
    assert.equal((await engine.call('session-b','list',{defaultTitle:'我的白板'})).ok,true);
    assert.equal((await engine.call('session-b','create',{title:'数学',start:'blank'})).ok,true);
    // The window's service follows its newest session, and every session sees the same library.
    assert.deepEqual((await engine.call('session-a','list',{defaultTitle:'我的白板'})).value.boards.map(entry=>entry.title),['数学']);
    assert.equal((await engine.call('session-a','rename',{boardId:'missing',title:'x'})).error,'not_found');
    engine.board.disposeWindow(engine.webContents.id);
    assert.equal((await engine.call('fresh','list',{defaultTitle:'我的白板'})).ok,true);
    const foreignWindow=JSON.parse(await engine.raw(JSON.stringify({version:1,session:'s',requestId:'r',op:'list'}),{webContents:{id:9,mainFrame:{url:rendererUrl}}}));
    assert.equal(foreignWindow.error,'forbidden');
    assert.equal(JSON.parse(await engine.board.handle({sender:engine.webContents,senderFrame:{url:'https://example.invalid/'}},'{}',engine.win,rendererUrl)).error,'forbidden');
    assert.equal(JSON.parse(await engine.raw('not json')).error,'invalid_data');
    assert.equal(JSON.parse(await engine.raw(JSON.stringify({version:1,session:'bad session',requestId:'r',op:'list'}))).error,'stale_session');
    assert.equal(JSON.parse(await engine.raw(JSON.stringify({version:1,session:'s',requestId:'r',op:'audit'}))).error,'unsupported_operation');
  } finally { engine.board.close();space.done(); }
});

test('the storage adapter refuses every key outside the protocol',()=>{
  const space=workspace();
  const db=new DatabaseSync(space.file);
  db.exec('CREATE TABLE IF NOT EXISTS board_storage (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const storage=createBoardStorage(db);
  try {
    storage.setItemSync(INDEX_KEY,'{"schemaVersion":1,"boards":[]}');
    assert.equal(storage.getItemSync(INDEX_KEY),'{"schemaVersion":1,"boards":[]}');
    storage.removeItemSync(INDEX_KEY);
    assert.equal(storage.getItemSync(INDEX_KEY),null);
    assert.throws(()=>storage.getItemSync('siyue.whiteboard.trial.v1'),/invalid_key/);
    assert.throws(()=>storage.setItemSync('siyue.whiteboard.board.bad id.v2','{}'),/invalid_key/);
    assert.throws(()=>storage.removeItemSync('siyue.whiteboard.excalidraw.v2x'),/invalid_key/);
  } finally { db.close();space.done(); }
});

test('the desktop picker is library-only, normalises to JPEG and enforces both size limits',async()=>{
  const space=workspace();
  const imagePath=path.join(space.dir,'shot.png');
  writeFileSync(imagePath,png);
  const calls=[];
  const makeImage=(width,height,options={})=>({
    isEmpty:()=>!!options.empty,
    getSize:()=>({width,height}),
    resize(next){calls.push(['resize',next]);const scale=next.width?next.width/width:next.height/height;return makeImage(next.width??Math.round(width*scale),next.height??Math.round(height*scale),options);},
    toJPEG:()=>options.bytes??Buffer.from('/9j/desktop'),
  });
  const nativeImage={createFromPath:()=>makeImage(1000,500)};
  const dialog={showOpenDialog:async(win,options)=>{calls.push(['dialog',win,options]);return {canceled:true,filePaths:[]};}};
  const pick=()=>pickDesktopImage('library',{dialog,nativeImage,win:'window'});
  try {
    await assert.rejects(()=>pickDesktopImage('camera',{dialog,nativeImage,win:'window'}),/camera_unavailable/);
    assert.deepEqual(await pick(),{cancelled:true});
    assert.deepEqual(calls[0],['dialog','window',{properties:['openFile'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp']}]}]);
    dialog.showOpenDialog=async(win,options)=>{calls.push(['dialog',win,options]);return {canceled:false,filePaths:[imagePath]};};

    nativeImage.createFromPath=()=>makeImage(4000,3000);
    const landscape=await pick();
    assert.deepEqual(calls.filter(call=>call[0]==='resize'),[['resize',{width:3200}]]);
    assert.deepEqual([landscape.width,landscape.height],[3200,2400]);
    assert.equal(landscape.file.mimeType,'image/jpeg');
    assert.match(landscape.file.dataURL,/^data:image\/jpeg;base64,/);
    assert.match(landscape.file.id,/^[0-9a-f-]{36}$/);
    assert.equal(typeof landscape.file.created,'number');

    calls.length=0;
    nativeImage.createFromPath=()=>makeImage(2000,4000);
    assert.deepEqual((await pick()).height,3200);
    assert.deepEqual(calls.filter(call=>call[0]==='resize'),[['resize',{height:3200}]]);

    calls.length=0;
    nativeImage.createFromPath=()=>makeImage(3200,2000);
    assert.deepEqual([(await pick()).width,(await pick()).height],[3200,2000]);
    assert.deepEqual(calls.filter(call=>call[0]==='resize'),[]);

    nativeImage.createFromPath=()=>makeImage(1000,500,{empty:true});
    await assert.rejects(pick,/invalid_image/);
    nativeImage.createFromPath=()=>makeImage(20000,20000);
    await assert.rejects(pick,/image_too_large/);
    nativeImage.createFromPath=()=>makeImage(500,500,{bytes:Buffer.alloc(MAX_IMAGE+1)});
    await assert.rejects(pick,/image_too_large/);
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(space.dir,'missing.png')]});
    await assert.rejects(pick,/ENOENT/);
    await later();
  } finally { space.done(); }
});
