import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createCommandService, type CommandService } from '@siyue/domain';
import { createLocalClient, createSqliteRequestJournalStorage, type RequestJournal } from './index.js';
import { openNodeConnection, openNodeStore } from './node.js';

const now = () => '2026-09-06T12:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const payload = {title: 'Private synthetic goal', projectTitles: [], taskTitles: []};
const sampleKey = `siyue.pending.v1.${'a'.repeat(64)}`;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'siyue-request-journal-test-'));
  const database = join(directory, 'space.sqlite');
  const journalFile = join(directory, 'pending.sqlite');
  const closables: {close(): Promise<void>}[] = [];
  t.after(async () => {for (const item of closables) await item.close(); rmSync(directory, {recursive: true});});
  function open() {
    const store = openNodeStore(database);
    const storage = createSqliteRequestJournalStorage(openNodeConnection(journalFile));
    closables.push(store, storage);
    const service = createCommandService({store, now, newId: randomUUID, hash});
    return {store, storage, service};
  }
  function rows() {
    const db = new DatabaseSync(journalFile, {readOnly: true});
    try {return db.prepare('SELECT key, value FROM pending_requests').all() as {key: string; value: string}[];} finally {db.close();}
  }
  return {open, rows, journalFile, closables};
}

async function local(host: ReturnType<ReturnType<typeof fixture>['open']>, options: {owner?: string; service?: CommandService; journal?: RequestJournal; clock?: () => string} = {}) {
  const {spaceId, actorId} = await host.store.initialize(options.owner ?? 'owner-a', randomUUID());
  return createLocalClient({service: options.service ?? host.service, spaceId, actor: {id: actorId, kind: 'user'}, now: options.clock ?? now,
    newId: randomUUID, propose: async () => payload, requestJournal: options.journal ?? {storage: host.storage, hash}});
}

test('journal persists before commit and reopens with the same command identity after lost receipts', async (t) => {
  const f = fixture(t);
  const first = f.open();
  let received: {commandId: string; issuedAt: string} | undefined;
  const unavailable = {...first.service,
    async execute(command: unknown, actor: Parameters<CommandService['execute']>[1]) {
      assert.equal(f.rows().length, 1);
      received = command as typeof received;
      await first.service.execute(command, actor);
      throw new Error('response lost');
    },
    async getReceipt() {throw new Error('receipt lookup unavailable');},
  };
  await assert.rejects((await local(first, {service: unavailable})).saveManual(payload), /response lost/);
  const stored = f.rows();
  assert.equal(stored.length, 1);
  assert.equal(JSON.stringify(stored).includes(payload.title), false);
  assert.deepEqual(JSON.parse(stored[0]!.value), {schemaVersion: 1, commandId: received!.commandId, issuedAt: received!.issuedAt});
  await first.store.close(); await first.storage.close();
  const next = f.open();
  let executions = 0;
  const recovered = await local(next, {clock: () => '2026-09-07T12:00:00.000Z', service: {...next.service,
    async execute(...args) {executions += 1; return next.service.execute(...args);},
  }});
  const receipt = await recovered.saveManual(payload);
  assert.equal(receipt.commandId, received!.commandId);
  assert.equal(executions, 0); // Verified receipt before considering re-execution.
  assert.equal((await recovered.snapshot()).goals.length, 1);
  assert.deepEqual(f.rows(), []);
});

test('concurrent identical requests share one attempt; completion permits a new deliberate operation', async (t) => {
  const f = fixture(t);
  const host = f.open();
  const client = await local(host);
  const receipts = await Promise.all([client.saveManual(payload), client.saveManual(payload), client.saveManual(payload)]);
  assert.equal(new Set(receipts.map((receipt) => receipt.commandId)).size, 1);
  assert.equal((await client.snapshot()).goals.length, 1);
  const later = await client.saveManual(payload);
  assert.notEqual(later.commandId, receipts[0]!.commandId);
  assert.equal((await client.snapshot()).goals.length, 2);
  assert.deepEqual(f.rows(), []);
});

test('failure to persist first request prevents all command execution', async (t) => {
  const f = fixture(t);
  const host = f.open();
  let executed = false;
  const client = await local(host, {journal: {hash, storage: {...host.storage, async setItem() {throw new Error('journal full');}}},
    service: {...host.service, async execute(...args) {executed = true; return host.service.execute(...args);}}});
  await assert.rejects(client.saveManual(payload), /journal full/);
  assert.equal(executed, false);
  assert.equal((await client.snapshot()).goals.length, 0);
});

test('pending metadata is isolated by actor and space even when payloads match', async (t) => {
  const f = fixture(t);
  const host = f.open();
  const offline = {...host.service, async execute() {throw new Error('offline before execution');}, async getReceipt() {return null;}};
  const a = await local(host, {owner: 'owner-a', service: offline});
  const b = await local(host, {owner: 'owner-b', service: offline});
  await assert.rejects(a.saveManual(payload), /offline/);
  await assert.rejects(b.saveManual(payload), /offline/);
  const rows = f.rows();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]!.key, rows[1]!.key);
  assert.notEqual(JSON.parse(rows[0]!.value).commandId, JSON.parse(rows[1]!.value).commandId);
  const onlineA = await local(host, {owner: 'owner-a'});
  await onlineA.saveManual(payload);
  assert.equal(f.rows().length, 1);
  assert.equal((await (await local(host, {owner: 'owner-b'})).snapshot()).goals.length, 0);
});

