import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BoardError,
  addPage,
  appendStroke,
  createBoard,
  eraseAt,
  parseBoard,
  serializeBoard,
} from '../src/whiteboard/model.ts';

const reject = (run, pattern) =>
  assert.throws(run, (error) => error instanceof BoardError && pattern.test(error.message));
const point = (x, y) => ({ x, y });
const stroke = (overrides = {}) => ({ id: 'stroke-a', color: '#112233', width: 4, points: [point(0, 0), point(10, 10)], ...overrides });
const appendToFirst = (doc, value) => appendStroke(doc, doc.pages[0].id, value);
const repeat = (count, factory) => Array.from({ length: count }, (_, index) => factory(index));
const rawBoard = (pages) => JSON.stringify({ schemaVersion: 1, pages });
const rawStroke = (id, points) => ({ id, color: '#000000', width: 1, points });

test('createBoard 生成单页空白文档，尺寸常量与序列化往返一致', () => {
  const board = createBoard();
  assert.equal(BOARD_WIDTH, 1000);
  assert.equal(BOARD_HEIGHT, 1400);
  assert.equal(board.schemaVersion, 1);
  assert.equal(board.pages.length, 1);
  assert.equal(board.pages[0].background, 'blank');
  assert.deepEqual(board.pages[0].strokes, []);
  assert.match(board.pages[0].id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  assert.deepEqual(parseBoard(serializeBoard(board)), board);
});

test('parseBoard 拒绝损坏 JSON、未知 schema 与未知字段', () => {
  reject(() => parseBoard('{'), /JSON/);
  reject(() => parseBoard('null'), /必须/);
  reject(() => parseBoard('[]'), /必须/);
  reject(() => parseBoard(JSON.stringify({ schemaVersion: 2, pages: [] })), /schemaVersion/);
  reject(() => parseBoard(JSON.stringify({ pages: [] })), /schemaVersion/);
  reject(() => parseBoard(JSON.stringify({ schemaVersion: 1 })), /pages/);
  reject(() => parseBoard(rawBoard([])), /页数/);
  reject(() => parseBoard(JSON.stringify({ ...createBoard(), extra: true })), /未知字段/);
  reject(() => parseBoard(JSON.stringify({ schemaVersion: 1, pages: [{ id: 'page-a', background: 'blank', strokes: [], note: 'x' }] })), /未知字段/);
  reject(() => parseBoard(rawBoard([{ id: 'page-a', background: 'grid', strokes: [] }])), /background/);
});

test('坐标与笔参数执行有界校验，越界值不静默截断', () => {
  const board = createBoard();
  const pageId = board.pages[0].id;
  const edge = appendStroke(board, pageId, stroke({ color: '#abcdef', width: 1, points: [point(0, 0), point(BOARD_WIDTH, BOARD_HEIGHT)] }));
  assert.deepEqual(parseBoard(serializeBoard(edge)), edge);

  reject(() => appendStroke(board, pageId, stroke({ points: [point(0, 0), point(BOARD_WIDTH + 1, 0)] })), /超出/);
  reject(() => appendStroke(board, pageId, stroke({ points: [point(0, BOARD_HEIGHT + 1)] })), /超出/);
  reject(() => appendStroke(board, pageId, stroke({ points: [point(-1, 0)] })), /超出/);
  reject(() => appendStroke(board, pageId, stroke({ points: [point(Number.NaN, 0)] })), /有限/);
  reject(() => appendStroke(board, pageId, stroke({ points: [point(0, Number.POSITIVE_INFINITY)] })), /有限/);
  reject(() => appendStroke(board, pageId, stroke({ points: [{ x: 1 }] })), /有限/);
  reject(() => appendStroke(board, pageId, stroke({ points: [{ x: 1, y: 1, z: 1 }] })), /未知字段/);
  reject(() => appendStroke(board, pageId, stroke({ points: [] })), /点数/);
  reject(() => appendStroke(board, pageId, stroke({ points: '0,0' })), /points/);
  reject(() => appendStroke(board, pageId, stroke({ color: '#abc' })), /#RRGGBB/);
  reject(() => appendStroke(board, pageId, stroke({ color: '112233' })), /#RRGGBB/);
  reject(() => appendStroke(board, pageId, stroke({ width: 0 })), /width/);
  reject(() => appendStroke(board, pageId, stroke({ width: 31 })), /width/);
  reject(() => appendStroke(board, pageId, stroke({ width: '4' })), /width/);
  reject(() => appendStroke(board, pageId, stroke({ id: 'bad id' })), /id/);
});

test('appendStroke 返回新文档，深拷贝输入笔并强制总量上限', () => {
  const board = createBoard();
  const pageId = board.pages[0].id;
  const snapshot = structuredClone(board);
  const input = stroke();
  const next = appendStroke(board, pageId, input);

  assert.deepEqual(board, snapshot);
  assert.equal(next.pages[0].strokes.length, 1);
  assert.notEqual(next, board);
  assert.notEqual(next.pages[0], board.pages[0]);

  input.id = 'renamed';
  input.points.push(point(999, 999));
  assert.equal(next.pages[0].strokes[0].id, 'stroke-a');
  assert.deepEqual(next.pages[0].strokes[0].points, [point(0, 0), point(10, 10)]);
  assert.deepEqual(board.pages[0].strokes, []);

  assert.equal(appendToFirst(next, stroke({ id: 'stroke-b' })).pages[0].strokes.length, 2);
  assert.equal(next.pages[0].strokes.length, 1);
  reject(() => appendStroke(board, 'missing-page', stroke()), /找不到页/);
  reject(() => appendStroke(next, pageId, stroke()), /重复的笔 id/);
  reject(() => appendToFirst(board, stroke({ points: repeat(601, () => point(1, 1)) })), /点数/);
  assert.equal(appendToFirst(board, stroke({ points: repeat(600, () => point(1, 1)) })).pages[0].strokes[0].points.length, 600);
});

test('页数、总笔数与总点数上限拒绝，超限文档解析失败', () => {
  let board = createBoard();
  board = repeat(400, (index) => index).reduce((doc, index) => appendToFirst(doc, stroke({ id: `s-${index}`, points: [point(0, 0)] })), board);
  assert.equal(board.pages[0].strokes.length, 400);
  const frozen = structuredClone(board);
  reject(() => appendToFirst(board, stroke({ id: 's-400', points: [point(0, 0)] })), /总笔数/);
  assert.deepEqual(board, frozen);

  let dense = createBoard();
  const chunk = (id) => stroke({ id, points: repeat(600, (index) => point(index, index)) });
  dense = repeat(33, (index) => index).reduce((doc, index) => appendToFirst(doc, chunk(`dense-${index}`)), dense);
  assert.equal(dense.pages[0].strokes.length, 33);
  const denseFrozen = structuredClone(dense);
  reject(() => appendToFirst(dense, chunk('dense-33')), /总点数/);
  assert.deepEqual(dense, denseFrozen);

  const page = (id, strokes) => ({ id, background: 'blank', strokes });
  reject(() => parseBoard(rawBoard(repeat(11, (index) => page(`page-${index}`, [])))), /页数/);
  reject(() => parseBoard(rawBoard(repeat(2, () => page('page-a', [])))), /重复的页 id/);
  reject(() => parseBoard(rawBoard([page('page-a', [rawStroke('s-1', [point(0, 0)]), rawStroke('s-1', [point(1, 1)])])])), /重复的笔 id/);
  reject(() => parseBoard(rawBoard([page('page-a', [rawStroke('s-1', repeat(601, () => point(0, 0)))])])), /点数/);
  reject(
    () => parseBoard(rawBoard([page('page-a', repeat(34, (index) => rawStroke(`over-${index}`, repeat(600, () => point(0, 0)))))])),
    /总点数/,
  );
});

test('eraseAt 按线段距离整笔删除，而不是只比对采样点', () => {
  const board = appendToFirst(createBoard(), stroke({ id: 'long', points: [point(100, 100), point(900, 100)] }));
  const pageId = board.pages[0].id;
  const snapshot = structuredClone(board);

  // 擦除点距两个采样点各 400，但距线段只有 20，落在半径 30 内。
  const hit = eraseAt(board, pageId, point(500, 120), 30);
  assert.deepEqual(hit.pages[0].strokes, []);
  assert.deepEqual(board, snapshot);
  assert.equal(board.pages[0].strokes.length, 1);

  const miss = eraseAt(board, pageId, point(500, 300), 30);
  assert.equal(miss.pages[0].strokes.length, 1);
  assert.notEqual(miss, board);
  assert.notEqual(miss.pages[0], board.pages[0]);
  assert.deepEqual(miss.pages[0].strokes[0].points, [point(100, 100), point(900, 100)]);

  assert.equal(eraseAt(board, pageId, point(940, 100), 30).pages[0].strokes.length, 1);
  assert.equal(eraseAt(board, pageId, point(930, 100), 30).pages[0].strokes.length, 0);

  const dot = appendToFirst(createBoard(), stroke({ id: 'dot', points: [point(10, 10)] }));
  const dotPage = dot.pages[0].id;
  assert.equal(eraseAt(dot, dotPage, point(12, 12), 5).pages[0].strokes.length, 0);
  assert.equal(eraseAt(dot, dotPage, point(30, 30), 5).pages[0].strokes.length, 1);
  reject(() => eraseAt(dot, dotPage, point(-1, 0), 5), /超出/);
  reject(() => eraseAt(dot, dotPage, point(0, 0), 0), /半径/);
  reject(() => eraseAt(dot, dotPage, point(0, 0), Number.NaN), /半径/);
  reject(() => eraseAt(dot, 'missing-page', point(0, 0), 5), /找不到页/);
});

test('addPage 校验背景与页数上限，且不改动原文档', () => {
  const board = createBoard();
  const snapshot = structuredClone(board);
  const exercise = addPage(board, 'exercise');
  assert.equal(exercise.pages.length, 2);
  assert.equal(exercise.pages[1].background, 'exercise');
  assert.deepEqual(exercise.pages[1].strokes, []);
  assert.notEqual(exercise.pages[1].id, board.pages[0].id);
  assert.deepEqual(board, snapshot);
  assert.deepEqual(parseBoard(serializeBoard(exercise)), exercise);
  reject(() => addPage(board, 'grid'), /background/);

  let full = board;
  for (let index = 0; index < 9; index += 1) full = addPage(full, index % 2 === 0 ? 'blank' : 'exercise');
  assert.equal(full.pages.length, 10);
  assert.equal(new Set(full.pages.map((page) => page.id)).size, 10);
  const fullSnapshot = structuredClone(full);
  reject(() => addPage(full, 'blank'), /页数/);
  assert.deepEqual(full, fullSnapshot);
});

test('serializeBoard 校验后输出 JSON，非法文档拒绝', () => {
  const board = appendToFirst(createBoard(), stroke({ color: '#ABCDEF', width: 30 }));
  const serialized = serializeBoard(board);
  assert.equal(typeof serialized, 'string');
  assert.deepEqual(JSON.parse(serialized), board);
  assert.deepEqual(parseBoard(serialized), board);

  const outOfRange = structuredClone(board);
  outOfRange.pages[0].strokes[0].points[0].x = BOARD_WIDTH + 5;
  reject(() => serializeBoard(outOfRange), /超出/);

  const extraKey = structuredClone(board);
  extraKey.version = 2;
  reject(() => serializeBoard(extraKey), /未知字段/);

  const badWidth = structuredClone(board);
  badWidth.pages[0].strokes[0].width = 0;
  reject(() => serializeBoard(badWidth), /width/);

  const noPages = { schemaVersion: 1, pages: [] };
  reject(() => serializeBoard(noPages), /页数/);
});
