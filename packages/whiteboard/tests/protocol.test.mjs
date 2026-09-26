import {test} from 'node:test';
import assert from 'node:assert/strict';
import {blankPage,boardKey,createService,emptyBoard,INDEX_KEY,isStorageKey,KEY,MAX_BOARDS,MAX_THUMBNAIL,MAX_TITLE} from '../src/protocol.ts';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=';
function setup({initial={},pick=async()=>({cancelled:true}),options}={}) {
 const store=new Map(Object.entries(initial));
 let blocked=null;
 const storage={
  getItemSync:key=>{if(!isStorageKey(key))throw Error('invalid_key');return store.has(key)?store.get(key):null;},
  setItemSync:(key,value)=>{if(!isStorageKey(key))throw Error('invalid_key');if(key===blocked)throw Error('disk full');store.set(key,value);},
  removeItemSync:key=>{if(!isStorageKey(key))throw Error('invalid_key');store.delete(key);},
 };
 const service=createService(storage,'session',pick,options);
 const call=async(op,payload,requestId=crypto.randomUUID(),session='session')=>JSON.parse(await service.request(JSON.stringify({version:1,session,requestId,op,...(payload===undefined?{}:{payload})})));
 return {call,service,store,raw:key=>store.has(key)?store.get(key):null,block:key=>{blocked=key;}};
}
const save=(boardId,baseRevision,extra={})=>({boardId,baseRevision,pages:emptyBoard(boardId).pages,files:{},...extra});
const titles=boards=>boards.map(board=>board.title);

test('a first list without a legacy body creates the empty index once and unlocks the library',async()=>{
 let sequence=0;
 const s=setup({options:{newId:()=>'board-'+(++sequence)}});
 assert.deepEqual((await s.call('list',{defaultTitle:'我的白板'})).value,{boards:[]});
 assert.deepEqual(JSON.parse(s.raw(INDEX_KEY)),{schemaVersion:1,boards:[]});
 assert.deepEqual((await s.call('create',{title:'数学',start:'blank'})).value.summary.id,'board-1');
 assert.deepEqual(titles((await s.call('list',{defaultTitle:'别的'})).value.boards),['数学']);
});

test('the single legacy board becomes one titled entry on first list and its key is never rewritten',async()=>{
 const legacy=JSON.stringify({...emptyBoard(),revision:7,pages:[blankPage('page-1'),blankPage('page-2')],activePageId:'page-2'});
 const s=setup({initial:{[KEY]:legacy}});
 const listed=await s.call('list',{defaultTitle:'  我的白板 '});
 assert.deepEqual(listed.value.boards.map(board=>[board.id,board.title,board.pageCount]),[['local-whiteboard','我的白板',2]]);
 assert.equal(s.raw(KEY),legacy);
 assert.equal(s.raw(boardKey('local-whiteboard')),legacy);
 const loaded=await s.call('load',{boardId:'local-whiteboard'});
 assert.equal(loaded.value.board.revision,7);
 assert.equal(loaded.value.board.activePageId,'page-2');
 assert.equal(loaded.value.board.pages.length,2);
 // The stored index wins afterwards: a second list never migrates again or retitles.
 assert.deepEqual(titles((await s.call('list',{defaultTitle:'别的名字'})).value.boards),['我的白板']);
});

test('migration needs the caller title and refuses to touch anything without one',async()=>{
 const legacy=JSON.stringify(emptyBoard());
 const s=setup({initial:{[KEY]:legacy}});
 assert.equal((await s.call('list',{})).error,'invalid_data');
 assert.equal((await s.call('list',{defaultTitle:'   '})).error,'invalid_data');
 assert.equal(s.raw(INDEX_KEY),null);
 assert.equal(s.raw(boardKey('local-whiteboard')),null);
 assert.equal(s.raw(KEY),legacy);
 assert.deepEqual(titles((await s.call('list',{defaultTitle:'My whiteboard'})).value.boards),['My whiteboard']);
});

test('a corrupt or newer legacy body is reported and never replaced by a blank board',async()=>{
 for (const [legacy,code] of [['{broken','storage_or_read_failed'],[JSON.stringify({...emptyBoard(),schemaVersion:3}),'unsupported_schema']]) {
  const s=setup({initial:{[KEY]:legacy}});
  assert.equal((await s.call('list',{defaultTitle:'我的白板'})).error,code);
  assert.equal(s.raw(KEY),legacy);
  assert.equal(s.raw(INDEX_KEY),null);
  assert.equal(s.raw(boardKey('local-whiteboard')),null);
  assert.equal((await s.call('save',save('local-whiteboard',0))).error,'not_loaded');
 }
});

