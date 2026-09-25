import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createCommandService, createRunService } from '@siyue/domain';
import { AuthClientError, createAuthController, createLocalClient, createSqliteStore, type AuthApiClient } from './index.js';
import { openNodeConnection, openNodeStore } from './node.js';

const now = () => '2026-09-05T12:00:00.000Z';
const payload = {title: 'Synthetic goal', projectTitles: ['Project'], taskTitles: ['Task']};
const compatibleExecution = {executor: 'compatible', modelVersion: 'test-model', promptVersion: 'compatible-plan-v1'} as const;

test('workspace lifetime stops a non-cooperative provider before saving its late draft',async t=>{
 const store=fixture(t).open(),{spaceId,actorId}=await store.initialize('local-owner',randomUUID());
 const lifetime=new AbortController(),runs=createRunService({store,now,newId:randomUUID});
 let entered!:()=>void,release!:(value:typeof payload)=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const local=createLocalClient({service:service(store),runService:runs,spaceId,actor:{id:actorId,kind:'user'},now,newId:randomUUID,lifetimeSignal:lifetime.signal,
  propose:async()=>{entered();return new Promise(resolve=>{release=resolve;});}});
 const result=local.propose('old account').then(()=>({code:'unexpected'}),error=>({code:error.code}));
 await started;lifetime.abort();release(payload);assert.deepEqual(await result,{code:'cancelled'});
 const state=await store.read(spaceId,x=>x);assert.equal(state.drafts.length,0);assert.equal(state.runs[0]?.status,'cancelled');
 await assert.rejects(local.snapshot(),{code:'cancelled'});
});

test('retired workspace cannot continue an approval or execute queued confirmations',async t=>{
 const store=fixture(t).open(),{spaceId,actorId}=await store.initialize('local-owner',randomUUID()),real=service(store);
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 const lifetime=new AbortController();
 const local=createLocalClient({service:{...real,approveDraft:async(...args)=>{const result=await real.approveDraft(...args);entered();await new Promise<void>(resolve=>{release=resolve;});return result;}},spaceId,actor:{id:actorId,kind:'user'},now,newId:randomUUID,lifetimeSignal:lifetime.signal,propose:async()=>payload});
 const draft=await local.createManualDraft(payload,{commandId:randomUUID(),issuedAt:now()});
 const first=local.confirmDraft(draft.id,draft.version).then(()=>false,error=>error.code);
 const queued=local.confirmDraft(draft.id,draft.version).then(()=>false,error=>error.code);
 await started;lifetime.abort();release();assert.equal(await first,'cancelled');assert.equal(await queued,'cancelled');
 assert.equal((await store.read(spaceId,x=>x)).goals.length,0);
});

test('a committed old-space write keeps its receipt but its late result is not returned to a new context',async t=>{
 const store=fixture(t).open(),{spaceId,actorId}=await store.initialize('local-owner',randomUUID()),real=service(store);
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 const lifetime=new AbortController();
 const local=createLocalClient({service:{...real,execute:async(...args)=>{const receipt=await real.execute(...args);entered();await new Promise<void>(resolve=>{release=resolve;});return receipt;}},spaceId,actor:{id:actorId,kind:'user'},now,newId:randomUUID,lifetimeSignal:lifetime.signal,propose:async()=>payload});
 const request={commandId:randomUUID(),issuedAt:now()};
 const pending=local.saveManual(payload,request).then(()=>false,error=>error.code);
 await started;lifetime.abort();release();assert.equal(await pending,'cancelled');
 const state=await store.read(spaceId,x=>x);assert.equal(state.goals.length,1);assert.equal(state.receipts[0]?.commandId,request.commandId);
 assert.throws(()=>local.saveManual(payload),{code:'cancelled'});
});
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

test('request-scoped proposer creates only a draft and never replaces the default proposer', async (t) => {
  const store = fixture(t).open();
  const a = await client(store);
  const generated = {...payload, title: 'Explicit provider draft'};
  let received: string | undefined;
  const draft = await a.client.propose('Explicit input', undefined, {execution: compatibleExecution, propose: async (goal) => {
    received = goal;
    return generated;
  }});
  assert.equal(received, 'Explicit input');
  assert.equal(draft.command.kind, 'plan.create');
  if (draft.command.kind !== 'plan.create') throw new Error('Unexpected command');
  assert.deepEqual(draft.command.payload, generated);
  const snapshot = await a.client.snapshot();
  assert.equal(snapshot.goals.length, 0);
  assert.equal(snapshot.tasks.length, 0);
  const next = await a.client.propose('Default input');
  if (next.command.kind !== 'plan.create') throw new Error('Unexpected command');
  assert.deepEqual(next.command.payload, payload);
});

