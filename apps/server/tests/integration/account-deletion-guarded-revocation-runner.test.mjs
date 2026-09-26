import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { RecoveryCipher } from '../../dist/adapters/crypto/auth-crypto.js';
import { createAppleRevocationPostgresStore } from '../../dist/identities/apple/revocation-postgres.js';
import { createDeletionLedgerStore, DELETION_LEDGER_FORMAT }
  from '../../dist/account-deletion-ledger/index.js';
import { AccountDeletionRevocationGuardConfigError, AccountDeletionRevocationGuardRefusal,
  createAccountDeletionGuardedRevocationRunner, createAccountDeletionGuardedRevocationStore }
  from '../../dist/modules/auth/account-deletion-guarded-revocation-runner.js';

// Ledger-authorized Apple revocation (design 13.3/13.4) against an isolated temporary PostgreSQL cluster
// only. The fixture builds a fresh cluster on a short Unix socket and never reads a database URL or the
// workspace .env, and it holds two independent temporary databases: siyue_test (the restorable main
// database, with the revocation queue and the deletion job) and siyue_deletion_ledger (its own role pair,
// provision/deletion-ledger.sql). Every UUID, instant and credential seal below is synthetic, the provider
// half is always an injected counting stand-in, and no Apple endpoint, route, worker timer or mail
// transport is reached.
//
// The cases are one per property the guard claims. Only an accepted marker whose intent is the committed
// job id may let a claim reach the provider or let a job be coordinated; prepared, cancelled, no marker, a
// marker accepted for another intent, no committed job, a closed provider dimension and an identity that no
// longer resolves are all refused with a bounded reason while the queue row keeps its sealed credential; a
// ledger that cannot answer rejects the sweep as an infrastructure fault instead of a quiet queue; a refusal
// is never an empty queue and never a success; a durable authorization retry window bounds when a refused row can be retried; and a job
// with no ledger marker keeps its whole row -- provider flag, last_error_code and the rest -- byte-identical
// while an authorized job in the same pass is still decided.
const day = 86_400_000;
const LEDGER_DATABASE = 'siyue_deletion_ledger';
const namespace = 'app.siyue.mobile';
const refresh = 'synthetic-apple-refresh-token';
const start = Date.parse('2026-09-24T00:00:00Z');
const cipher = new RecoveryCipher('test', new Map([['test', randomBytes(32)]]));
let db, ledgerPool, ledgerAdmin, ledger, time;
const clock = () => new Date(time);
const advance = milliseconds => { time += milliseconds; };

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
  time = start;
  await db.admin.query('TRUNCATE siyue.subjects CASCADE');
  // An intact, empty ledger again: the entries and the watermark move back together, and the usage grant is
  // re-issued so a case that deliberately broke the ledger cannot poison the next one.
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  await ledgerAdmin.query('GRANT USAGE ON SCHEMA ledger TO siyue_deletion_ledger_app');
  await ledgerAdmin.query("UPDATE ledger.metadata SET format=$1,environment='test',seq=0,entry_count=0",
    [DELETION_LEDGER_FORMAT]);
  ledger = createDeletionLedgerStore(ledgerPool, { database: LEDGER_DATABASE, environment: 'test' }, clock);
});
after(async () => { await db?.stop(); });

const rows = (sql, ...args) => db.app.query(sql, args).then(result => result.rows);
const one = async (sql, ...args) => (await rows(sql, ...args))[0];
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
/** The credential the identity store seals: the revocation AAD is the identity id plus the provider
 * namespace, so a seal is only openable by the job that names exactly those two. */
const sealOf = (identityId, token = refresh) =>
  cipher.seal({ refreshToken: token }, 'apple-identity:' + identityId + ':' + namespace);
const addSubject = status => db.app
  .query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'adult',$2) RETURNING id",
    [randomUUID(), status ?? 'deletion_pending']).then(result => result.rows[0].id);
