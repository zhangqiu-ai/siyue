import path from 'node:path';
import {MAX_MESSAGE} from '@siyue/whiteboard';
import {mkdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {createAccountSpaceCatalog,createAccountWorkspace,createLocalClient} from '@siyue/adapters';
import {openNodeConnection,openNodeStore} from '@siyue/adapters/node';
import {createCommandService,createRunService} from '@siyue/domain';
import {MockAgentExecutor} from '@siyue/ai';
import {openWhiteboard} from './whiteboard.mjs';
import {isTrustedSender} from './ipc.mjs';

export async function openDesktopWorkspace({auth,environment,directory,windows,closeBoard,rendererUrl}){
 await mkdir(path.join(directory,'account-spaces'),{recursive:true});
 const catalog=createAccountSpaceCatalog(openNodeConnection(path.join(directory,'account-spaces','catalog.sqlite')),randomUUID);
 let boardResource;
 const now=()=>new Date().toISOString();
 const workspace=createAccountWorkspace({auth,environment,catalog,open:async(scope,lifetimeSignal)=>{
  const revision=workspace.getState().revision;
  const folder=scope.kind==='local'?directory:path.join(directory,'account-spaces',scope.namespace);
  await mkdir(folder,{recursive:true});
  const store=openNodeStore(path.join(folder,'siyue-m1-local.sqlite'));let board;
  try{
   const {spaceId,actorId}=await store.initialize('local-owner',scope.kind==='account'?scope.spaceId:randomUUID());
   if(scope.kind==='account'&&spaceId!==scope.spaceId)throw Error('workspace_identity_mismatch');
   const service=createCommandService({store,now,newId:randomUUID,hash:text=>createHash('sha256').update(text).digest('hex')});
   const runService=createRunService({store,now,newId:randomUUID}),actor={id:actorId,kind:'user'};
   await runService.recover(spaceId,actor);
   board=openWhiteboard(path.join(folder,'siyue-whiteboard.sqlite'));
   const resource={board,revision,closed:false,boardClosed:false};if(!lifetimeSignal.aborted)boardResource=resource;
   const mock=new MockAgentExecutor();
   return {client:createLocalClient({service,runService,spaceId,actor,now,newId:randomUUID,lifetimeSignal,
    propose:(goal,signal)=>mock.createGoalPlan(goal,{runId:randomUUID(),spaceId,signal})}),
    close:async()=>{
     if(resource.closed)return;
     if(boardResource===resource){
      const results=await Promise.all(windows().map(win=>closeBoard.request(win)));
      if(results.some(ok=>!ok))throw Error('whiteboard_save_failed');
     }
     if(!resource.boardClosed){board.close();resource.boardClosed=true;}await store.close();resource.closed=true;if(boardResource===resource)boardResource=undefined;
    }};
 }catch(error){board?.close();await store.close();throw error;}
 }});
 const stop=workspace.subscribe(()=>{for(const win of windows())if(!win.isDestroyed()&&win.webContents.getURL()===rendererUrl)win.webContents.send('siyue:workspace-state',workspace.getState());});
 await workspace.start();
 return {
  ...workspace,
  async command(event,message,win){
   if(!win||!isTrustedSender(event,win.webContents,rendererUrl)||!message||typeof message!=='object'||Array.isArray(message))return {ok:false,error:'forbidden'};
   try{
    if(message.op==='state'&&Object.keys(message).length===1)return {ok:true,value:workspace.getState()};
    if(message.op==='retry'&&Object.keys(message).length===1){await workspace.retry();return {ok:true,value:workspace.getState()};}
    if(message.op==='create'&&Object.keys(message).length===2&&Number.isSafeInteger(message.generation))return {ok:true,value:await workspace.createAccountSpace(message.generation)};
    return {ok:false,error:'invalid_request'};
   }catch{return {ok:false,error:'unavailable'};}
  },
  whiteboard(event,message,revision,win){
   const resource=boardResource,state=workspace.getState();
   let saving=false;try{saving=typeof message==='string'&&message.length<=MAX_MESSAGE&&JSON.parse(message).op==='save';}catch{}
   // During retirement only the old editor's final save may reach its original file.
   if(!resource||revision!==resource.revision||(state.status!=='ready'&&!saving))return Promise.resolve(JSON.stringify({version:1,requestId:'',ok:false,error:'stale_session'}));
   return resource.board.handle(event,message,win,rendererUrl);
  },
  disposeWindow:id=>boardResource?.board.disposeWindow(id),
  async dispose(){stop();await workspace.dispose();await catalog.close();},
 };
}
