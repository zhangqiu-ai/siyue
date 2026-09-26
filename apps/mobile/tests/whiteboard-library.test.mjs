import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService, emptyBoard, KEY } from '../../../packages/whiteboard/src/protocol.ts';
import { boardAge, boardLibraryClient } from '../src/whiteboard/library-client.ts';

function fixture(initial = {}) {
  const rows = new Map(Object.entries(initial));
  const storage = { getItemSync: key => rows.get(key) ?? null, setItemSync: (key, value) => rows.set(key, value), removeItemSync: key => rows.delete(key) };
  let sequence = 0;
  const service = createService(storage, 'library', async () => ({ cancelled: true }), { newId: () => `board-${++sequence}`, now: () => new Date(Date.UTC(2026, 8, 25, 10, sequence)).toISOString() });
  return { rows, client: boardLibraryClient('library', service.request, () => `request-${++sequence}`) };
}

test('the library adopts the prior local board, keeps it, and lists multiple recent boards', async () => {
  const original = JSON.stringify(emptyBoard());
  const { rows, client } = fixture({ [KEY]: original });
  assert.deepEqual((await client.list('我的白板')).map(board => board.title), ['我的白板']);
  const first = await client.create('数学', 'blank');
  const second = await client.create('英语', 'library');
  assert.deepEqual((await client.list('unused')).map(board => board.title), ['英语', '数学', '我的白板']);
  await client.rename(first.id, '周三数学');
  assert.equal((await client.list('unused')).find(board => board.id === first.id)?.title, '周三数学');
  await client.delete(second.id);
  assert.deepEqual((await client.list('unused')).map(board => board.title), ['周三数学', '我的白板']);
  assert.equal(rows.get(KEY), original);
});

test('library dates are localized and a failed operation surfaces its code', async () => {
  assert.equal(boardAge('2026-09-25T09:50:00.000Z', Date.UTC(2026, 8, 25, 10), 'zh-CN'), '10 分钟前');
  assert.equal(boardAge('2026-09-25T09:50:00.000Z', Date.UTC(2026, 8, 25, 10), 'en-US'), '10 min ago');
  const { client } = fixture();
  await client.list('My whiteboard');
  await assert.rejects(client.delete('missing'), /not_found/);
});
