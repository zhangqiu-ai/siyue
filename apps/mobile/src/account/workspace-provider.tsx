import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {View,Text,Pressable} from 'react-native';
import type {AuthClientState,AuthEnvironment} from '@siyue/contracts';
import type {WorkspaceState} from '@siyue/adapters';
import {useAccountAuth} from './auth-provider';
import {configureWorkspace} from './workspace-runtime';
import {hasPendingWorkspaceInput,retainedScopeOnSwitch,subscribeWorkspacePending} from './workspace-pending';
import type {MobileWorkspace} from './workspace-service';
import {useLocale} from '../i18n';
import {useTheme} from '../ui/theme';
const initial:WorkspaceState={revision:0,status:'loading',scope:null,canCreate:false};
const localOnlyAuth={getState:():AuthClientState=>({status:'anonymous',generation:0,session:null,account:null,error:null,pendingRevocations:0}),subscribe:()=>()=>{}};
const Context=createContext<{host:MobileWorkspace|null;state:WorkspaceState}>({host:null,state:initial});
export const useWorkspace=()=>useContext(Context);
export function scopeKey(state:WorkspaceState){return state.scope?.kind==='account'?`${state.scope.environment}.${state.scope.namespace}`:'local';}
export function WorkspaceProvider({children,environment:providedEnvironment}:{children:ReactNode;environment?:AuthEnvironment}){
 const {client}=useAccountAuth(),{locale,t}=useLocale(),theme=useTheme();
 const [host,setHost]=useState<MobileWorkspace|null>(null),[state,setState]=useState(initial),[ready,setReady]=useState<WorkspaceState|null>(null),[attempt,setAttempt]=useState(0);
 const [retained,setRetained]=useState<string|null>(null),departed=useRef<string|null>(null);
 useEffect(()=>{
  let live=true,stop:(()=>void)|undefined;
  const environment=providedEnvironment??(__DEV__&&process.env.EXPO_PUBLIC_SIYUE_AUTH_URL?'development':'production');
  void configureWorkspace(client??localOnlyAuth,environment).then(manager=>{
   if(!live)return;setHost(manager);const update=()=>{const next=manager.getState();setState(next);if(next.status==='ready')setReady(next);};stop=manager.subscribe(update);update();
  }).catch(()=>{if(live)setState({...initial,status:'unavailable'});});
  return()=>{live=false;stop?.();};
 },[client,attempt,providedEnvironment]);
 // A completed switch leaves the departed space's unsubmitted input in its own buffers; report that instead of dropping it silently.
 useEffect(()=>{
  if(!ready)return;const current=scopeKey(ready),previous=departed.current;if(previous===current)return;departed.current=current;
  const kept=retainedScopeOnSwitch(previous,current);if(kept)setRetained(kept);
 },[ready]);
 // The notice retires itself once that space no longer holds unsubmitted input.
 useEffect(()=>{
  if(!retained)return;const check=()=>{if(!hasPendingWorkspaceInput(retained))setRetained(null);};
  const unsubscribe=subscribeWorkspacePending(check);check();return unsubscribe;
 },[retained]);
 const pending=state.status!=='ready'||state.revision!==ready?.revision;
 return <View style={{flex:1,backgroundColor:theme.color.background}}>
  {ready&&<View key={scopeKey(ready)} style={{flex:1,opacity:pending?0:1}} pointerEvents={pending?'none':'auto'} accessibilityElementsHidden={pending} importantForAccessibility={pending?'no-hide-descendants':'auto'}>
   <Context.Provider value={{host,state:ready}}>{children}</Context.Provider>
  </View>}
  {retained&&!pending&&<View style={{position:'absolute',left:0,right:0,bottom:0,gap:4,paddingHorizontal:20,paddingVertical:16,backgroundColor:theme.color.surface,borderTopWidth:1,borderTopColor:theme.color.border}}>
   <Text accessibilityLiveRegion="polite" style={{fontSize:14,lineHeight:22,color:theme.color.ink}}>{t('workspace.inputRetained')}</Text>
   <Pressable accessibilityRole="button" accessibilityLabel={t('workspace.dismiss')} onPress={()=>setRetained(null)} style={{alignSelf:'flex-start',paddingVertical:8}}><Text style={{fontSize:15,lineHeight:22,color:theme.color.accent}}>{t('workspace.dismiss')}</Text></Pressable>
  </View>}
  {pending&&<View style={{position:'absolute',inset:0,justifyContent:'center',padding:24,backgroundColor:theme.color.background}}>
   <Text accessibilityLiveRegion="polite" style={{color:theme.color.ink}}>{state.status==='unavailable'?(locale==='en'?'Unable to open this workspace. Saved content is preserved.':'无法打开当前空间，已保存的内容仍保留。'):(locale==='en'?'Opening workspace…':'正在打开空间…')}</Text>
   {state.status==='unavailable'&&<Pressable accessibilityRole="button" onPress={()=>{if(host)void host.retry();else setAttempt(value=>value+1);}} style={{paddingVertical:16}}><Text style={{color:theme.color.accent}}>{locale==='en'?'Retry':'重试'}</Text></Pressable>}
  </View>}
 </View>;
}
