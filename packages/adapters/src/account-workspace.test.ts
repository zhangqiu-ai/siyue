import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AuthClientState} from '@siyue/contracts';
import type {LocalClient} from './local-client.js';
import {createAccountWorkspace} from './account-workspace.js';
import {createAccountSpaceCatalog} from './account-space-catalog.js';
import {openNodeConnection} from './node.js';
import {randomUUID} from 'node:crypto';

test('a failed resource close retains the original and prevents replacement until retry succeeds',async()=>{
 const auth:AuthClientState={status:'anonymous',generation:0,session:null,account:null,error:null,pendingRevocations:0};
 const catalog=createAccountSpaceCatalog(openNodeConnection(':memory:'),randomUUID);
 let opens=0,closes=0,fail=true;const signals:AbortSignal[]=[];
 const workspace=createAccountWorkspace({auth:{getState:()=>auth,subscribe:()=>()=>{}},environment:'test',catalog,open:async(_scope,signal)=>{
  opens++;signals.push(signal);return {client:{} as LocalClient,close:async()=>{closes++;if(fail)throw Error('close failed');}};
 }});
 try{
  await workspace.start();assert.equal(opens,1);await workspace.retry();
  assert.equal(workspace.getState().status,'unavailable');assert.equal(opens,1);assert.equal(signals[0]?.aborted,true);
  assert.throws(()=>workspace.client(),{code:'cancelled'});
  fail=false;await workspace.retry();assert.equal(workspace.getState().status,'ready');assert.equal(opens,2);assert.equal(closes,2);
 }finally{fail=false;await workspace.dispose();await catalog.close();}
});

test('expired adult authentication locks the account workspace but retains local login recovery',async()=>{
 const subjectId=randomUUID(),catalog=createAccountSpaceCatalog(openNodeConnection(':memory:'),randomUUID);
 await catalog.create('test',subjectId);
 const auth:AuthClientState={status:'authenticated',generation:1,session:null,account:{subjectId,subjectKind:'adult',sessionId:randomUUID()},error:null,pendingRevocations:0};
 const opened:string[]=[];const workspace=createAccountWorkspace({auth:{getState:()=>auth,subscribe:()=>()=>{}},environment:'test',catalog,open:async(scope)=>{opened.push(scope.kind);return {client:{} as LocalClient,close:async()=>{}};}});
 try{await workspace.start();assert.equal(workspace.getState().scope?.kind,'account');
  auth.status='reauth-required';auth.error='reauth_required';await workspace.retry();
  assert.equal(workspace.getState().status,'ready');assert.equal(workspace.getState().scope?.kind,'local');assert.equal(workspace.getState().canCreate,false);assert.deepEqual(opened,['account','local']);
  auth.status='authenticated';auth.error=null;await workspace.retry();assert.equal(workspace.getState().scope?.kind,'account');
  auth.status='reauth-required';auth.account={...auth.account!,subjectKind:'child'};await workspace.retry();assert.equal(workspace.getState().status,'unavailable');
 }finally{await workspace.dispose();await catalog.close();}
});

test('cold startup does not open the unowned workspace before authentication resolves',async()=>{
 const subjectId=randomUUID(),catalog=createAccountSpaceCatalog(openNodeConnection(':memory:'),randomUUID);
 await catalog.create('test',subjectId);
 const auth:AuthClientState={status:'bootstrapping',generation:1,session:null,account:null,error:null,pendingRevocations:0};
 let notify=()=>{};const opened:string[]=[];
 const workspace=createAccountWorkspace({auth:{getState:()=>auth,subscribe(fn){notify=fn;return()=>{};}},environment:'test',catalog,open:async(scope)=>{opened.push(scope.kind);return {client:{} as LocalClient,close:async()=>{}};}});
 try{
  await workspace.start();assert.equal(workspace.getState().status,'loading');assert.deepEqual(opened,[]);assert.throws(()=>workspace.client(),{code:'cancelled'});
  auth.status='refreshing';auth.account={subjectId,subjectKind:'adult',sessionId:randomUUID()};notify();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(workspace.getState().status,'loading');assert.deepEqual(opened,[]);
  auth.status='authenticated';notify();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(workspace.getState().scope?.kind,'account');assert.deepEqual(opened,['account']);
  auth.generation++;auth.status='bootstrapping';auth.account=null;notify();await new Promise(resolve=>setImmediate(resolve));assert.equal(workspace.getState().status,'loading');assert.deepEqual(opened,['account']);
  auth.status='anonymous';notify();await new Promise(resolve=>setImmediate(resolve));assert.equal(workspace.getState().scope?.kind,'local');assert.deepEqual(opened,['account','local']);
 }finally{await workspace.dispose();await catalog.close();}
});

test('a faulted unauthenticated bootstrap never retires an already ready local workspace',async()=>{
 const subjectId=randomUUID(),catalog=createAccountSpaceCatalog(openNodeConnection(':memory:'),randomUUID);
 const auth:AuthClientState={status:'authenticated',generation:0,session:null,account:{subjectId,subjectKind:'adult',sessionId:randomUUID()},error:null,pendingRevocations:0};
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 let notify=()=>{},fail=true,closes=0;const opened:string[]=[],local={} as LocalClient,account={} as LocalClient;
 const workspace=createAccountWorkspace({auth:{getState:()=>auth,subscribe(fn){notify=fn;return()=>{};}},environment:'test',catalog,
  open:async(scope)=>{opened.push(scope.kind);return {client:scope.kind==='account'?account:local,close:async()=>{closes++;if(fail)throw Error('whiteboard_save_failed');}};}});
 try{
  await workspace.start();const revision=workspace.getState().revision;
  assert.equal(workspace.getState().status,'ready');assert.equal(workspace.getState().scope?.kind,'local');assert.equal(workspace.getState().canCreate,true);
  // AppState active runs a faulted, unauthenticated bootstrap: the generation moves and no subject is usable.
  auth.status='bootstrapping';auth.generation=1;auth.account=null;notify();await settle();
  auth.status='secure-storage-unavailable';auth.error='storage_unavailable';notify();await settle();
  auth.status='anonymous';auth.generation=2;notify();await settle();
  assert.equal(workspace.getState().status,'ready');assert.equal(workspace.getState().revision,revision);
  assert.equal(workspace.getState().scope?.kind,'local');assert.equal(workspace.getState().canCreate,false);
  assert.equal(workspace.client(),local);assert.deepEqual(opened,['local']);assert.equal(closes,0);
  // The coordinator is not frozen: a bound adult identity still retires local and opens the account space.
  await catalog.create('test',subjectId);fail=false;
  auth.status='authenticated';auth.account={subjectId,subjectKind:'adult',sessionId:randomUUID()};notify();await settle();
  assert.equal(workspace.getState().status,'ready');assert.equal(workspace.getState().scope?.kind,'account');
  assert.deepEqual(opened,['local','account']);assert.equal(closes,1);assert.equal(workspace.client(),account);
 }finally{fail=false;await workspace.dispose();await catalog.close();}
});
