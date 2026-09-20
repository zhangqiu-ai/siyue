// DOM-only resource policy. Expo's general native-module proxy stays disabled.
if(typeof document !== 'undefined') {
  const meta=document.createElement('meta'); meta.httpEquiv='Content-Security-Policy';
  meta.content="default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  document.head.appendChild(meta);
  const style=document.createElement('style');style.textContent='html,body,#root{height:100%;width:100%;margin:0;overflow:hidden}';document.head.appendChild(style);
  const base=location.protocol==='file:'?new URL('./excalidraw/',location.href).href:new URL('/excalidraw/',location.origin).href;
  (window as unknown as {EXCALIDRAW_ASSET_PATH:string}).EXCALIDRAW_ASSET_PATH=base;
  window.addEventListener('click',event=>{if((event.target as Element)?.closest?.('a[href]')){event.preventDefault();event.stopPropagation();}},true);
}