test('request-scoped provider failure or cancellation never falls back to the default', async (t) => {
  const store = fixture(t).open();
  const a = await client(store);
  await assert.rejects(a.client.propose('Goal', undefined, {execution: compatibleExecution, propose: async () => { throw new Error('provider failed'); }}), /provider failed/);
  const abort = new AbortController();
  await assert.rejects(a.client.propose('Goal', abort.signal, {execution: compatibleExecution, propose: async () => {
    abort.abort();
    return payload;
  }}), {code: 'cancelled'});
  const snapshot = await a.client.snapshot();
  assert.equal(snapshot.drafts.length, 0);
  assert.equal(snapshot.goals.length, 0);
});

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

test('manual draft remains provisional, preserves identity, and confirms linked records', async (t) => {
  const a = await client(fixture(t).open());
  const request = {commandId: randomUUID(), issuedAt: now()};
  const draft = await a.client.createManualDraft(payload, request);
  assert.equal(draft.source, 'ui');
  assert.equal(draft.command.commandId, request.commandId);
  assert.equal(draft.command.issuedAt, request.issuedAt);
  assert.equal(draft.expiresAt, '2026-09-05T12:30:00.000Z');
  const retry = await a.client.createManualDraft(payload, request);
  assert.equal(retry.id, draft.id);
  const before = await a.client.snapshot();
  assert.equal(before.drafts.length, 1);
  assert.equal(before.goals.length + before.projects.length + before.tasks.length, 0);
  await assert.rejects(a.client.createManualDraft({...payload, title: 'Changed'}, request), {code: 'command_conflict'});
  await a.client.confirmDraft(draft.id, draft.version);
  const after = await a.client.snapshot();
  assert.equal(after.goals.length, 1);
  assert.equal(after.projects[0]?.goalId, after.goals[0]?.id);
  assert.equal(after.tasks[0]?.projectId, after.projects[0]?.id);
});

test('manual draft recovers lost create response using the original command only', async (t) => {
  const store = fixture(t).open();
  const a = await client(store);
  const real = service(store);
  let calls = 0;
  const local = createLocalClient({service: {...real, async createDraft(...args) { calls += 1; await real.createDraft(...args); throw new Error('lost draft response'); }}, spaceId: a.spaceId, actor: {id: a.actorId, kind: 'user'}, now, newId: () => {throw new Error('Must not allocate another command ID');}, propose: async () => payload});
  const request = {commandId: randomUUID(), issuedAt: now()};
  const saved = await local.createManualDraft(payload, request);
  assert.equal(saved.command.commandId, request.commandId);
  assert.equal(calls, 1);
  assert.equal((await local.snapshot()).drafts.length, 1);
  assert.equal((await local.snapshot()).goals.length, 0);
});

test('manual draft rejects invalid projects, empty task titles and invalid stable identity', async (t) => {
  const a = await client(fixture(t).open());
  const request = {commandId: randomUUID(), issuedAt: now()};
  for (const projectTitles of [[], ['One', 'Two']]) await assert.rejects(a.client.createManualDraft({...payload, projectTitles}, request), {code: 'invalid_input'});
  await assert.rejects(a.client.createManualDraft({...payload, taskTitles: [' ']}, request), {code: 'invalid_input'});
  await assert.rejects(a.client.createManualDraft(payload, {...request, commandId: 'bad'}), {code: 'invalid_input'});
  assert.equal((await a.client.snapshot()).drafts.length, 0);
});

test('manual draft preserves caller input and refuses unknown outcomes without inventing a new identity', async (t) => {
  const store = fixture(t).open();
  const a = await client(store);
  const real = service(store);
  let received: unknown;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => {release = resolve;});
  const local = createLocalClient({service: {...real, async createDraft(command) {received = command; await waiting; throw new Error('unconfirmed write');}}, spaceId: a.spaceId, actor: {id: a.actorId, kind: 'user'}, now, newId: () => {throw new Error('Unexpected identity');}, propose: async () => payload});
  const input = structuredClone(payload);
  const request = {commandId: randomUUID(), issuedAt: now()};
  const operation = local.createManualDraft(input, request);
  input.taskTitles[0] = 'Changed during wait';
  release();
  await assert.rejects(operation, /unconfirmed write/);
  assert.equal((received as {payload: typeof payload}).payload.taskTitles[0], 'Task');
  assert.equal(input.taskTitles[0], 'Changed during wait');
  assert.equal((await local.snapshot()).drafts.length, 0);
});

