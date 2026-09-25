import type {AuthClientState,AuthEnvironment,AccountSpaceBinding} from '@siyue/contracts';
import type {LocalClient} from './local-client.js';
import type {createAccountSpaceCatalog} from './account-space-catalog.js';

export type WorkspaceScope={kind:'local'}|({kind:'account'}&AccountSpaceBinding);
export type WorkspaceState={revision:number;status:'loading'|'ready'|'unavailable';scope:WorkspaceScope|null;canCreate:boolean};
type Resource={client:LocalClient;close():Promise<void>};
type AuthSource={getState():AuthClientState;subscribe(listener:()=>void):()=>void};
const cancelled=()=>Object.assign(new Error('Workspace selection changed'),{code:'cancelled'});

/** Host coordinator: the auth source is trusted; UI cannot nominate a subject or filename.
 * Factory must bind every client operation to the supplied lifetime signal and fixed scope.
 * Existing local content is never adopted. Explicit creation allocates a separate account space.
 */
export function createAccountWorkspace(options:{auth:AuthSource;environment:AuthEnvironment;catalog:ReturnType<typeof createAccountSpaceCatalog>;
  open(scope:WorkspaceScope,lifetime:AbortSignal):Promise<Resource>}){
  let settledGeneration:number|undefined;
  let revision=0,key='',disposed=false,resource:Resource|undefined,lifetime=new AbortController();
  let tail:Promise<unknown>=Promise.resolve(),flight:Promise<void>=Promise.resolve();
  let state:WorkspaceState={revision,status:'loading',scope:null,canCreate:false};
  const retired:Resource[]=[];
  async function closeRetired(){while(retired.length){await retired[0]!.close();retired.shift();}}
  const listeners=new Set<()=>void>();
  const publish=(next:WorkspaceState)=>{if(disposed)return;state=next;for(const listener of listeners)listener();};
  function identity(){
    const auth=options.auth.getState();
    const usable=['authenticated','offline-available','refreshing'].includes(auth.status)&&auth.account?.subjectKind==='adult';
    const subject=usable?auth.account!.subjectId:null;
    // An expired adult session must not trap the login screen behind the private-space gate.
    // Original unowned local content remains available; the account namespace stays closed.
    const loginRecovery=auth.status==='reauth-required'&&auth.account?.subjectKind==='adult';
    const blocked=auth.account!==null&&!usable&&!loginRecovery;
    if(auth.status==='authenticated'||auth.status==='offline-available')settledGeneration=auth.generation;
    const pending=auth.status==='bootstrapping'||(auth.status==='refreshing'&&settledGeneration!==auth.generation);
    return {auth,subject,blocked,pending,key:JSON.stringify([auth.generation,subject,blocked,pending])};
  }
  /** A ready local resource outlives auth churn that yields no usable subject and no blocked account: the
   *  unowned local data is still the right workspace, so generation bumps and pending retries must not
   *  retire it. Cold bootstrap, account scopes and blocked accounts still resolve through refresh. */
  const holdsLocalResource=(own:ReturnType<typeof identity>)=>state.status==='ready'&&state.scope?.kind==='local'&&own.subject===null&&own.auth.account===null&&!own.blocked;
  function refresh(force=false):Promise<void>{
    if(disposed)return Promise.reject(cancelled());
    const own=identity();if(!force&&(key===own.key||holdsLocalResource(own))){
      const canCreate=state.status==='ready'&&state.scope?.kind==='local'&&own.subject!==null&&own.auth.status==='authenticated';
      if(canCreate!==state.canCreate)publish({...state,canCreate});return flight;
    }
    key=own.key;const epoch=++revision;lifetime.abort();lifetime=new AbortController();const signal=lifetime.signal;
    if(resource)retired.push(resource);resource=undefined;
    publish({revision:epoch,status:'loading',scope:null,canCreate:false});
    const work=tail.then(async()=>{
      await closeRetired();
      if(disposed||epoch!==revision)return;
      if(own.pending)return;
      if(own.blocked){publish({revision:epoch,status:'unavailable',scope:null,canCreate:false});return;}
      const binding=own.subject?await options.catalog.find(options.environment,own.subject):null;
      if(disposed||epoch!==revision)return;
      const scope:WorkspaceScope=binding?{kind:'account',...binding}:{kind:'local'};
      const opened=await options.open(scope,signal);
      if(disposed||epoch!==revision){retired.push(opened);await closeRetired();return;}
      resource=opened;publish({revision:epoch,status:'ready',scope,canCreate:own.subject!==null&&!binding&&own.auth.status==='authenticated'});
    }).catch(()=>{if(!disposed&&epoch===revision)publish({revision:epoch,status:'unavailable',scope:null,canCreate:false});});
    tail=work;flight=work;return work;
  }
  const unsubscribe=options.auth.subscribe(()=>{void refresh();});
  return {
    getState:()=>state,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    // Starting subscribes and returns even while credentials are loading; hosts can then bootstrap auth.
    start:()=>refresh(true),
    retry:()=>refresh(true),
    client(){if(disposed||state.status!=='ready'||!resource)throw cancelled();return resource.client;},
    async createAccountSpace(expectedGeneration:number){
      const own=identity();
      if(disposed||own.auth.generation!==expectedGeneration||own.auth.status!=='authenticated'||!own.subject)throw cancelled();
      await options.catalog.create(options.environment,own.subject);
      if(disposed||identity().key!==own.key)throw cancelled();
      await refresh(true);
      if(disposed||identity().key!==own.key||state.status!=='ready'||state.scope?.kind!=='account')throw cancelled();
      return state;
    },
    async dispose(){
      if(!disposed){disposed=true;revision++;lifetime.abort();unsubscribe();listeners.clear();if(resource)retired.push(resource);resource=undefined;}
      const closing=tail.then(closeRetired);tail=closing.catch(()=>undefined);await closing;
    },
  };
}
