// Platform-neutral, local-device editing protocol. This grants no family-room permissions.
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
export type ViewState = Pick<AppState, 'viewBackgroundColor' | 'scrollX' | 'scrollY' | 'zoom'>;
export type Page = { id: string; elements: readonly ExcalidrawElement[]; appState: ViewState };
export type Board = { schemaVersion: 2; editor: 'excalidraw-0.18.1'; id: string; revision: number; activePageId: string; pages: Page[]; files: BinaryFiles };
/** Board-library metadata. Holds no page content, so `list` stays cheap and safe to call often. */
export type BoardSummary = { id: string; title: string; pageCount: number; updatedAt: string; thumbnail?: string };
export type BoardIndex = { schemaVersion: 1; boards: BoardSummary[] };
export type BoardStart = 'blank' | 'photo' | 'library';
export type BridgeOp = 'list' | 'create' | 'rename' | 'delete' | 'load' | 'save' | 'pick';
export type BridgeRequest = { version: 1; session: string; requestId: string; op: BridgeOp; payload?: unknown };
export type Reply = { version: 1; requestId: string; ok: boolean; value?: unknown; error?: string };
export type Transport = (message: string) => Promise<string>;
/** Legacy single-board body, kept byte for byte after migration so a rollback still finds it. */
export const KEY = 'siyue.whiteboard.excalidraw.v2';
export const INDEX_KEY = 'siyue.whiteboard.boards.v1';
export const BOARD_KEY_PREFIX = 'siyue.whiteboard.board.';
export const MAX_BOARDS = 200;
export const MAX_TITLE = 80;
export const MAX_THUMBNAIL = 64 * 1024;
export const MAX_PAGES = 30;
export const MAX_MESSAGE = 32 * 1024 * 1024;
export const MAX_IMAGE = 8 * 1024 * 1024;
const BOARD_KEY = /^siyue\.whiteboard\.board\.[\w-]{1,100}\.v2$/;
const TITLE_CONTROL = /[\u0000-\u001f\u007f]/;
const THUMBNAIL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export const boardKey = (id: string) => `${BOARD_KEY_PREFIX}${id}.v2`;
/** Exactly the keys a host storage adapter may be asked for. Anything else is a programming error. */
export const isStorageKey = (key: string) => key === INDEX_KEY || key === KEY || BOARD_KEY.test(key);
const types = new Set(['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'freedraw', 'text', 'image', 'frame']);
const identifier = (x: unknown): x is string => typeof x === 'string' && /^[\w-]{1,100}$/.test(x);
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
function requireValue(value: unknown, reason = 'invalid_data'): asserts value { if (!value) throw new Error(reason); }
export function blankPage(id: string): Page {
  return { id, elements: [], appState: { viewBackgroundColor: '#fffefa', scrollX: 0, scrollY: 0, zoom: { value: 1 as AppState['zoom']['value'] } } };
}
export function emptyBoard(id = 'local-whiteboard'): Board { return { schemaVersion: 2, editor: 'excalidraw-0.18.1', id, revision: 0, activePageId: 'page-1', pages: [blankPage('page-1')], files: {} }; }
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
  requireValue(identifier(value.id) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0);
  requireValue(Array.isArray(value.pages) && value.pages.length > 0 && value.pages.length <= MAX_PAGES);
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
  const activePageId = value.activePageId ?? value.pages[0].id;
  requireValue(typeof activePageId === 'string' && ids.has(activePageId));
  return { ...value, activePageId } as unknown as Board;
}
export function parseBoard(raw: string): Board { requireValue(raw.length <= MAX_MESSAGE, 'capacity'); return validateBoard(JSON.parse(raw)); }
export function normalizeTitle(value: unknown): string {
  requireValue(typeof value === 'string');
  const title = value.trim();
  requireValue(title.length >= 1 && title.length <= MAX_TITLE && !TITLE_CONTROL.test(title));
  return title;
}
/** Thumbnails are decoration: a malformed or oversized one is dropped instead of blocking the save. */
export function optionalThumbnail(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_THUMBNAIL && THUMBNAIL.test(value) ? value : undefined;
}
export function validateSummary(value: unknown): BoardSummary {
  requireValue(record(value));
  requireValue(identifier(value.id));
  const title = normalizeTitle(value.title);
  requireValue(Number.isSafeInteger(value.pageCount) && Number(value.pageCount) >= 1 && Number(value.pageCount) <= MAX_PAGES);
  requireValue(typeof value.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value.updatedAt) && Number.isFinite(Date.parse(value.updatedAt)));
  requireValue(value.thumbnail === undefined || optionalThumbnail(value.thumbnail) !== undefined);
  return { id: value.id, title, pageCount: Number(value.pageCount), updatedAt: value.updatedAt, ...(value.thumbnail === undefined ? {} : { thumbnail: value.thumbnail as string }) };
}
export function validateIndex(value: unknown): BoardIndex {
  requireValue(record(value) && value.schemaVersion === 1 && Array.isArray(value.boards));
  requireValue(value.boards.length <= MAX_BOARDS, 'capacity');
  const ids = new Set<string>();
  for (const entry of value.boards) { const summary = validateSummary(entry); requireValue(!ids.has(summary.id)); ids.add(summary.id); }
  return { schemaVersion: 1, boards: value.boards.map(validateSummary) };
}
export function parseIndex(raw: string): BoardIndex { requireValue(raw.length <= MAX_MESSAGE, 'capacity'); return validateIndex(JSON.parse(raw)); }
/** Library order: most recently edited first, with the id as a stable tie-break. */
export const sortSummaries = (boards: readonly BoardSummary[]) =>
  [...boards].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