test('manual draft cannot adopt an existing AI draft with the same command and payload', async (t) => {
  const a = await client(fixture(t).open());
  const aiDraft = await a.client.propose('Goal');
  await assert.rejects(a.client.createManualDraft(payload, {commandId: aiDraft.command.commandId, issuedAt: aiDraft.command.issuedAt}), {code: 'command_conflict'});
  const snapshot = await a.client.snapshot();
  assert.equal(snapshot.drafts.length, 1);
  assert.equal(snapshot.drafts[0]?.source, 'ai');
  assert.equal(snapshot.goals.length, 0);
});

test('manual draft with an unknown save recovers its original identity after expiry', async (t) => {
  const store = fixture(t).open();
  const a = await client(store);
  let timestamp = now();
  const real = createCommandService({store, now: () => timestamp, newId: randomUUID, hash: value => createHash('sha256').update(value).digest('hex')});
  let unavailable = true;
  const local = createLocalClient({service: {...real,
    async createDraft(...args) {const result = await real.createDraft(...args); if (unavailable) throw new Error('lost draft response'); return result;},
    async listPlan(...args) {if (unavailable) throw new Error('read unavailable'); return real.listPlan(...args);},
  }, spaceId: a.spaceId, actor: {id: a.actorId, kind: 'user'}, now: () => timestamp, newId: () => {throw new Error('No replacement identity');}, propose: async () => payload});
  const request = {commandId: randomUUID(), issuedAt: timestamp};
  await assert.rejects(local.createManualDraft(payload, request), /read unavailable/);
  const saved = (await a.client.snapshot()).drafts[0]!;
  timestamp = '2026-09-05T12:31:00.000Z';
  await assert.rejects(local.createManualDraft(payload, request), /read unavailable/);
  unavailable = false;
  const recovered = await local.createManualDraft(payload, request);
  assert.equal(recovered.id, saved.id);
  assert.equal(recovered.command.commandId, request.commandId);
  assert.equal(recovered.expiresAt, '2026-09-05T12:30:00.000Z');
  const snapshot = await local.snapshot();
  assert.equal(snapshot.drafts.length, 1);
  assert.equal(snapshot.goals.length, 0);
  await assert.rejects(local.confirmDraft(recovered.id, recovered.version), {code: 'approval_expired'});
  await assert.rejects(local.createManualDraft(payload, {...request, commandId: randomUUID()}), {code: 'approval_expired'});
});

test('compatible execution metadata survives draft confirmation and SQLite reopen with unknown usage', async (t) => {
  const f = fixture(t), store = f.open(), a = await client(store);
  const actor = {id: a.actorId, kind: 'user' as const};
  const local = createLocalClient({service: service(store), runService: createRunService({store, now, newId: randomUUID}), spaceId: a.spaceId, actor, now, newId: randomUUID, propose: async () => payload});
  const execution = {executor: 'compatible', modelVersion: 'configured/model-id', promptVersion: 'compatible-plan-v1'} as const;
  const draft = await local.propose('Goal', undefined, {execution, propose: async () => payload});
  await local.confirmDraft(draft.id, draft.version);
  await store.close();
  const runs = await createRunService({store: f.open(), now, newId: randomUUID}).list(a.spaceId, actor);
  assert.equal(runs[0]?.executor, execution.executor);
  assert.equal(runs[0]?.modelVersion, execution.modelVersion);
  assert.equal(runs[0]?.promptVersion, execution.promptVersion);
  assert.equal(runs[0]?.usage, null);
  assert.equal(runs[0]?.status, 'succeeded');
});

test('request-scoped proposer without valid execution metadata is rejected before starting a run', async (t) => {
  const store = fixture(t).open(), a = await client(store);
  const actor = {id: a.actorId, kind: 'user' as const};
  const local = createLocalClient({service: service(store), runService: createRunService({store, now, newId: randomUUID}), spaceId: a.spaceId, actor, now, newId: randomUUID, propose: async () => payload});
  let called = false;
  for (const request of [async () => {called = true; return payload;}, {propose: async () => {called = true; return payload;}}, {execution: {executor: 'compatible', modelVersion: 'model'}, propose: async () => {called = true; return payload;}}]) {
    await assert.rejects(local.propose('Goal', undefined, request as never), {code: 'invalid_input'});
  }
  assert.equal(called, false);
  assert.equal((await local.snapshot()).runs.length, 0);
});

