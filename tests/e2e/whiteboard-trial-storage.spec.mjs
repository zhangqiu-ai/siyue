// Playwright-runner integration of production trial model/storage with real SQLite.
// Native pointer interaction is covered separately by WhiteboardTrialUITests.
import { test, expect } from 'playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoard, appendStroke, addPage, eraseAt } from '../../apps/mobile/src/whiteboard/model.ts';
import { loadBoard, saveBoard, WHITEBOARD_KEY } from '../../apps/mobile/src/whiteboard/storage.ts';

function open(file) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return {
    db,
    getItemSync: key => db.prepare('SELECT value FROM storage WHERE key=?').get(key)?.value ?? null,
    setItemSync: (key, value) => db.prepare('INSERT OR REPLACE INTO storage VALUES (?,?)').run(key, value),
  };
}
const ink = { id: 'ink-1', color: '#25352B', width: 8, points: [{ x: 100, y: 200 }, { x: 900, y: 200 }] };
let dir, storage;
test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'siyue-board-trial-')); storage = open(join(dir, 'kv.sqlite')); });
test.afterEach(async () => { storage.db.close(); await rm(dir, { recursive: true, force: true }); });

test('saved editable ink and exercise pages survive SQLite reopen and can be erased', () => {
  const empty = loadBoard(storage);
  let board = appendStroke(empty, empty.pages[0].id, ink);
  board = addPage(board, 'exercise');
  saveBoard(storage, board);
  storage.db.close(); storage = open(join(dir, 'kv.sqlite'));
  expect(loadBoard(storage)).toEqual(board);
  const erased = eraseAt(loadBoard(storage), board.pages[0].id, { x: 500, y: 200 }, 24);
  saveBoard(storage, erased);
  expect(loadBoard(storage).pages[0].strokes).toEqual([]);
  expect(loadBoard(storage).pages[1].background).toBe('exercise');
  expect(board.pages[0].strokes).toEqual([ink]);
});

test('corrupt and newer originals are rejected and preserved', () => {
  for (const original of ['{broken', '{"schemaVersion":2,"pages":[]}']) {
    storage.setItemSync(WHITEBOARD_KEY, original);
    expect(() => loadBoard(storage)).toThrow();
    expect(() => saveBoard(storage, createBoard())).toThrow();
    expect(storage.getItemSync(WHITEBOARD_KEY)).toBe(original);
  }
});

test('failed SQLite save preserves prior saved board and editable draft for retry', () => {
  const original = createBoard(); saveBoard(storage, original);
  const draft = appendStroke(original, original.pages[0].id, ink);
  storage.db.exec('PRAGMA query_only=ON');
  expect(() => saveBoard(storage, draft)).toThrow();
  expect(loadBoard(storage)).toEqual(original);
  expect(draft.pages[0].strokes).toEqual([ink]);
  storage.db.exec('PRAGMA query_only=OFF');
  saveBoard(storage, draft);
  expect(loadBoard(storage)).toEqual(draft);
});