test('definite business rejection ends its request; unknown outcomes and mismatched receipts do not', async (t) => {
  const f = fixture(t);
  const host = f.open();
  const client = await local(host);
  await assert.rejects(client.update('goal', 'missing', 1, {title: 'Change'}), {code: 'not_found'});
  assert.deepEqual(f.rows(), []);
  const wrongReceipt = await local(host, {service: {...host.service,
    async execute(...args) {const receipt = await host.service.execute(...args); return {...receipt, commandId: randomUUID()};},
    async getReceipt() {return null;},
  }});
  await assert.rejects(wrongReceipt.saveManual(payload), /receipt does not match/);
  assert.equal(f.rows().length, 1);
});

test('journal-backed updates preserve command identity across process restart', async (t) => {
  const f = fixture(t);
  const first = f.open();
  const normal = await local(first);
  await normal.saveManual(payload);
  const goal = (await normal.snapshot()).goals[0]!;
  const lost = await local(first, {service: {...first.service,
    async execute(...args) {await first.service.execute(...args); throw new Error('lost update response');},
    async getReceipt() {throw new Error('receipt unavailable');},
  }});
  await assert.rejects(lost.update('goal', goal.id, goal.version, {title: 'Changed once'}), /lost update/);
  await first.store.close(); await first.storage.close();
  const second = f.open();
  const recovered = await local(second);
  await recovered.update('goal', goal.id, goal.version, {title: 'Changed once'});
  const updated = (await recovered.snapshot()).goals[0]!;
  assert.equal(updated.version, 2);
  assert.equal(updated.title, 'Changed once');
  assert.deepEqual(f.rows(), []);
});

test('failed journal cleanup keeps verified command identity for restart reconciliation', async (t) => {
  const f = fixture(t);
  const first = f.open();
  const client = await local(first, {journal: {hash, storage: {...first.storage, async removeItem() {throw new Error('cleanup unavailable');}}}});
  await assert.rejects(client.saveManual(payload), /cleanup unavailable/);
  assert.equal(f.rows().length, 1);
  assert.equal((await client.snapshot()).goals.length, 1);
  await first.store.close(); await first.storage.close();
  const next = f.open();
  const recovered = await local(next);
  await recovered.saveManual(payload);
  assert.equal((await recovered.snapshot()).goals.length, 1);
  assert.deepEqual(f.rows(), []);
});

test('desktop explicit requests bypass optional journal storage and preserve their envelope', async (t) => {
  const f = fixture(t);
  const host = f.open();
  const client = await local(host, {journal: {hash, storage: {...host.storage, async getItem() {throw new Error('must not read desktop journal');}}}});
  const request = {commandId: randomUUID(), issuedAt: now()};
  const first = await client.saveManual(payload, request);
  assert.deepEqual(await client.saveManual(payload, request), first);
  assert.equal((await client.snapshot()).goals.length, 1);
});

test('changed persisted identity is refused while an earlier in-memory attempt remains unknown', async (t) => {
  const f = fixture(t);
  const host = f.open();
  let executions = 0;
  const client = await local(host, {service: {...host.service,
    async execute() {executions += 1; throw new Error('unknown');}, async getReceipt() {return null;},
  }});
  await assert.rejects(client.saveManual(payload), /unknown/);
  const key = f.rows()[0]!.key;
  const replacement = JSON.stringify({schemaVersion: 1, commandId: randomUUID(), issuedAt: now()});
  await host.storage.setItem(key, replacement);
  await assert.rejects(client.saveManual(payload), /identity changed/);
  assert.equal(executions, 1);
  assert.equal(f.rows()[0]!.value, replacement);
});

for (const invalid of ['{broken', JSON.stringify({schemaVersion: 1, commandId: '        ', issuedAt: now()}), JSON.stringify({schemaVersion: 2, commandId: 'valid-command-id', issuedAt: now()}), JSON.stringify({schemaVersion: 1, commandId: '', issuedAt: now()}), JSON.stringify({schemaVersion: 1, commandId: 'valid-command-id', issuedAt: '2026-99-99T12:00:00.000Z'}), JSON.stringify({schemaVersion: 1, commandId: 'valid-command-id', issuedAt: now(), payload: 'unexpected'})]) {
  test(`corrupt request metadata is preserved and cannot cause a fresh command: ${invalid.slice(0, 40)}`, async (t) => {
    const f = fixture(t);
    const host = f.open();
    const offline = await local(host, {service: {...host.service, async execute() {throw new Error('offline');}, async getReceipt() {return null;}}});
    await assert.rejects(offline.saveManual(payload), /offline/);
    const key = f.rows()[0]!.key;
    await host.storage.setItem(key, invalid);
    const recovered = await local(host);
    await assert.rejects(recovered.saveManual(payload), /metadata/);
    assert.equal((await recovered.snapshot()).goals.length, 0);
    assert.equal(f.rows()[0]!.value, invalid);
  });
}

for (const kind of ['future', 'unversioned', 'missing-table'] as const) {
  test(`dedicated journal refuses ${kind} database without recreating schema`, async (t) => {
    const f = fixture(t);
    const raw = new DatabaseSync(f.journalFile);
    raw.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('keep')");
    if (kind === 'future') raw.exec('PRAGMA user_version = 99');
    if (kind === 'missing-table') raw.exec('PRAGMA user_version = 1');
    raw.close();
    const storage = createSqliteRequestJournalStorage(openNodeConnection(f.journalFile)); f.closables.push(storage);
    await assert.rejects(storage.getItem(sampleKey), {code: kind === 'future' ? 'unsupported_schema' : 'corrupt_data'});
    const inspect = new DatabaseSync(f.journalFile, {readOnly: true});
    try {
      assert.equal(inspect.prepare('SELECT value FROM preserved').get()?.value, 'keep');
      assert.equal(inspect.prepare("SELECT count(*) AS total FROM sqlite_master WHERE name = 'pending_requests'").get()?.total, 0);
    } finally {inspect.close();}
  });
}