const unlinkBaseUrl = 'http://127.0.0.1:8787/v1';
const unlinkPassword = '合成的当前密码 15+ 字符 🌙';
/** Controller over one seeded recovery record; every route is a stand-in inside this process. */
function unlinkFixture({authenticated = true}: {authenticated?: boolean} = {}) {
  const subjectId = randomUUID(), sessionId = randomUUID(), installationId = randomUUID();
  const opaque = () => `${randomUUID()}.${'s'.repeat(43)}`;
  const at = () => new Date(Date.now() + 600_000).toISOString();
  const refreshToken = opaque();
  // One seeded deadline for the absolute expiry, so a rotation answers with the same instant the
  // stored record already carries instead of a slightly later one.
  const seededExpiry = at();
  let raw: string | null = authenticated ? JSON.stringify({schemaVersion: 1, environment: 'test', apiBaseUrl: unlinkBaseUrl, installationId,
    active: {subjectId, subjectKind: 'adult', sessionId, refreshToken, refreshExpiresAt: seededExpiry, absoluteExpiresAt: seededExpiry, pendingRotationId: null, pendingSince: null}, revocations: []}) : null;
  const calls = {reauth: [] as {token: string; password: string; action: string}[], unlink: [] as {token: string; identityId: string; reauthGrant: string}[], refresh: 0, logout: 0};
  const issued: string[] = [];
  let committed = false, failUnlink = false, unlinkCode: 'network' | 'timeout' | 'unavailable' | 'last_method_required' | 'identity_not_found' = 'network';
  let wait: {promise: Promise<void>; resolve: () => void} | null = null, notify: (() => void) | null = null;
  const api = {endpoint: {environment: 'test' as const, apiBaseUrl: unlinkBaseUrl},
    reauthPassword: async (token: string, password: string, _signal?: AbortSignal, action = 'change-password') => {
      calls.reauth.push({token, password, action});
      const reauthGrant = opaque(); issued.push(reauthGrant);
      return {reauthGrant, expiresAt: at()};
    },
    unlinkIdentity: async (token: string, identityId: string, reauthGrant: string) => {
      calls.unlink.push({token, identityId, reauthGrant}); notify?.();
      if (wait) await wait.promise;
      if (failUnlink) {failUnlink = false; throw new AuthClientError(unlinkCode);}
      committed = true;
    },
    // The server revokes every credential of the subject when it removes the method, so a refresh
    // only answers while the removal has not happened.
    refresh: async () => {
      calls.refresh++;
      if (committed) throw new AuthClientError('reauth_required');
      const expiry = at(), stored = JSON.parse(raw!).active as {refreshToken: string; absoluteExpiresAt: string};
      return {tokenType: 'Bearer' as const, accessToken: 'synthetic-access-1', accessExpiresAt: expiry, refreshToken: stored.refreshToken, refreshExpiresAt: stored.absoluteExpiresAt, sessionAbsoluteExpiresAt: stored.absoluteExpiresAt,
        session: {subjectId, subjectKind: 'adult' as const, sessionId, expiresAt: expiry}};
    },
    logout: async () => {calls.logout++;}};
  const host = createAuthController({api: api as unknown as AuthApiClient, vault: {read: async () => raw, write: async value => {raw = value;}}, newId: randomUUID});
  return {host, calls, subjectId, sessionId, raw: () => raw!,
    lastGrant: () => issued[issued.length - 1]!,
    fail(code: typeof unlinkCode) {failUnlink = true; unlinkCode = code;},
    commitBeforeFailure() {committed = true;},
    hold() {let resolve!: () => void; wait = {promise: new Promise<void>(r => {resolve = r;}), resolve};},
    release() {wait?.resolve(); wait = null;},
    next() {return new Promise<void>(resolve => {notify = resolve;});}};
}

test('unlinking a login method clears the local session only after the server confirms the removal', async () => {
  const f = unlinkFixture(); await f.host.bootstrap();
  const identityId = `email:${randomUUID()}`;
  assert.equal(await f.host.unlinkIdentity(identityId, unlinkPassword), undefined);
  assert.deepEqual(f.calls.reauth, [{token: 'synthetic-access-1', password: unlinkPassword, action: 'unlink-identity'}]);
  assert.deepEqual(f.calls.unlink, [{token: 'synthetic-access-1', identityId, reauthGrant: f.lastGrant()}]);
  // The server already revoked every session of the subject, so nothing is queued for it locally.
  assert.equal(f.calls.logout, 0);
  assert.equal(f.host.getState().status, 'anonymous'); assert.equal(f.host.getState().session, null); assert.equal(f.host.getState().account, null);
  assert.equal(f.host.getState().pendingRevocations, 0); assert.equal(JSON.parse(f.raw()!).active, null);
  // The one-time grant is spent inside the call: it is not persisted, queued or published.
  assert.equal(f.raw()!.includes(f.lastGrant()), false); assert.equal(f.raw()!.includes('reauthGrant'), false);
  assert.equal(JSON.stringify(f.host.getState()).includes(f.lastGrant()), false);
});

