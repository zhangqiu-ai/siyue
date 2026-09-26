import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createAccountDeletionJobStore } from '../../dist/modules/auth/account-deletion-jobs.js';
import { AccountDeletionCleanupError } from '../../dist/modules/auth/account-deletion-cleanup.js';
import { createDeletionLedgerStore, DELETION_LEDGER_FORMAT }
  from '../../dist/account-deletion-ledger/index.js';
import { AccountDeletionLedgerGuardRefusal, createAccountDeletionGuardedCleanupKernel,
  createAccountDeletionGuardedCleanupRunner }
  from '../../dist/modules/auth/account-deletion-guarded-runner.js';

// Ledger-authorized cleanup sweep (design 13.4) against an isolated temporary PostgreSQL cluster only.
// The fixture builds a fresh cluster on a short Unix socket and never reads a database URL or the
// workspace .env, and it holds two independent temporary databases: siyue_test (the restorable main
// database) and siyue_deletion_ledger (its own role pair, provision/deletion-ledger.sql). Every UUID,
// instant, address and secret below is synthetic, and neither the sweep nor the guard makes a mail,
// provider or network call.
//
// The cases below are one per fail-closed state the guard claims. Only an accepted marker whose intent
// is the committed job id may remove a row: prepared (acceptance might not be recorded), cancelled, no
// marker at all (what a restored older backup shows), a marker accepted for a different intent, an
// unreadable ledger, an unreachable ledger, and a subject with no committed job.
const day = 86_400_000;
const LEDGER_DATABASE = 'siyue_deletion_ledger';
const zero = { emails: 0, passwordCredentials: 0, challenges: 0, sessions: 0, refreshTokens: 0,
  reauthGrants: 0, appleLoginFlows: 0, roomSeats: 0, accountConsents: 0, idempotencyRecords: 0,
  familyCreateRequests: 0, familyMemberships: 0, mailJobs: 0, appleCredentials: 0,
  appleRevocationJobs: 0, appleIdentities: 0,
  // The layered historical pass reports its own counts beside the credential and temporary material.
  history: { invitationsDeleted: 0, invitationsRedacted: 0, invitationsClosed: 0, pairingRequests: 0,
    deviceGrants: 0, guardianships: 0, consents: 0, rooms: 0, roomInvitationsDeleted: 0,
    roomInvitationsRedacted: 0, reviews: 0, reviewAcceptances: 0, acceptances: 0, families: 0 } };

