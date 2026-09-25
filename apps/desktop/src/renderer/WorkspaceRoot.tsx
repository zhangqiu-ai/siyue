import {useEffect,useState,useSyncExternalStore} from 'react';
import {App} from './App';
import {useLocale} from './i18n';
import {workspaceState,subscribeWorkspace,workspaceCommand,workspaceKey} from './workspace';
export function WorkspaceRoot(){
 const state=useSyncExternalStore(subscribeWorkspace,workspaceState),{locale}=useLocale();
 const [ready,setReady]=useState(state.status==='ready'?state:null);
 useEffect(()=>{if(state.status==='ready')setReady(state);},[state]);
 const pending=state.status!=='ready'||ready?.revision!==state.revision;
 return <>{ready&&<div data-testid="workspace-content" data-workspace-revision={ready.revision} style={{visibility:pending?'hidden':'visible'}} inert={pending}><App key={workspaceKey(ready)} workspaceRevision={ready.revision}/></div>}{pending&&<main role="status"><p>{state.status==='unavailable'?(locale==='en'?'Unable to open this workspace. Your saved content is preserved.':'无法打开当前空间，已保存的内容仍保留。'):(locale==='en'?'Opening workspace…':'正在打开空间…')}</p>{state.status==='unavailable'&&<button onClick={()=>void workspaceCommand('retry').catch(()=>undefined)}>{locale==='en'?'Retry':'重试'}</button>}</main>}</>;
}
