import {test,expect} from 'playwright/test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createCommandService,createRunService} from '../../packages/domain/dist/index.js';
import {createAccountSpaceCatalog,createAccountWorkspace,createLocalClient,createAuthApiClient,createAuthController} from '../../packages/adapters/dist/index.js';
import {openNodeConnection,openNodeStore} from '../../packages/adapters/dist/node.js';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture,password} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';

test('real account sessions select durable isolated SQLite spaces; guest is not adopted and late old reads are discarded',async({},info)=>{
 const db=await startPostgresFixture(),fx=await createEmailFixture(db);
 const server=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});
 const address=await server.listen({host:'127.0.0.1',port:0});
 await fx.register('space-a@example.test');await fx.register('space-b@example.test');
 const directory=info.outputPath('isolated-spaces');await mkdir(directory,{recursive:true});
 let vaultData=null;const vault={read:async()=>vaultData,write:async value=>{vaultData=value;}};
 const openedScopes=[];
 let host,catalog,workspace,holdRead=false,releaseRead,readEntered;
 const entered=new Promise(resolve=>{readEntered=resolve;});
 function setup(){
  host=createAuthController({api:createAuthApiClient({environment:'test',apiBaseUrl:address+'/v1',fetcher:fetch}),vault,newId:randomUUID,now:()=>+fx.clock()});
  catalog=createAccountSpaceCatalog(openNodeConnection(path.join(directory,'catalog.sqlite')),randomUUID);
  workspace=createAccountWorkspace({auth:host,environment:'test',catalog,open:async(scope,lifetimeSignal)=>{
   openedScopes.push(scope.kind);
   const store=openNodeStore(path.join(directory,(scope.kind==='account'?scope.namespace:'guest')+'.sqlite'));
   try{
    const {spaceId,actorId}=await store.initialize('local-owner',scope.kind==='account'?scope.spaceId:randomUUID());
    const base=createCommandService({store,now:()=>fx.clock().toISOString(),newId:randomUUID,hash:text=>createHash('sha256').update(text).digest('hex')});
    const service={...base,listPlan:async(...args)=>{const result=await base.listPlan(...args);if(holdRead){holdRead=false;readEntered();await new Promise(resolve=>{releaseRead=resolve;});}return result;}};
    return {client:createLocalClient({service,runService:createRunService({store,now:()=>fx.clock().toISOString(),newId:randomUUID}),spaceId,actor:{id:actorId,kind:'user'},now:()=>fx.clock().toISOString(),newId:randomUUID,lifetimeSignal,propose:async()=>{throw Error('not used');}}),close:()=>store.close()};
   }catch(error){await store.close();throw error;}
  }});
 }
 async function ready(){await expect.poll(()=>workspace.getState().status).toBe('ready');}
 const save=title=>workspace.client().saveManual({title,projectTitles:['Project'],taskTitles:[]});
 try{
  setup();await host.bootstrap();await workspace.start();await save('Guest original');
  await host.login({email:'space-a@example.test',password,platform:'desktop'});await ready();
  expect(workspace.getState().scope.kind).toBe('local');expect(workspace.getState().canCreate).toBe(true);
  await workspace.createAccountSpace(host.getState().generation);const a=workspace.getState().scope;
  expect(a.kind).toBe('account');expect((await workspace.client().snapshot()).goals).toHaveLength(0);
  await save('Account A private');const old=workspace.client();holdRead=true;
  const late=old.snapshot().then(()=>({leaked:true}),error=>({code:error.code}));await entered;
  await host.login({email:'space-b@example.test',password,platform:'desktop'});await ready();
  expect((await workspace.client().snapshot()).goals.map(x=>x.title)).toEqual(['Guest original']);
  releaseRead();expect(await late).toEqual({code:'cancelled'});
  await expect(old.snapshot()).rejects.toMatchObject({code:'cancelled'});
  await workspace.createAccountSpace(host.getState().generation);const b=workspace.getState().scope;
  expect(b.namespace).not.toBe(a.namespace);expect(b.spaceId).not.toBe(a.spaceId);
  expect((await workspace.client().snapshot()).goals).toHaveLength(0);await save('Account B private');
  await workspace.dispose();await host.dispose();await catalog.close();setup();
  openedScopes.length=0;await workspace.start();expect(workspace.getState().status).toBe('loading');expect(openedScopes).toEqual([]);
  await host.bootstrap();await ready();expect(openedScopes).toEqual(['account']);expect(workspace.getState().scope.namespace).toBe(b.namespace);
  expect((await workspace.client().snapshot()).goals.map(x=>x.title)).toEqual(['Account B private']);
  await host.logout();await ready();expect((await workspace.client().snapshot()).goals.map(x=>x.title)).toEqual(['Guest original']);
  await host.login({email:'space-a@example.test',password,platform:'desktop'});await ready();
  expect(workspace.getState().scope.namespace).toBe(a.namespace);
  expect((await workspace.client().snapshot()).goals.map(x=>x.title)).toEqual(['Account A private']);
 }finally{releaseRead?.();await workspace?.dispose();await host?.dispose();await catalog?.close();await server.close();await db.stop();}
});