test('identity unlink requires an authenticated session and validates the handle and password first', async () => {
  const anonymous = unlinkFixture({authenticated: false}); await anonymous.host.bootstrap();
  await assert.rejects(anonymous.host.unlinkIdentity(`email:${randomUUID()}`, unlinkPassword), {code: 'reauth_required'});
  assert.deepEqual(anonymous.calls.reauth, []); assert.deepEqual(anonymous.calls.unlink, []); assert.equal(anonymous.calls.refresh, 0);
  const f = unlinkFixture(); await f.host.bootstrap();
  for (const identityId of [randomUUID(), `apple:${randomUUID()}`, 'email:not-a-uuid', 'EMAIL:0F0D1F5E-1A2B-4C3D-8E4F-5A6B7C8D9E0F']) {
    await assert.rejects(f.host.unlinkIdentity(identityId, unlinkPassword), {code: 'invalid_request'});
  }
  await assert.rejects(f.host.unlinkIdentity(`email:${randomUUID()}`, 'too short'), {code: 'invalid_request'});
  assert.deepEqual(f.calls.reauth, []); assert.deepEqual(f.calls.unlink, []);
  assert.equal(f.host.getState().status, 'authenticated'); assert.equal(JSON.parse(f.raw()!).active.sessionId, f.sessionId);
});

test('both unlink refusals keep their own code and are never probed or repeated', async () => {
  const f = unlinkFixture(); await f.host.bootstrap();
  const identityId = `email:${randomUUID()}`;
  f.fail('last_method_required');
  await assert.rejects(f.host.unlinkIdentity(identityId, unlinkPassword), {code: 'last_method_required'});
  f.fail('identity_not_found');
  await assert.rejects(f.host.unlinkIdentity(identityId, unlinkPassword), {code: 'identity_not_found'});
  assert.equal(f.calls.unlink.length, 2);
  // Only bootstrap refreshed: a refusal is surfaced as-is, with no probe and no second mutation.
  assert.equal(f.calls.refresh, 1);
  assert.notEqual(f.calls.unlink[0]!.reauthGrant, f.calls.unlink[1]!.reauthGrant);
  assert.equal(f.host.getState().status, 'authenticated'); assert.equal(f.host.getState().session!.sessionId, f.sessionId);
  assert.equal(JSON.parse(f.raw()!).active.sessionId, f.sessionId);
});

test('a lost DELETE is never repeated and the session probe decides the local outcome', async () => {
  const retained = unlinkFixture(); await retained.host.bootstrap();
  const identityId = `email:${randomUUID()}`;
  retained.fail('network');
  await assert.rejects(retained.host.unlinkIdentity(identityId, unlinkPassword), {code: 'network'});
  assert.equal(retained.calls.unlink.length, 1); assert.equal(retained.calls.refresh, 2);
  assert.equal(retained.host.getState().status, 'authenticated'); assert.equal(JSON.parse(retained.raw()!).active.sessionId, retained.sessionId);
  // The same loss after the server committed is a dead session, not a success story.
  const committed = unlinkFixture(); await committed.host.bootstrap(); committed.commitBeforeFailure(); committed.fail('network');
  await assert.rejects(committed.host.unlinkIdentity(identityId, unlinkPassword), {code: 'reauth_required'});
  assert.equal(committed.calls.unlink.length, 1); assert.equal(committed.calls.refresh, 2);
  assert.equal(committed.host.getState().status, 'anonymous'); assert.equal(JSON.parse(committed.raw()!).active, null);
});

test('an unlink in flight is cancelled by a generation change without a second mutation', async () => {
  const f = unlinkFixture(); await f.host.bootstrap(); f.hold();
  const entered = f.next(), pending = f.host.unlinkIdentity(`email:${randomUUID()}`, unlinkPassword);
  await entered; await f.host.logout(); f.release();
  await assert.rejects(pending, {code: 'cancelled'});
  assert.equal(f.calls.unlink.length, 1); assert.equal(f.calls.logout, 1);
  assert.equal(f.host.getState().status, 'anonymous'); assert.equal(JSON.parse(f.raw()!).active, null);
});