let db, ledgerPool, ledgerAdmin, fx, jobs, ledger, runner;
before(async () => {
  db = await startPostgresFixture();
  const bin = process.env.SIYUE_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
  if (!existsSync(join(bin, 'psql'))) throw Error('PostgreSQL binaries missing; set SIYUE_TEST_POSTGRES_BIN');
  const socket = (await db.admin.query(
    "SELECT current_setting('unix_socket_directories') AS socket")).rows[0].socket;
  execFileSync(join(bin, 'psql'), ['-h', socket, '-U', 'siyue_test_admin', '-d', 'postgres', '-f',
    fileURLToPath(new URL('../../provision/deletion-ledger.sql', import.meta.url))], {
    env: { ...process.env, LC_ALL: 'C', SIYUE_DELETION_LEDGER_DATABASE: LEDGER_DATABASE,
      SIYUE_DELETION_LEDGER_ENVIRONMENT: 'test',
      SIYUE_DELETION_LEDGER_APP_PASSWORD: randomBytes(32).toString('hex') },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  ledgerPool = db.poolFor('siyue_deletion_ledger_app', LEDGER_DATABASE);
  ledgerAdmin = db.poolFor('siyue_test_admin', LEDGER_DATABASE);
});
beforeEach(async () => {
  await db.admin.query('TRUNCATE siyue.subjects CASCADE');
  // An intact, empty ledger again: the entries and the watermark move back together, and the usage
  // grant is re-issued so a case that deliberately broke the ledger cannot poison the next one.
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  await ledgerAdmin.query('GRANT USAGE ON SCHEMA ledger TO siyue_deletion_ledger_app');
  await ledgerAdmin.query("UPDATE ledger.metadata SET format=$1,environment='test',seq=0,entry_count=0",
    [DELETION_LEDGER_FORMAT]);
  fx = await createEmailFixture(db);
  jobs = createAccountDeletionJobStore(db.app, fx.clock);
  ledger = createDeletionLedgerStore(ledgerPool, { database: LEDGER_DATABASE, environment: 'test' }, fx.clock);
  runner = createAccountDeletionGuardedCleanupRunner(db.app, { ledger, clock: fx.clock });
});
after(async () => { await db?.stop(); });

const query = (sql, ...args) => db.app.query(sql, args);
const rows = (sql, ...args) => query(sql, ...args).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
const subjectRow = subjectId => rows('SELECT status,display_name,deleted_at,credential_version,updated_at'
  + ' FROM siyue.subjects WHERE id=$1', subjectId).then(result => result[0]);
const jobRow = deletionId => rows('SELECT state,local_data_deleted,provider_revocation_pending,completed_at,'
  + 'last_error_code FROM siyue.account_deletion_jobs WHERE id=$1', deletionId).then(result => result[0]);

/**
 * One adult deletion request: a registered subject holding live personal rows, moved to
 * deletion_pending, with the committed main job a sweep selects. `marker` says what the independent
 * ledger holds for that subject -- accepted (the authorized shape), prepared, cancelled, mismatch
 * (accepted, but for another intent) or none (no marker at all).
 */
async function deletion(marker = 'accepted') {
  const { tokens } = await fx.register();
  const subjectId = tokens.session.subjectId;
  await query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1", subjectId);
  const jobId = randomUUID();
  const intentId = marker === 'mismatch' ? randomUUID() : jobId;
  if (marker !== 'none') await ledger.prepare({ subjectId, intentId });
  const receipt = await transaction(db.app, client => jobs.insertPending(client, {
    subjectId, deletionId: jobId, receiptExpiresAt: new Date(+fx.clock() + day),
    providerRevocationPending: false }));
  if (marker === 'accepted' || marker === 'mismatch') await ledger.markAccepted({ subjectId, intentId });
  if (marker === 'cancelled') await ledger.cancel({ subjectId, intentId });
  return { subjectId, jobId, receipt };
}

/** Everything a refused cleanup must leave exactly as it was, plus the job row it may not move. */
async function assertUntouched({ subjectId, jobId }) {
  assert.equal((await subjectRow(subjectId)).status, 'deletion_pending');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    subjectId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1',
    subjectId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',
    subjectId), 1);
  assert.deepEqual(await jobRow(jobId), { state: 'accepted', local_data_deleted: false,
    provider_revocation_pending: false, completed_at: null, last_error_code: null });
}

const tally = batch => ({ outcome: batch.outcome, taken: batch.taken, completed: batch.completed,
  cleaned: batch.cleaned, needsAttention: batch.needsAttention, failed: batch.failed,
  deferred: batch.deferred });
const shape = job => ({ deletionId: job.deletionId, subjectId: job.subjectId, status: job.status,
  errorCode: job.errorCode, serverDataDeleted: job.serverDataDeleted,
  providerRevocationPending: job.providerRevocationPending, blockers: job.blockers });

test('账本 accepted 且意图等于已提交作业时，扫描清理服务端资料并完成该作业', async () => {
  const target = await deletion();
  const batch = await runner.sweep();
  assert.deepEqual(tally(batch), { outcome: 'ran', taken: 1, completed: 1, cleaned: 0,
    needsAttention: 0, failed: 0, deferred: 0 });
  const [job] = batch.jobs;
  assert.deepEqual(shape(job), { deletionId: target.jobId, subjectId: target.subjectId,
    status: 'completed', errorCode: null, serverDataDeleted: true, providerRevocationPending: false,
    blockers: [] });
  assert.equal(job.removed.emails, 1);
  assert.equal(job.removed.sessions, 1);
  assert.equal(target.receipt.deletionId, target.jobId);
  // The main database keeps the tombstone and the job; the personal rows are gone.
  assert.equal((await subjectRow(target.subjectId)).status, 'deleted');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    target.subjectId), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1',
    target.subjectId), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',
    target.subjectId), 0);
  const finished = await jobRow(target.jobId);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.local_data_deleted, true);
  assert.ok(finished.completed_at instanceof Date);
  assert.equal(finished.last_error_code, null);
  // The ledger is read and never written: the accepted marker is exactly as acceptance left it.
  assert.equal((await ledger.lookup(target.subjectId)).intentId, target.jobId);
});

