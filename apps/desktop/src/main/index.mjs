import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAuthApiClient,createAuthController } from '@siyue/adapters';
import { openDesktopWorkspace } from './workspace.mjs';
import { whiteboardClose } from './whiteboard-close.mjs';
import { createIpcDispatcher, publicError } from './ipc.mjs';
import { createDesktopAuthVault } from './auth-vault.mjs';
import { createAuthIpcDispatcher } from './auth-ipc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dispatchers = new Map();
const authDispatchers = new Map();
let accountAuth;
// Development/QA may isolate its data explicitly. Packaged applications ignore this override.
if (!app.isPackaged && process.env.SIYUE_DATA_DIR) {
  if (!path.isAbsolute(process.env.SIYUE_DATA_DIR)) throw new Error('SIYUE_DATA_DIR must be absolute');
  mkdirSync(process.env.SIYUE_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.SIYUE_DATA_DIR);
}
// Two processes must not rotate and overwrite the same account vault independently.
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
let initialized = false;
app.on('second-instance', () => {
  if (!initialized) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) createWindow();
  else { if (win.isMinimized()) win.restore(); win.focus(); }
});

const rendererUrl = (() => {
  if (!app.isPackaged && process.env.SIYUE_RENDERER_URL) {
    const url = new URL(process.env.SIYUE_RENDERER_URL);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Renderer must be an explicit loopback development origin');
    }
    return url.href;
  }
  return pathToFileURL(path.join(here, '../../dist/renderer/index.html')).href;
})();
const closeBoard = whiteboardClose(ipcMain,rendererUrl);
const allowedClose = new Set();
let closing = false, checkingClose = false;
let workspace;
let authEnvironment='production';
ipcMain.handle('siyue:whiteboard', (event,message,revision)=>workspace?.whiteboard(event,message,revision,BrowserWindow.fromWebContents(event.sender)) ?? JSON.stringify({version:1,requestId:'',ok:false,error:'storage_or_read_failed'}));
ipcMain.handle('siyue:workspace',(event,message)=>workspace?.command(event,message,BrowserWindow.fromWebContents(event.sender))??{ok:false,error:'unavailable'});
ipcMain.handle('siyue:local-command', async(event, message) => {
  const dispatcher = dispatchers.get(event.sender.id),state=workspace?.getState();
  if(!message||typeof message!=='object'||message.workspaceRevision!==state?.revision||state?.status!=='ready')return publicError({code:'cancelled'});
  const {workspaceRevision,...call}=message;
  const result=dispatcher?await dispatcher.handle(event,call):publicError({code:'forbidden'});
  return workspaceRevision===workspace?.getState().revision?result:publicError({code:'cancelled'});
});
ipcMain.handle('siyue:auth',(event,message)=>authDispatchers.get(event.sender.id)?.handle(event,message)??{version:1,requestId:'',ok:false,error:'unavailable'});
ipcMain.on('siyue:cancel-proposal', (event, requestId) => dispatchers.get(event.sender.id)?.cancel(event, requestId));

function createWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 640, title: 'Siyue',
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  // Surface a preserved-storage error through the same UI boundary; never substitute volatile data.
  const client = new Proxy({}, {get:(_target,method)=>(...args)=>workspace.client()[method](...args)});
  const dispatcher = createIpcDispatcher({ client, webContents: win.webContents, rendererUrl });
  const windowId = win.webContents.id;
  dispatchers.set(windowId, dispatcher);
  if(accountAuth)authDispatchers.set(windowId,createAuthIpcDispatcher({auth:accountAuth,webContents:win.webContents,rendererUrl}));
  win.on('close', event=>{
    if(closing||allowedClose.has(windowId))return;
    event.preventDefault();
    void closeBoard.request(win).then(ok=>{if(ok&&!win.isDestroyed()){allowedClose.add(windowId);win.close();}});
  });
  win.on('closed', () => { authDispatchers.get(windowId)?.dispose();authDispatchers.delete(windowId);closeBoard.dispose(windowId);allowedClose.delete(windowId);dispatcher.dispose(); dispatchers.delete(windowId); workspace?.disposeWindow(windowId); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  win.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const session = win.webContents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  const development = rendererUrl.startsWith('http:');
  const origin = development ? new URL(rendererUrl).origin : '';
  const policy = `default-src 'self'; script-src 'self'${development ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'${development ? ` ${origin.replace('http:', 'ws:')}` : ''}; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`;
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } });
  });
  void win.loadURL(rendererUrl);
}

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  try {
    const override=!app.isPackaged?process.env.SIYUE_AUTH_URL:undefined;
    authEnvironment=override?'development':'production';
    const api=createAuthApiClient({environment:authEnvironment,apiBaseUrl:override??'https://api.qiugeapp.com/api/siyue/v1',fetcher:fetch});
    accountAuth=createAuthController({api,newId:randomUUID,
      deletionReceiptVault:createDesktopAuthVault({directory:path.join(app.getPath('userData'),'auth',api.endpoint.environment,'deletion-receipt'),safeStorage}),vault:createDesktopAuthVault({directory:path.join(app.getPath('userData'),'auth',api.endpoint.environment),safeStorage})});
  } catch { /* Authentication configuration failure must not erase or disable local works. */ }

  const unavailable={getState:()=>({status:'anonymous',generation:0,session:null,account:null,error:null,pendingRevocations:0}),subscribe:()=>()=>{}};
  workspace=await openDesktopWorkspace({auth:accountAuth??unavailable,environment:authEnvironment,directory:app.getPath('userData'),windows:()=>BrowserWindow.getAllWindows(),closeBoard,rendererUrl});
  // Local initialization precedes cloud restoration; network waiting never gates the local editor.
  void accountAuth?.bootstrap().catch(()=>{});
  initialized = true;
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (!ownsInstance) return;
  if (closing) return;
  event.preventDefault();
  if(checkingClose)return;
  checkingClose=true;
  void Promise.all(BrowserWindow.getAllWindows().map(win=>closeBoard.request(win))).then(async results=>{
    if(results.some(ok=>!ok))return;
    closing=true;
    for(const dispatcher of dispatchers.values())dispatcher.dispose();
    await workspace?.dispose();
    await accountAuth?.dispose();
    app.quit();
  }).catch(()=>{closing=false;}).finally(()=>{checkingClose=false;});
});
