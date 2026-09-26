import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emptyBoard,INDEX_KEY,boardKey} from '@siyue/whiteboard';
import {nativeWorkspaceFixture} from './native-workspace-fixture.mjs';
const fixture=await nativeWorkspaceFixture();test.after(fixture.cleanup);
test('mobile host switches isolated business and board namespaces only after a successful editor flush',async()=>{
 let state={status:'anonymous',generation:0,account:null};const listeners=new Set();
 const auth={getState:()=>state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
 const host=await fixture.openMobileWorkspace(auth,'test');let editor;
 const change=async(subject)=>{state={status:subject?'authenticated':'anonymous',generation:state.generation+1,account:subject?{subjectId:subject,subjectKind:'adult'}:null};listeners.forEach(fn=>fn());await host.retry();};
 async function request(board,session,op,payload){return JSON.parse(await board.request(JSON.stringify({version:1,session,requestId:randomUUID(),op,...(payload?{payload}:{})})));}
 try{
  await host.client().saveManual({title:'Guest',projectTitles:['guest'],taskTitles:[]});
  await change(randomUUID());await host.createAccountSpace(state.generation);const a=host.getState().scope;
  const board=host.board('a');assert.equal((await request(board,'a','list',{defaultTitle:'Previous board'})).ok,true);
  const created=await request(board,'a','create',{title:'House board',start:'blank'});
  assert.equal(created.ok,true);
  const boardId=created.value.summary.id;
  const blank=emptyBoard(boardId);
  assert.equal((await request(board,'a','save',{boardId,baseRevision:0,pages:blank.pages,files:{}})).ok,true);
  assert.equal(fixture.kv.has(INDEX_KEY),false);
  assert.ok(fixture.kv.has(`siyue.account.${a.namespace}.${INDEX_KEY}`));
  assert.ok(fixture.kv.has(`siyue.account.${a.namespace}.${boardKey(boardId)}`));
  let good=false;editor=board.registerEditor(token=>queueMicrotask(()=>editor.finish(token,good)));
  const old=host.client();await change(randomUUID());assert.equal(host.getState().status,'unavailable');
  await assert.rejects(old.snapshot(),error=>error.code==='cancelled');await assert.rejects(board.request(JSON.stringify({op:'load'})),/stale_session/);
  good=true;await host.retry();await host.createAccountSpace(state.generation);assert.notEqual(host.getState().scope.namespace,a.namespace);
  assert.deepEqual((await host.client().snapshot()).goals,[]);const b=host.board('b');
  assert.deepEqual((await request(b,'b','list',{defaultTitle:'Previous board'})).value.boards,[]);b.dispose();
  await change(null);assert.equal((await host.client().snapshot()).goals[0].title,'Guest');
 }finally{editor?.dispose();await host.dispose();}
});
test('mobile runtime captures the calling workspace before promise continuation',async()=>{
 const auth={getState:()=>({status:'anonymous',generation:0,account:null}),subscribe:()=>()=>{}};
 const host=await fixture.configureWorkspace(auth,'test');
 assert.throws(()=>fixture.configureWorkspace(auth,'production'),/already configured/);
 try{
  const previous=host.client(),capture=fixture.configuredClient();
  const switching=host.retry();
  assert.equal(await capture,previous);
  await switching;assert.notEqual(host.client(),previous);
  await assert.rejects(previous.snapshot(),error=>error.code==='cancelled');
 }finally{await host.dispose();}
});