test('prepared 标记不清理：受理可能已提交但账本未记录，扫描报告有界失败', async () => {
  const target = await deletion('prepared');
  const batch = await runner.sweep();
  assert.deepEqual(tally(batch), { outcome: 'ran', taken: 1, completed: 0, cleaned: 0,
    needsAttention: 0, failed: 1, deferred: 0 });
  const [job] = batch.jobs;
  assert.deepEqual(shape(job), { deletionId: target.jobId, subjectId: target.subjectId, status: 'failed',
    errorCode: 'ledger_entry_prepared', serverDataDeleted: false, providerRevocationPending: false,
    blockers: [] });
  assert.equal(job.removed, null);
  await assertUntouched(target);
});

test('cancelled 标记不清理：注销已撤回，扫描报告有界失败', async () => {
  const target = await deletion('cancelled');
  assert.equal((await ledger.lookup(target.subjectId)).status, 'cancelled');
  const batch = await runner.sweep();
  assert.deepEqual({ taken: batch.taken, completed: batch.completed, failed: batch.failed },
    { taken: 1, completed: 0, failed: 1 });
  assert.equal(batch.jobs[0].errorCode, 'ledger_entry_cancelled');
  assert.equal(batch.jobs[0].removed, null);
  await assertUntouched(target);
});

test('账本 accepted 但意图不是该主体的已提交作业时不清理', async () => {
  const target = await deletion('mismatch');
  const marker = await ledger.lookup(target.subjectId);
  assert.equal(marker.status, 'accepted');
  assert.notEqual(marker.intentId, target.jobId);
  const batch = await runner.sweep();
  assert.deepEqual({ taken: batch.taken, completed: batch.completed, failed: batch.failed },
    { taken: 1, completed: 0, failed: 1 });
  assert.equal(batch.jobs[0].errorCode, 'ledger_intent_mismatch');
  assert.equal(batch.jobs[0].deletionId, target.jobId);
  assert.equal(batch.jobs[0].removed, null);
  await assertUntouched(target);
});

test('账本读取后主库作业 ID 改变时，清理事务在行锁内拒绝旧授权', async () => {
  const target = await deletion();
  const replacementId = randomUUID();
  const changingLedger = {
    async lookup(subjectId) {
      const marker = await ledger.lookup(subjectId);
      await db.admin.query('UPDATE siyue.account_deletion_jobs SET id=$2 WHERE subject_id=$1',
        [subjectId, replacementId]);
      return marker;
    },
  };
  const guarded = createAccountDeletionGuardedCleanupKernel(db.app,
    { ledger: changingLedger, clock: fx.clock });
  await assert.rejects(guarded.cleanupSubject({ subjectId: target.subjectId }),
    { code: 'cleanup_job_mismatch' });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    target.subjectId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1',
    target.subjectId), 1);
  assert.equal((await subjectRow(target.subjectId)).status, 'deletion_pending');
  assert.equal((await jobRow(replacementId)).local_data_deleted, false);
});

test('账本没有该主体标记（恢复出的旧备份）时不清理', async () => {
  const target = await deletion('none');
  assert.equal(await ledger.lookup(target.subjectId), null);
  const batch = await runner.sweep();
  assert.deepEqual({ taken: batch.taken, completed: batch.completed, failed: batch.failed },
    { taken: 1, completed: 0, failed: 1 });
  assert.equal(batch.jobs[0].errorCode, 'ledger_entry_missing');
  assert.equal(batch.jobs[0].removed, null);
  await assertUntouched(target);
});

test('账本数据库不可达时扫描整体拒绝，批内任何资料都不删除', async () => {
  const first = await deletion();
  const second = await deletion();
  // The ledger database this pool points at does not exist, which is the same unreachable-database
  // answer a real ledger outage gives (LEDGER_UNAVAILABLE) -- no stub and no injected error.
  const unreachable = LEDGER_DATABASE + '_missing';
  const missing = createDeletionLedgerStore(db.poolFor('siyue_deletion_ledger_app', unreachable),
    { database: unreachable, environment: 'test' }, fx.clock);
  const guarded = createAccountDeletionGuardedCleanupRunner(db.app, { ledger: missing, clock: fx.clock });
  await assert.rejects(guarded.sweep(), { code: 'LEDGER_UNAVAILABLE' });
  await assertUntouched(first);
  await assertUntouched(second);
});

