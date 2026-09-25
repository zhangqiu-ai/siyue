import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createDeletionLedgerStore, createDeletionLedgerGate, DELETION_LEDGER_FORMAT }
  from '../../dist/account-deletion-ledger/index.js';
// The main-database half of the fence, read here only to prove the ledger side hands it a value its
// strict schema accepts and its comparator can decide on.
import { compareLedgerFence, ledgerFencePointSchema } from '../../dist/account-deletion-ledger/fence.js';

// Independent deletion anti-revival ledger (design 13.4) against an isolated temporary PostgreSQL
// cluster only. The fixture builds a fresh cluster on a short Unix socket and never reads a database
// URL or the workspace .env. Two independent temporary databases live in it:
//   * siyue_test            - the restorable main database (provision/independent-database.sql)
//   * siyue_deletion_ledger - the ledger, own role pair, created by provision/deletion-ledger.sql
// The second one is never part of a main-database backup, which is exactly what the restore test
// relies on. Every UUID, instant and password below is synthetic, and no mail, provider, real
// account database or network call happens.
// The ledger also carries a monotonic watermark (ledger.metadata.seq = max(seq) over ledger.entries).
// Cases below move it one step per effective change and prove that a ledger whose entries were
// truncated, deleted or restored without the watermark fails closed instead of reading as clear.
const LEDGER_DATABASE = 'siyue_deletion_ledger';
const LEDGER_ROLE = 'siyue_deletion_ledger_app';
let db, ledger, ledgerAdmin, store, gate, now;
const clock = () => new Date(now);

const postgresBin = () => process.env.SIYUE_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
/**
 * Runs the checked-in provisioning script as the fixture admin, the way an operator would, against
 * one database name, and reports the exit status instead of throwing so a test can assert on it.
 */