test('list, create, rename, delete and revision conflicts work per board id',async()=>{
 let sequence=0;
 const s=setup({options:{newId:()=>'board-'+(++sequence),now:()=>new Date(Date.UTC(2026,8,25,10,sequence)).toISOString()}});
 await s.call('list',{defaultTitle:'我的白板'});
 const first=(await s.call('create',{title:'  数学  ',start:'blank'})).value.summary;
 assert.deepEqual([first.id,first.title,first.pageCount,first.updatedAt.startsWith('2026-09-25T')],[ 'board-1','数学',1,true]);
 const second=(await s.call('create',{title:'英语单词卡',start:'photo'})).value.summary;
 assert.deepEqual(titles((await s.call('list',{defaultTitle:'x'})).value.boards),['英语单词卡','数学']);
 assert.equal((await s.call('load',{boardId:'missing'})).error,'not_found');
 assert.equal((await s.call('rename',{boardId:first.id,title:'  '})).error,'invalid_data');
 assert.equal((await s.call('rename',{boardId:first.id,title:'x'.repeat(MAX_TITLE+1)})).error,'invalid_data');
 assert.equal((await s.call('rename',{boardId:'missing',title:'x'})).error,'not_found');
 assert.equal((await s.call('create',{title:'扫描',start:'scan'})).error,'invalid_data');
 const renamed=await s.call('rename',{boardId:first.id,title:'周三数学题'});
 assert.equal(renamed.value.summary.title,'周三数学题');
 assert.equal(renamed.value.summary.pageCount,1);
 const loaded=await s.call('load',{boardId:first.id});
 assert.equal(loaded.value.board.revision,0);
 assert.equal(loaded.value.summary.title,'周三数学题');
 const saved=await s.call('save',save(first.id,0),'save-1');
 assert.deepEqual([saved.ok,saved.value.revision],[true,1]);
 assert.deepEqual(await s.call('save',save(first.id,0),'save-1'),saved);
 assert.equal((await s.call('save',{...save(first.id,0),baseRevision:1},'save-1')).error,'request_conflict');
 assert.equal((await s.call('save',save(first.id,0),'save-2')).error,'revision_conflict');
 assert.equal(JSON.parse(s.raw(boardKey(first.id))).revision,1);
 assert.deepEqual((await s.call('delete',{boardId:second.id})).value,{deleted:true});
 assert.equal(s.raw(boardKey(second.id)),null);
 assert.equal((await s.call('load',{boardId:second.id})).error,'not_found');
 assert.equal((await s.call('delete',{boardId:second.id})).error,'not_found');
 assert.equal((await s.call('load',{boardId:first.id})).value.board.revision,1);
});

test('replayed library requests are answered from the receipt instead of creating twice',async()=>{
 let sequence=0;
 const s=setup({options:{newId:()=>'board-'+(++sequence)}});
 await s.call('list',{defaultTitle:'x'});
 const created=await s.call('create',{title:'数学',start:'blank'},'create-1');
 assert.deepEqual(await s.call('create',{title:'数学',start:'blank'},'create-1'),created);
 assert.equal((await s.call('create',{title:'英语',start:'blank'},'create-1')).error,'request_conflict');
 assert.equal(JSON.parse(s.raw(INDEX_KEY)).boards.length,1);
});

test('the index stops at 200 boards and an unreadable body reports not_found',async()=>{
 let sequence=0;
 const s=setup({options:{newId:()=>'board-'+(++sequence)}});
 await s.call('list',{defaultTitle:'x'});
 for (let index=0;index<MAX_BOARDS;index+=1) assert.equal((await s.call('create',{title:'板 '+index,start:'blank'})).ok,true);
 assert.equal((await s.call('create',{title:'过多',start:'blank'})).error,'capacity');
 assert.equal(JSON.parse(s.raw(INDEX_KEY)).boards.length,MAX_BOARDS);
 // A restored index whose body row is gone must never read as a blank board.
 s.store.delete(boardKey('board-1'));
 assert.equal((await s.call('load',{boardId:'board-1'})).error,'not_found');
 assert.equal((await s.call('save',save('board-1',0))).error,'not_found');
});

test('a failed body write keeps the original revision so the same base can be retried',async()=>{
 let sequence=0;
 const s=setup({options:{newId:()=>'board-'+(++sequence)}});
 await s.call('list',{defaultTitle:'x'});
 const board=(await s.call('create',{title:'数学',start:'blank'})).value.summary;
 await s.call('load',{boardId:board.id});
 s.block(boardKey(board.id));
 assert.equal((await s.call('save',save(board.id,0),'save-1')).error,'storage_or_read_failed');
 assert.equal(JSON.parse(s.raw(boardKey(board.id))).revision,0);
 s.block(null);
 const retried=await s.call('save',save(board.id,0),'save-2');
 assert.deepEqual([retried.ok,retried.value.revision],[true,1]);
});