test('账本水位与条目不一致（不可读）时扫描拒绝且不清理', async () => {
  const target = await deletion();
  // Break the ledger's completeness proof the way a partial restore does: the watermark moves past
  // the entries, so the store refuses to answer instead of reading this subject as clear.
  await ledgerAdmin.query('UPDATE ledger.metadata SET seq = seq + 1');
  await assert.rejects(runner.sweep(), { code: 'LEDGER_UNREADABLE' });
  await assertUntouched(target);
});

test('重复扫描幂等：已完成作业不再被取，直接重放守卫内核也不产生第二次写入', async () => {
  const target = await deletion();
  assert.equal((await runner.sweep()).completed, 1);
  const finished = await jobRow(target.jobId);
  const cleanedSubject = await subjectRow(target.subjectId);
  const second = await runner.sweep();
  assert.deepEqual({ outcome: second.outcome, taken: second.taken, jobs: second.jobs },
    { outcome: 'ran', taken: 0, jobs: [] });
  assert.deepEqual(await jobRow(target.jobId), finished);
  assert.deepEqual(await subjectRow(target.subjectId), cleanedSubject);
  // The guard authorizes the same subject again -- the accepted marker and the committed job id are
  // both unchanged -- and the kernel's own guards make that second pass remove nothing.
  const guarded = createAccountDeletionGuardedCleanupKernel(db.app, { ledger, clock: fx.clock });
  const replay = await guarded.cleanupSubject({ subjectId: target.subjectId });
  assert.equal(replay.outcome, 'completed');
  assert.equal(replay.serverDataDeleted, true);
  assert.deepEqual(replay.removed, zero);
  assert.deepEqual(await jobRow(target.jobId), finished);
  assert.deepEqual(await subjectRow(target.subjectId), cleanedSubject);
});

test('同一批中只有账本授权的作业被清理，未授权作业失败且不牵连其他作业', async () => {
  const authorized = await deletion();
  const held = await deletion('prepared');
  const batch = await runner.sweep();
  assert.deepEqual({ outcome: batch.outcome, taken: batch.taken, completed: batch.completed,
    failed: batch.failed }, { outcome: 'ran', taken: 2, completed: 1, failed: 1 });
  const byJob = new Map(batch.jobs.map(job => [job.deletionId, job]));
  assert.equal(byJob.get(authorized.jobId).status, 'completed');
  assert.equal(byJob.get(held.jobId).status, 'failed');
  assert.equal(byJob.get(held.jobId).errorCode, 'ledger_entry_prepared');
  assert.equal((await subjectRow(authorized.subjectId)).status, 'deleted');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    authorized.subjectId), 0);
  await assertUntouched(held);
});

test('直接调用守卫内核时，缺作业与无效输入都不写入且保留内核自身的拒绝', async () => {
  const { tokens } = await fx.register();
  const subjectId = tokens.session.subjectId;
  await query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1", subjectId);
  // A ledger that accepted an intent for this subject while no committed job exists: a sweep never
  // selects such a subject, so the guard is driven directly here.
  const intentId = randomUUID();
  await ledger.prepare({ subjectId, intentId });
  await ledger.markAccepted({ subjectId, intentId });
  const guarded = createAccountDeletionGuardedCleanupKernel(db.app, { ledger, clock: fx.clock });
  await assert.rejects(guarded.cleanupSubject({ subjectId }),
    error => error instanceof AccountDeletionLedgerGuardRefusal
      && error.code === 'deletion_job_missing' && error.reason === 'deletion_job_missing');
  assert.equal(await count(
    'SELECT count(*)::int AS n FROM siyue.account_deletion_jobs WHERE subject_id=$1', subjectId), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    subjectId), 1);
  // An input the guard cannot name a subject for stays the kernel's own bounded refusal.
  await assert.rejects(guarded.cleanupSubject({ subjectId: 'not-a-uuid' }),
    error => error instanceof AccountDeletionCleanupError
      && !(error instanceof AccountDeletionLedgerGuardRefusal)
      && error.code === 'cleanup_invalid_request');
});
