/** Scope-keyed edit buffers and the "unsubmitted input" registry they drive.
 * Process-local only: never restored into a different account, never a crash-safety promise.
 * Kept React-free so the host, the screens and node tests can read the same state. */
const buffers=new Map<string,unknown>();
/** Tracked buffer fields: a non-empty value means this space still holds unsubmitted input. */
const pendingFields:Record<string,(value:unknown)=>boolean>={
 'create.goal':value=>typeof value==='string'&&value.trim()!=='',
 'create.project':value=>typeof value==='string'&&value.trim()!=='',
 'create.unknown':value=>value===true,
};
const fieldNames=Object.keys(pendingFields),listeners=new Set<()=>void>();
export function readWorkspaceBuffer<T>(key:string,initial:T):T{return buffers.has(key)?buffers.get(key) as T:initial;}
export function writeWorkspaceBuffer(key:string,name:string,value:unknown){
 buffers.set(key,value);
 if(pendingFields[name])for(const listener of listeners)listener();
}
export function ensureWorkspaceBuffer<T>(key:string,name:string,initial:T):T{
 if(!buffers.has(key))writeWorkspaceBuffer(key,name,initial);
 return buffers.get(key) as T;
}
export function hasPendingWorkspaceInput(scope:string):boolean{
 for(const name of fieldNames){const tracked=pendingFields[name];if(tracked&&tracked(buffers.get(`${scope}:${name}`)))return true;}
 return false;
}
export function subscribeWorkspacePending(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
/** The space a completed switch must not drop silently: its unsubmitted input stays in the buffers. */
export function retainedScopeOnSwitch(previous:string|null,current:string):string|null{
 return previous!==null&&previous!==current&&hasPendingWorkspaceInput(previous)?previous:null;
}
