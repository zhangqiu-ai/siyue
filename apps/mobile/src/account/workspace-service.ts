import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import {createAccountSpaceCatalog,createAccountWorkspace,type AuthController} from '@siyue/adapters';
import type {AuthEnvironment} from '@siyue/contracts';
import {MAX_MESSAGE} from '@siyue/whiteboard';
import {createNativeClientResource,wrapNativeConnection} from '../native-client';
import {nativeBoardService} from '../whiteboard/native-service';
import {createWorkspaceEditors} from './workspace-editors';

/** Native host only. Subjects and namespaces originate from verified auth and the local catalog. */
export async function openMobileWorkspace(auth:Pick<AuthController,'getState'|'subscribe'>,environment:AuthEnvironment){
 const catalog=createAccountSpaceCatalog(wrapNativeConnection(await SQLite.openDatabaseAsync('siyue-account-spaces.db')),Crypto.randomUUID);
 type BoardService=ReturnType<typeof nativeBoardService>;
 let current:{revision:number;signal:AbortSignal;boards:Map<string,BoardService>;editors:ReturnType<typeof createWorkspaceEditors>;namespace?:string}|undefined;
 const manager=createAccountWorkspace({auth,environment,catalog,open:async(scope,signal)=>{
  const revision=manager.getState().revision;
  const native=await createNativeClientResource({...scope.kind==='account'?{databaseName:`account-${scope.namespace}.db`,pendingDatabaseName:`account-${scope.namespace}-pending.db`,spaceId:scope.spaceId}:{},lifetimeSignal:signal});
  const resource={revision,signal,boards:new Map<string,BoardService>(),editors:createWorkspaceEditors(),...(scope.kind==='account'?{namespace:scope.namespace}:{})};
  if(!signal.aborted)current=resource;
  return {client:native.client,close:async()=>{
   if(!await resource.editors.flush())throw Error('whiteboard_save_failed');
   for(const board of resource.boards.values())board.dispose();resource.boards.clear();
   await native.close();if(current===resource)current=undefined;
  }};
 }});
 await manager.start();
 return {...manager,
  board(session:string){
   const resource=current;
   if(!resource||manager.getState().status!=='ready'||resource.revision!==manager.getState().revision)throw Error('workspace_unavailable');
   if(resource.boards.has(session))throw Error('duplicate_session');
   const board=nativeBoardService(session,{...(resource.namespace?{namespace:resource.namespace}:{}),lifetimeSignal:resource.signal});resource.boards.set(session,board);
   return {
    registerEditor:(request:(token:number)=>void)=>resource.editors.register(session,request),
    async request(message:string){
     // The retired DOM can finish its last save into its original namespace only.
     if(resource.signal.aborted){let save=false;try{save=typeof message==='string'&&message.length<=MAX_MESSAGE&&JSON.parse(message).op==='save';}catch{}
      if(!save)throw Error('stale_session');
     }
     return board.request(message);
    },
    dispose(){board.dispose();resource.boards.delete(session);},
   };
  },
  async dispose(){await manager.dispose();await catalog.close();},
 };
}
export type MobileWorkspace=Awaited<ReturnType<typeof openMobileWorkspace>>;
