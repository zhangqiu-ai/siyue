import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalize, createCommandService } from '@siyue/domain';
import { createLocalClient } from '@siyue/adapters';
import { openNodeStore } from '@siyue/adapters/node';
import { createDesktopClient } from '../renderer/client.ts';
import { createIpcDispatcher } from './ipc.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'siyue-ipc-recovery-'));
  const store = openNodeStore(path.join(directory, 'test.sqlite'));
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const { spaceId, actorId } = await store.initialize('test-owner', randomUUID());
  const now = () => new Date().toISOString();
  const service = createCommandService({ store, now, newId: randomUUID, hash: (text) => createHash('sha256').update(text).digest('hex') });
  const client = createLocalClient({ service, spaceId, actor: { id: actorId, kind: 'user' }, now, newId: randomUUID, propose: async () => { throw new Error('not needed'); } });
  const rendererUrl = 'file:///test/index.html';
  const frame = { url: rendererUrl };
  const webContents = { mainFrame: frame, getURL: () => rendererUrl, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: frame };
  const dispatcher = createIpcDispatcher({ client, webContents, rendererUrl });
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
  return { client, dispatcher, event, storage, data };
}

test('lost manual-write response survives renderer reload and reconciles to one real SQLite plan', async (t) => {
  const fixtureData = await fixture(t);
  const { client, dispatcher, event, storage, data } = fixtureData;
  let disconnected = true;
  let writes = 0;
  const bridge = { cancel() {}, async invoke(message) {
    if (message.method === 'receipt' && disconnected) throw new Error('channel disconnected');
    const result = await dispatcher.handle(event, message);
    if (message.method === 'saveManual') {
      writes += 1;
      if (disconnected) throw new Error('response dropped after commit');
    }
    return result;
  } };
  const payload = { title: 'private synthetic goal', projectTitles: ['project'], taskTitles: ['task'] };
  await assert.rejects(createDesktopClient({ bridge, storage }).saveManual(payload));
  assert.equal((await client.snapshot()).goals.length, 1);
  assert.equal(data.size, 1);
  assert.equal(JSON.stringify([...data]).includes(payload.title), false);
  const pending = JSON.parse([...data.values()][0]);
  assert.deepEqual(Object.keys(pending).sort(), ['commandId', 'issuedAt']);
  disconnected = false;
  const receipt = await createDesktopClient({ bridge, storage }).saveManual(payload);
  assert.equal(receipt.commandId, pending.commandId);
  assert.equal(writes, 1, 'reload queried the receipt rather than writing again');
  assert.equal((await client.snapshot()).goals.length, 1);
  assert.equal(data.size, 0);
});

test('lost update response returns the original receipt without incrementing the version again', async (t) => {
  const { client, dispatcher, event, storage } = await fixture(t);
  await client.saveManual({ title: 'goal', projectTitles: [], taskTitles: ['task'] });
  const task = (await client.snapshot()).tasks[0];
  let updates = 0;
  const bridge = { cancel() {}, async invoke(message) {
    const result = await dispatcher.handle(event, message);
    if (message.method === 'update') { updates += 1; throw new Error('lost response'); }
    return result;
  } };
  const receipt = await createDesktopClient({ bridge, storage }).update('task', task.id, task.version, { status: 'done' });
  assert.equal(receipt.status, 'applied');
  const updated = (await client.snapshot()).tasks[0];
  assert.equal(updated.status, 'done');
  assert.equal(updated.version, task.version + 1);
  assert.equal(updates, 1);
});

test('strict IPC operation envelope rejects identity injection and invalid timestamps', async (t) => {
  const { dispatcher, event } = await fixture(t);
  for (const operation of [{ commandId: 'stable-command', issuedAt: 'bad-date' }, { commandId: 'stable-command', issuedAt: '2026-01-01T00:00:00.000Z', actorId: 'other' }]) {
    assert.deepEqual(await dispatcher.handle(event, { requestId: randomUUID(), method: 'saveManual', args: [{ title: 'test' }, operation] }), { ok: false, error: { code: 'invalid_input' } });
  }
});

test('retry before any commit preserves both commandId and issuedAt across renderer reload', async (t) => {
  const { client, dispatcher, event, storage } = await fixture(t);
  let drop = true;
  const operations = [];
  const bridge = { cancel() {}, async invoke(message) {
    if (message.method === 'saveManual') {
      operations.push(message.args[1]);
      if (drop) throw new Error('request dropped before host received it');
    }
    return dispatcher.handle(event, message);
  } };
  const payload = { title: 'retryable goal', projectTitles: [], taskTitles: [] };
  await assert.rejects(createDesktopClient({ bridge, storage }).saveManual(payload));
  assert.equal((await client.snapshot()).goals.length, 0);
  drop = false;
  await createDesktopClient({ bridge, storage }).saveManual(payload);
  assert.equal(operations.length, 2);
  assert.deepEqual(operations[1], operations[0]);
  assert.equal((await client.snapshot()).goals.length, 1);
});