async function runProvisioning(database) {
  const bin = postgresBin();
  if (!existsSync(join(bin, 'psql'))) throw Error('PostgreSQL binaries missing; set SIYUE_TEST_POSTGRES_BIN');
  const socket = (await db.admin.query("SELECT current_setting('unix_socket_directories') AS socket")).rows[0].socket;
  try {
    execFileSync(join(bin, 'psql'), ['-h', socket, '-U', 'siyue_test_admin', '-d', 'postgres', '-f',
      fileURLToPath(new URL('../../provision/deletion-ledger.sql', import.meta.url))], {
      env: { ...process.env, LC_ALL: 'C', SIYUE_DELETION_LEDGER_DATABASE: database,
        SIYUE_DELETION_LEDGER_ENVIRONMENT: 'test',
        SIYUE_DELETION_LEDGER_APP_PASSWORD: randomBytes(32).toString('hex') },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return { status: 0, stderr: '' };
  } catch (error) { return { status: error.status, stderr: error.stderr?.toString() ?? '' }; }
}
/** The first provisioning run; a failure here means the rest of the file cannot mean anything. */
async function provisionLedger() {
  const { status, stderr } = await runProvisioning(LEDGER_DATABASE);
  if (status !== 0) throw Error(`ledger provisioning failed: ${stderr.split('\n')[0]}`);
}

before(async () => {
  db = await startPostgresFixture();
  await provisionLedger();
  ledger = db.poolFor(LEDGER_ROLE, LEDGER_DATABASE);
  ledgerAdmin = db.poolFor('siyue_test_admin', LEDGER_DATABASE);
});
beforeEach(async () => {
  now = Date.parse('2026-09-24T00:00:00.000Z');
  // The runtime role deliberately holds no TRUNCATE privilege on the main database either.
  await db.admin.query('TRUNCATE siyue.subjects CASCADE');
  // Self-heal whatever a fail-closed test deliberately broke, so one case cannot poison the next. The
  // fixture truncates the entries, so the watermark goes back to 0 in the same breath: leaving it
  // ahead of the entries is exactly the truncation the store now refuses to answer around.
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  await ledgerAdmin.query(`GRANT USAGE ON SCHEMA ledger TO ${LEDGER_ROLE}`);
  await ledgerAdmin.query(`INSERT INTO ledger.metadata(singleton,format,environment,seq,entry_count) VALUES(true,$1,'test',0,0)
    ON CONFLICT (singleton) DO UPDATE SET format=excluded.format, environment=excluded.environment, seq=0, entry_count=0`,
  [DELETION_LEDGER_FORMAT]);
  store = createDeletionLedgerStore(ledger,{database:LEDGER_DATABASE,environment:'test'},clock);
  gate = createDeletionLedgerGate(store);
});
after(async () => { await db?.stop(); });

const uuid = () => randomUUID();
const addSubject = async () => {
  const subjectId = uuid();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [subjectId]);
  return subjectId;
};
const ledgerRow = subjectId => ledger.query(`SELECT subject_id,intent_id,status,prepared_at,accepted_at,
  cancelled_at FROM ledger.entries WHERE subject_id=$1`, [subjectId]).then(result => result.rows[0] ?? null);
const subjectRow = subjectId => db.app.query('SELECT to_jsonb(s) AS row FROM siyue.subjects s WHERE id=$1', [subjectId])
  .then(result => result.rows[0]?.row ?? null);
/** Asserts one statement was refused with one SQLSTATE. */
const failure = async (query, code) => assert.equal((await query.then(() => null, error => error))?.code, code);
/** The watermark and one row's sequence as text: pg returns bigint as a string, so tests compare text. */
const watermark = () => ledger.query('SELECT seq::text AS seq FROM ledger.metadata')
  .then(result => result.rows[0]?.seq ?? null);
const ledgerSeq = subjectId => ledger.query('SELECT seq::text AS seq FROM ledger.entries WHERE subject_id=$1',
  [subjectId]).then(result => result.rows[0]?.seq ?? null);

test('账本独立于主库：主库角色不可触达，账本角色不可触达主库，且只保存 UUID/时间/状态', async () => {
  assert.equal((await ledger.query('SELECT format FROM ledger.metadata')).rows[0].format, DELETION_LEDGER_FORMAT);
  // The runtime role has no table write privilege and no DDL anywhere: it cannot forge, downgrade or
  // delete a marker, and cannot create a schema or table of its own to fake a ledger.
  for (const [sql, params] of [
    ["INSERT INTO ledger.entries(subject_id,intent_id,status,prepared_at) VALUES($1,$2,'prepared',now())", [uuid(), uuid()]],
    ["INSERT INTO ledger.entries(subject_id,intent_id,status,prepared_at,accepted_at) VALUES($1,$2,'accepted',now(),now())", [uuid(), uuid()]],
    ["UPDATE ledger.entries SET status='cancelled'", []],
    ['DELETE FROM ledger.entries', []],
    ['TRUNCATE ledger.entries', []],
    ['CREATE TABLE ledger.forged(id int)', []],
    ['CREATE TABLE public.forged(id int)', []],
    ["UPDATE ledger.metadata SET format='siyue-deletion-ledger-v0'", []],
    // The watermark is not the runtime's to move either: no table write privilege, and no EXECUTE on
    // the allocator the three transitions use.
    ['UPDATE ledger.metadata SET seq=seq+1', []],
    ['SELECT ledger.advance_watermark()', []],
  ]) await failure(ledger.query(sql, params), '42501');
  // Independence in both directions: the main-database runtime role cannot reach the ledger database,
  // and the ledger role cannot reach the main one (each revokes CONNECT from PUBLIC).
  await failure(db.poolFor('siyue_app', LEDGER_DATABASE).query('SELECT 1'), '42501');
  await failure(db.poolFor(LEDGER_ROLE, 'siyue_test').query('SELECT 1'), '42501');
  // Shape: exactly two tables, and no column that could hold an email, a name or any content.
  const tables = (await ledgerAdmin.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='ledger' ORDER BY table_name`)).rows.map(entry => entry.table_name);
  assert.deepEqual(tables, ['entries', 'metadata']);
  const columns = (await ledgerAdmin.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='ledger' ORDER BY table_name, ordinal_position`)).rows.map(entry => entry.column_name);
  assert.deepEqual(columns, ['subject_id', 'intent_id', 'status', 'prepared_at', 'accepted_at', 'cancelled_at',
    'seq', 'singleton', 'format', 'environment', 'instance_id', 'seq', 'entry_count']);
  assert.equal(columns.some(name => /email|mail|name|body|content|token|secret|phone|profile|address/i.test(name)), false);
});

test('provisioning 只接受账本命名契约：无效库名在建立任何对象前退出，不留下数据库', async () => {
  const { status } = await runProvisioning('siyue');
  assert.notEqual(status, 0);
  assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM pg_database WHERE datname='siyue'")).rows[0].n, 0);
});