export interface Storage { getItemSync(key: string): string | null; setItemSync(key: string, value: string): void; removeItemSync(key: string): void }
export type ServiceOptions = { newId?: () => string; now?: () => string };
const defaultId = () => {
  const source = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (source && typeof source.randomUUID === 'function') return source.randomUUID();
  return `board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};
export function createService(storage: Storage, session: string, pick: (source: 'camera' | 'library') => Promise<unknown>, options: ServiceOptions = {}) {
  const newId = options.newId ?? defaultId, now = options.now ?? (() => new Date().toISOString());
  let active = true, loaded = false;
  const receipts = new Map<string, { message: string; reply: string }>();
  // Mutating operations are replay-safe through the receipt table, including the library operations.
  const deduped = new Set(['save', 'create', 'rename', 'delete']);
  const readIndex = () => { const raw = storage.getItemSync(INDEX_KEY); return raw === null ? null : parseIndex(raw); };
  const writeIndex = (boards: BoardSummary[]) => storage.setItemSync(INDEX_KEY, JSON.stringify(validateIndex({ schemaVersion: 1, boards })));
  const requireIndex = () => { const index = readIndex(); requireValue(index !== null, 'not_loaded'); return index as BoardIndex; };
  const locate = (index: BoardIndex, value: unknown) => {
    requireValue(identifier(value));
    const summary = index.boards.find(entry => entry.id === value);
    requireValue(summary, 'not_found');
    return summary as BoardSummary;
  };
  // First list after an upgrade adopts the single legacy board. The legacy key is left untouched.
  function listWithMigration(defaultTitle: unknown): BoardIndex {
    const existing = readIndex();
    if (existing) return existing;
    const legacy = storage.getItemSync(KEY);
    const body = legacy === null ? null : parseBoard(legacy);
    // The title is resolved before anything is written, so a refused migration leaves no trace.
    const boards: BoardSummary[] = body === null ? [] : [{ id: body.id, title: normalizeTitle(defaultTitle), pageCount: body.pages.length, updatedAt: now() }];
    // Body first, index second: an interrupted migration is retried, never left half-pointed.
    if (body !== null) storage.setItemSync(boardKey(body.id), JSON.stringify(body));
    writeIndex(boards);
    return { schemaVersion: 1, boards };
  }
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
        const payload = record(req.payload) ? req.payload : undefined;
        let value: unknown;
        if (req.op === 'list') {
          value = { boards: sortSummaries(listWithMigration(payload?.defaultTitle).boards) };
          loaded = true;
        } else if (req.op === 'create') {
          requireValue(loaded && payload, 'not_loaded');
          const index = requireIndex();
          requireValue(index.boards.length < MAX_BOARDS, 'capacity');
          const start = payload.start;
          requireValue(start === 'blank' || start === 'photo' || start === 'library');
          const title = normalizeTitle(payload.title);
          let id = newId();
          for (let guard = 0; !identifier(id) || index.boards.some(entry => entry.id === id); guard += 1) { requireValue(guard < 1000); id = newId(); }
          const body = emptyBoard(id);
          const summary: BoardSummary = { id, title, pageCount: body.pages.length, updatedAt: now() };
          storage.setItemSync(boardKey(id), JSON.stringify(body));
          writeIndex([...index.boards, summary]);
          value = { summary, start };
        } else if (req.op === 'rename') {
          requireValue(loaded && payload, 'not_loaded');
          const index = requireIndex(), current = locate(index, payload.boardId), title = normalizeTitle(payload.title);
          const summary: BoardSummary = { ...current, title };
          writeIndex(index.boards.map(entry => entry.id === current.id ? summary : entry));
          value = { summary };
        } else if (req.op === 'delete') {
          requireValue(loaded && payload, 'not_loaded');
          const index = requireIndex(), current = locate(index, payload.boardId);
          writeIndex(index.boards.filter(entry => entry.id !== current.id));
          // The logical delete is already committed, so an unreferenced body is only wasted space,
          // never something a later load can still read.
          try { storage.removeItemSync(boardKey(current.id)); } catch { /* unreferenced body kept */ }
          value = { deleted: true };
        } else if (req.op === 'load') {
          requireValue(loaded && payload, 'not_loaded');
          const index = requireIndex(), summary = locate(index, payload.boardId);
          const raw = storage.getItemSync(boardKey(summary.id));
          requireValue(raw !== null, 'not_found');
          value = { board: parseBoard(raw), summary };
        } else if (req.op === 'pick') {
          requireValue(loaded && payload && ['camera', 'library'].includes(String(payload.source)));
          value = await pick(payload.source as 'camera' | 'library'); requireValue(active, 'stale_session');
        } else if (req.op === 'save') {
          requireValue(loaded && payload, 'not_loaded');
          const index = requireIndex(), summary = locate(index, payload.boardId);
          const raw = storage.getItemSync(boardKey(summary.id));
          requireValue(raw !== null, 'not_found');
          const previous = parseBoard(raw);
          requireValue(payload.baseRevision === previous.revision, 'revision_conflict');
          requireValue(record(payload.files));
          for (const [id, file] of Object.entries(payload.files)) {
            validateImage(file);
            requireValue(!previous.files[id] || JSON.stringify(previous.files[id]) === JSON.stringify(file), 'file_conflict');
          }
          requireValue(Array.isArray(payload.pages));
          const referenced = new Set(payload.pages.flatMap(page => record(page) && Array.isArray(page.elements) ? page.elements.filter(e => record(e) && e.type === 'image').map(e => e.fileId) : []));
          const completeFiles = Object.fromEntries(Object.entries({ ...previous.files, ...payload.files }).filter(([id]) => referenced.has(id)));
          const next = validateBoard({ ...previous, revision: previous.revision + 1, pages: payload.pages, activePageId: payload.activePageId ?? previous.activePageId, files: completeFiles });
          const thumbnail = optionalThumbnail(payload.thumbnail);
          const updated: BoardSummary = { ...summary, pageCount: next.pages.length, updatedAt: now(), ...(thumbnail === undefined ? {} : { thumbnail }) };
          // Index first: if the large body write fails, the next attempt still sees the old revision
          // and can retry the same base instead of being locked out by a bumped revision.
          writeIndex(index.boards.map(entry => entry.id === summary.id ? updated : entry));
          // One synchronous atomic SQLite/KV replacement. No async gap between compare and write.
          storage.setItemSync(boardKey(summary.id), JSON.stringify(next)); value = { revision: next.revision, fileIds: Object.keys(next.files), summary: updated };
        } else throw new Error('unsupported_operation');
        const reply = JSON.stringify({ version: 1, requestId, ok: true, value });
        if (deduped.has(String(req.op))) { receipts.set(requestId, { message, reply }); if (receipts.size > 8) receipts.delete(receipts.keys().next().value!); }
        return reply;
      } catch (error) {
        const known = new Set(['invalid_data', 'image_too_large', 'invalid_image', 'unsupported_schema', 'unsupported_element', 'external_content', 'missing_image', 'capacity', 'stale_session', 'request_conflict', 'not_loaded', 'not_found', 'revision_conflict', 'file_conflict', 'unsupported_operation', 'permission_denied', 'camera_unavailable']);
        const code = error instanceof Error && known.has(error.message) ? error.message : 'storage_or_read_failed';
        return JSON.stringify({ version: 1, requestId, ok: false, error: code });
      }
    },
  };
}
