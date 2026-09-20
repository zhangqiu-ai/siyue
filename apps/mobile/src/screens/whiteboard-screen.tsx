import { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, usePreventRemove } from 'expo-router/react-navigation';
import { useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { useLocale } from '../i18n';
import { useTheme } from '../ui/theme';
import EditorDOM from '../whiteboard/editor-dom';
import { nativeBoardService } from '../whiteboard/native-service';
export default function WhiteboardScreen() {
  const {locale}=useLocale(),theme=useTheme(),router=useRouter(),navigation=useNavigation();
  const [session]=useState(()=>Crypto.randomUUID());
  const [service]=useState(()=>nativeBoardService(session));
  const [dirty,setDirty]=useState(false),[flushToken,setFlushToken]=useState(0),[exitAllowed,setExitAllowed]=useState(false),[saveToken,setSaveToken]=useState(0);
  const pending=useRef<Parameters<typeof navigation.dispatch>[0]|null>(null);
  usePreventRemove(dirty&&!exitAllowed,({data})=>{pending.current=data.action;setFlushToken(n=>n+1);});
  useEffect(()=>()=>service.dispose(),[service]);
  useEffect(()=>{const listener=AppState.addEventListener('change',state=>{if(state!=='active')setSaveToken(n=>n+1);});return()=>listener.remove();},[]);
  useEffect(()=>{if(exitAllowed){if(pending.current)navigation.dispatch(pending.current);else if(router.canGoBack())router.back();else router.replace('/');}},[exitAllowed]);
  return <SafeAreaView style={{flex:1,backgroundColor:theme.color.background}} edges={['top','bottom','left','right']}>
    <View style={{flex:1}} testID="whiteboard-excalidraw">
      <EditorDOM session={session} request={service.request} locale={locale==='en'?'en-US':'zh-CN'} theme={theme.mode} camera
        flushToken={flushToken} saveToken={saveToken} onDirty={async value=>setDirty(value)} onExit={async()=>setExitAllowed(true)}
        dom={{scrollEnabled:false,style:{flex:1},contentInsetAdjustmentBehavior:'never',unstable_useExpoModulesBridge:false,
          originWhitelist:['file://*','http://localhost:*','http://127.0.0.1:*'],
          onShouldStartLoadWithRequest:(request:{url:string})=>request.url.startsWith('file:')||/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(request.url)}}/>
    </View>
  </SafeAreaView>;
}
