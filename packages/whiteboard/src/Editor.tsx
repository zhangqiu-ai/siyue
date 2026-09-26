import React, { useEffect, useRef, useState } from 'react';
import { Excalidraw, convertToExcalidrawElements, exportToCanvas, CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, BinaryFiles, BinaryFileData, AppState } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types';
import { blankPage, MAX_PAGES, MAX_THUMBNAIL, MAX_TITLE, validateBoard, validateImage, viewState, type Board, type BoardStart, type BoardSummary, type Page, type Reply, type Transport } from './protocol';
import { boardStrings, pageLabel, type BoardLocale, type BoardStrings } from './strings';
import '@excalidraw/excalidraw/index.css';
import './editor.css';
export { boardStrings, pageLabel } from './strings';
export type { BoardLocale, BoardStrings } from './strings';
export type { BoardStart, BoardSummary } from './protocol';

export type EditorProps = {
  session: string;
  request: Transport;
  locale: BoardLocale;
  /** Host-supplied bilingual table. Defaults to the table for the host locale. */
  strings?: BoardStrings;
  theme: 'light' | 'dark';
  safeAreaTop?: number;
  safeAreaBottom?: number;
  /** Board to open. Without it the most recently edited board is opened, or one is created. */
  boardId?: string;
  /** Create a new board from this starting point instead of reopening the last one. */
  startWith?: BoardStart;
  /** Only hosts with a working camera module set this; the insert sheet hides the camera row otherwise. */
  camera?: boolean;
  /** Family call entry. The button only exists when a host actually implements the call flow. */
  onStartCall?: () => void | Promise<void>;
  onExit: () => Promise<void>;
  onDirty?: (dirty: boolean) => Promise<void> | void;
  /** Fires when the editor had to move to another board, which today only a conflict copy does. */
  onBoardChanged?: (summary: BoardSummary) => void;
  flushToken?: number;
  saveToken?: number;
  closeToken?: number;
  onCloseReady?: (ok: boolean) => Promise<void>;
};

const DEBOUNCE_MS = 600;
const INTERVAL_MS = 2000;
const THUMBNAIL_INTERVAL_MS = 12000;
const BRIDGE_TIMEOUT_MS = 20000;
// Replayed request ids are deduplicated by the host, so a lost acknowledgement may resend these.
const REPLAY_SAFE = new Set(['save', 'create', 'rename', 'delete']);
type Status = 'loading' | 'saved' | 'saving' | 'failed';
const newId = () => crypto.randomUUID();