test('prepare 先持久化：独立连接立即可见，重复幂等，不同 intent 冲突而非覆盖', async () => {
  const subjectId = await addSubject(), intents = [uuid(), uuid()];
  const prepared = await store.prepare({ subjectId, intentId: intents[0] });
  assert.deepEqual(prepared, { subjectId, intentId: intents[0], status: 'prepared',
    preparedAt: new Date(now).toISOString(), acceptedAt: null, cancelledAt: null });
  // A different connection to the same ledger database already sees the row, i.e. it was persisted
  // before anything else about the deletion happened.
  const mirror = db.poolFor(LEDGER_ROLE, LEDGER_DATABASE);
  assert.deepEqual((await mirror.query('SELECT status,intent_id FROM ledger.entries WHERE subject_id=$1', [subjectId])).rows[0],
    { status: 'prepared', intent_id: intents[0] });
  now += 3_600_000;
  assert.deepEqual(await store.prepare({ subjectId, intentId: intents[0] }), prepared);
  await assert.rejects(store.prepare({ subjectId, intentId: intents[1] }), { code: 'LEDGER_INTENT_CONFLICT' });
  assert.deepEqual(await ledgerRow(subjectId), { subject_id: subjectId, intent_id: intents[0], status: 'prepared',
    prepared_at: new Date(prepared.preparedAt), accepted_at: null, cancelled_at: null });
  for (const bad of [{ subjectId: 'not-a-uuid', intentId: uuid() }, { subjectId, intentId: uuid(), extra: true }, { subjectId }])
    await assert.rejects(store.prepare(bad), { code: 'LEDGER_INVALID_REQUEST' });
  assert.equal((await ledger.query('SELECT count(*)::int AS n FROM ledger.entries')).rows[0].n, 1);
});

test('首次 prepare 的并发重试只建立一个意图与一个水位', async () => {
  const subjectId = await addSubject(), intentId = uuid();
  const results = await Promise.all(Array.from({ length: 4 }, () => store.prepare({ subjectId, intentId })));
  assert.ok(results.every(entry => entry.status === 'prepared' && entry.intentId === intentId));
  assert.equal(await watermark(), '1');
  assert.equal((await ledger.query('SELECT entry_count::text AS n FROM ledger.metadata')).rows[0].n, '1');
  assert.equal((await ledger.query('SELECT count(*)::int AS n FROM ledger.entries')).rows[0].n, 1);
});

test('markAccepted 只在 prepared 之后持久化；未 prepare 或 intent 不符不产生 accepted', async () => {
  const subjectId = await addSubject(), intent = uuid();
  await assert.rejects(store.markAccepted({ subjectId, intentId: intent }), { code: 'LEDGER_NOT_PREPARED' });
  assert.equal(await ledgerRow(subjectId), null);
  await store.prepare({ subjectId, intentId: intent });
  await assert.rejects(store.markAccepted({ subjectId, intentId: uuid() }), { code: 'LEDGER_INTENT_CONFLICT' });
  assert.equal((await ledgerRow(subjectId)).status, 'prepared');
  now += 60_000;
  const accepted = await store.markAccepted({ subjectId, intentId: intent });
  assert.deepEqual(accepted, { subjectId, intentId: intent, status: 'accepted',
    preparedAt: new Date(Date.parse('2026-09-24T00:00:00.000Z')).toISOString(),
    acceptedAt: new Date(now).toISOString(), cancelledAt: null });
  // Repeating it after an uncertain result is safe: same intent, same row, no second acceptance.
  assert.deepEqual(await store.markAccepted({ subjectId, intentId: intent }), accepted);
  const mirror = db.poolFor(LEDGER_ROLE, LEDGER_DATABASE);
  assert.equal((await mirror.query('SELECT status FROM ledger.entries WHERE subject_id=$1', [subjectId])).rows[0].status, 'accepted');
});

test('已 accepted 不可取消或降级：运行角色无写权限，账本函数返回 accepted_immutable', async () => {
  const subjectId = await addSubject(), intent = uuid();
  await store.prepare({ subjectId, intentId: intent });
  now += 1_000;
  const accepted = await store.markAccepted({ subjectId, intentId: intent });
  for (const [sql, params] of [
    ["UPDATE ledger.entries SET status='cancelled',cancelled_at=now(),accepted_at=NULL WHERE subject_id=$1", [subjectId]],
    ["UPDATE ledger.entries SET status='prepared' WHERE subject_id=$1", [subjectId]],
    ['UPDATE ledger.entries SET intent_id=gen_random_uuid()', []],
    ['DELETE FROM ledger.entries WHERE subject_id=$1', [subjectId]],
    ['TRUNCATE ledger.entries', []],
  ]) await failure(ledger.query(sql, params), '42501');
  await assert.rejects(store.cancel({ subjectId, intentId: intent }), { code: 'LEDGER_ACCEPTED_IMMUTABLE' });
  // Defense in depth: the ledger function itself refuses the downgrade, so even a direct caller that
  // bypasses the adapter cannot clear the marker.
  const direct = (await ledger.query('SELECT ledger.cancel_intent($1,$2,$3) AS result',
    [subjectId, intent, new Date(now + 60_000)])).rows[0].result;
  assert.equal(direct.outcome, 'accepted_immutable');
  const rePrepare = await store.prepare({ subjectId, intentId: uuid() });
  assert.equal(rePrepare.status, 'accepted');
  assert.equal(rePrepare.intentId, intent);
  assert.deepEqual(await ledgerRow(subjectId), { subject_id: subjectId, intent_id: intent, status: 'accepted',
    prepared_at: new Date(accepted.preparedAt), accepted_at: new Date(accepted.acceptedAt), cancelled_at: null });
});

