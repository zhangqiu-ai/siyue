import {useWorkspace} from '../account/workspace-provider';
import { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, usePreventRemove } from 'expo-router/react-navigation';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import type { BoardStart } from '@siyue/whiteboard';
import { boardStrings } from '@siyue/whiteboard/strings';
import { useLocale } from '../i18n';
import { useTheme } from '../ui/theme';
import EditorDOM from '../whiteboard/editor-dom';
import { nativeBoardService } from '../whiteboard/native-service';
export default function WhiteboardScreen(){const {state}=useWorkspace();return <WhiteboardEditor key={state.revision}/>;}
function WhiteboardEditor() {
  const {host}=useWorkspace();
  const {locale}=useLocale(),theme=useTheme(),router=useRouter(),navigation=useNavigation();
  const insets=useSafeAreaInsets();
  const [session]=useState(()=>Crypto.randomUUID());
  // The board library screen may open a specific board, or ask for a new one from a photo or the
  // library. Without parameters the editor opens the most recently edited board.
  const params=useLocalSearchParams<{id?:string;start?:string}>();
  const boardId=typeof params.id==='string'&&params.id?params.id:undefined;
  const startWith=params.start==='blank'||params.start==='photo'||params.start==='library'?params.start as BoardStart:undefined;
  const strings=boardStrings(locale==='en'?'en-US':'zh-CN');
  type BoardService=ReturnType<typeof nativeBoardService>&{registerEditor?:(request:(token:number)=>void)=>{finish:(id:number,ok:boolean)=>void;dispose:()=>void}};
  const [service,setService]=useState<BoardService|null>(null);
  const [dirty,setDirty]=useState(false),[flushToken,setFlushToken]=useState(0),[exitAllowed,setExitAllowed]=useState(false),[saveToken,setSaveToken]=useState(0);
  const [closeToken,setCloseToken]=useState(0);
  const registration=useRef<{finish:(id:number,ok:boolean)=>void;dispose:()=>void}|null>(null);
  useEffect(()=>{const next=host?host.board(session):nativeBoardService(session);setService(next);return()=>next.dispose();},[host,session]);
  useEffect(()=>{if(service?.registerEditor)registration.current=service.registerEditor(setCloseToken);return()=>{registration.current?.dispose();registration.current=null;};},[service]);
  const pending=useRef<Parameters<typeof navigation.dispatch>[0]|null>(null);
  usePreventRemove(dirty&&!exitAllowed,({data})=>{pending.current=data.action;setFlushToken(n=>n+1);});
  useEffect(()=>{const listener=AppState.addEventListener('change',state=>{if(state!=='active')setSaveToken(n=>n+1);});return()=>listener.remove();},[]);
  useEffect(()=>{if(exitAllowed){if(pending.current)navigation.dispatch(pending.current);else if(router.canGoBack())router.back();else router.replace('/boards');}},[exitAllowed]);
  return <View style={{flex:1,backgroundColor:theme.color.background}}>
    <View style={{flex:1}} testID="whiteboard-excalidraw">
      {service&&<EditorDOM session={session} request={service.request} locale={locale==='en'?'en-US':'zh-CN'} strings={strings} boardId={boardId} startWith={startWith} theme={theme.mode} safeAreaTop={insets.top} safeAreaBottom={insets.bottom} camera
        closeToken={closeToken} onCloseReady={async ok=>{registration.current?.finish(closeToken,ok);}} flushToken={flushToken} saveToken={saveToken} onDirty={async value=>setDirty(value)} onExit={async()=>setExitAllowed(true)}
        dom={{scrollEnabled:false,style:{flex:1},contentInsetAdjustmentBehavior:'never',unstable_useExpoModulesBridge:false,
          originWhitelist:['file://*','http://localhost:*','http://127.0.0.1:*'],
          onShouldStartLoadWithRequest:(request:{url:string})=>request.url.startsWith('file:')||/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(request.url)}}/>}
    </View>
  </View>;
}
