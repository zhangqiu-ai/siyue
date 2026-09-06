import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createCommandService, createRunService } from '@siyue/domain';
import { createLocalClient, createSqliteStore } from './index.js';
import { openNodeConnection, openNodeStore } from './node.js';

const now = () => '2026-09-05T12:00:00.000Z';
const payload = {title: 'Synthetic goal', projectTitles: ['Project'], taskTitles: ['Task']};
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'siyue-adapters-test-'));
  const filename = join(directory, 'data.sqlite');
  const stores: ReturnType<typeof openNodeStore>[] = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    rmSync(directory, {recursive: true});
  });
  return {filename, stores, open() {const store = openNodeStore(filename); stores.push(store); return store;}};
}
function service(store: ReturnType<typeof openNodeStore>) {
  return createCommandService({store, now, newId: randomUUID, hash: (value) => createHash('sha256').update(value).digest('hex')});
}
async function client(store: ReturnType<typeof openNodeStore>, owner = 'owner-a') {
  const {spaceId, actorId} = await store.initialize(owner, randomUUID());
  return {spaceId, actorId, client: createLocalClient({service: service(store), spaceId, actor: {id: actorId, kind: 'user'}, now, newId: randomUUID, propose: async () => payload})};
}

test('formal command writes survive reopen; initialization preserves original space ID', async (t) => {
  const f = fixture(t);
  const first = f.open();
  const a = await client(first);
  const receipt = await a.client.saveManual(payload);
  await first.close();
  const reopened = f.open();
  const b = await client(reopened);
  assert.equal(b.spaceId, a.spaceId);
  const snapshot = await b.client.snapshot();
  assert.equal(snapshot.goals[0]?.title, payload.title);
  assert.equal(snapshot.tasks.length, 1);
  assert.deepEqual(await b.client.receipt(receipt.commandId), receipt);
  const state = await reopened.read(b.spaceId, (state) => state);
  assert.equal(state.events.length, 1);
  assert.equal(state.receipts.length, 1);
});

test('callback failure and invalid snapshot roll back without discarding previous data', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  await a.client.saveManual(payload);
  await assert.rejects(store.transaction(a.spaceId, async (state) => {
    state.goals[0]!.title = 'Uncommitted';
    throw new Error('synthetic fault');
  }), /synthetic fault/);
  await assert.rejects(store.transaction(a.spaceId, async (state) => {state.receipts = [];}), {code: 'corrupt_data'});
  assert.equal((await a.client.snapshot()).goals[0]?.title, payload.title);
  assert.equal((await store.read(a.spaceId, (state) => state)).receipts.length, 1);
});

test('write failure after SQL update rolls back business, event and receipt snapshot', async (t) => {
  const f = fixture(t);
  const connection = openNodeConnection(f.filename);
  let fail = false;
  const wrapped = {...connection, transaction: async <T>(work: Parameters<typeof connection.transaction<T>>[0]) => connection.transaction((tx) => work({...tx,
    async run(sql, params) {
      await tx.run(sql, params);
      if (fail && sql.startsWith('UPDATE spaces')) throw new Error('after update');
    },
  }))};
  const store = createSqliteStore(wrapped); f.stores.push(store);
  const a = await client(store);
  fail = true;
  await assert.rejects(a.client.saveManual(payload), /after update/);
  const state = await store.read(a.spaceId, (value) => value);
  assert.deepEqual([state.goals.length, state.events.length, state.receipts.length], [0, 0, 0]);
});

test('concurrent writes serialize and read results cannot mutate stored data', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  await Promise.all(Array.from({length: 12}, (_, index) => a.client.saveManual({...payload, title: `Goal ${index}`})));
  const snapshot = await a.client.snapshot();
  assert.equal(snapshot.goals.length, 12);
  snapshot.goals[0]!.title = 'Detached mutation';
  assert.notEqual((await a.client.snapshot()).goals[0]?.title, 'Detached mutation');
  assert.equal((await store.read(a.spaceId, (value) => value)).receipts.length, 12);
});