test('需重放的是 prepared 与 accepted；cancelled 与空账本不是', async () => {
  assert.deepEqual(await store.listReplayable(), []);
  assert.deepEqual(await gate.restoreGate({ restored: true }), { openLogin: true, replay: { accepted: [], prepared: [] } });
  const preparedSubject = await addSubject(), acceptedSubject = await addSubject(), cancelledSubject = await addSubject();
  await store.prepare({ subjectId: preparedSubject, intentId: uuid() });
  now += 1_000;
  const acceptedIntent = uuid();
  await store.prepare({ subjectId: acceptedSubject, intentId: acceptedIntent });
  now += 1_000;
  await store.markAccepted({ subjectId: acceptedSubject, intentId: acceptedIntent });
  now += 1_000;
  const cancelledIntent = uuid();
  await store.prepare({ subjectId: cancelledSubject, intentId: cancelledIntent });
  now += 1_000;
  await store.cancel({ subjectId: cancelledSubject, intentId: cancelledIntent });
  assert.deepEqual((await store.listReplayable()).map(entry => [entry.subjectId, entry.status]),
    [[preparedSubject, 'prepared'], [acceptedSubject, 'accepted']]);
  assert.deepEqual(await gate.restoreGate({ restored: true }), { openLogin: false, reason: 'replay_required',
    replay: { accepted: [acceptedSubject], prepared: [preparedSubject] } });
  // A cancelled row is a withdrawn request, not a deletion marker, and does not block its subject.
  assert.deepEqual(await gate.loginDecision(cancelledSubject), { allow: true, reason: 'ledger_clear' });
});

test('主库回滚后 prepared 仅阻断登录：不自动删除，也不冒充已注销', async () => {
  const subjectId = await addSubject(), intent = uuid();
  await store.prepare({ subjectId, intentId: intent });
  const before = await subjectRow(subjectId);
  await assert.rejects(transaction(db.app, async client => {
    await client.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1", [subjectId]);
    throw new Error('synthetic_main_database_rollback');
  }), /synthetic_main_database_rollback/);
  assert.equal((await db.app.query('SELECT status FROM siyue.subjects WHERE id=$1', [subjectId])).rows[0].status, 'active');
  assert.deepEqual(await gate.loginDecision(subjectId), { allow: false, reason: 'deletion_prepared_unresolved' });
  // Blocking a login is not deleting: the main row, the deletion job table and the ledger row are all
  // untouched by the decision.
  assert.deepEqual(await subjectRow(subjectId), before);
  assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs WHERE subject_id=$1',
    [subjectId])).rows[0].n, 0);
  assert.equal((await ledgerRow(subjectId)).status, 'prepared');
  // Only a main transaction known to have rolled back may be compensated; the accepted case above can
  // never be cleared this way.
  assert.equal((await store.cancel({ subjectId, intentId: intent })).status, 'cancelled');
  assert.deepEqual(await gate.loginDecision(subjectId), { allow: true, reason: 'ledger_clear' });
});

test('旧备份恢复出的已注销账户在账本重放前不得登录', async () => {
  const subjectId = await addSubject(), intent = uuid();
  const backup = await subjectRow(subjectId);
  await store.prepare({ subjectId, intentId: intent });
  now += 1_000;
  await db.app.query(`UPDATE siyue.subjects SET status='deletion_pending',
    credential_version=credential_version+1, updated_at=now() WHERE id=$1`, [subjectId]);
  await store.markAccepted({ subjectId, intentId: intent });
  assert.deepEqual(await gate.loginDecision(subjectId), { allow: false, reason: 'deletion_accepted' });
  // Simulate restoring an older main-database backup: the pre-deletion row is written back, so the
  // account exists again exactly as the backup had it. A real restore would bring back its old
  // sessions and profile the same way; nothing here re-creates them.
  await db.app.query('DELETE FROM siyue.subjects WHERE id=$1', [subjectId]);
  await db.app.query('INSERT INTO siyue.subjects SELECT * FROM jsonb_populate_record(NULL::siyue.subjects,$1::jsonb)',
    [backup]);
  assert.equal((await db.app.query('SELECT status FROM siyue.subjects WHERE id=$1', [subjectId])).rows[0].status, 'active');
  // The ledger lives in a different database, so the restore cannot bring it back with the account:
  // login stays refused and the subject must be replayed before login reopens.
  assert.deepEqual(await gate.loginDecision(subjectId), { allow: false, reason: 'deletion_accepted' });
  assert.deepEqual(await gate.restoreGate({ restored: true }), { openLogin: false, reason: 'replay_required',
    replay: { accepted: [subjectId], prepared: [] } });
  assert.equal((await ledgerRow(subjectId)).status, 'accepted');
  // Without a restore, login is decided per subject, and another subject is unaffected.
  assert.deepEqual(await gate.restoreGate({ restored: false }), { openLogin: true, replay: null });
  assert.deepEqual(await gate.loginDecision(await addSubject()), { allow: true, reason: 'ledger_clear' });
});

