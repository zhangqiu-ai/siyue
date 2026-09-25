import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {nativeWorkspaceFixture} from './native-workspace-fixture.mjs';
const fixture=await nativeWorkspaceFixture();
const {createNativeClientResource}=fixture;
test.after(fixture.cleanup);
test('native workspace resource isolates files, cancels retired client and preserves reopened content',async()=>{
 const aId=randomUUID(),bId=randomUUID();
 const aOptions={databaseName:'a.db',pendingDatabaseName:'a-pending.db',spaceId:aId};
 const a=await createNativeClientResource(aOptions),b=await createNativeClientResource({databaseName:'b.db',pendingDatabaseName:'b-pending.db',spaceId:bId});
 try{
  await a.client.saveManual({title:'A private',projectTitles:['A project'],taskTitles:[]});
  assert.equal((await a.client.snapshot()).goals[0].spaceId,aId);assert.equal((await b.client.snapshot()).goals.length,0);
  await Promise.all([a.close(),a.close()]);await assert.rejects(a.client.snapshot(),error=>error.code==='cancelled');
  await assert.rejects(createNativeClientResource({...aOptions,spaceId:randomUUID()}),error=>error.code==='corrupt_data');
  const restored=await createNativeClientResource(aOptions);try{assert.equal((await restored.client.snapshot()).goals[0].title,'A private');}finally{await restored.close();}
 }finally{await a.close();await b.close();}
});
test('native retirement drains pending operations and refuses late writes',async()=>{
 const life=new AbortController();const resource=await createNativeClientResource({databaseName:'retiring.db',pendingDatabaseName:'retiring-pending.db',lifetimeSignal:life.signal});
 const read=resource.client.snapshot();life.abort();await resource.close();await assert.rejects(read,error=>error.code==='cancelled');
 await assert.rejects(resource.client.saveManual({title:'Late',projectTitles:[],taskTitles:[]}),error=>error.code==='cancelled');
});
test('invalid native namespace inputs cannot open arbitrary files',async()=>{
 await assert.rejects(createNativeClientResource({databaseName:'../escape.db'}));
 await assert.rejects(createNativeClientResource({databaseName:'same.db',pendingDatabaseName:'same.db'}));
 await assert.rejects(createNativeClientResource({spaceId:'../escape'}));
});
