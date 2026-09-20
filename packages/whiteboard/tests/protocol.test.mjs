import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createService,emptyBoard,KEY} from '../src/protocol.ts';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=';
function setup(initial=null,pick=async()=>({cancelled:true})) {
 let raw=initial,fail=false;
 const storage={getItemSync:key=>key===KEY?raw:null,setItemSync:(_,value)=>{if(fail)throw Error('disk full');raw=value;}};
 const service=createService(storage,'session',pick);
 const call=async(op,payload,requestId=crypto.randomUUID(),session='session')=>JSON.parse(await service.request(JSON.stringify({version:1,session,requestId,op,payload})));
 return {call,service,raw:()=>raw,fail:value=>{fail=value;}};
}
const payload=()=>({baseRevision:0,pages:emptyBoard().pages,files:{}});
test('load required; request identity and revision checks prevent stale overwrites',async()=>{
 const s=setup();assert.equal((await s.call('save',payload())).ok,false);await s.call('load');
 const reply=await s.call('save',payload(),'save-1');assert.equal(reply.ok,true);const original=s.raw();
 assert.deepEqual(await s.call('save',payload(),'save-1'),reply);assert.equal(s.raw(),original);
 assert.equal((await s.call('save',{...payload(),baseRevision:1},'save-1')).error,'request_conflict');
 assert.equal((await s.call('save',payload(),'late')).error,'revision_conflict');assert.equal(s.raw(),original);
 assert.equal((await s.call('save',{...payload(),baseRevision:1},'other','wrong')).error,'stale_session');
});
test('corrupt and future records never turn into blank boards or get overwritten',async()=>{
 for(const original of ['{broken',JSON.stringify({...emptyBoard(),schemaVersion:3})]) {
  const s=setup(original);assert.equal((await s.call('load')).ok,false);assert.equal((await s.call('save',payload())).ok,false);assert.equal(s.raw(),original);
 }
});
test('write failure preserves original, valid retry succeeds',async()=>{
 const original=JSON.stringify(emptyBoard()),s=setup(original);await s.call('load');s.fail(true);
 assert.equal((await s.call('save',payload())).ok,false);assert.equal(s.raw(),original);
 s.fail(false);assert.equal((await s.call('save',payload())).ok,true);assert.equal(JSON.parse(s.raw()).revision,1);
});
test('complete image bytes survive delta-only subsequent saves; missing and unsafe images rejected',async()=>{
 const s=setup();await s.call('load');
 const image={id:'image-1',type:'image',fileId:'file-1',x:0,y:0,width:100,height:100,angle:0,version:1,link:null};
 const p=payload();p.pages[0].elements=[image];
 assert.equal((await s.call('save',p)).error,'missing_image');assert.equal(s.raw(),null);
 p.files={'file-1':{id:'file-1',created:1,mimeType:'image/png',dataURL:png}};
 assert.equal((await s.call('save',p)).ok,true);
 assert.equal((await s.call('save',{...p,baseRevision:1,files:{}})).ok,true);
 const raw=s.raw();assert.equal(JSON.parse(raw).files['file-1'].dataURL,png);
 assert.equal((await s.call('save',{...p,baseRevision:2,files:{'file-1':{...p.files['file-1'],dataURL:'data:image/svg+xml;base64,PHN2Zz4='}}})).ok,false);assert.equal(s.raw(),raw);
 const withoutImage={...payload(),baseRevision:2};assert.equal((await s.call('save',withoutImage)).ok,true);assert.deepEqual(JSON.parse(s.raw()).files,{});
});
test('closing context rejects late native result and prevents further saves',async()=>{
 let resolve;const s=setup(null,()=>new Promise(r=>{resolve=r;}));await s.call('load');
 const pending=s.call('pick',{source:'library'});s.service.dispose();resolve({cancelled:true});
 assert.equal((await pending).error,'stale_session');assert.equal((await s.call('save',payload())).error,'stale_session');assert.equal(s.raw(),null);
});

test('obsolete development archive is never read and conversion is no longer an allowed operation',async()=>{
 const reads=[];
 const service=createService({getItemSync:key=>{reads.push(key);return key===KEY?null:'{obsolete development data';},setItemSync:()=>{}},'session',async()=>({cancelled:true}));
 const call=async op=>JSON.parse(await service.request(JSON.stringify({version:1,session:'session',requestId:crypto.randomUUID(),op})));
 assert.deepEqual((await call('load')).value,{board:null});assert.deepEqual(reads,[KEY]);
 assert.equal((await call('legacy')).error,'unsupported_operation');
});