test('账本损坏或不可用时 fail closed：不放开登录，也不报告重放已完成', async () => {
  const subjectId = await addSubject();
  await ledgerAdmin.query("UPDATE ledger.metadata SET environment='production'");
  assert.deepEqual(await gate.loginDecision(subjectId), {allow:false,reason:'ledger_unreadable'});
  await ledgerAdmin.query("UPDATE ledger.metadata SET environment='test'");
  // Unreachable ledger: the database does not exist, so no read can prove the subject is clear.
  const missing = createDeletionLedgerGate(createDeletionLedgerStore(
    db.poolFor(LEDGER_ROLE, `${LEDGER_DATABASE}_missing`),
    {database:`${LEDGER_DATABASE}_missing`,environment:'test'},clock));
  assert.deepEqual(await missing.loginDecision(subjectId), { allow: false, reason: 'ledger_unavailable' });
  assert.deepEqual(await missing.restoreGate({ restored: true }), { openLogin: false, reason: 'ledger_unavailable' });
  // Reachable but unreadable ledger: the schema privilege is gone, so the ledger cannot answer.
  await ledgerAdmin.query(`REVOKE USAGE ON SCHEMA ledger FROM ${LEDGER_ROLE}`);
  try {
    assert.deepEqual(await gate.loginDecision(subjectId), { allow: false, reason: 'ledger_unavailable' });
    assert.deepEqual(await gate.restoreGate({ restored: true }), { openLogin: false, reason: 'ledger_unavailable' });
  } finally { await ledgerAdmin.query(`GRANT USAGE ON SCHEMA ledger TO ${LEDGER_ROLE}`); }
  // Corrupt marker, first variant: the format row is gone. "Nothing to replay" would be a lie.
  await ledgerAdmin.query('DELETE FROM ledger.metadata');
  assert.deepEqual(await gate.loginDecision(subjectId), { allow: false, reason: 'ledger_unreadable' });
  assert.deepEqual(await gate.restoreGate({ restored: true }), { openLogin: false, reason: 'ledger_unreadable' });
  // Corrupt marker, second variant: a foreign or stale format is not this ledger.
  await ledgerAdmin.query("INSERT INTO ledger.metadata(singleton,format,environment) VALUES(true,'siyue-deletion-ledger-v0','test')");
  assert.deepEqual(await gate.loginDecision(subjectId), { allow: false, reason: 'ledger_unreadable' });
  assert.deepEqual(await gate.restoreGate({ restored: true }), { openLogin: false, reason: 'ledger_unreadable' });
  // The same failure blocks a subject that has no marker at all: fail closed does not depend on the
  // subject, otherwise an unreadable ledger would silently allow everyone it cannot see.
  assert.deepEqual(await gate.loginDecision(await addSubject()), { allow: false, reason: 'ledger_unreadable' });
  assert.deepEqual(await gate.loginDecision('not-a-uuid'), { allow: false, reason: 'invalid_subject' });
  assert.deepEqual(await gate.restoreGate({ restored: 'yes' }), { openLogin: false, reason: 'invalid_request' });
});

