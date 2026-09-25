import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createDeletionLedgerStore, createDeletionLedgerGate, DELETION_LEDGER_FORMAT }
  from '../../dist/account-deletion-ledger/index.js';
// The kernel under test is deliberately not re-exported by index.ts yet, exactly like `fence.ts`.
import { createPreparedReconciler } from '../../dist/account-deletion-ledger/prepared-reconciler.js';

// Prepared-marker reconciler (design 13.4) against an isolated temporary PostgreSQL cluster only. The
// fixture builds a fresh cluster on a short Unix socket and never reads a database URL or the workspace
// .env; two independent temporary databases live in it -- the main database `siyue_test` and the ledger
// `siyue_deletion_ledger` created by provision/deletion-ledger.sql. The kernel opens no route and makes
// no provider call, and every UUID, instant and digest below is synthetic.
//
// The subject/job rows are written directly instead of through the acceptance kernel: what is under test
// is how this kernel reads them, and the acceptance kernel does not create the ledger marker. Cases that
// write re-check a bystander marker, because one subject's contradiction may not commit another's.
const LEDGER_DATABASE = 'siyue_deletion_ledger';
const LEDGER_ROLE = 'siyue_deletion_ledger_app';
let db, ledger, ledgerAdmin, store, gate, reconciler, now;
const clock = () => new Date(now);