const addIdentity = async ({ subjectId, status = 'active', credential = true } = {}) => {
  const owner = subjectId ?? await addSubject(), identityId = randomUUID();
  await db.app.query(`INSERT INTO siyue.external_identities(id,subject_id,provider,provider_namespace,
      provider_subject,client_id,issuer,status)
    VALUES($1,$2,'apple',$3,$4,$5,'https://appleid.apple.com',$6)`,
  [identityId, owner, namespace, `synthetic-apple-subject-${identityId.slice(0, 8)}`, namespace, status]);
  if (credential) await db.app.query('INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext) VALUES($1,$2)',
    [identityId, sealOf(identityId)]);
  return { subjectId: owner, identityId };
};
/** The deletion job as the acceptance kernel commits it: `pending` is the provider dimension this guard
 * requires to still be open. `errorCode` is what a previous, authorized pass may already have written. */
const addDeletionJob = async (subjectId, { deletionId = randomUUID(), pending = true, errorCode = null } = {}) => {
  const receiptSecret = randomBytes(32).toString('base64url');
  await db.app.query(`INSERT INTO siyue.account_deletion_jobs(id,subject_id,state,requested_at,local_data_deleted,
      provider_revocation_pending,receipt_secret_hash,receipt_expires_at,last_error_code)
    VALUES($1,$2,'accepted',$3,false,$4,$5,$6,$7)`,
  [deletionId, subjectId, new Date(start), pending,
    createHash('sha256').update(receiptSecret).digest('hex'), new Date(start + 30 * day), errorCode]);
  return deletionId;
};
const jobRow = deletionId => one('SELECT * FROM siyue.account_deletion_jobs WHERE id=$1', deletionId);
const queueRow = identityId => one('SELECT * FROM siyue.apple_revocation_outbox WHERE identity_id=$1', identityId);
/** The whole provider dimension of one job, plus the three columns no path here may touch. */
const dimension = deletionId => jobRow(deletionId)
  .then(row => [row.provider_revocation_pending, row.last_error_code, row.local_data_deleted, row.completed_at, row.state]);
/** The queue row as the guard has to leave it: status, attempt count, whether a lease is held, and whether the
 * sealed credential is still there. `payloadKept` false means the seal was destroyed, which only a
 * settlement may do. */
const queueShape = async identityId => {
  const row = await queueRow(identityId);
  return { status: row.status, attempts: row.attempts, leased: row.lease_id !== null,
    payloadKept: row.refresh_ciphertext !== null };
};
/** The ledger's watermark as text: a read-only guard pass never moves it. */
const watermark = () => ledgerPool.query('SELECT seq::text AS seq FROM ledger.metadata')
  .then(result => result.rows[0]?.seq ?? null);
const refused = promise => promise.then(() => null, error => error);

/**
 * One Apple identity with a live sealed credential, one committed deletion job waiting on Apple, and the
 * independent ledger marker `marker` says it holds: accepted (the authorized shape, intent = the committed
 * job id), prepared, cancelled, mismatch (accepted, but for another intent) or none (no marker at all, which
 * is what a restored older backup looks like).
 */
async function scene(marker = 'accepted') {
  const subjectId = await addSubject();
  const { identityId } = await addIdentity({ subjectId });
  const deletionId = randomUUID(), intentId = marker === 'mismatch' ? randomUUID() : deletionId;
  if (marker !== 'none') await ledger.prepare({ subjectId, intentId });
  await addDeletionJob(subjectId, { deletionId });
  if (marker === 'accepted' || marker === 'mismatch') await ledger.markAccepted({ subjectId, intentId });
  if (marker === 'cancelled') await ledger.cancel({ subjectId, intentId });
  return { subjectId, identityId, deletionId };
}

/** The composition under test: the real postgres store behind the ledger gate, the guarded coordination
 * pass, and the real bounded sweep runner over both, with the provider always an injected stand-in. */