test('单调水位：每次有效变更推进一次，幂等重复、冲突与被拒调用都不推进', async () => {
  const subjectId = await addSubject(), stranger = await addSubject();
  const intent = uuid(), otherIntent = uuid();
  assert.equal(await watermark(), '0');
  await store.prepare({ subjectId, intentId: intent });
  assert.deepEqual([await watermark(), await ledgerSeq(subjectId)], ['1', '1']);
  // Repeats and refusals change no row, so they move nothing: the number counts committed changes.
  now += 1_000;
  await store.prepare({ subjectId, intentId: intent });
  await assert.rejects(store.prepare({ subjectId, intentId: otherIntent }), { code: 'LEDGER_INTENT_CONFLICT' });
  await assert.rejects(store.prepare({ subjectId, intentId: 'not-a-uuid' }), { code: 'LEDGER_INVALID_REQUEST' });
  await assert.rejects(store.markAccepted({ subjectId: stranger, intentId: otherIntent }), { code: 'LEDGER_NOT_PREPARED' });
  await assert.rejects(store.cancel({ subjectId: stranger, intentId: otherIntent }), { code: 'LEDGER_NOT_PREPARED' });
  assert.deepEqual([await watermark(), await ledgerSeq(subjectId)], ['1', '1']);
  now += 1_000;
  await store.markAccepted({ subjectId, intentId: intent });
  assert.deepEqual([await watermark(), await ledgerSeq(subjectId)], ['2', '2']);
  // An accepted row is terminal: a repeat, a later prepare and a cancel all return it and move nothing.
  await store.markAccepted({ subjectId, intentId: intent });
  assert.equal((await store.prepare({ subjectId, intentId: otherIntent })).status, 'accepted');
  await assert.rejects(store.cancel({ subjectId, intentId: intent }), { code: 'LEDGER_ACCEPTED_IMMUTABLE' });
  assert.deepEqual([await watermark(), await ledgerSeq(subjectId)], ['2', '2']);
  // A second subject: prepare, cancel, a repeated cancel, then a re-prepare over the cancelled row.
  now += 1_000;
  await store.prepare({ subjectId: stranger, intentId: otherIntent });
  assert.deepEqual([await watermark(), await ledgerSeq(stranger)], ['3', '3']);
  now += 1_000;
  await store.cancel({ subjectId: stranger, intentId: otherIntent });
  assert.deepEqual([await watermark(), await ledgerSeq(stranger)], ['4', '4']);
  now += 1_000;
  await store.cancel({ subjectId: stranger, intentId: otherIntent });
  assert.deepEqual([await watermark(), await ledgerSeq(stranger)], ['4', '4']);
  now += 1_000;
  await store.prepare({ subjectId: stranger, intentId: uuid() });
  assert.deepEqual([await watermark(), await ledgerSeq(stranger)], ['5', '5']);
  // The reads agree at every step above, and the rows still carry the whole state.
  assert.deepEqual((await store.listReplayable()).map(entry => [entry.subjectId, entry.status]),
    [[subjectId, 'accepted'], [stranger, 'prepared']]);
});

test('截断检测 fail closed：条目被删、被清空或水位回退时都不回答，也不放开登录', async () => {
  const kept = await addSubject(), newest = await addSubject();
  await store.prepare({ subjectId: kept, intentId: uuid() });
  now += 1_000;
  await store.prepare({ subjectId: newest, intentId: uuid() });
  assert.deepEqual((await store.listReplayable()).map(entry => entry.subjectId), [kept, newest]);
  const olderRow = await ledgerRow(kept);
  const newestRow = await ledgerRow(newest);
  // Removing an older row leaves max(seq) unchanged. The row count still exposes the loss.
  await ledgerAdmin.query('DELETE FROM ledger.entries WHERE subject_id=$1', [kept]);
  await assert.rejects(store.lookup(newest), { code: 'LEDGER_UNREADABLE' });
  await assert.rejects(store.prepare({ subjectId: uuid(), intentId: uuid() }), { code: 'LEDGER_UNREADABLE' });
  await ledgerAdmin.query(`INSERT INTO ledger.entries(subject_id,intent_id,status,prepared_at,accepted_at,cancelled_at,seq)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [olderRow.subject_id, olderRow.intent_id, olderRow.status,
    olderRow.prepared_at, olderRow.accepted_at, olderRow.cancelled_at, 1]);
  assert.deepEqual((await store.listReplayable()).map(entry => entry.subjectId), [kept, newest]);
  // Deleting exactly the newest row leaves the watermark one ahead of every remaining sequence: the
  // ledger can no longer show that the missing row was not a deletion marker, so it answers nothing.
  await ledgerAdmin.query('DELETE FROM ledger.entries WHERE subject_id=$1', [newest]);
  await assert.rejects(store.lookup(newest), { code: 'LEDGER_UNREADABLE' });
  await assert.rejects(store.lookup(kept), { code: 'LEDGER_UNREADABLE' });
  await assert.rejects(store.listReplayable(), { code: 'LEDGER_UNREADABLE' });
  assert.deepEqual(await gate.loginDecision(kept), { allow: false, reason: 'ledger_unreadable' });
  assert.deepEqual(await gate.restoreGate({ restored: true }), { openLogin: false, reason: 'ledger_unreadable' });
  // Putting the row back makes the same reads answer again: the refusal tracked the ledger rather than
  // the subject, and it was a check with a real signal, not a blanket failure.
  await ledgerAdmin.query(`INSERT INTO ledger.entries(subject_id,intent_id,status,prepared_at,accepted_at,cancelled_at,seq)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [newestRow.subject_id, newestRow.intent_id, newestRow.status,
    newestRow.prepared_at, newestRow.accepted_at, newestRow.cancelled_at, 2]);
  assert.deepEqual((await store.listReplayable()).map(entry => entry.subjectId), [kept, newest]);
  assert.deepEqual(await gate.restoreGate({ restored: true }), { openLogin: false, reason: 'replay_required',
    replay: { accepted: [], prepared: [kept, newest] } });
  // TRUNCATE -- or a partial restore of the entries table -- leaves every remaining sequence behind the
  // watermark, and a watermark that went backwards is just as unprovable: both fail closed.
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  await assert.rejects(store.lookup(kept), { code: 'LEDGER_UNREADABLE' });
  await assert.rejects(store.listReplayable(), { code: 'LEDGER_UNREADABLE' });
  // A subsequent legitimate transition must not move the watermark down the corruption path and
  // make the ledger appear healthy again.
  await assert.rejects(store.prepare({ subjectId: uuid(), intentId: uuid() }), { code: 'LEDGER_UNREADABLE' });
  assert.equal(await watermark(), '2');
  assert.equal((await ledger.query('SELECT count(*)::int AS n FROM ledger.entries')).rows[0].n, 0);
  await ledgerAdmin.query(`INSERT INTO ledger.entries(subject_id,intent_id,status,prepared_at,seq)
    VALUES($1,$2,'prepared',$3,7)`, [kept, uuid(), new Date(now)]);
  assert.equal(await ledgerSeq(kept), '7');
  await assert.rejects(store.lookup(kept), { code: 'LEDGER_UNREADABLE' });
  // Fail closed does not depend on the subject: one with no marker at all is refused the same way.
  assert.deepEqual(await gate.loginDecision(await addSubject()), { allow: false, reason: 'ledger_unreadable' });
});