test('two independent connections report busy, preserve data and recover on retry', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const other = f.open();
  const b = await client(other);
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {entered = resolve;});
  const wait = new Promise<void>((resolve) => {release = resolve;});
  const held = store.transaction(a.spaceId, async () => {entered(); await wait;});
  await ready;
  try { await assert.rejects(b.client.saveManual(payload), (error: unknown) => (error as {errcode: number}).errcode === 5); }
  finally {release(); await held;}
  await b.client.saveManual(payload);
  assert.equal((await a.client.snapshot()).goals.length, 1);
});

test('owners have isolated spaces; cross-space mutations fail validation', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const b = await client(store, 'owner-b');
  assert.notEqual(a.spaceId, b.spaceId);
  await a.client.saveManual(payload);
  assert.equal((await b.client.snapshot()).goals.length, 0);
  await assert.rejects(store.transaction(a.spaceId, async (state) => {state.goals[0]!.spaceId = b.spaceId;}), {code: 'corrupt_data'});
  await assert.rejects(service(store).listPlan(a.spaceId, {id: b.actorId, kind: 'user'}), {code: 'forbidden'});
  assert.equal((await a.client.snapshot()).goals[0]?.spaceId, a.spaceId);
});

test('corrupt JSON is refused and left unchanged', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  await store.close();
  const raw = new DatabaseSync(f.filename);
  raw.prepare('UPDATE spaces SET state = ? WHERE id = ?').run('{broken', a.spaceId);
  raw.close();
  await assert.rejects(f.open().initialize('owner-a', randomUUID()), {code: 'corrupt_data'});
  const inspect = new DatabaseSync(f.filename, {readOnly: true});
  try {assert.equal(inspect.prepare('SELECT state FROM spaces').get()?.state, '{broken');} finally {inspect.close();}
});

test('future version and unversioned existing tables are refused without modification', async (t) => {
  const f = fixture(t);
  const raw = new DatabaseSync(f.filename);
  raw.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('keep'); PRAGMA user_version = 99");
  raw.close();
  const future = f.open();
  await assert.rejects(future.initialize('owner', randomUUID()), {code: 'unsupported_schema'});
  await future.close();
  const edit = new DatabaseSync(f.filename);
  assert.equal(edit.prepare('PRAGMA user_version').get()?.user_version, 99);
  edit.exec('PRAGMA user_version = 0'); edit.close();
  await assert.rejects(f.open().initialize('owner', randomUUID()), {code: 'corrupt_data'});
  const inspect = new DatabaseSync(f.filename, {readOnly: true});
  try {
    assert.equal(inspect.prepare('SELECT value FROM preserved').get()?.value, 'keep');
    assert.equal(inspect.prepare('PRAGMA user_version').get()?.user_version, 0);
  } finally {inspect.close();}
});

test('draft edit retains command identity; repeated concurrent confirmation is idempotent', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const draft = await a.client.propose('A synthetic goal');
  assert.equal((await a.client.snapshot()).goals.length, 0);
  assert.equal(draft.actorKind, 'user');
  assert.equal(draft.source, 'ai');
  const edited = await a.client.editDraft(draft.id, draft.version, {...payload, title: 'Edited goal'});
  assert.equal(edited.command.commandId, draft.command.commandId);
  assert.equal(edited.command.issuedAt, draft.command.issuedAt);
  const receipts = await Promise.all([a.client.confirmDraft(edited.id, edited.version), a.client.confirmDraft(edited.id, edited.version)]);
  assert.deepEqual(receipts[0], receipts[1]);
  const snapshot = await a.client.snapshot();
  assert.equal(snapshot.goals.length, 1);
  assert.equal(snapshot.goals[0]?.title, 'Edited goal');
  assert.equal(snapshot.drafts[0]?.status, 'applied');
});