test('complete image bytes survive delta-only saves; missing and unsafe images are rejected',async()=>{
 const s=setup();
 await s.call('list',{defaultTitle:'x'});
 const board=(await s.call('create',{title:'数学',start:'blank'})).value.summary;
 await s.call('load',{boardId:board.id});
 const image={id:'image-1',type:'image',fileId:'file-1',x:0,y:0,width:100,height:100,angle:0,version:1,link:null};
 const pages=save(board.id,0,{pages:[{...blankPage('page-1'),elements:[image]}]});
 assert.equal((await s.call('save',pages)).error,'missing_image');
 assert.equal(JSON.parse(s.raw(boardKey(board.id))).revision,0);
 pages.files={'file-1':{id:'file-1',created:1,mimeType:'image/png',dataURL:png}};
 assert.equal((await s.call('save',pages)).ok,true);
 assert.equal((await s.call('save',{...pages,baseRevision:1,files:{}})).ok,true);
 assert.equal(JSON.parse(s.raw(boardKey(board.id))).files['file-1'].dataURL,png);
 assert.equal((await s.call('save',{...pages,baseRevision:2,files:{'file-1':{...pages.files['file-1'],dataURL:'data:image/svg+xml;base64,PHN2Zz4='}}})).ok,false);
 assert.equal(JSON.parse(s.raw(boardKey(board.id))).files['file-1'].dataURL,png);
 const withoutImage=save(board.id,2);
 assert.equal((await s.call('save',withoutImage)).ok,true);
 assert.deepEqual(JSON.parse(s.raw(boardKey(board.id))).files,{});
});

test('a board thumbnail reaches the index; an unusable one is dropped without failing the save',async()=>{
 const s=setup();
 await s.call('list',{defaultTitle:'x'});
 const board=(await s.call('create',{title:'数学',start:'blank'})).value.summary;
 await s.call('load',{boardId:board.id});
 const good=await s.call('save',save(board.id,0,{thumbnail:png}));
 assert.equal(good.value.summary.thumbnail,png);
 assert.equal((await s.call('list',{defaultTitle:'x'})).value.boards[0].thumbnail,png);
 const oversized=await s.call('save',save(board.id,1,{thumbnail:'data:image/png;base64,'+'A'.repeat(MAX_THUMBNAIL)}));
 assert.equal(oversized.ok,true);
 assert.equal(oversized.value.summary.thumbnail,png);
 const malformed=await s.call('save',save(board.id,2,{thumbnail:'data:image/svg+xml;base64,PHN2Zz4='}));
 assert.equal(malformed.ok,true);
 assert.equal(malformed.value.summary.thumbnail,png);
});

test('closing context rejects a late native result and prevents further writes',async()=>{
 let resolve;
 const s=setup({pick:()=>new Promise(done=>{resolve=done;})});
 await s.call('list',{defaultTitle:'x'});
 const board=(await s.call('create',{title:'数学',start:'blank'})).value.summary;
 await s.call('load',{boardId:board.id});
 const pending=s.call('pick',{source:'library'});
 s.service.dispose();resolve({cancelled:true});
 assert.equal((await pending).error,'stale_session');
 assert.equal((await s.call('save',save(board.id,0))).error,'stale_session');
 assert.equal((await s.call('list',{defaultTitle:'x'})).error,'stale_session');
 assert.equal(JSON.parse(s.raw(boardKey(board.id))).revision,0);
});

test('only protocol keys are read, and the retired conversion operation stays unknown',async()=>{
 const reads=[];
 const storage={getItemSync:key=>{assert.equal(isStorageKey(key),true);reads.push(key);return null;},setItemSync:()=>{},removeItemSync:()=>{}};
 const service=createService(storage,'session',async()=>({cancelled:true}));
 const call=async(op,payload,requestId=crypto.randomUUID(),session='session')=>JSON.parse(await service.request(JSON.stringify({version:1,session,requestId,op,...(payload===undefined?{}:{payload})})));
 assert.deepEqual((await call('list',{defaultTitle:'x'})).value,{boards:[]});
 assert.deepEqual(reads,[INDEX_KEY,KEY]);
 assert.equal((await call('legacy')).error,'unsupported_operation');
 assert.equal((await call('save',{boardId:'local-whiteboard',baseRevision:0,pages:[],files:{}},'wrong','other')).error,'stale_session');
});

test('the storage key guard accepts exactly index, legacy and per-board body keys',()=>{
 assert.equal(isStorageKey(INDEX_KEY),true);
 assert.equal(isStorageKey(KEY),true);
 assert.equal(isStorageKey(boardKey('local-whiteboard')),true);
 assert.equal(isStorageKey(boardKey(crypto.randomUUID())),true);
 assert.equal(isStorageKey(KEY+'x'),false);
 assert.equal(isStorageKey('siyue.whiteboard.board.bad id.v2'),false);
 assert.equal(isStorageKey(boardKey('a'.repeat(101))),false);
 assert.equal(isStorageKey('siyue.whiteboard.trial.v1'),false);
 assert.equal(isStorageKey('siyue.account.space.siyue.whiteboard.boards.v1'),false);
});
