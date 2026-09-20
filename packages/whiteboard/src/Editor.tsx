import React, { useEffect, useRef, useState } from 'react';
import { Excalidraw, MainMenu, convertToExcalidrawElements, CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, BinaryFiles, BinaryFileData, AppState } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types';
import { blankPage, emptyBoard, validateBoard, validateImage, viewState, type Board, type Page, type Reply, type Transport } from './protocol';
import '@excalidraw/excalidraw/index.css';
import './editor.css';

const words = {
  'zh-CN': { cancel:'取消', back:'返回', camera:'拍题', library:'选图', add:'新建页', del:'删除页', page:'页', save:'保存', saved:'已保存到本机', saving:'保存中…', dirty:'待保存', failed:'保存失败，内容已保留；请重试', load:'无法读取白板，原件已保留', retry:'重试', confirm:'删除当前页？保存后无法撤销删除。', importing:'正在处理图片…', imageError:'图片未导入。请检查权限、图片格式或大小后重试。', capacity:'最多 30 页', cancelled:'已取消', loading:'正在打开白板…', conflict:'版本冲突，请保留当前页面并重试或联系维护者', local:'仅本机作品', leave:'尚有未保存内容。仍要离开？' },
  'en-US': { cancel:'Cancel', back:'Back', camera:'Camera', library:'Photos', add:'New page', del:'Delete page', page:'Page', save:'Save', saved:'Saved locally', saving:'Saving…', dirty:'Unsaved', failed:'Save failed. Changes kept; retry.', load:'Cannot read board. Original kept.', retry:'Retry', confirm:'Delete this page? Deletion cannot be undone after saving.', importing:'Preparing image…', imageError:'Image not imported. Check permission, type or size and retry.', capacity:'Maximum 30 pages', cancelled:'Cancelled', loading:'Opening board…', conflict:'Revision conflict. Keep this page and retry or contact the maintainer.', local:'Local work only', leave:'Unsaved changes remain. Leave anyway?' },
};
export type EditorProps = { session:string; request:Transport; locale:'zh-CN'|'en-US'; theme:'light'|'dark'; camera?:boolean; onExit:()=>Promise<void>; onDirty?:(dirty:boolean)=>Promise<void>; flushToken?:number; saveToken?:number; closeToken?:number; onCloseReady?:(ok:boolean)=>Promise<void> };
const id = () => crypto.randomUUID();
export default function Editor(props: EditorProps) {
  const t=words[props.locale], [board,setBoard]=useState<Board|null>(null), [pageId,setPageId]=useState(''), [error,setError]=useState(''), [status,setStatus]=useState<'loading'|'saved'|'dirty'|'saving'|'failed'>('loading'), [busy,setBusy]=useState(false), [deletePending,setDeletePending]=useState(false), [picking,setPicking]=useState(false);
  const documentRef=useRef<Board|null>(null), api=useRef<ExcalidrawImperativeAPI|null>(null), pageRef=useRef('');
  const counter=useRef(0), confirmed=useRef(0), storedFiles=useRef(new Set<string>()), flight=useRef<Promise<void>|null>(null), timer=useRef<ReturnType<typeof setTimeout>|null>(null), alive=useRef(true), dirtyRef=useRef(false), busyRef=useRef(false);
  const currentProps=useRef(props);currentProps.current=props;
  async function rpc(op:'load'|'save'|'pick', payload?:unknown) {
    const requestId=id(), message=JSON.stringify({version:1,session:props.session,requestId,op,payload});
    const send=()=>new Promise<string>((resolve,reject)=>{
      const timeout=op==='pick'?null:setTimeout(()=>reject(new Error('bridge_timeout')),15000);
      currentProps.current.request(message).then(resolve,reject).finally(()=>{if(timeout)clearTimeout(timeout);});
    });
    // A lost acknowledgement retries the SAME request identity; the host deduplicates commits.
    let raw:string;
    try{raw=await send();}catch(e){if(e instanceof Error&&e.message==='bridge_timeout'&&op==='save')raw=await send();else throw e;}
    const reply:Reply=JSON.parse(raw);
    if(reply.version!==1||reply.requestId!==requestId||!reply.ok) throw new Error(reply.error??'bridge_error');
    return reply.value;
  }
  function dirty(value:boolean) { if(dirtyRef.current!==value){dirtyRef.current=value;void currentProps.current.onDirty?.(value);} }
  async function load() {
    setError('');setStatus('loading');
    try {
      const result=await rpc('load') as {board:Board|null};
      if(!alive.current)return;
      const doc=result.board?validateBoard(result.board):emptyBoard();
      documentRef.current=doc;storedFiles.current=new Set(Object.keys(doc.files));confirmed.current=0;counter.current=result.board?0:1;
      pageRef.current=doc.activePageId;setBoard(doc);setPageId(pageRef.current);setStatus(result.board?'saved':'dirty');
    }catch{setError(t.load);setStatus('failed');}
  }
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;if(timer.current)clearTimeout(timer.current);};},[props.session]);
  function snapshot(elements:readonly ExcalidrawElement[], state:AppState, files:BinaryFiles, expectedPage=pageRef.current) {
    if(expectedPage!==pageRef.current)return;
    const doc=documentRef.current;if(!doc)return;
    // Compare scene/version and whitelisted viewport state locally; no bridge traffic per touch.
    const previous=doc.pages.find(p=>p.id===pageRef.current);if(!previous)return;
    const stable=elements.map(element=>({...element,boundElements:element.boundElements??[],...('lastCommittedPoint' in element?{lastCommittedPoint:null}:{})}));
    const next:Page={id:previous.id,elements:stable,appState:viewState(state)};
    if(JSON.stringify(previous)===JSON.stringify(next))return;
    documentRef.current={...doc,pages:doc.pages.map(p=>p.id===next.id?next:p),files:{...doc.files,...files}};
    counter.current++;dirty(true);setStatus('dirty');
    if(timer.current)clearTimeout(timer.current);
    timer.current=setTimeout(()=>void flush().catch(()=>{}),600);
  }
  async function flush() {
    if(flight.current){await flight.current;if(counter.current>confirmed.current)return flush();return;}
    const doc=documentRef.current;if(!doc||counter.current===confirmed.current)return;
    const seq=counter.current, captured=doc;
    const usedFiles=new Set(captured.pages.flatMap(page=>page.elements.filter(element=>element.type==='image').map(element=>element.fileId)));
    const files=Object.fromEntries(Object.entries(captured.files).filter(([key])=>usedFiles.has(key as FileId)&&!storedFiles.current.has(key)));
    setStatus('saving');
    const task=(async()=>{
      try {
        const result=await rpc('save',{baseRevision:captured.revision,pages:captured.pages,activePageId:captured.activePageId,files}) as {revision:number;fileIds:string[]};
        if(!alive.current)return;
        documentRef.current={...documentRef.current!,revision:result.revision};confirmed.current=seq;
        storedFiles.current=new Set(result.fileIds);
        setStatus(counter.current===seq?'saved':'dirty');dirty(counter.current!==seq);setError('');
      }catch(e){setStatus('failed');setError(e instanceof Error&&e.message==='revision_conflict'?t.conflict:t.failed);throw e;}
    })();
    flight.current=task;
    try{await task;}finally{if(flight.current===task)flight.current=null;}
  }
  useEffect(()=>{
    const interval=setInterval(()=>{if(!busyRef.current)void flush().catch(()=>{});},2000);
    const hidden=()=>{if(document.visibilityState==='hidden')void flush().catch(()=>{});};
    document.addEventListener('visibilitychange',hidden);
    return()=>{clearInterval(interval);document.removeEventListener('visibilitychange',hidden);};
  },[]);
  async function transition(action:()=>Promise<void>|void) {
    if(busyRef.current)return;busyRef.current=true;setBusy(true);
    try{await flush();await action();}catch{/* Preserve active editor on failure. */}finally{busyRef.current=false;setBusy(false);}
  }
  async function exit(){await transition(async()=>{await currentProps.current.onExit();});}
  useEffect(()=>{if(props.flushToken)void exit();},[props.flushToken]);
  useEffect(()=>{if(props.saveToken)void flush().catch(()=>{});},[props.saveToken]);
  useEffect(()=>{if(!props.closeToken)return;
    void (async()=>{
      if(busyRef.current){await currentProps.current.onCloseReady?.(false);return;}
      busyRef.current=true;setBusy(true);
      try{await flush();await currentProps.current.onCloseReady?.(true);}
      catch{await currentProps.current.onCloseReady?.(false);}
      finally{busyRef.current=false;setBusy(false);}
    })();
  },[props.closeToken]);
  function showPage(next:string) { if(documentRef.current&&documentRef.current.activePageId!==next){documentRef.current={...documentRef.current,activePageId:next};counter.current++;dirty(true);}api.current=null;pageRef.current=next;setPageId(next);setBoard(documentRef.current); }
  async function pages(action:'add'|'delete'|'switch',target?:string) {
    await transition(async()=>{
      let doc=documentRef.current!;
      if(action==='switch'){showPage(target!);await flush();return;}
      if(action==='add') {if(doc.pages.length>=30){setError(t.capacity);return;}const page=blankPage(id());doc={...doc,pages:[...doc.pages,page]};target=page.id;}
      else {if(doc.pages.length<=1)return;doc={...doc,pages:doc.pages.filter(p=>p.id!==pageRef.current)};target=doc.pages[0]!.id;}
      documentRef.current=doc;counter.current++;dirty(true);showPage(target!);await flush();
    });
  }
  async function insertImage(source:'camera'|'library') {
    await transition(async()=>{
      let inserted=false;
      try {
        setError('');setPicking(true); const result=await rpc('pick',{source}) as {cancelled?:boolean;file?:BinaryFileData;width?:number;height?:number};
        if(result.cancelled)return;
        validateImage(result.file);if(!api.current||!result.width||!result.height)throw new Error('invalid_image');
        const current=api.current,state=current.getAppState(),file=result.file!;
        const ratio=Math.min(1,1200/result.width,1600/result.height);
        const elements=convertToExcalidrawElements([{type:'image',x:-state.scrollX+40/state.zoom.value,y:-state.scrollY+40/state.zoom.value,width:result.width*ratio,height:result.height*ratio,fileId:file.id,status:'saved'}]);
        current.addFiles([file]);current.updateScene({elements:[...current.getSceneElements(),...elements],captureUpdate:CaptureUpdateAction.IMMEDIATELY});
        current.scrollToContent(elements,{fitToContent:true});
        snapshot(current.getSceneElementsIncludingDeleted(),current.getAppState(),current.getFiles());inserted=true;await flush();
      }catch{if(!inserted)setError(t.imageError);}finally{setPicking(false);}
    });
  }
  const active=board?.pages.find(p=>p.id===pageId);
  return <div className={`siyue-board ${props.theme}`} onDropCapture={e=>{e.preventDefault();e.stopPropagation();}} onDragOverCapture={e=>{e.preventDefault();e.stopPropagation();}} onContextMenuCapture={e=>{e.preventDefault();e.stopPropagation();}}
    onKeyDownCapture={e=>{if((e.metaKey||e.ctrlKey)&&['s','o','e','c','x'].includes(e.key.toLowerCase())){e.preventDefault();e.stopPropagation();if(e.key.toLowerCase()==='s')void flush().catch(()=>{});}}}>
    <div className="hostbar" aria-label={t.local}>
      <button onClick={()=>void exit()} disabled={busy}>{t.back}</button>
      {props.camera&&<button onClick={()=>void insertImage('camera')} disabled={!board||busy}>{t.camera}</button>}
      <button onClick={()=>void insertImage('library')} disabled={!board||busy}>{t.library}</button>
      <select aria-label={t.page} value={pageId} disabled={!board||busy} onChange={e=>void pages('switch',e.target.value)}>{board?.pages.map((p,i)=><option key={p.id} value={p.id}>{t.page} {i+1}</option>)}</select>
      <button aria-label={t.add} onClick={()=>void pages('add')} disabled={!board||busy}>＋</button>
      <button aria-label={t.del} onClick={()=>setDeletePending(true)} disabled={!board||busy||board.pages.length<2}>−</button>
      <button onClick={()=>void flush().catch(()=>{})} disabled={!board||busy}>{t.save}</button>
      <span className="save-state" role="status">{picking?t.importing:busy?t.saving:t[status==='failed'?'failed':status]}</span>
    </div>
    {error&&<div role="alert" className="error">{error}{!board&&<button onClick={()=>void load()}>{t.retry}</button>}</div>}
    {deletePending&&<div className="board-dialog-backdrop"><div className="board-dialog" role="alertdialog" aria-label={t.del} aria-modal="true">
      <p>{t.confirm}</p><button autoFocus onClick={()=>setDeletePending(false)}>{t.cancel}</button>
      <button onClick={()=>{setDeletePending(false);void pages('delete');}}>{t.del}</button>
    </div></div>}
    <div className="editor-area">
      {active&&<Excalidraw key={pageId} excalidrawAPI={value=>{api.current=value;}} initialData={{elements:active.elements,files:documentRef.current!.files,appState:{...active.appState,currentItemFontFamily:2},scrollToContent:false}}
        langCode={props.locale==='zh-CN'?'zh-CN':'en'} theme={props.theme} aiEnabled={false} isCollaborating={false}
        onChange={(elements,state,files)=>snapshot(elements,state,files,pageId)} onLinkOpen={(_,event)=>event.preventDefault()} validateEmbeddable={false}
        onPaste={()=>false} onPointerDown={tool=>{if(['embeddable','magicframe','image'].includes(tool.type))api.current?.setActiveTool({type:'selection'});}}
        UIOptions={{canvasActions:{loadScene:false,saveToActiveFile:false,export:false,saveAsImage:false,toggleTheme:false,clearCanvas:false},tools:{image:false}}}>
        <MainMenu><MainMenu.Item onSelect={()=>void flush().catch(()=>{})}>{t.save}</MainMenu.Item></MainMenu>
      </Excalidraw>}
      {busy&&<div className="blocking" aria-label={t.saving}/>}
    </div>
  </div>;
}