test('rejected and aborted drafts create no formal records', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const draft = await a.client.propose('Goal');
  await a.client.discardDraft(draft.id, draft.version);
  await assert.rejects(a.client.confirmDraft(draft.id, draft.version), {code: 'version_conflict'});
  const abort = new AbortController(); abort.abort();
  await assert.rejects(a.client.propose('Never runs', abort.signal), {name: 'AbortError'});
  const snapshot = await a.client.snapshot();
  assert.equal(snapshot.goals.length, 0);
  assert.equal(snapshot.drafts.length, 1);
});

test('failed first schema creation rolls back DDL and version, allowing a clean retry', async (t) => {
  const f = fixture(t);
  const connection = openNodeConnection(f.filename);
  let fail = true;
  const store = createSqliteStore({...connection, transaction: async <T>(work: Parameters<typeof connection.transaction<T>>[0]) => connection.transaction((tx) => work({...tx,
    async exec(sql) {
      await tx.exec(sql);
      if (fail && sql.startsWith('CREATE TABLE spaces')) throw new Error('schema creation fault');
    },
  }))}); f.stores.push(store);
  await assert.rejects(store.initialize('owner', randomUUID()), /schema creation fault/);
  assert.equal((await connection.get<{user_version: number}>('PRAGMA user_version', []))?.user_version, 0);
  assert.equal((await connection.get<{total: number}>("SELECT count(*) AS total FROM sqlite_master WHERE name = 'spaces'", []))?.total, 0);
  fail = false;
  const identity = await store.initialize('owner', randomUUID());
  assert.equal(identity.actorId, 'owner');
});

test('transaction work uses supplied transaction handle rather than the outer connection', async (t) => {
  const f = fixture(t);
  const connection = openNodeConnection(f.filename);
  let transactionActive = false;
  const store = createSqliteStore({...connection,
    async exec(sql) {assert.equal(transactionActive, false); return connection.exec(sql);},
    async run(sql, params) {assert.equal(transactionActive, false); return connection.run(sql, params);},
    async get<T>(sql: string, params: readonly (string | number | null)[]) {assert.equal(transactionActive, false); return connection.get<T>(sql, params);},
    async transaction(work) {
      return connection.transaction(async (tx) => {
        transactionActive = true;
        try { return await work(tx); } finally { transactionActive = false; }
      });
    },
  }); f.stores.push(store);
  const a = await client(store);
  await a.client.saveManual(payload);
  assert.equal((await a.client.snapshot()).goals.length, 1);
});

test('facade reconciles a committed command when the service loses its response', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const real = service(store);
  const local = createLocalClient({service: {...real, async execute(command, actor) {
    await real.execute(command, actor);
    throw new Error('lost response after commit');
  }}, spaceId: a.spaceId, actor: {id: a.actorId, kind: 'user'}, now, newId: randomUUID, propose: async () => payload});
  const receipt = await local.saveManual(payload);
  assert.equal(receipt.status, 'applied');
  assert.equal((await local.snapshot()).goals.length, 1);
});

test('unknown commit keeps the same command envelope for a later manual retry', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const real = service(store);
  let unavailable = true;
  const local = createLocalClient({service: {...real,
    async execute(command, actor) {const receipt = await real.execute(command, actor); if (unavailable) throw new Error('lost response'); return receipt;},
    async getReceipt(...args) {if (unavailable) throw new Error('receipt unavailable'); return real.getReceipt(...args);},
  }, spaceId: a.spaceId, actor: {id: a.actorId, kind: 'user'}, now, newId: randomUUID, propose: async () => payload});
  await assert.rejects(local.saveManual(payload), /lost response/);
  unavailable = false;
  await local.saveManual(payload);
  assert.equal((await local.snapshot()).goals.length, 1);
  assert.equal((await store.read(a.spaceId, (state) => state)).receipts.length, 1);
});

test('stable renderer request survives two host client instances and rejects changed payload', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const request = {commandId: randomUUID(), issuedAt: now()};
  const first = await a.client.saveManual(payload, request);
  const b = await client(store);
  assert.deepEqual(await b.client.saveManual(payload, request), first);
  await assert.rejects(b.client.saveManual({...payload, title: 'Different'}, request), {code: 'command_conflict'});
  assert.equal((await b.client.snapshot()).goals.length, 1);
});