const PATHS: Record<string, string> = {
  chevL: 'M15 5l-7 7 7 7', check: 'M4 12.5l5 5L20 6.5', warn: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5', plus: 'M12 5v14M5 12h14', close: 'M6 6l12 12M18 6L6 18',
  camera: 'M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h3l2-3h8l2 3h3a2 2 0 012 2zM12 17a4 4 0 100-8 4 4 0 000 8z',
  image: 'M3 5h18v14H3zM8.5 11a2 2 0 100-4 2 2 0 000 4zM21 15l-5-5-9 9',
  video: 'M23 7l-7 5 7 5zM14 5H3a2 2 0 00-2 2v10a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2z',
};
function Icon({ name, size = 20, width = 2.1 }: { name: string; size?: number; width?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={PATHS[name]}/></svg>;
}
// Excalidraw 0.18.1 honours a per-shape false here at runtime (ShapesSwitcher and the command
// palette both read it) while its published type only declares "image". This keeps the everyday
// upstream toolbar - selection, freedraw, eraser, text, rectangle/ellipse - instead of a fake one.
const simpleTools = { selection: true, rectangle: true, diamond: false, ellipse: true, arrow: false, line: false, freedraw: true, text: true, image: false, eraser: true } as unknown as { image: boolean };
const canvasActions = { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false, clearCanvas: false } as const;

function Sheet({ label, children, onClose }: { label: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="wb-sheet-backdrop" onClick={onClose}><div className="wb-sheet" role="dialog" aria-modal="true" aria-label={label} onClick={event => event.stopPropagation()}>{children}</div></div>;
}
async function renderThumbnail(page: Page, files: BinaryFiles, theme: 'light' | 'dark', max: number) {
  const elements = page.elements.filter(element => !element.isDeleted) as unknown as Parameters<typeof exportToCanvas>[0]['elements'];
  if (!elements.length) return '';
  const canvas = await exportToCanvas({ elements, files, maxWidthOrHeight: max, exportPadding: 8, appState: { exportBackground: true, exportWithDarkMode: theme === 'dark', viewBackgroundColor: page.appState.viewBackgroundColor } });
  const data = canvas.toDataURL('image/png');
  return data.length <= MAX_THUMBNAIL ? data : '';
}

export default function Editor(props: EditorProps) {
  const t = props.strings ?? boardStrings(props.locale);
  const [board, setBoard] = useState<Board | null>(null), [pageId, setPageId] = useState(''), [mounted, setMounted] = useState<string[]>([]);
  const [title, setTitle] = useState(''), [status, setStatus] = useState<Status>('loading'), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [sheet, setSheet] = useState<'none' | 'pages' | 'insert' | 'rename' | 'delete'>('none'), [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false), [picking, setPicking] = useState(false), [thumbs, setThumbs] = useState<Record<string, string>>({});
  const documentRef = useRef<Board | null>(null), apis = useRef(new Map<string, ExcalidrawImperativeAPI>());
  const shells = useRef(new Map<string, HTMLDivElement>());
  const pageRef = useRef(''), boardIdRef = useRef(''), titleRef = useRef('');
  const counter = useRef(0), confirmed = useRef(0), storedFiles = useRef(new Set<string>());
  const flight = useRef<Promise<void> | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true), dirtyRef = useRef(false), busyRef = useRef(false);
  const autoRetryBlocked = useRef(false);
  const thumbsRef = useRef<Record<string, string>>({}), thumbnailRef = useRef(''), thumbAt = useRef(0);
  const openRef = useRef<(() => Promise<void>) | null>(null);
  const pendingInitialImage = useRef<{ file: BinaryFileData; width: number; height: number } | null>(null);
  const currentProps = useRef(props); currentProps.current = props;

  async function rpc(op: string, payload?: unknown) {
    const requestId = newId(), message = JSON.stringify({ version: 1, session: props.session, requestId, op, payload });
    const send = () => new Promise<string>((resolve, reject) => {
      const timeout = op === 'pick' ? null : setTimeout(() => reject(new Error('bridge_timeout')), BRIDGE_TIMEOUT_MS);
      currentProps.current.request(message).then(resolve, reject).finally(() => { if (timeout) clearTimeout(timeout); });
    });
    // A lost acknowledgement retries the SAME request identity; the host deduplicates the commit.
    let raw: string;
    try { raw = await send(); } catch (thrown) { if (thrown instanceof Error && thrown.message === 'bridge_timeout' && REPLAY_SAFE.has(op)) raw = await send(); else throw thrown; }
    const reply: Reply = JSON.parse(raw);
    if (reply.version !== 1 || reply.requestId !== requestId || !reply.ok) throw new Error(reply.error ?? 'bridge_error');
    return reply.value;
  }
  function dirty(value: boolean) { if (dirtyRef.current !== value) { dirtyRef.current = value; void currentProps.current.onDirty?.(value); } }

  async function loadBoard() {
    setError(''); setStatus('loading');
    try {
      const listed = await rpc('list', { defaultTitle: t.migratedBoardTitle }) as { boards: BoardSummary[] };
      if (!alive.current) return;
      const requested = currentProps.current.boardId, startWith = currentProps.current.startWith;
      let summary: BoardSummary | undefined;
      if (requested) {
        summary = listed.boards.find(entry => entry.id === requested);
        if (!summary) throw new Error('not_found');
      } else if (startWith) {
        if (startWith !== 'blank') {
          const picked = await rpc('pick', { source: startWith === 'photo' ? 'camera' : 'library' }) as { cancelled?: boolean; file?: BinaryFileData; width?: number; height?: number };
          if (!alive.current) return;
          if (picked.cancelled) { await currentProps.current.onExit(); return; }
          validateImage(picked.file);
          if (!picked.file || !picked.width || !picked.height) throw new Error('invalid_image');
          pendingInitialImage.current = { file: picked.file, width: picked.width, height: picked.height };
        }
        summary = ((await rpc('create', { title: t.newBoardTitle, start: startWith })) as { summary: BoardSummary }).summary;
      } else {
        summary = listed.boards[0];
        if (!summary) summary = ((await rpc('create', { title: t.newBoardTitle, start: 'blank' })) as { summary: BoardSummary }).summary;
      }
      const loaded = await rpc('load', { boardId: summary.id }) as { board: Board; summary: BoardSummary };
      if (!alive.current) return;
      const document = validateBoard(loaded.board);
      documentRef.current = document; storedFiles.current = new Set(Object.keys(document.files));
      confirmed.current = 0; counter.current = 0; autoRetryBlocked.current = false;
      boardIdRef.current = document.id; titleRef.current = summary.title; setTitle(summary.title);
      apis.current.clear(); shells.current.clear(); thumbsRef.current = {}; setThumbs({}); thumbnailRef.current = ''; thumbAt.current = 0;
      pageRef.current = document.activePageId; setPageId(document.activePageId); setMounted([document.activePageId]);
      setBoard(document); setStatus('saved'); dirty(false);
    } catch { if (alive.current) { setBoard(null); setMounted([]); setError(t.openFailed); setStatus('failed'); } }
  }
  openRef.current = loadBoard;

  function snapshot(elements: readonly ExcalidrawElement[], state: AppState, files: BinaryFiles, expectedPage: string) {
    if (expectedPage !== pageRef.current) return;
    const document = documentRef.current; if (!document) return;
    // Compare scene/version and whitelisted viewport state locally; no bridge traffic per touch.
    const previous = document.pages.find(page => page.id === expectedPage); if (!previous) return;
    const stable = elements.map(element => ({ ...element, boundElements: element.boundElements ?? [], ...('lastCommittedPoint' in element ? { lastCommittedPoint: null } : {}) }));
    const next: Page = { id: previous.id, elements: stable, appState: viewState(state) };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    documentRef.current = { ...document, pages: document.pages.map(page => page.id === next.id ? next : page), files: { ...document.files, ...files } };
    counter.current += 1; dirty(true); if (!autoRetryBlocked.current) setStatus('saving');
    if (timer.current) clearTimeout(timer.current);
    if (!autoRetryBlocked.current) timer.current = setTimeout(() => { if (!autoRetryBlocked.current) void flush().catch(() => {}); }, DEBOUNCE_MS);
  }
  // Library thumbnails are decoration. Regenerating at most every 12s keeps a long drawing session
  // from paying for a canvas export on every autosave.
  async function boardThumbnail(document: Board) {
    if (Date.now() - thumbAt.current >= THUMBNAIL_INTERVAL_MS) {
      thumbAt.current = Date.now();
      const page = document.pages.find(entry => entry.id === pageRef.current) ?? document.pages[0];
      try { if (page) { const data = await renderThumbnail(page, document.files, props.theme, 160); if (data) thumbnailRef.current = data; } } catch { /* a missing thumbnail never fails a save */ }
    }
    return thumbnailRef.current || undefined;
  }
  async function flush(): Promise<void> {
    if (flight.current) { await flight.current; if (counter.current > confirmed.current) return flush(); return; }
    const document = documentRef.current;
    if (!document || counter.current === confirmed.current) return;
    const seq = counter.current, captured = document, boardId = captured.id;
    const used = new Set(captured.pages.flatMap(page => page.elements.flatMap(element => element.type === 'image' && element.fileId ? [element.fileId] : [])));
    const delta = Object.fromEntries(Object.entries(captured.files).filter(([key]) => used.has(key as FileId) && !storedFiles.current.has(key)));
    setStatus('saving');
    const task = (async () => {
      try {
        const thumbnail = await boardThumbnail(captured);
        const result = await rpc('save', { boardId, baseRevision: captured.revision, pages: captured.pages, activePageId: captured.activePageId, files: delta, ...(thumbnail ? { thumbnail } : {}) }) as { revision: number; fileIds: string[] };
        if (!alive.current) return;
        documentRef.current = { ...documentRef.current!, revision: result.revision };
        confirmed.current = seq; storedFiles.current = new Set(result.fileIds);
        autoRetryBlocked.current = false; setStatus(counter.current === seq ? 'saved' : 'saving'); dirty(counter.current !== seq);
      } catch (thrown) {
        if (!alive.current) throw thrown;
        // A board edited elsewhere is neither overwritten nor discarded: both copies are kept.
        if (thrown instanceof Error && thrown.message === 'revision_conflict') { await keepBoth(captured, seq, used); return; }
        autoRetryBlocked.current = true; setStatus('failed'); throw thrown;
      }
    })();
    flight.current = task;
    try { await task; } finally { if (flight.current === task) flight.current = null; }
  }
  async function keepBoth(captured: Board, seq: number, used: Set<FileId>) {
    const copyTitle = titleRef.current + t.copySuffix;
    let copyId = '';
    try {
      copyId = ((await rpc('create', { title: copyTitle, start: 'blank' })) as { summary: BoardSummary }).summary.id;
      const files = Object.fromEntries(Object.entries(captured.files).filter(([key]) => used.has(key as FileId)));
      const result = await rpc('save', { boardId: copyId, baseRevision: 0, pages: captured.pages, activePageId: captured.activePageId, files }) as { revision: number; fileIds: string[]; summary: BoardSummary };
      if (!alive.current) return;
      documentRef.current = { ...captured, id: copyId, revision: result.revision };
      boardIdRef.current = copyId; titleRef.current = copyTitle; setTitle(copyTitle);
      confirmed.current = seq; storedFiles.current = new Set(result.fileIds);
      setStatus(counter.current === seq ? 'saved' : 'saving'); dirty(counter.current !== seq);
      setNotice(t.conflictKeptBoth);
      currentProps.current.onBoardChanged?.(result.summary);
    } catch (thrown) {
      if (copyId) { try { await rpc('delete', { boardId: copyId }); } catch { /* an empty copy may stay in the library */ } }
      if (alive.current) { autoRetryBlocked.current = true; setStatus('failed'); }
      throw thrown;
    }
  }
  useEffect(() => {
    const interval = setInterval(() => { if (!busyRef.current && !autoRetryBlocked.current) void flush().catch(() => {}); }, INTERVAL_MS);
    const hidden = () => { if (document.visibilityState === 'hidden') void flush().catch(() => {}); };
    document.addEventListener('visibilitychange', hidden);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useEffect(() => { alive.current = true; void loadBoard(); return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); }; }, [props.session]);
  useEffect(() => { if (props.flushToken) void exit(); }, [props.flushToken]);
  useEffect(() => { if (props.saveToken) void flush().catch(() => {}); }, [props.saveToken]);
  useEffect(() => {
    if (!props.closeToken) return;
    void (async () => {
      if (busyRef.current) { await currentProps.current.onCloseReady?.(false); return; }
      busyRef.current = true; setBusy(true);
      try { await flush(); await currentProps.current.onCloseReady?.(!dirtyRef.current); }
      catch { await currentProps.current.onCloseReady?.(false); }
      finally { busyRef.current = false; setBusy(false); }
    })();
  }, [props.closeToken]);
  useEffect(() => {
    if (sheet !== 'pages') return;
    let cancelled = false;
    void (async () => {
      for (const page of documentRef.current?.pages ?? []) {
        if (cancelled) return;
        if (page.id in thumbsRef.current) continue;
        const data = await renderThumbnail(page, documentRef.current!.files, props.theme, 200).catch(() => '');
        if (cancelled) return;
        thumbsRef.current = { ...thumbsRef.current, [page.id]: data }; setThumbs(thumbsRef.current);
      }
    })();
    return () => { cancelled = true; };
  }, [sheet, board, pageId]);

  // Leaving is only safe once the newest revision is on disk; a failed save keeps the editor open.
  async function exit() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await flush(); if (dirtyRef.current) return; await currentProps.current.onExit(); }
    catch { /* the title status line already offers retry */ }
    finally { busyRef.current = false; setBusy(false); }
  }
  function focusPage(next: string) {
    requestAnimationFrame(() => shells.current.get(next)?.querySelector<HTMLElement>('.excalidraw')?.focus({ preventScroll: true }));
  }
  function showPage(next: string) {
    const document = documentRef.current;
    if (document && document.activePageId !== next) { documentRef.current = { ...document, activePageId: next }; counter.current += 1; dirty(true); }
    const previous = pageRef.current;
    if (previous && previous !== next && previous in thumbsRef.current) { const rest = { ...thumbsRef.current }; delete rest[previous]; thumbsRef.current = rest; setThumbs(rest); }
    pageRef.current = next; setPageId(next); setMounted(current => current.includes(next) ? current : [...current, next]); setBoard(documentRef.current);
    focusPage(next);
  }
  async function pages(action: 'add' | 'delete' | 'switch', target?: string) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const document = documentRef.current; if (!document) return;
      if (action === 'switch') { showPage(target!); await flush(); return; }
      if (action === 'add') {
        if (document.pages.length >= MAX_PAGES) { setNotice(t.pageCapacity); return; }
        const page = blankPage(newId());
        documentRef.current = { ...document, pages: [...document.pages, page] }; counter.current += 1; dirty(true);
        showPage(page.id); await flush(); return;
      }
      if (document.pages.length <= 1) return;
      const current = pageRef.current, index = document.pages.findIndex(page => page.id === current);
      // Deleting keeps the previous page in view, per the prototype: page 2 of 3 leaves page 1.
      const remaining = document.pages.filter(page => page.id !== current);
      const next = remaining[Math.max(0, index - 1)]!;
      documentRef.current = { ...document, pages: remaining }; counter.current += 1; dirty(true);
      apis.current.delete(current); shells.current.delete(current);
      if (current in thumbsRef.current) { const rest = { ...thumbsRef.current }; delete rest[current]; thumbsRef.current = rest; setThumbs(rest); }
      showPage(next.id); await flush();
    } catch { /* the revision stays dirty and the status line offers retry */ }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function placeImage(result: { file: BinaryFileData; width: number; height: number }) {
      const active = apis.current.get(pageRef.current);
      if (!active) throw new Error('editor_not_ready');
      const state = active.getAppState(), file = result.file;
      const ratio = Math.min(1, 1200 / result.width, 1600 / result.height);
      const elements = convertToExcalidrawElements([{ type: 'image', x: -state.scrollX + 40 / state.zoom.value, y: -state.scrollY + 40 / state.zoom.value, width: result.width * ratio, height: result.height * ratio, fileId: file.id, status: 'saved' }]);
      active.addFiles([file]); active.updateScene({ elements: [...active.getSceneElements(), ...elements], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      active.scrollToContent(elements, { fitToContent: true });
      snapshot(active.getSceneElementsIncludingDeleted(), active.getAppState(), active.getFiles(), pageRef.current);
      await flush();
  }
  async function insertImage(source: 'camera' | 'library') {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      setError(''); setPicking(true);
      const result = await rpc('pick', { source }) as { cancelled?: boolean; file?: BinaryFileData; width?: number; height?: number };
      if (result.cancelled) return;
      validateImage(result.file);
      if (!result.file || !result.width || !result.height) throw new Error('invalid_image');
      await placeImage({ file: result.file, width: result.width, height: result.height });
    } catch { setError(t.imageError); }
    finally { setPicking(false); busyRef.current = false; setBusy(false); }
  }
  const renameText = renameValue.trim();
  async function rename() {
    if (!renameText || renameText.length > MAX_TITLE) return;
    if (renameText === titleRef.current) { setSheet('none'); return; }
    try {
      const result = await rpc('rename', { boardId: boardIdRef.current, title: renameText }) as { summary: BoardSummary };
      titleRef.current = result.summary.title; setTitle(result.summary.title); setError(''); setSheet('none');
      currentProps.current.onBoardChanged?.(result.summary);
    } catch { setError(t.openFailed); setSheet('none'); }
  }

  const shown = board?.pages ?? [], index = Math.max(1, shown.findIndex(page => page.id === pageId) + 1);
  const failed = status === 'failed';
  const statusText = picking ? t.importing : failed ? t.notSaved : status === 'saved' ? t.saved : status === 'saving' ? t.saving : t.opening;
  return <div className={'siyue-board ' + props.theme} style={{ '--wb-safe-top': `${props.safeAreaTop ?? 0}px`, '--wb-safe-bottom': `${props.safeAreaBottom ?? 0}px` } as React.CSSProperties} aria-label={t.boardArea} onDropCapture={e => { e.preventDefault(); e.stopPropagation(); }} onDragOverCapture={e => { e.preventDefault(); e.stopPropagation(); }} onContextMenuCapture={e => { e.preventDefault(); e.stopPropagation(); }}
    onKeyDownCapture={e => { if ((e.metaKey || e.ctrlKey) && ['s', 'o', 'e', 'c', 'x'].includes(e.key.toLowerCase())) { e.preventDefault(); e.stopPropagation(); if (e.key.toLowerCase() === 's') void flush().catch(() => {}); } }}>
    <div className="canvas">
      {mounted.filter(known => shown.some(page => page.id === known)).map(known => {
        const page = documentRef.current?.pages.find(entry => entry.id === known) ?? shown.find(entry => entry.id === known)!;
        return <div key={page.id} className={'page-shell' + (page.id === pageId ? ' on' : '')} aria-hidden={page.id !== pageId}
          ref={node => { if (node) shells.current.set(page.id, node); else shells.current.delete(page.id); }}>
          <Excalidraw excalidrawAPI={value => { if (value) { apis.current.set(page.id, value); if (page.id === pageRef.current && pendingInitialImage.current) {
            const image = pendingInitialImage.current; pendingInitialImage.current = null;
            void placeImage(image).catch(() => { if (alive.current) setError(t.imageError); });
          } } else apis.current.delete(page.id); }}
            initialData={{ elements: page.elements, files: documentRef.current!.files, appState: { ...page.appState, currentItemFontFamily: 2 }, scrollToContent: false }}
            langCode={props.locale === 'zh-CN' ? 'zh-CN' : 'en'} theme={props.theme} aiEnabled={false} isCollaborating={false}
            onChange={(elements, state, files) => snapshot(elements, state, files, page.id)} onLinkOpen={(_, event) => event.preventDefault()} validateEmbeddable={false}
            onPaste={() => false} onPointerDown={tool => { if (['embeddable', 'magicframe', 'image'].includes(tool.type)) apis.current.get(page.id)?.setActiveTool({ type: 'selection' }); }}
            UIOptions={{ canvasActions, tools: simpleTools }}/>
        </div>;
      })}
    </div>
    <div className="wb-top">
      <button className="wb-icon" onClick={() => void exit()} disabled={busy} aria-label={t.back}><Icon name="chevL"/></button>
      <button className="wb-title" onClick={() => { if (failed) void flush().catch(() => {}); else { setRenameValue(titleRef.current); setSheet('rename'); } }}>
        <div>{title || t.opening}</div>
        <small className={failed ? 'bad' : ''}>
          {failed ? <Icon name="warn" size={12} width={2.4}/> : status === 'saved' ? <Icon name="check" size={12} width={2.6}/> : null}{statusText}
        </small>
      </button>
      <button className="wb-pill" onClick={() => setSheet('pages')} disabled={!board || busy} aria-label={t.pages}><Icon name="layers" size={17}/>{index}/{shown.length || 1}</button>
      {props.onStartCall && <button className="wb-icon" onClick={() => void props.onStartCall?.()} disabled={busy} aria-label={t.startCall}><Icon name="video"/></button>}
      <button className="wb-icon" onClick={() => setSheet('insert')} disabled={!board || busy} aria-label={t.insert}><Icon name="plus"/></button>
    </div>
    {(notice || error) && <div className="wb-banners">
      {notice && <div className="wb-banner" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label={t.dismiss}><Icon name="close" size={16} width={2.4}/></button></div>}
      {error && <div className="wb-banner bad" role="alert"><span>{error}</span>
        {!board && <button className="wb-inline" onClick={() => void openRef.current?.()}>{t.retry}</button>}
        <button onClick={() => setError('')} aria-label={t.dismiss}><Icon name="close" size={16} width={2.4}/></button></div>}
    </div>}
    {sheet === 'pages' && <Sheet label={t.pages} onClose={() => setSheet('none')}>
      <h2>{t.pages}</h2>
      <div className="wb-pages">
        {shown.map((page, position) => <button key={page.id} className={'wb-pthumb' + (page.id === pageId ? ' on' : '')} aria-current={page.id === pageId} aria-label={pageLabel(t, position + 1)}
          onClick={() => { setSheet('none'); void pages('switch', page.id); }}>
          {thumbs[page.id] ? <img src={thumbs[page.id]} alt=""/> : <span className="wb-pempty"/>}<em>{position + 1}</em>
        </button>)}
        <button className="wb-pthumb add" onClick={() => { setSheet('none'); void pages('add'); }} aria-label={t.newPage}><Icon name="plus" size={22}/></button>
      </div>
      <div className="wb-btns"><button className="wb-text danger" disabled={shown.length < 2} onClick={() => setSheet('delete')}>{t.deletePage}</button></div>
    </Sheet>}
    {sheet === 'insert' && <Sheet label={t.insert} onClose={() => setSheet('none')}>
      <h2>{t.insert}</h2>
      {props.camera && <button className="wb-row" onClick={() => { setSheet('none'); void insertImage('camera'); }}><Icon name="camera"/><span>{t.insertCamera}</span></button>}
      <button className="wb-row" onClick={() => { setSheet('none'); void insertImage('library'); }}><Icon name="image"/><span>{t.insertLibrary}</span></button>
      <button className="wb-row" onClick={() => { setSheet('none'); void pages('add'); }}><Icon name="layers"/><span>{t.insertBlank}</span></button>
    </Sheet>}
    {sheet === 'rename' && <Sheet label={t.rename} onClose={() => setSheet('none')}>
      <h2>{t.rename}</h2>
      <label className="wb-field"><span>{t.renameLabel}</span>
        <input value={renameValue} maxLength={MAX_TITLE} autoFocus onChange={event => setRenameValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void rename(); } }}/>
      </label>
      <div className="wb-btns"><button onClick={() => setSheet('none')}>{t.cancel}</button>
        <button className="wb-primary" disabled={!renameText} onClick={() => void rename()}>{t.confirm}</button></div>
    </Sheet>}
    {sheet === 'delete' && <div className="wb-sheet-backdrop" onClick={() => setSheet('none')}>
      <div className="wb-sheet" role="alertdialog" aria-modal="true" aria-label={t.deletePage} onClick={event => event.stopPropagation()}>
        <p>{t.deletePageConfirm}</p>
        <div className="wb-btns"><button autoFocus onClick={() => setSheet('none')}>{t.cancel}</button>
          <button className="wb-danger" onClick={() => { setSheet('none'); void pages('delete'); }}>{t.deletePage}</button></div>
      </div>
    </div>}
  </div>;
}
