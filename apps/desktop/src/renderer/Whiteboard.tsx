import {workspaceState} from './workspace';
import { useEffect, useState, useRef } from 'react';
import Editor from '@siyue/whiteboard/editor';
import { useLocale } from './i18n';
(window as unknown as {EXCALIDRAW_ASSET_PATH:string}).EXCALIDRAW_ASSET_PATH=new URL('excalidraw/',location.href).href;
export function Whiteboard({onExit}:{onExit:()=>void}) {
  const [revision]=useState(()=>workspaceState().revision);
  const [session]=useState(()=>crypto.randomUUID()),{locale}=useLocale();
  const [theme,setTheme]=useState<'dark'|'light'>(()=>matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
  useEffect(()=>{const media=matchMedia('(prefers-color-scheme:dark)');const changed=()=>setTheme(media.matches?'dark':'light');media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);},[]);
  const [closeToken,setCloseToken]=useState(0), closeId=useRef('');
  const bridge=(window as unknown as {siyueDesktop?:{
    whiteboard:(message:string,revision:number)=>Promise<string>;
    onWhiteboardClose:(callback:(id:string)=>void)=>()=>void;
    finishWhiteboardClose:(id:string,ok:boolean)=>void;
  }}).siyueDesktop;
  useEffect(()=>bridge?.onWhiteboardClose(id=>{closeId.current=id;setCloseToken(token=>token+1);}),[bridge]);
  return <div style={{position:'fixed',inset:0,zIndex:10}}><Editor session={session} locale={locale==='en'?'en-US':'zh-CN'} theme={theme}
    request={async message=>{
      if(!bridge)throw new Error('Desktop bridge unavailable');return bridge.whiteboard(message,revision);
    }} closeToken={closeToken} onCloseReady={async ok=>{bridge?.finishWhiteboardClose(closeId.current,ok);}} onExit={async()=>onExit()}/></div>;
}