const guardedFor = ({ ledger: source = ledger, revoke } = {}) =>
  createAccountDeletionGuardedRevocationRunner(db.app, {
    ledger: source, store: createAppleRevocationPostgresStore(db.app, { clock }), cipher, clock,
    revoke: revoke ?? (async () => ({ outcome: 'revoked' })),
  });
const enqueue = (runner, subjectId) =>
  transaction(db.app, client => runner.enqueueForSubject(client, { subjectId }));
/** A confirmed revocation produced by the real store, standing for the terminal row a restored backup
 * carries: the coordinator would read this identity as confirmed. The bare store claims the oldest due row,
 * so this helper is only reachable while this identity's row is the only claimable one -- and it refuses to
 * settle a row belonging to anybody else. */
async function settledRevocation(identityId) {
  const store = createAppleRevocationPostgresStore(db.app, { clock });
  await transaction(db.app, client => store.enqueue(client, { availableAt: clock(),
    expiresAt: new Date(time + 7 * day),
    job: { identityId, providerNamespace: namespace, refreshCiphertext: sealOf(identityId) } }));
  const claim = await store.claim(clock(), new Date(time + 60_000));
  assert.equal(claim?.job.identityId, identityId, 'the settled row must be this identity\'s');
  await store.settle(claim, { state: 'revoked' }, clock());
}