test('corrupt pending metadata is preserved without querying receipts or dispatching writes', async (t) => {
  const { storage, data } = await fixture(t);
  const payload = { title: 'preserve metadata', projectTitles: [], taskTitles: [] };
  const key = 'siyue.pending-command.v1.' + createHash('sha256').update(canonicalize(['saveManual', [payload]])).digest('hex');
  const operation = { commandId: randomUUID(), issuedAt: new Date().toISOString() };
  let calls = 0;
  const bridge = { cancel() {}, async invoke() { calls += 1; throw new Error('must not dispatch'); } };
  for (const raw of ['', '{', 'null', JSON.stringify({ ...operation, issuedAt: 'invalid' }), JSON.stringify({ ...operation, commandId: '' }), JSON.stringify({ ...operation, actorId: 'injected' })]) {
    data.set(key, raw);
    await assert.rejects(createDesktopClient({ bridge, storage }).saveManual(payload), { code: 'corrupt_data' });
    assert.equal(data.get(key), raw);
  }
  assert.equal(calls, 0);
});

test('a pending operation pointing to a different committed command cannot claim success or clear recovery data', async (t) => {
  const { client, dispatcher, event, storage, data } = await fixture(t);
  const operation = { commandId: randomUUID(), issuedAt: new Date().toISOString() };
  await client.saveManual({ title: 'previous plan', projectTitles: [], taskTitles: [] }, operation);
  const payload = { title: 'requested new plan', projectTitles: [], taskTitles: [] };
  const key = 'siyue.pending-command.v1.' + createHash('sha256').update(canonicalize(['saveManual', [payload]])).digest('hex');
  const raw = JSON.stringify(operation);
  data.set(key, raw);
  const calls = [];
  const bridge = { cancel() {}, async invoke(message) { calls.push(message.method); return dispatcher.handle(event, message); } };
  await assert.rejects(createDesktopClient({ bridge, storage }).saveManual(payload), { code: 'failed' });
  assert.equal(data.get(key), raw);
  assert.deepEqual(calls, ['receipt']);
  assert.deepEqual((await client.snapshot()).goals.map((goal) => goal.title), ['previous plan']);
});

test('receipt verification matches IPC trimming and defaults for manual writes and updates', async (t) => {
  const { client, dispatcher, event, storage, data } = await fixture(t);
  const bridge = { cancel() {}, invoke: (message) => dispatcher.handle(event, message) };
  const renderer = createDesktopClient({ bridge, storage });
  await renderer.saveManual({ title: '  normalized goal  ' });
  const goal = (await client.snapshot()).goals[0];
  assert.equal(goal.title, 'normalized goal');
  await renderer.update('goal', goal.id, goal.version, { title: '  renamed goal  ' });
  assert.equal((await client.snapshot()).goals[0].title, 'renamed goal');
  assert.equal(data.size, 0);
});

test('caller mutation during hashing cannot change the dispatched command or break restart reconciliation', async (t) => {
  const { client, dispatcher, event, storage, data } = await fixture(t);
  let disconnected = true;
  let writes = 0;
  const bridge = { cancel() {}, async invoke(message) {
    if (disconnected && message.method === 'receipt') throw new Error('offline');
    const result = await dispatcher.handle(event, message);
    if (message.method === 'saveManual') {
      writes += 1;
      if (disconnected) throw new Error('response lost');
    }
    return result;
  } };
  const payload = { title: 'original goal', projectTitles: [], taskTitles: ['original task'] };
  const original = structuredClone(payload);
  const write = createDesktopClient({ bridge, storage }).saveManual(payload);
  payload.title = 'mutated goal';
  payload.taskTitles[0] = 'mutated task';
  await assert.rejects(write, /response lost/);
  assert.equal((await client.snapshot()).goals[0].title, original.title);
  assert.equal((await client.snapshot()).tasks[0].title, original.taskTitles[0]);
  disconnected = false;
  await createDesktopClient({ bridge, storage }).saveManual(original);
  assert.equal(writes, 1);
  assert.equal(data.size, 0);
  assert.equal((await client.snapshot()).goals.length, 1);
});
