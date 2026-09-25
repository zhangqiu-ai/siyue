import type {AuthController,LocalClient} from '@siyue/adapters';
import type {AuthEnvironment} from '@siyue/contracts';
import {openMobileWorkspace,type MobileWorkspace} from './workspace-service';
let configured:Promise<MobileWorkspace>|undefined;
type AuthSource=Pick<AuthController,'getState'|'subscribe'>;
let owner:AuthSource|undefined;
let active:MobileWorkspace|undefined;
let ownerEnvironment:AuthEnvironment|undefined;
/** One app host owns one auth source. Test apps without this provider keep their isolated legacy fixture. */
export function configureWorkspace(auth:AuthSource,environment:AuthEnvironment){
 if(owner&&(owner!==auth||ownerEnvironment!==environment))throw Error('Workspace auth source already configured');
 owner=auth;ownerEnvironment=environment;
 configured??=openMobileWorkspace(auth,environment).then(host=>{active=host;return host;}).catch(error=>{configured=undefined;active=undefined;throw error;});
 return configured;
}
export function configuredWorkspace(){return configured??(owner?Promise.reject(new Error('workspace_unavailable')):undefined);}

/** Capture the resource synchronously: a queued promise must never select a later account. */
export function configuredClient():Promise<LocalClient>|undefined{
 if(!owner)return undefined;
 try{if(!active)throw Error('workspace_unavailable');return Promise.resolve(active.client());}
 catch(error){return Promise.reject(error);}
}