test('run linked to draft survives SQLite reopen and succeeds only after confirmed writes', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const actor = {id: a.actorId, kind: 'user' as const};
  const runs = createRunService({store, now, newId: randomUUID});
  const local = createLocalClient({service: service(store), runService: runs, spaceId: a.spaceId, actor, now, newId: randomUUID, propose: async () => payload});
  const draft = await local.propose('Goal');
  assert.equal((await runs.list(a.spaceId, actor))[0]?.status, 'awaiting_approval');
  assert.equal((await local.snapshot()).runs[0]?.status, 'awaiting_approval');
  assert.equal((await local.snapshot()).goals.length, 0);
  await store.close();
  const reopened = f.open();
  const recoveredRuns = createRunService({store: reopened, now, newId: randomUUID});
  await recoveredRuns.recover(a.spaceId, actor);
  const recovered = createLocalClient({service: service(reopened), runService: recoveredRuns, spaceId: a.spaceId, actor, now, newId: randomUUID, propose: async () => payload});
  await recovered.confirmDraft(draft.id, draft.version);
  assert.equal((await recoveredRuns.list(a.spaceId, actor))[0]?.status, 'succeeded');
  assert.equal((await recovered.snapshot()).runs[0]?.status, 'succeeded');
  assert.equal((await recovered.snapshot()).goals.length, 1);
});

test('cancelled generation, discarded draft and provider failures persist distinct run outcomes', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const actor = {id: a.actorId, kind: 'user' as const};
  const runs = createRunService({store, now, newId: randomUUID});
  const abort = new AbortController();
  const base = {service: service(store), runService: runs, spaceId: a.spaceId, actor, now, newId: randomUUID};
  const cancelled = createLocalClient({...base, propose: async () => {abort.abort(); return payload;}});
  await assert.rejects(cancelled.propose('Goal', abort.signal), {code: 'cancelled'});
  const normal = createLocalClient({...base, propose: async () => payload});
  const draft = await normal.propose('Goal');
  await normal.discardDraft(draft.id, draft.version);
  const failed = createLocalClient({...base, propose: async () => {throw new Error('Sensitive provider detail');}});
  await assert.rejects(failed.propose('Goal'), /Sensitive provider detail/);
  const records = await runs.list(a.spaceId, actor);
  assert.deepEqual(records.map((run) => run.status), ['cancelled', 'cancelled', 'failed']);
  assert.equal(JSON.stringify(records).includes('Sensitive provider detail'), false);
  assert.equal((await normal.snapshot()).goals.length, 0);
});

test('restart reconciles applied draft when run status update was lost, and interrupts unfinished generation', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const actor = {id: a.actorId, kind: 'user' as const};
  const runs = createRunService({store, now, newId: randomUUID});
  const local = createLocalClient({service: service(store), runService: {...runs, async settleDraft() {throw new Error('run update unavailable');}}, spaceId: a.spaceId, actor, now, newId: randomUUID, propose: async () => payload});
  const draft = await local.propose('Goal');
  await assert.rejects(local.confirmDraft(draft.id, draft.version), /run update unavailable/);
  assert.equal((await local.snapshot()).goals.length, 1);
  const unfinished = await runs.start(a.spaceId, actor);
  await store.close();
  const reopened = f.open();
  const recovered = createRunService({store: reopened, now, newId: randomUUID});
  await recovered.recover(a.spaceId, actor);
  const records = await recovered.list(a.spaceId, actor);
  assert.equal(records.find((run) => run.draftId === draft.id)?.status, 'succeeded');
  assert.equal(records.find((run) => run.id === unfinished.id)?.status, 'interrupted');
  assert.equal((await reopened.read(a.spaceId, (state) => state)).receipts.length, 1);
});

