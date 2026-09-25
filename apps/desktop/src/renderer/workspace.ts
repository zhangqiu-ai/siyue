import {workspaceStateSchema} from '@siyue/contracts';
import type {WorkspaceState} from '@siyue/adapters';
type Bridge={workspace(message:{op:string;generation?:number}):Promise<unknown>;onWorkspaceState(callback:(value:unknown)=>void):()=>void};
const bridge=typeof window==='undefined'?undefined:(window as unknown as {siyueDesktop?:Bridge}).siyueDesktop;
let state:WorkspaceState={revision:0,status:'loading',scope:null,canCreate:false},events=0;
const listeners=new Set<()=>void>();
function receive(value:unknown){const parsed=workspaceStateSchema.safeParse(value);if(parsed.success&&parsed.data.revision>=state.revision){state=parsed.data;listeners.forEach(fn=>fn());}}
bridge?.onWorkspaceState(value=>{events++;receive(value);});
export async function workspaceCommand(op='state',generation?:number){
 const before=events,result=await bridge?.workspace({op,...(generation===undefined?{}:{generation})});
 if(!result||typeof result!=='object'||!('ok'in result)||result.ok!==true||!('value'in result))throw Error('unavailable');
 if(events===before)receive(result.value);
}
export const workspaceState=()=>state;
export const subscribeWorkspace=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
export function workspaceKey(value=state){return value.scope?.kind==='account'?`${value.scope.environment}.${value.scope.namespace}`:'local';}
export const workspaceReady=workspaceCommand().catch(()=>{state={...state,status:'unavailable'};listeners.forEach(fn=>fn());});
