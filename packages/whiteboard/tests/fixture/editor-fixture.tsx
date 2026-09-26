// Browser fixture for the editor chrome. The host transport is a faithful in-page stub of the
// bridge protocol so the spec can assert what the editor asked the host to store, and can inject
// a revision conflict or a failing write without any real device.
import React from 'react';
import { createRoot } from 'react-dom/client';
import Editor, { boardStrings } from '../../src/Editor';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=';
type Body = { id: string; title: string; revision: number; updatedAt: string; activePageId: string; pages: any[]; files: Record<string, any> };
type Options = { boardId?: string; startWith?: string; camera?: boolean; conflictOnce?: boolean; saveFails?: number; pickCancels?: boolean; onExit?: () => void };
type Save = { boardId: string; baseRevision: number; revision: number; thumbnail: boolean; files: string[]; count: number[]; activePageId: string };

const state = {
  bodies: new Map<string, Body>(),
  ops: [] as string[],
  saves: [] as Save[],
  picks: [] as string[],
  creates: [] as string[],
  renames: [] as string[],
  deletes: [] as string[],
  exits: 0,
  options: { camera: false } as Options,
};
const blankPage = (id: string) => ({ id, elements: [], appState: { viewBackgroundColor: '#fffefa', scrollX: 0, scrollY: 0, zoom: { value: 1 } } });
let counter = 0;
function createBody(title: string) {
  counter += 1;
  const body: Body = { id: 'board-' + counter, title, revision: 0, updatedAt: new Date(Date.UTC(2026, 8, 25, 10, counter)).toISOString(), activePageId: 'page-' + counter + '-1', pages: [blankPage('page-' + counter + '-1')], files: {} };
  state.bodies.set(body.id, body);
  return body;
}
const summary = (body: Body) => ({ id: body.id, title: body.title, pageCount: body.pages.length, updatedAt: body.updatedAt });
const ordered = () => [...state.bodies.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));

async function transport(message: string) {
  const request = JSON.parse(message);
  const payload = request.payload ?? {};
  state.ops.push(request.op);
  const ok = (value: unknown) => JSON.stringify({ version: 1, requestId: request.requestId, ok: true, value });
  const no = (error: string) => JSON.stringify({ version: 1, requestId: request.requestId, ok: false, error });
  if (request.op === 'list') return ok({ boards: ordered().map(summary) });
  if (request.op === 'create') { const body = createBody(payload.title); state.creates.push(body.title); return ok({ summary: summary(body), start: payload.start }); }
  if (request.op === 'load') {
    const body = state.bodies.get(payload.boardId);
    return body ? ok({ board: { schemaVersion: 2, editor: 'excalidraw-0.18.1', ...body }, summary: summary(body) }) : no('not_found');
  }
  if (request.op === 'save') {
    const body = state.bodies.get(payload.boardId);
    if (!body) return no('not_found');
    if (state.options.conflictOnce) { state.options.conflictOnce = false; return no('revision_conflict'); }
    if (state.options.saveFails) { state.options.saveFails -= 1; return no('storage_or_read_failed'); }
    if (payload.baseRevision !== body.revision) return no('revision_conflict');
    body.revision += 1;
    body.pages = payload.pages;
    body.activePageId = payload.activePageId ?? body.activePageId;
    body.files = { ...body.files, ...(payload.files ?? {}) };
    body.updatedAt = new Date(Date.UTC(2026, 8, 25, 11, body.revision)).toISOString();
    state.saves.push({ boardId: body.id, baseRevision: payload.baseRevision, revision: body.revision, thumbnail: typeof payload.thumbnail === 'string', files: Object.keys(payload.files ?? {}), activePageId: body.activePageId,
      count: payload.pages.map((entry: any) => entry.elements.filter((element: any) => !element.isDeleted).length) });
    return ok({ revision: body.revision, fileIds: Object.keys(body.files), summary: summary(body) });
  }
  if (request.op === 'rename') {
    const body = state.bodies.get(payload.boardId);
    if (!body) return no('not_found');
    state.renames.push(payload.title); body.title = payload.title;
    return ok({ summary: summary(body) });
  }
  if (request.op === 'delete') {
    if (!state.bodies.has(payload.boardId)) return no('not_found');
    state.deletes.push(payload.boardId); state.bodies.delete(payload.boardId);
    return ok({ deleted: true });
  }
  if (request.op === 'pick') {
    state.picks.push(payload.source);
    if (state.options.pickCancels) return ok({ cancelled: true });
    return ok({ file: { id: 'file-1', mimeType: 'image/png', dataURL: PNG, created: 1758700000000 }, width: 400, height: 300 });
  }
  return no('unsupported_operation');
}

const root = createRoot(document.getElementById('root')!);
let mountCount = 0;
function mount(options: Options = {}) {
  mountCount += 1;
  state.options = { camera: false, ...options };
  root.render(<Editor key={mountCount} session="fixture" request={transport} locale="zh-CN" strings={boardStrings('zh-CN')} theme="light"
    camera={!!options.camera} boardId={options.boardId} startWith={options.startWith as never}
    onExit={async () => { state.exits += 1; state.ops.push('exit'); options.onExit?.() }} onDirty={() => {}}/>);
}
(window as unknown as { __fixture: unknown }).__fixture = {
  state,
  mount,
  body: (id: string) => state.bodies.get(id),
  snapshot: () => ({
    ops: [...state.ops],
    saves: state.saves.map(save => ({ ...save })),
    picks: [...state.picks],
    creates: [...state.creates],
    renames: [...state.renames],
    deletes: [...state.deletes],
    exits: state.exits,
    boards: ordered().map(body => ({ id: body.id, title: body.title, revision: body.revision, pageCount: body.pages.length, count: body.pages.map(entry => entry.elements.filter((element: any) => !element.isDeleted).length) })),
  }),
};
mount();
