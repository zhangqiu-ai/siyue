import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCommandService, createRunService } from '@siyue/domain';
import { createLocalClient } from '@siyue/adapters';
import { openNodeStore } from '@siyue/adapters/node';
import { MockAgentExecutor } from '@siyue/ai';
import { openWhiteboard } from './whiteboard.mjs';
import { whiteboardClose } from './whiteboard-close.mjs';
import { createIpcDispatcher, publicError } from './ipc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dispatchers = new Map();
// Development/QA may isolate its data explicitly. Packaged applications ignore this override.
if (!app.isPackaged && process.env.SIYUE_DATA_DIR) {
  if (!path.isAbsolute(process.env.SIYUE_DATA_DIR)) throw new Error('SIYUE_DATA_DIR must be absolute');
  mkdirSync(process.env.SIYUE_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.SIYUE_DATA_DIR);
}

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
const now = () => new Date().toISOString();
let store;
let localClient;
let startupError;
let whiteboard;
ipcMain.handle('siyue:whiteboard', (event,message)=>whiteboard?.handle(event,message,BrowserWindow.fromWebContents(event.sender),rendererUrl) ?? JSON.stringify({version:1,requestId:'',ok:false,error:'storage_or_read_failed'}));

ipcMain.handle('siyue:local-command', (event, message) => {
  const dispatcher = dispatchers.get(event.sender.id);
  return dispatcher ? dispatcher.handle(event, message) : publicError({ code: 'forbidden' });
});
ipcMain.on('siyue:cancel-proposal', (event, requestId) => dispatchers.get(event.sender.id)?.cancel(event, requestId));

function createWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 640, title: 'Siyue',
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  // Surface a preserved-storage error through the same UI boundary; never substitute volatile data.
  const client = localClient ?? new Proxy({}, { get: () => async () => { throw startupError; } });
  const dispatcher = createIpcDispatcher({ client, webContents: win.webContents, rendererUrl });
  const windowId = win.webContents.id;
  dispatchers.set(windowId, dispatcher);
  win.on('close', event=>{
    if(closing||allowedClose.has(windowId))return;
    event.preventDefault();
    void closeBoard.request(win).then(ok=>{if(ok&&!win.isDestroyed()){allowedClose.add(windowId);win.close();}});
  });
  win.on('closed', () => { closeBoard.dispose(windowId);allowedClose.delete(windowId);dispatcher.dispose(); dispatchers.delete(windowId); whiteboard?.disposeWindow(windowId); });
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
  try {whiteboard = openWhiteboard(path.join(app.getPath('userData'), 'siyue-whiteboard.sqlite'));}catch{/* Board reports its own preserved-storage failure. */}
  try {
    // This dedicated development DB is separate from other products and legacy data.
    store = openNodeStore(path.join(app.getPath('userData'), 'siyue-m1-local.sqlite'));
    const { spaceId, actorId } = await store.initialize('local-owner', randomUUID());
    const service = createCommandService({ store, now, newId: randomUUID, hash: (text) => createHash('sha256').update(text).digest('hex') });
    const actor = { id: actorId, kind: 'user' };
    const runService = createRunService({ store, now, newId: randomUUID });
    await runService.recover(spaceId, actor);
    const mock = new MockAgentExecutor();
    localClient = createLocalClient({
      service, runService, spaceId, actor, now, newId: randomUUID,
      propose: (goal, signal) => mock.createGoalPlan(goal, { runId: randomUUID(), spaceId, signal }),
    });
  } catch (error) {
    startupError = error;
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (closing) return;
  event.preventDefault();
  if(checkingClose)return;
  checkingClose=true;
  void Promise.all(BrowserWindow.getAllWindows().map(win=>closeBoard.request(win))).then(async results=>{
    if(results.some(ok=>!ok))return;
    closing=true;
    whiteboard?.close();
    for(const dispatcher of dispatchers.values())dispatcher.dispose();
    await store?.close();
    app.quit();
  }).catch(()=>{closing=false;}).finally(()=>{checkingClose=false;});
});
