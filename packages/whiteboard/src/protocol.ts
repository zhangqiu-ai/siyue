// Platform-neutral, local-device editing protocol. This grants no family-room permissions.
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
export type ViewState = Pick<AppState, 'viewBackgroundColor' | 'scrollX' | 'scrollY' | 'zoom'>;
export type Page = { id: string; elements: readonly ExcalidrawElement[]; appState: ViewState };
export type Board = { schemaVersion: 2; editor: 'excalidraw-0.18.1'; id: string; revision: number; activePageId:string; pages: Page[]; files: BinaryFiles };
export type BridgeRequest = { version: 1; session: string; requestId: string; op: 'load' | 'save' | 'pick'; payload?: unknown };
export type Reply = { version: 1; requestId: string; ok: boolean; value?: unknown; error?: string };
export type Transport = (message: string) => Promise<string>;
export const KEY = 'siyue.whiteboard.excalidraw.v2';
export const MAX_MESSAGE = 32 * 1024 * 1024;
export const MAX_IMAGE = 8 * 1024 * 1024;
const types = new Set(['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'freedraw', 'text', 'image', 'frame']);
const identifier = (x: unknown): x is string => typeof x === 'string' && /^[\w-]{1,100}$/.test(x);
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
function requireValue(value: unknown, reason = 'invalid_data'): asserts value { if (!value) throw new Error(reason); }
export function blankPage(id: string): Page {
  return { id, elements: [], appState: { viewBackgroundColor: '#fffefa', scrollX: 0, scrollY: 0, zoom: { value: 1 as AppState['zoom']['value'] } } };
}
export function emptyBoard(): Board { return { schemaVersion: 2, editor: 'excalidraw-0.18.1', id: 'local-whiteboard', revision: 0, activePageId:'page-1', pages: [blankPage('page-1')], files: {} }; }
export function viewState(state: AppState | ViewState): ViewState {
  return { viewBackgroundColor: state.viewBackgroundColor, scrollX: state.scrollX, scrollY: state.scrollY, zoom: { value: state.zoom.value } };
}
export function validateImage(value: unknown) {
  requireValue(record(value));
  requireValue(identifier(value.id) && typeof value.created === 'number' && Number.isFinite(value.created));
  requireValue(typeof value.dataURL === 'string' && value.dataURL.length <= MAX_IMAGE * 4 / 3 + 100, 'image_too_large');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.dataURL);
  requireValue(match && match[1] === value.mimeType, 'invalid_image');
  const prefix = match[2]!;
  requireValue((value.mimeType === 'image/png' && prefix.startsWith('iVBORw0KGgo')) ||
    (value.mimeType === 'image/jpeg' && prefix.startsWith('/9j/')) ||
    (value.mimeType === 'image/webp' && prefix.startsWith('UklGR')), 'invalid_image');
}
export function validateBoard(value: unknown): Board {
  requireValue(record(value));
  requireValue(value.schemaVersion === 2 && value.editor === 'excalidraw-0.18.1', 'unsupported_schema');
  requireValue(value.id === 'local-whiteboard' && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0);
  requireValue(Array.isArray(value.pages) && value.pages.length > 0 && value.pages.length <= 30);
  requireValue(record(value.files) && Object.keys(value.files).length <= 100);
  for (const [key, file] of Object.entries(value.files)) { validateImage(file); requireValue(record(file) && key === file.id); }
  const ids = new Set<string>();
  for (const page of value.pages) {
    requireValue(record(page) && identifier(page.id) && !ids.has(page.id)); ids.add(page.id);
    requireValue(Array.isArray(page.elements) && page.elements.length <= 5000);
    const elementIds = new Set<string>();
    for (const element of page.elements) {
      requireValue(record(element) && identifier(element.id) && !elementIds.has(element.id)); elementIds.add(element.id);
      requireValue(typeof element.type === 'string' && types.has(element.type), 'unsupported_element');
      requireValue(element.link === null || element.link === undefined, 'external_content');
      for (const key of ['x', 'y', 'width', 'height', 'angle', 'version']) requireValue(typeof element[key] === 'number' && Number.isFinite(element[key]) && Math.abs(element[key]) <= 1e8);
      if (element.type === 'image') requireValue(typeof element.fileId === 'string' && Object.hasOwn(value.files, element.fileId), 'missing_image');
      if (element.type === 'text') requireValue(typeof element.text === 'string' && element.text.length <= 100000);
      if (element.type === 'freedraw' || element.type === 'line' || element.type === 'arrow') {
        requireValue(Array.isArray(element.points) && element.points.length <= 100000);
        for (const point of element.points) requireValue(Array.isArray(point) && point.length === 2 && point.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e8));
      }
    }
    const state = page.appState;
    requireValue(record(state) && Object.keys(state).every(k => ['viewBackgroundColor', 'scrollX', 'scrollY', 'zoom'].includes(k)));
    requireValue(typeof state.viewBackgroundColor === 'string' && /^#[\da-f]{3,8}$/i.test(state.viewBackgroundColor));
    requireValue(Number.isFinite(state.scrollX) && Number.isFinite(state.scrollY) && record(state.zoom) && Number.isFinite(state.zoom.value) && Number(state.zoom.value) >= 0.1 && Number(state.zoom.value) <= 30);
  }
  requireValue(JSON.stringify(value).length <= MAX_MESSAGE, 'capacity');
  const activePageId=value.activePageId??value.pages[0].id;
  requireValue(typeof activePageId==='string'&&ids.has(activePageId));
  return {...value,activePageId} as unknown as Board;
}
export function parseBoard(raw: string): Board { requireValue(raw.length <= MAX_MESSAGE, 'capacity'); return validateBoard(JSON.parse(raw)); }
export interface Storage { getItemSync(key: string): string | null; setItemSync(key: string, value: string): void }
export function createService(storage: Storage, session: string, pick: (source: 'camera' | 'library') => Promise<unknown>) {
  let active = true, loaded = false;
  const receipts = new Map<string, { message: string; reply: string }>();
  return {
    dispose: () => { active = false; },
    async request(message: string): Promise<string> {
      let requestId = '';
      try {
        requireValue(typeof message === 'string' && message.length <= MAX_MESSAGE, 'capacity');
        const req: unknown = JSON.parse(message);
        requireValue(record(req) && req.version === 1 && identifier(req.requestId)); requestId = req.requestId;
        requireValue(active && req.session === session, 'stale_session');
        const receipt = receipts.get(requestId);
        if (receipt) { requireValue(receipt.message === message, 'request_conflict'); return receipt.reply; }
        let value: unknown;
        if (req.op === 'load') {
          const raw = storage.getItemSync(KEY);
          value = { board: raw === null ? null : parseBoard(raw) };
          loaded = true;

        } else if (req.op === 'pick') {
          requireValue(loaded && record(req.payload) && ['camera', 'library'].includes(String(req.payload.source)));
          value = await pick(req.payload.source as 'camera' | 'library'); requireValue(active, 'stale_session');
        } else if (req.op === 'save') {
          requireValue(loaded && record(req.payload), 'not_loaded');
          const raw = storage.getItemSync(KEY);
          const previous = raw === null ? emptyBoard() : parseBoard(raw);
          requireValue(req.payload.baseRevision === previous.revision, 'revision_conflict');
          requireValue(record(req.payload.files));
          for (const [id, file] of Object.entries(req.payload.files)) {
            validateImage(file);
            requireValue(!previous.files[id] || JSON.stringify(previous.files[id]) === JSON.stringify(file), 'file_conflict');
          }
          requireValue(Array.isArray(req.payload.pages));
          const referenced=new Set(req.payload.pages.flatMap(page=>record(page)&&Array.isArray(page.elements)?page.elements.filter(e=>record(e)&&e.type==='image').map(e=>e.fileId):[]));
          const completeFiles=Object.fromEntries(Object.entries({...previous.files,...req.payload.files}).filter(([id])=>referenced.has(id)));
          const next = validateBoard({ ...previous, revision: previous.revision + 1, pages: req.payload.pages, activePageId:req.payload.activePageId??previous.activePageId, files: completeFiles });
          // One synchronous atomic SQLite/KV replacement. No async gap between compare and write.
          storage.setItemSync(KEY, JSON.stringify(next)); value = { revision: next.revision, fileIds:Object.keys(next.files) };
        } else throw new Error('unsupported_operation');
        const reply = JSON.stringify({ version: 1, requestId, ok: true, value });
        if (req.op === 'save') { receipts.set(requestId, { message, reply }); if (receipts.size > 1) receipts.delete(receipts.keys().next().value!); }
        return reply;
      } catch (error) {
        const known = new Set(['invalid_data','image_too_large','invalid_image','unsupported_schema','unsupported_element','external_content','missing_image','capacity','stale_session','request_conflict','not_loaded','revision_conflict','file_conflict','unsupported_operation','permission_denied','camera_unavailable']);
        const code = error instanceof Error && known.has(error.message) ? error.message : 'storage_or_read_failed';
        return JSON.stringify({ version: 1, requestId, ok: false, error: code });
      }
    },
  };
}