test('v1 原型账本不兼容也不自动升级：读写都 fail closed，且不改写 v1 已有的数据', async () => {
  const subjectId = await addSubject();
  // Stand in for an already-initialized v1 ledger: the format marker that prototype wrote, with no
  // watermark. It must read as unreadable, never as "nothing to replay".
  await ledgerAdmin.query("UPDATE ledger.metadata SET format='siyue-deletion-ledger-v1'");
  await assert.rejects(store.lookup(subjectId), { code: 'LEDGER_UNREADABLE' });
  await assert.rejects(store.listReplayable(), { code: 'LEDGER_UNREADABLE' });
  await assert.rejects(store.prepare({ subjectId, intentId: uuid() }), { code: 'LEDGER_UNREADABLE' });
  assert.deepEqual(await gate.loginDecision(subjectId), { allow: false, reason: 'ledger_unreadable' });
  assert.deepEqual(await gate.restoreGate({ restored: true }), { openLogin: false, reason: 'ledger_unreadable' });
  // Nothing rewrote the marker, invented a row or moved the watermark: the v1 ledger is untouched.
  assert.equal((await ledger.query('SELECT format FROM ledger.metadata')).rows[0].format, 'siyue-deletion-ledger-v1');
  assert.equal((await ledger.query('SELECT count(*)::int AS n FROM ledger.entries')).rows[0].n, 0);
  assert.equal(await watermark(), '0');
});

test('已初始化的账本不会被 provisioning 覆盖：二次运行失败，且一行数据都不丢', async () => {
  const subjectId = await addSubject();
  await store.prepare({ subjectId, intentId: uuid() });
  const before = await ledgerRow(subjectId);
  // The script creates the role pair and the database; both already exist, so ON_ERROR_STOP ends the
  // second run with a non-zero status before anything is replaced or dropped.
  const { status, stderr } = await runProvisioning(LEDGER_DATABASE);
  assert.notEqual(status, 0);
  assert.match(stderr, /already exists/);
  assert.deepEqual(await ledgerRow(subjectId), before);
  assert.equal(await watermark(), '1');
  assert.equal((await ledger.query('SELECT format FROM ledger.metadata')).rows[0].format, DELETION_LEDGER_FORMAT);
  assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1',
    [LEDGER_DATABASE])).rows[0].n, 1);
  // The store still answers after the refused re-run: the failed provisioning changed nothing.
  assert.deepEqual((await store.listReplayable()).map(entry => entry.subjectId), [subjectId]);
});

const INSTANCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('账本身份：highWater 就是 fence 绑定的那个点，新初始化的空账本不是同一个实例', async () => {
  const empty = await store.highWater();
  assert.deepEqual(Object.keys(empty).sort(), ['format', 'instanceId', 'sequence']);
  assert.equal(empty.format, DELETION_LEDGER_FORMAT);
  assert.equal(empty.sequence, 0n);
  assert.match(empty.instanceId, INSTANCE_UUID);
  // The fence parses this value with a strict schema and compares it as it stands, so the ledger side has
  // to hand over exactly the triple -- no environment, no extra field.
  assert.equal(ledgerFencePointSchema.safeParse(empty).success, true);
  assert.equal(compareLedgerFence(null, empty), 'replay_required');
  assert.equal(compareLedgerFence(empty, empty), 'ready');
  const subjectId = await addSubject(), intent = uuid();
  await store.prepare({ subjectId, intentId: intent });
  now += 1_000;
  await store.markAccepted({ subjectId, intentId: intent });
  // The identity is minted once per ledger database and does not move with the entries: it is what a
  // fence binds to. The sequence is the part that advances.
  const afterWrites = await store.highWater();
  assert.deepEqual({ ...afterWrites, sequence: 0n }, empty);
  assert.equal(afterWrites.sequence, 2n);
  assert.equal(compareLedgerFence(afterWrites, afterWrites), 'ready');
  assert.equal(compareLedgerFence(afterWrites, { ...afterWrites, sequence: 5n }), 'replay_required');
  assert.equal(compareLedgerFence({ ...afterWrites, sequence: 5n }, afterWrites), 'ledger_regressed');
  // A newly initialized ledger with the same format and environment and no entries is a DIFFERENT
  // instance. Without the identity, an empty ledger would read as "nothing to replay, same ledger".
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  await ledgerAdmin.query('DELETE FROM ledger.metadata');
  await ledgerAdmin.query('INSERT INTO ledger.metadata(singleton,format,environment) VALUES(true,$1,$2)',
    [DELETION_LEDGER_FORMAT, 'test']);
  const reinitialized = await store.highWater();
  assert.equal(reinitialized.sequence, 0n);
  assert.equal(reinitialized.format, empty.format);
  assert.notEqual(reinitialized.instanceId, empty.instanceId);
  // This is exactly what the fence has to catch: same format, same environment, empty, and yet not the
  // ledger instance it was bound to.
  assert.equal(compareLedgerFence(empty, reinitialized), 'ledger_replaced');
  // An identity is only reported for a ledger that proves it is complete and is this environment: an
  // entry newer than the watermark is the truncation case, and another environment is another ledger.
  await ledgerAdmin.query(`INSERT INTO ledger.entries(subject_id,intent_id,status,prepared_at,seq)
    VALUES($1,$2,'prepared',$3,5)`, [uuid(), uuid(), new Date(now)]);
  await assert.rejects(store.highWater(), { code: 'LEDGER_UNREADABLE' });
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  await ledgerAdmin.query("UPDATE ledger.metadata SET environment='production'");
  await assert.rejects(store.highWater(), { code: 'LEDGER_UNREADABLE' });
});

test('身份列可加性升级：ADD COLUMN 不改写既有账本数据，只是重新给出一个新身份', async () => {
  const subjectId = await addSubject(), intent = uuid();
  await store.prepare({ subjectId, intentId: intent });
  const before = await ledgerRow(subjectId);
  const beforeIdentity = (await store.highWater()).instanceId;
  // Stand in for a ledger database created before the identity column existed. The adapter must not
  // answer for it, and the documented upgrade is one ADD COLUMN with a DEFAULT: no row is rewritten.
  await ledgerAdmin.query('ALTER TABLE ledger.metadata DROP COLUMN instance_id');
  try {
    await assert.rejects(store.highWater(), { code: 'LEDGER_UNAVAILABLE' });
    await ledgerAdmin.query('ALTER TABLE ledger.metadata ADD COLUMN instance_id uuid NOT NULL DEFAULT gen_random_uuid()');
    const upgraded = await store.highWater();
    assert.match(upgraded.instanceId, INSTANCE_UUID);
    assert.equal(upgraded.sequence, 1n);
    // Nothing about the ledger's data changed: the marker, the watermark and the replay set are as they
    // were, so this is an additive upgrade and not a re-initialization.
    assert.deepEqual(await ledgerRow(subjectId), before);
    assert.equal(await watermark(), '1');
    assert.deepEqual((await store.listReplayable()).map(entry => entry.subjectId), [subjectId]);
    // A ledger that had no identity gets a fresh one, so the fence has to bind it deliberately instead
    // of silently treating it as the same ledger instance it protected before.
    assert.notEqual(upgraded.instanceId, beforeIdentity);
  } finally {
    // Leave the fixture ledger shaped the way the provisioning script builds it, whatever happened.
    const columns = await ledgerAdmin.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='ledger' AND table_name='metadata' AND column_name='instance_id'`);
    if (!columns.rowCount) await ledgerAdmin.query(
      'ALTER TABLE ledger.metadata ADD COLUMN instance_id uuid NOT NULL DEFAULT gen_random_uuid()');
  }
});