test('snapshot run queries respect actor and space access; minimal aborted signals need no helper methods', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const b = await client(store, 'owner-b');
  const runs = createRunService({store, now, newId: randomUUID});
  const base = {service: service(store), runService: runs, now, newId: randomUUID, propose: async () => payload};
  const localA = createLocalClient({...base, spaceId: a.spaceId, actor: {id: a.actorId, kind: 'user'}});
  await localA.propose('Goal');
  const localB = createLocalClient({...base, spaceId: b.spaceId, actor: {id: b.actorId, kind: 'user'}});
  assert.deepEqual((await localB.snapshot()).runs, []);
  const wrongActor = createLocalClient({...base, spaceId: a.spaceId, actor: {id: b.actorId, kind: 'user'}});
  await assert.rejects(wrongActor.snapshot(), {code: 'forbidden'});
  await assert.rejects(localA.propose('Cancelled', {aborted: true} as AbortSignal), {code: 'cancelled', name: 'AbortError'});
  assert.equal((await localA.snapshot()).runs.length, 1);
});

test('atomic draft commit with lost response recovers the linked run and later succeeds once', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const actor = {id: a.actorId, kind: 'user' as const};
  const real = service(store);
  const runs = createRunService({store, now, newId: randomUUID});
  const local = createLocalClient({service: {...real, async createDraft(...args) {
    await real.createDraft(...args);
    throw new Error('draft response lost after commit');
  }}, runService: runs, spaceId: a.spaceId, actor, now, newId: randomUUID, propose: async () => payload});
  const draft = await local.propose('Goal');
  const before = await local.snapshot();
  assert.equal(before.drafts.length, 1);
  assert.equal(before.runs[0]?.status, 'awaiting_approval');
  assert.equal(before.runs[0]?.draftId, draft.id);
  await local.confirmDraft(draft.id, draft.version);
  const after = await local.snapshot();
  assert.equal(after.runs[0]?.status, 'succeeded');
  assert.equal(after.goals.length, 1);
});

test('cancel after atomic draft commit with lost response rejects draft and cancels its run', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const actor = {id: a.actorId, kind: 'user' as const};
  const real = service(store);
  const abort = new AbortController();
  const runs = createRunService({store, now, newId: randomUUID});
  const local = createLocalClient({service: {...real, async createDraft(...args) {
    await real.createDraft(...args);
    abort.abort();
    throw new Error('draft response lost after commit');
  }}, runService: runs, spaceId: a.spaceId, actor, now, newId: randomUUID, propose: async () => payload});
  await assert.rejects(local.propose('Goal', abort.signal), {code: 'cancelled'});
  const snapshot = await local.snapshot();
  assert.equal(snapshot.drafts[0]?.status, 'cancelled');
  assert.equal(snapshot.runs[0]?.status, 'cancelled');
  assert.equal(snapshot.goals.length, 0);
});

test('uncertain draft commit leaves awaiting run intact when reconciliation is temporarily unavailable', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const a = await client(store);
  const actor = {id: a.actorId, kind: 'user' as const};
  const real = service(store);
  const runs = createRunService({store, now, newId: randomUUID});
  const local = createLocalClient({service: {...real, async createDraft(...args) {
    await real.createDraft(...args);
    throw new Error('draft response lost after commit');
  }, async listPlan() {throw new Error('read unavailable');}}, runService: runs, spaceId: a.spaceId, actor, now, newId: randomUUID, propose: async () => payload});
  await assert.rejects(local.propose('Goal'), /draft response lost after commit/);
  assert.equal((await runs.list(a.spaceId, actor))[0]?.status, 'awaiting_approval');
  await store.close();
  const reopened = f.open();
  const recoveredRuns = createRunService({store: reopened, now, newId: randomUUID});
  await recoveredRuns.recover(a.spaceId, actor);
  const recovered = createLocalClient({service: service(reopened), runService: recoveredRuns, spaceId: a.spaceId, actor, now, newId: randomUUID, propose: async () => payload});
  const draft = (await recovered.snapshot()).drafts[0]!;
  await recovered.confirmDraft(draft.id, draft.version);
  assert.equal((await recovered.snapshot()).runs[0]?.status, 'succeeded');
});