test('账本 accepted 且意图等于主库作业 id 时撤销一次：凭据交给 provider，成功后销毁载荷并清除维度', async () => {
  const calls = [];
  const runner = guardedFor({ revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
  const target = await scene('accepted');
  assert.deepEqual(await enqueue(runner, target.subjectId), { identities: 1 });
  const before = await watermark();

  const report = await runner.sweep();

  assert.deepEqual(report, { outcome: 'ran', attempts: 1, refused: 0, revoked: 1, retry: 0, needsAttention: 0,
    expired: 0, checked: 1, cleared: 1, jobs: [{ deletionId: target.deletionId, subjectId: target.subjectId,
      cleared: true, errorCode: null, identities: 1, confirmed: 1 }] });
  // Exactly the credential the identity store sealed was handed to the provider, once.
  assert.deepEqual(calls, [{ refreshToken: refresh }]);
  assert.deepEqual(await queueShape(target.identityId),
    { status: 'revoked', attempts: 1, leased: false, payloadKept: false });
  assert.deepEqual(await dimension(target.deletionId), [false, null, false, null, 'accepted']);
  // The guard read the ledger and wrote nothing: the accepted marker and its watermark are exactly as
  // acceptance left them.
  const marker = await ledger.lookup(target.subjectId);
  assert.equal(marker.status, 'accepted');
  assert.equal(marker.intentId, target.deletionId);
  assert.equal(await watermark(), before);
});

test('有界协调游标越过未授权队首，下一轮处理后续已授权作业', async () => {
  const held = await scene('none');
  const allowed = await scene('accepted');
  await db.app.query('UPDATE siyue.account_deletion_jobs SET requested_at=$2 WHERE id=$1',
    [held.deletionId, new Date(start)]);
  await db.app.query('UPDATE siyue.account_deletion_jobs SET requested_at=$2 WHERE id=$1',
    [allowed.deletionId, new Date(start + 1000)]);
  const runner = guardedFor();
  const first = await runner.sweep({ limit: 1 });
  assert.equal(first.checked, 0);
  assert.equal((await jobRow(held.deletionId)).last_error_code, null);
  const second = await runner.sweep({ limit: 1 });
  assert.deepEqual(second.jobs.map(job => job.deletionId), [allowed.deletionId]);
  assert.equal((await jobRow(allowed.deletionId)).last_error_code, 'apple_credential_missing');
  assert.equal((await jobRow(held.deletionId)).last_error_code, null);
});

const refusalShapes = [
  ['prepared（受理可能未记录）', 'prepared', 'ledger_entry_prepared'],
  ['cancelled（注销已撤回）', 'cancelled', 'ledger_entry_cancelled'],
  ['accepted 但意图不是该主体的已提交作业', 'mismatch', 'ledger_intent_mismatch'],
  ['没有该主体标记（恢复出的旧备份）', 'none', 'ledger_entry_missing'],
];
for (const [label, marker, reason] of refusalShapes) {
  test(`账本 ${label} 时拒绝：provider 0 次，凭据不销毁，作业与账本都不变`, async () => {
    const calls = [];
    const runner = guardedFor({ revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
    const target = await scene(marker);
    await enqueue(runner, target.subjectId);
    const before = await watermark();
    const jobBefore = await jobRow(target.deletionId), markerBefore = await ledger.lookup(target.subjectId);

    const report = await runner.sweep();
    assert.deepEqual([report.attempts, report.refused, report.checked], [0, 1, 0], reason);
    // The provider was never reached and the credential is still sealed in the queue: a refusal delays the
    // attempt, it destroys no payload and it settles no row.
    assert.deepEqual(calls, []);
    assert.deepEqual(await queueShape(target.identityId),
      { status: 'pending', attempts: 1, leased: false, payloadKept: true });
    assert.deepEqual(await jobRow(target.deletionId), jobBefore);
    assert.deepEqual(await dimension(target.deletionId), [true, null, false, null, 'accepted']);
    // Neither database was written by the guard: the marker is unchanged and the watermark did not move.
    assert.deepEqual(await ledger.lookup(target.subjectId), markerBefore);
    assert.equal(await watermark(), before);
  });
}

test('主库没有已提交的删除作业时拒绝：恢复出的队列行不会触发撤销', async () => {
  const calls = [];
  const runner = guardedFor({ revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
  const subjectId = await addSubject();
  const { identityId } = await addIdentity({ subjectId });
  // An accepted marker for an intent that has no committed main job: a sweep never selects this subject, so
  // only a restored queue row (or a direct insert) can produce this pair.
  const intentId = randomUUID();
  await ledger.prepare({ subjectId, intentId });
  await ledger.markAccepted({ subjectId, intentId });
  await enqueue(runner, subjectId);

  const report = await runner.sweep();
  assert.equal(report.refused, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(await queueShape(identityId),
    { status: 'pending', attempts: 1, leased: false, payloadKept: true });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs'), 0);
});

test('主库作业的 provider 维度已关闭时拒绝：没有开放维度可供这次尝试归属', async () => {
  const calls = [];
  const runner = guardedFor({ revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
  const subjectId = await addSubject();
  const { identityId } = await addIdentity({ subjectId });
  const deletionId = await addDeletionJob(subjectId, { pending: false });
  // The ledger marker is accepted AND matches this job: the closed dimension is the only failing fact.
  await ledger.prepare({ subjectId, intentId: deletionId });
  await ledger.markAccepted({ subjectId, intentId: deletionId });
  await enqueue(runner, subjectId);

  const report = await runner.sweep();
  assert.equal(report.refused, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(await queueShape(identityId),
    { status: 'pending', attempts: 1, leased: false, payloadKept: true });
  assert.deepEqual(await dimension(deletionId), [false, null, false, null, 'accepted']);
});

test('被领取的 identity 在主库查不到时拒绝：结构漂移下仍然 fail closed', async () => {
  // Migration 0016's foreign key keeps a queued row from outliving its identity, so this shape is reachable
  // only through the port (drift, another store, a future schema): the guard is driven with the claim shape
  // the postgres store returns for an identity id that does not resolve.
  const identifier = randomUUID();
  const claim = { jobId: randomUUID(), attempt: 1, leaseId: randomUUID(), expiresAt: new Date(time + day),
    job: { identityId: identifier, providerNamespace: namespace, refreshCiphertext: 'synthetic-seal' } };
  const guarded = createAccountDeletionGuardedRevocationStore(db.app, { ledger,
    store: { claim: async () => claim, enqueue: async () => { throw Error('unused'); },
      settle: async () => { throw Error('unused'); },deferAuthorization:async()=>{} } });

  const failure = await refused(guarded.claim(clock(), new Date(time + 60_000)));

  assert.equal(failure?.reason, 'identity_missing');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox'), 0);
});

test('账本数据库不可达时扫描整体拒绝：既不撤销也不报告空队列', async () => {
  const calls = [];
  // The ledger database this pool points at does not exist, which is the same unreachable-database answer a
  // real ledger outage gives (LEDGER_UNAVAILABLE) -- no stub and no injected error.
  const unreachable = LEDGER_DATABASE + '_missing';
  const missing = createDeletionLedgerStore(db.poolFor('siyue_deletion_ledger_app', unreachable),
    { database: unreachable, environment: 'test' }, clock);
  const runner = guardedFor({ ledger: missing,
    revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
  const target = await scene('accepted');
  await enqueue(runner, target.subjectId);

  const failure = await refused(runner.sweep());

  assert.equal(failure?.code, 'LEDGER_UNAVAILABLE');
  // An infrastructure fault is never laundered into a bounded job refusal, and never into a pass.
  assert.equal(failure instanceof AccountDeletionRevocationGuardRefusal, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(await queueShape(target.identityId),
    { status: 'sending', attempts: 1, leased: true, payloadKept: true });
  assert.deepEqual(await dimension(target.deletionId), [true, null, false, null, 'accepted']);
});

test('账本水位被破坏（不可读）时扫描拒绝且不撤销', async () => {
  const calls = [];
  const runner = guardedFor({ revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
  const target = await scene('accepted');
  await enqueue(runner, target.subjectId);
  // Break the ledger's completeness proof the way a partial restore does: the watermark moves past the
  // entries, so the store refuses to answer instead of reading this subject as clear.
  await ledgerAdmin.query('UPDATE ledger.metadata SET seq = seq + 1');

  const failure = await refused(runner.sweep());

  assert.equal(failure?.code, 'LEDGER_UNREADABLE');
  assert.deepEqual(calls, []);
  assert.deepEqual(await queueShape(target.identityId),
    { status: 'sending', attempts: 1, leased: true, payloadKept: true });
  assert.deepEqual(await dimension(target.deletionId), [true, null, false, null, 'accepted']);
});

test('拒绝不是空队列也不是成功：扫描单独计数且不调用供应商', async () => {
  const calls = [];
  const runner = guardedFor({ revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
  const target = await scene('none');
  await enqueue(runner, target.subjectId);

  const report = await runner.sweep();
  assert.deepEqual([report.attempts, report.refused, report.checked], [0, 1, 0]);
  assert.deepEqual(calls, []);
  assert.deepEqual(await queueShape(target.identityId),
    { status: 'pending', attempts: 1, leased: false, payloadKept: true });
});

test('拒绝后授权重试窗口到期才重新领取，届时已受理意图可完成撤销', async () => {
  const calls = [];
  const runner = guardedFor({ revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
  const target = await scene('prepared');
  await enqueue(runner, target.subjectId);

  const first = await runner.sweep();
  assert.equal(first.refused, 1);
  assert.deepEqual(await queueShape(target.identityId),
    { status: 'pending', attempts: 1, leased: false, payloadKept: true });
  // The guarded coordination pass skips this unauthorized job, keeping the code the acceptance
  // kernel left (none).
  assert.deepEqual(await dimension(target.deletionId), [true, null, false, null, 'accepted']);
  assert.deepEqual(calls, []);

  // Inside the retry window the row is not claimable, so a second sweep takes no attempt; the
  // coordination pass skips it too. No job field changes.
  const withinLease = await runner.sweep();
  assert.deepEqual([withinLease.outcome, withinLease.attempts, withinLease.revoked, withinLease.checked,
    withinLease.cleared, withinLease.jobs.length], ['ran', 0, 0, 0, 0, 0]);
  assert.equal((await queueRow(target.identityId)).attempts, 1);
  assert.deepEqual(await dimension(target.deletionId), [true, null, false, null, 'accepted']);
  assert.deepEqual(calls, []);

  // The marker is completed the way the acceptance path does, and once the authorization retry window ends the very same row
  // is claimed again, authorized and revoked. A refusal delays an attempt; it destroys no credential and it
  // loses no job.
  await ledger.markAccepted({ subjectId: target.subjectId, intentId: target.deletionId });
  advance(5*60_000);
  const authorized = await runner.sweep();
  assert.deepEqual([authorized.attempts, authorized.revoked, authorized.checked, authorized.cleared],
    [1, 1, 1, 1]);
  assert.deepEqual(calls, [{ refreshToken: refresh }]);
  assert.deepEqual(await queueShape(target.identityId),
    { status: 'revoked', attempts: 2, leased: false, payloadKept: false });
  assert.deepEqual(await dimension(target.deletionId), [false, null, false, null, 'accepted']);
});

test('未授权队首被延后，同一次扫描继续撤销后面的已授权作业', async () => {
  const calls = [];
  const runner = guardedFor({ revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
  const held = await scene('prepared'), authorized = await scene('accepted');
  // The claim order is the queue's own (available_at,id), so the refused row is made the oldest candidate:
  // it is the row a sweep takes first.
  await enqueue(runner, held.subjectId);
  advance(1_000);
  await enqueue(runner, authorized.subjectId);

  const report = await runner.sweep();
  assert.deepEqual([report.attempts, report.refused, report.revoked, report.checked, report.cleared],
    [1, 1, 1, 1, 1]);
  assert.deepEqual(report.jobs.map(job => job.deletionId), [authorized.deletionId]);
  assert.deepEqual(calls, [{ refreshToken: refresh }]);
  assert.deepEqual(await dimension(authorized.deletionId), [false, null, false, null, 'accepted']);
  assert.deepEqual(await dimension(held.deletionId), [true, null, false, null, 'accepted']);
});

test('批量协调只决定账本授权的作业：无标记作业整行不变，同批的授权作业仍被决定', async () => {
  const calls = [];
  const runner = guardedFor({ revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
  // B: a restored job with NO ledger marker whose only Apple identity already carries a confirmed revocation.
  // The restored main database on its own would read that as "provider dimension satisfied" and clear the
  // flag -- which is exactly the write the ledger exists to forbid. It is built before the authorized row is
  // queued, so the terminal row below is the only claimable one at the time it is settled.
  const restoredSubject = await addSubject();
  const { identityId: restoredIdentity } = await addIdentity({ subjectId: restoredSubject });
  await settledRevocation(restoredIdentity);
  const restoredJob = await addDeletionJob(restoredSubject);
  // C: a restored job with no ledger marker whose identity carries no queue row at all, which the unguarded
  // coordinator would answer with a bounded error code (`apple_credential_missing`).
  const quietSubject = await addSubject();
  await addIdentity({ subjectId: quietSubject, credential: false });
  const quietJob = await addDeletionJob(quietSubject);
  // A: authorized and still queued, so this sweep revokes it and closes its dimension.
  const authorized = await scene('accepted');
  await enqueue(runner, authorized.subjectId);
  const restoredBefore = await jobRow(restoredJob), quietBefore = await jobRow(quietJob);

  const report = await runner.sweep();

  // Only the authorized job was decided: neither restored job is coordinated, and neither appears as a
  // decided job, because this pass reports what it may act on.
  assert.deepEqual([report.attempts, report.revoked, report.checked, report.cleared], [1, 1, 1, 1]);
  assert.deepEqual(report.jobs.map(job => job.deletionId), [authorized.deletionId]);
  assert.deepEqual(calls, [{ refreshToken: refresh }]);
  // The restored rows are byte-identical: provider flag, last_error_code and every other column.
  assert.deepEqual(await jobRow(restoredJob), restoredBefore);
  assert.equal((await jobRow(restoredJob)).provider_revocation_pending, true);
  assert.equal((await jobRow(restoredJob)).last_error_code, null);
  assert.deepEqual(await jobRow(quietJob), quietBefore);
  assert.equal((await jobRow(quietJob)).provider_revocation_pending, true);
  assert.equal((await jobRow(quietJob)).last_error_code, null);
  // A second sweep with nothing left to attempt decides nothing for them either: silence is never turned into
  // a confirmation, and a restored job is never repaired from the restored backup.
  const again = await runner.sweep();
  assert.deepEqual([again.attempts, again.checked, again.cleared, again.jobs.length], [0, 0, 0, 0]);
  assert.deepEqual(await jobRow(restoredJob), restoredBefore);
  assert.deepEqual(await jobRow(quietJob), quietBefore);
});

test('批量协调对授权作业仍然有效：没有队列行的作业得到有界错误码而不是成功', async () => {
  const runner = guardedFor();
  // Authorized by the ledger, but no credential was ever queued for this identity -- the case the pass exists
  // for. The dimension must stay open with a bounded code, and must never read as a confirmed revocation.
  const subjectId = await addSubject();
  await addIdentity({ subjectId, credential: false });
  const deletionId = await addDeletionJob(subjectId);
  await ledger.prepare({ subjectId, intentId: deletionId });
  await ledger.markAccepted({ subjectId, intentId: deletionId });

  const report = await runner.sweep();

  assert.deepEqual(report, { outcome: 'ran', attempts: 0, refused: 0, revoked: 0, retry: 0, needsAttention: 0,
    expired: 0, checked: 1, cleared: 0, jobs: [{ deletionId, subjectId, cleared: false,
      errorCode: 'apple_credential_missing', identities: 1, confirmed: 0 }] });
  assert.deepEqual(await dimension(deletionId), [true, 'apple_credential_missing', false, null, 'accepted']);
});

test('直接调用 reconcile 也只决定账本授权的主体：未授权主体的行没有任何写入', async () => {
  const runner = guardedFor();
  const unauthorized = await scene('none'), authorized = await scene('accepted');
  const before = await jobRow(unauthorized.deletionId);

  const skipped = await runner.reconcile({ subjectId: unauthorized.subjectId });

  assert.deepEqual(skipped, { checked: 0, cleared: 0, jobs: [] });
  assert.deepEqual(await jobRow(unauthorized.deletionId), before);
  assert.deepEqual(await dimension(unauthorized.deletionId), [true, null, false, null, 'accepted']);
  // The authorized subject still gets its bounded code from the same entry point. Its credential was never
  // queued in this case, so the code the coordinator writes is the missing-credential one rather than the
  // queued one -- a bounded blocker, never a success.
  const decided = await runner.reconcile({ subjectId: authorized.subjectId });
  assert.deepEqual([decided.checked, decided.cleared], [1, 0]);
  assert.equal(decided.jobs[0].errorCode, 'apple_credential_missing');
  assert.deepEqual(await dimension(authorized.deletionId),
    [true, 'apple_credential_missing', false, null, 'accepted']);
});

test('拒绝注入自备 worker：守卫不可能与未受守卫的 claim 或 reconcile 并存', () => {
  const worker = { enqueueForSubject: async () => ({ identities: 0 }),
    reconcile: async () => ({ checked: 0, cleared: 0, jobs: [] }),
    tick: async () => ({ attempt: undefined, subjectId: undefined, report: undefined }) };
  assert.throws(() => createAccountDeletionGuardedRevocationRunner(db.app, { ledger, worker,
    store: createAppleRevocationPostgresStore(db.app, { clock }), cipher, clock,
    revoke: async () => ({ outcome: 'revoked' }) }),
  error => error instanceof AccountDeletionRevocationGuardConfigError
    && error.code === 'guarded_revocation_worker_not_injectable');
});