const postgresBin = () => process.env.SIYUE_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
/** Runs the checked-in provisioning script as the fixture admin, the way an operator would. */
async function provisionLedger() {
  const bin = postgresBin();
  if (!existsSync(join(bin, 'psql'))) throw Error('PostgreSQL binaries missing; set SIYUE_TEST_POSTGRES_BIN');
  const socket = (await db.admin.query("SELECT current_setting('unix_socket_directories') AS socket")).rows[0].socket;
  execFileSync(join(bin, 'psql'), ['-h', socket, '-U', 'siyue_test_admin', '-d', 'postgres', '-f',
    fileURLToPath(new URL('../../provision/deletion-ledger.sql', import.meta.url))], {
    env: { ...process.env, LC_ALL: 'C', SIYUE_DELETION_LEDGER_DATABASE: LEDGER_DATABASE,
      SIYUE_DELETION_LEDGER_ENVIRONMENT: 'test',
      SIYUE_DELETION_LEDGER_APP_PASSWORD: randomBytes(32).toString('hex') },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
}

before(async () => {
  db = await startPostgresFixture();
  await provisionLedger();
  ledger = db.poolFor(LEDGER_ROLE, LEDGER_DATABASE);
  ledgerAdmin = db.poolFor('siyue_test_admin', LEDGER_DATABASE);
});
beforeEach(async () => {
  now = Date.parse('2026-09-24T00:00:00.000Z');
  await db.admin.query('TRUNCATE siyue.subjects CASCADE');
  // Self-heal whatever a fail-closed case deliberately broke, so one case cannot poison the next.
  await db.admin.query('GRANT SELECT, UPDATE ON siyue.subjects TO siyue_app');
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  await ledgerAdmin.query(`GRANT USAGE ON SCHEMA ledger TO ${LEDGER_ROLE}`);
  await ledgerAdmin.query(`GRANT EXECUTE ON FUNCTION ledger.prepare_intent(uuid,uuid,timestamptz),
    ledger.mark_accepted(uuid,uuid,timestamptz), ledger.cancel_intent(uuid,uuid,timestamptz) TO ${LEDGER_ROLE}`);
  await ledgerAdmin.query(`INSERT INTO ledger.metadata(singleton,format,environment,seq,entry_count) VALUES(true,$1,'test',0,0)
    ON CONFLICT (singleton) DO UPDATE SET format=excluded.format, environment=excluded.environment, seq=0, entry_count=0`,
  [DELETION_LEDGER_FORMAT]);
  store = createDeletionLedgerStore(ledger, { database: LEDGER_DATABASE, environment: 'test' }, clock);
  gate = createDeletionLedgerGate(store);
  reconciler = createPreparedReconciler(db.app, store);
});
after(async () => { await db?.stop(); });

const uuid = () => randomUUID();
const at = () => new Date(now);
const ledgerRow = subjectId => ledger.query(`SELECT subject_id,intent_id,status,prepared_at,accepted_at,
  cancelled_at FROM ledger.entries WHERE subject_id=$1`, [subjectId]).then(result => result.rows[0] ?? null);
const subjectRow = subjectId => db.app.query('SELECT to_jsonb(s) AS row FROM siyue.subjects s WHERE id=$1',
  [subjectId]).then(result => result.rows[0]?.row ?? null);
const jobRow = subjectId => db.app.query(`SELECT id,state,local_data_deleted,completed_at
  FROM siyue.account_deletion_jobs WHERE subject_id=$1`, [subjectId])
  .then(result => result.rows[0] ?? null);
const count = (sql, ...args) => db.app.query(sql, args).then(result => Number(result.rows[0].n));
/** Reasons keyed by subject, because the replay set is ordered by instant and then subject UUID. */
const reasonsBySubject = result => Object.fromEntries(result.unresolved.map(row => [row.subjectId, row.reason]));

const addSubject = async (kind = 'adult', status = 'active') => {
  const subjectId = uuid();
  await db.app.query('INSERT INTO siyue.subjects(id,kind,status) VALUES($1,$2,$3)', [subjectId, kind, status]);
  return subjectId;
};
/** The committed job the acceptance transaction would have written, with `id` standing in for the intent. */
const addJob = async (subjectId, { id = uuid(), state = 'accepted', localDataDeleted = false,
  providerRevocationPending = false, completedAt = null } = {}) => {
  await db.app.query(`INSERT INTO siyue.account_deletion_jobs
    (id,subject_id,state,requested_at,local_data_deleted,provider_revocation_pending,
     receipt_secret_hash,receipt_expires_at,completed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [id, subjectId, state, at(), localDataDeleted, providerRevocationPending,
    randomBytes(32).toString('hex'), new Date(now + 86_400_000), completedAt]);
  return id;
};
/** A prepared marker for one intent. The ledger refuses to prepare twice for one subject. */
const prepare = async subjectId => {
  const intentId = uuid();
  const entry = await store.prepare({ subjectId, intentId });
  return { intentId, preparedAt: entry.preparedAt };
};
/** An `accepted` marker: terminal, and not this kernel's input. */
const accept = async subjectId => {
  const { intentId } = await prepare(subjectId);
  await store.markAccepted({ subjectId, intentId });
  return intentId;
};

test('已提交作业的 prepared 标记推进为 accepted：只写账本，主体与作业不变，第二次运行幂等', async () => {
  const pending = await addSubject('adult', 'deletion_pending');
  const { intentId, preparedAt } = await prepare(pending);
  await addJob(pending, { id: intentId, state: 'accepted' });
  // A marker that already reached `accepted` belongs to the replay kernel: counted, never rewritten.
  const settled = await addSubject('adult', 'deleted');
  const settledIntent = await accept(settled);
  const before = { subject: await subjectRow(pending), job: await jobRow(pending) };

  const result = await reconciler.reconcile();
  assert.deepEqual(result, { ledgerError: null, alreadyAccepted: 1, unresolved: [],
    reconciled: [{ subjectId: pending, intentId, preparedAt, acceptedAt: new Date(now).toISOString(),
      jobState: 'accepted' }] });
  const marker = await ledgerRow(pending);
  assert.equal(marker.status, 'accepted');
  assert.equal(Date.parse(marker.accepted_at), now);
  assert.equal(marker.cancelled_at, null);
  // The main database is read-only for this kernel: the tombstone, the job, and the receipt digest are
  // exactly as the acceptance transaction left them.
  assert.deepEqual(await subjectRow(pending), before.subject);
  assert.deepEqual(await jobRow(pending), before.job);
  assert.equal(before.subject.status, 'deletion_pending');

  // Idempotent: the same run reports no reconciliation, leaves the ledger untouched, and both markers
  // are now in the accepted set the replay kernel reads.
  assert.deepEqual(await reconciler.reconcile(),
    { ledgerError: null, reconciled: [], unresolved: [], alreadyAccepted: 2 });
  assert.deepEqual(await ledgerRow(pending), marker);
  assert.equal((await ledgerRow(settled)).intent_id, settledIntent);
});

test('已清理的作业（主体 deleted、local_data_deleted）同样推进，并报告作业状态', async () => {
  const cleaned = await addSubject('adult', 'deleted');
  const cleanedMarker = await prepare(cleaned);
  await addJob(cleaned, { id: cleanedMarker.intentId, state: 'processing', localDataDeleted: true });
  const completed = await addSubject('adult', 'deleted');
  const completedMarker = await prepare(completed);
  await addJob(completed, { id: completedMarker.intentId, state: 'completed', localDataDeleted: true,
    completedAt: new Date(now + 1_000) });
  // A bystander with no marker at all, whose rows must not move either way.
  const bystander = await addSubject();
  const bystanderBefore = await subjectRow(bystander);

  const result = await reconciler.reconcile();
  assert.equal(result.ledgerError, null);
  assert.equal(result.alreadyAccepted, 0);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(new Map(result.reconciled.map(row => [row.subjectId, row.jobState])),
    new Map([[cleaned, 'processing'], [completed, 'completed']]));
  assert.deepEqual(await ledgerRow(cleaned).then(row => row.status), 'accepted');
  assert.deepEqual(await ledgerRow(completed).then(row => row.status), 'accepted');
  assert.deepEqual(await subjectRow(bystander), bystanderBefore);
  assert.equal(await jobRow(bystander), null);
});

test('作业缺失 fail closed：不自动 cancel，标记保持 prepared 并继续阻断登录', async () => {
  const who = await addSubject('adult', 'deletion_pending');
  const { intentId, preparedAt } = await prepare(who);
  const expected = { ledgerError: null, reconciled: [], alreadyAccepted: 0,
    unresolved: [{ subjectId: who, intentId, preparedAt, reason: 'job_absent_no_rollback_proof' }] };

  assert.deepEqual(await reconciler.reconcile(), expected);
  // Nothing was cancelled: a restorable main database cannot prove a rollback, so the marker keeps
  // blocking the subject instead of being turned into "clear".
  const marker = await ledgerRow(who);
  assert.deepEqual(marker, { subject_id: who, intent_id: intentId, status: 'prepared',
    prepared_at: at(), accepted_at: null, cancelled_at: null });
  assert.deepEqual(await gate.restoreGate({ restored: true }),
    { openLogin: false, reason: 'replay_required', replay: { accepted: [], prepared: [who] } });
  assert.deepEqual(await gate.loginDecision(who),
    { allow: false, reason: 'deletion_prepared_unresolved' });
  // Repeating adds no marker and no job: the kernel does not create work items of its own.
  assert.deepEqual(await reconciler.reconcile(), expected);
  assert.deepEqual(await ledgerRow(who), marker);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs'), 0);
});

test('作业 id 与账本 intent 不一致时 fail closed：不为当前 intent 借用别的作业', async () => {
  // (a) this subject has a committed job, but under a different id than the prepared intent.
  const stale = await addSubject('adult', 'deletion_pending');
  const staleMarker = await prepare(stale);
  await addJob(stale, { state: 'accepted' });
  // (b) a job carries this subject's intent id but belongs to another subject.
  const crossed = await addSubject('adult', 'deletion_pending');
  const crossedMarker = await prepare(crossed);
  const other = await addSubject('adult', 'deletion_pending');
  await addJob(other, { id: crossedMarker.intentId, state: 'accepted' });

  const result = await reconciler.reconcile();
  assert.deepEqual(result.reconciled, []);
  assert.equal(result.ledgerError, null);
  assert.deepEqual(reasonsBySubject(result),
    { [stale]: 'job_intent_mismatch', [crossed]: 'job_subject_mismatch' });
  // Every marker stays prepared, and the crossed job row is left exactly as it was for a human.
  for (const [subjectId, marker] of [[stale, staleMarker], [crossed, crossedMarker]]) {
    const row = await ledgerRow(subjectId);
    assert.equal(row.status, 'prepared');
    assert.equal(row.intent_id, marker.intentId);
    assert.equal(row.accepted_at, null);
  }
  assert.equal((await jobRow(other)).id, crossedMarker.intentId);
});

test('缺数据与非成人 fail closed：主体不存在或不是成人时不给作业背书', async () => {
  const missing = uuid();
  const missingMarker = await prepare(missing);
  const child = await addSubject('child', 'deletion_pending');
  const childMarker = await prepare(child);
  await addJob(child, { id: childMarker.intentId, state: 'accepted' });

  const result = await reconciler.reconcile();
  assert.deepEqual(result.reconciled, []);
  assert.equal(result.alreadyAccepted, 0);
  assert.deepEqual(reasonsBySubject(result),
    { [missing]: 'subject_missing', [child]: 'subject_not_adult' });
  // The child's job row is not rewritten and its marker is not certified: the acceptance kernel only
  // ever accepts an adult, so this pairing cannot be explained by this service.
  assert.equal((await subjectRow(child)).status, 'deletion_pending');
  assert.equal((await ledgerRow(child)).status, 'prepared');
  assert.equal(await subjectRow(missing), null);
  assert.equal((await ledgerRow(missing)).intent_id, missingMarker.intentId);
});

test('主体状态与作业自身矛盾 fail closed：不推进任何标记', async () => {
  // (a) a committed job while the subject is still `active`: the acceptance transaction never commits that.
  const active = await addSubject();
  const activeMarker = await prepare(active);
  await addJob(active, { id: activeMarker.intentId, state: 'accepted' });
  // (b) the cleanup flag without the terminal state it is always written with.
  const halfCleaned = await addSubject('adult', 'deletion_pending');
  const halfMarker = await prepare(halfCleaned);
  await addJob(halfCleaned, { id: halfMarker.intentId, state: 'processing', localDataDeleted: true });
  // (c) a job state outside the vocabulary the schema declares. The table's CHECK is dropped for this
  // one insert to simulate schema drift, and restored immediately afterwards.
  const drifted = await addSubject('adult', 'deletion_pending');
  const driftMarker = await prepare(drifted);
  const constraint = (await db.admin.query(`SELECT conname FROM pg_constraint
    WHERE conrelid='siyue.account_deletion_jobs'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%state = ANY%'`)).rows[0].conname;
  await db.admin.query(`ALTER TABLE siyue.account_deletion_jobs DROP CONSTRAINT ${constraint}`);
  let result;
  try {
    await addJob(drifted, { id: driftMarker.intentId, state: 'paused' });
    result = await reconciler.reconcile();
  } finally {
    // The injected row has to become legal again before the CHECK can be re-applied.
    await db.admin.query(`UPDATE siyue.account_deletion_jobs SET state='accepted' WHERE id=$1`,
      [driftMarker.intentId]);
    await db.admin.query(`ALTER TABLE siyue.account_deletion_jobs ADD CONSTRAINT ${constraint}
      CHECK (state IN ('accepted','processing','needs_attention','completed'))`);
  }

  assert.deepEqual(result.reconciled, []);
  assert.equal(result.alreadyAccepted, 0);
  assert.deepEqual(reasonsBySubject(result), { [active]: 'subject_status_contradicts_job',
    [halfCleaned]: 'job_inconsistent', [drifted]: 'job_state_invalid' });
  for (const subjectId of [active, halfCleaned, drifted]) {
    const row = await ledgerRow(subjectId);
    assert.equal(row.status, 'prepared');
    assert.equal(row.accepted_at, null);
  }
});

test('主库读取失败按主体 unresolved：不写账本，恢复权限后同一标记可推进', async () => {
  const who = await addSubject('adult', 'deletion_pending');
  const { intentId, preparedAt } = await prepare(who);
  await addJob(who, { id: intentId, state: 'accepted' });
  await db.admin.query('REVOKE SELECT ON siyue.subjects FROM siyue_app');
  try {
    assert.deepEqual(await reconciler.reconcile(), { ledgerError: null, reconciled: [], alreadyAccepted: 0,
      unresolved: [{ subjectId: who, intentId, preparedAt, reason: 'main_read_failed' }] });
    assert.equal((await ledgerRow(who)).status, 'prepared');
  } finally { await db.admin.query('GRANT SELECT ON siyue.subjects TO siyue_app'); }
  // Nothing about the failed read was cached: the same marker is certified once the read can succeed.
  assert.deepEqual((await reconciler.reconcile()).reconciled.map(row => row.subjectId), [who]);
  assert.equal((await ledgerRow(who)).status, 'accepted');
});

test('账本写入失败 fail closed：标记保持 prepared、上报 ledgerError，并继续判断其余主体', async () => {
  const first = await addSubject('adult', 'deletion_pending');
  const firstMarker = await prepare(first);
  await addJob(first, { id: firstMarker.intentId, state: 'accepted' });
  const second = await addSubject('adult', 'deletion_pending');
  const secondMarker = await prepare(second);
  await addJob(second, { id: secondMarker.intentId, state: 'accepted' });
  await ledgerAdmin.query(`REVOKE EXECUTE ON FUNCTION ledger.mark_accepted(uuid,uuid,timestamptz) FROM ${LEDGER_ROLE}`);
  try {
    const result = await reconciler.reconcile();
    assert.equal(result.ledgerError, 'ledger_unavailable');
    assert.deepEqual(result.reconciled, []);
    assert.equal(result.alreadyAccepted, 0);
    assert.deepEqual(new Set(result.unresolved.flatMap(row => [row.subjectId, row.reason])),
      new Set([first, second, 'ledger_write_failed']));
    assert.equal((await ledgerRow(first)).status, 'prepared');
    assert.equal((await ledgerRow(second)).status, 'prepared');
  } finally {
    await ledgerAdmin.query(`GRANT EXECUTE ON FUNCTION ledger.mark_accepted(uuid,uuid,timestamptz) TO ${LEDGER_ROLE}`);
  }
  // The ledger is repaired, not the decision: a re-run certifies both markers.
  assert.deepEqual(new Set((await reconciler.reconcile()).reconciled.map(row => row.subjectId)),
    new Set([first, second]));
});

test('账本不可读或不可用时 fail closed：不判断任何标记，也不写主库', async () => {
  const who = await addSubject('adult', 'deletion_pending');
  const marker = await prepare(who);
  await addJob(who, { id: marker.intentId, state: 'accepted' });
  const empty = { reconciled: [], unresolved: [], alreadyAccepted: 0 };
  // Format marker missing: an emptied or foreign ledger must never read as "nothing to reconcile".
  await ledgerAdmin.query('DELETE FROM ledger.metadata');
  assert.deepEqual(await reconciler.reconcile(), { ...empty, ledgerError: 'ledger_unreadable' });
  // Right format, wrong environment: still not this ledger.
  await ledgerAdmin.query(`INSERT INTO ledger.metadata(singleton,format,environment) VALUES(true,$1,'production')`,
    [DELETION_LEDGER_FORMAT]);
  assert.deepEqual(await reconciler.reconcile(), { ...empty, ledgerError: 'ledger_unreadable' });
  // Unreachable ledger database: the same fail-closed answer, and the same untouched main database.
  const missing = createPreparedReconciler(db.app, createDeletionLedgerStore(
    db.poolFor(LEDGER_ROLE, `${LEDGER_DATABASE}_missing`),
    { database: `${LEDGER_DATABASE}_missing`, environment: 'test' }, clock));
  assert.deepEqual(await missing.reconcile(), { ...empty, ledgerError: 'ledger_unavailable' });
  // Reachable but unreadable: the runtime role lost the schema privilege, so the ledger cannot answer.
  await ledgerAdmin.query(`REVOKE USAGE ON SCHEMA ledger FROM ${LEDGER_ROLE}`);
  try { assert.deepEqual(await reconciler.reconcile(), { ...empty, ledgerError: 'ledger_unavailable' }); }
  finally { await ledgerAdmin.query(`GRANT USAGE ON SCHEMA ledger TO ${LEDGER_ROLE}`); }
  assert.equal((await ledgerRow(who)).status, 'prepared');
  assert.deepEqual(await subjectRow(who).then(row => row.status), 'deletion_pending');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs'), 1);
});
