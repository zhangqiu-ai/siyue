import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { RecoveryCipher } from '../../dist/adapters/crypto/auth-crypto.js';
import { createAppleRevocationPostgresStore } from '../../dist/identities/apple/revocation-postgres.js';
import { createAccountDeletionJobStore } from '../../dist/modules/auth/account-deletion-jobs.js';
import { AccountDeletionRevocationRunError, createAccountDeletionRevocationRunner }
  from '../../dist/modules/auth/account-deletion-revocation-runner.js';

// Bounded runtime sweep over the durable Apple revocation queue (design 13.3), against an isolated
// temporary PostgreSQL cluster only. The fixture always builds a fresh cluster on a short Unix socket
// and never reads a database URL or the workspace .env. Every subject, identity, credential seal,
// deletion receipt and provider answer below is synthetic: the provider half of the queue is always an
// injected local stand-in, so no Apple endpoint, mail transport, route or worker timer is reached, and
// nothing here claims that a real account was revoked at Apple.
//
// The cases are one per property the sweep claims: a bound on how much work one sweep takes and on how
// often it retries, a queue settlement that is never reported as a cleared dimension, a subject the
// queue cannot reach at all, one in-flight sweep per instance, two instances whose lease makes one
// attempt single-owner, and a request that is refused before anything is taken.
const day = 86_400_000;
const namespace = 'app.siyue.mobile';
const refresh = 'synthetic-apple-refresh-token';
const start = Date.parse('2026-09-24T00:00:00Z');
const cipher = new RecoveryCipher('test', new Map([['test', randomBytes(32)]]));
let db;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => { await db.admin.query('TRUNCATE siyue.subjects CASCADE'); });
after(async () => { await db?.stop(); });

const rows = (sql, ...args) => db.app.query(sql, args).then(result => result.rows);
const one = async (sql, ...args) => (await rows(sql, ...args))[0];
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
/** The credential the identity store seals: the revocation AAD is the identity id plus the provider
 * namespace, so a seal is only openable by the job that names exactly those two. */
const sealOf = (identityId, providerNamespace = namespace, token = refresh) =>
  cipher.seal({ refreshToken: token }, 'apple-identity:' + identityId + ':' + providerNamespace);
const addSubject = status => db.app
  .query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'adult',$2) RETURNING id",
    [randomUUID(), status ?? 'deletion_pending']).then(result => result.rows[0].id);
/** One Apple identity of that subject, with or without the credential row the queue copies a seal from. */
const addIdentity = async ({ subjectId, status = 'active', credential = true, sealed } = {}) => {
  const subject = subjectId ?? await addSubject(), identityId = randomUUID();
  await db.app.query(`INSERT INTO siyue.external_identities(id,subject_id,provider,provider_namespace,
      provider_subject,client_id,issuer,status)
    VALUES($1,$2,'apple',$3,$4,$5,'https://appleid.apple.com',$6)`,
  [identityId, subject, namespace, `synthetic-apple-subject-${identityId.slice(0, 8)}`, namespace, status]);
  if (credential) await db.app.query('INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext) VALUES($1,$2)',
    [identityId, sealed ?? sealOf(identityId)]);
  return { subjectId: subject, identityId };
};
/** The deletion job as the acceptance kernel writes it: only the provider dimension is open here. */
const addDeletionJob = async (subjectId, { pending = true, localDataDeleted = false, errorCode = null } = {}) => {
  const deletionId = randomUUID(), receiptSecret = randomBytes(32).toString('base64url');
  await db.app.query(`INSERT INTO siyue.account_deletion_jobs(id,subject_id,state,requested_at,local_data_deleted,
      provider_revocation_pending,receipt_secret_hash,receipt_expires_at,last_error_code)
    VALUES($1,$2,'accepted',$3,$4,$5,$6,$7,$8)`,
  [deletionId, subjectId, new Date(start), localDataDeleted, pending,
    createHash('sha256').update(receiptSecret).digest('hex'), new Date(start + 30 * day), errorCode]);
  return { deletionId, receiptSecret };
};
const deletionRow = subjectId => one('SELECT * FROM siyue.account_deletion_jobs WHERE subject_id=$1', subjectId);
/** The whole provider dimension of one job: flag, bounded code, and the three columns this module must
 * never touch. */
const dimensionOf = async subjectId => {
  const row = await deletionRow(subjectId);
  return [row.provider_revocation_pending, row.last_error_code, row.local_data_deleted, row.completed_at, row.state];
};
const queueRow = identityId => one('SELECT * FROM siyue.apple_revocation_outbox WHERE identity_id=$1', identityId);
const receipt = () => createAccountDeletionJobStore(db.app, () => new Date(start));
/** Synthetic clock shared by the store, the queue and the assertions, so no case depends on wall time. */
function fixture() {
  let time = start;
  return { clock: () => new Date(time), advance: milliseconds => { time += milliseconds; } };
}
/** The composition under test: the real worker over the real store, with the provider always injected. */
const runnerFor = (clock, { pool, revoke, alert, windowMs, limit } = {}) =>
  createAccountDeletionRevocationRunner(pool ?? db.app, {
    store: createAppleRevocationPostgresStore(pool ?? db.app, { clock }), cipher, clock, windowMs, limit, alert,
    revoke: revoke ?? (async () => ({ outcome: 'revoked' })),
  });
const enqueue = (runner, subjectId) =>
  transaction(db.app, client => runner.enqueueForSubject(client, { subjectId }));

test('一次扫描完成一次撤销并清除 provider 维度，重复扫描不再尝试', async () => {
  const { clock } = fixture(), calls = [];
  const runner = runnerFor(clock, { revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
  const subjectId = await addSubject();
  const { identityId } = await addIdentity({ subjectId });
  const { deletionId, receiptSecret } = await addDeletionJob(subjectId);
  assert.deepEqual(await enqueue(runner, subjectId), { identities: 1 });

  const report = await runner.sweep();

  assert.deepEqual(report, { outcome: 'ran', attempts: 1, refused: 0, revoked: 1, retry: 0, needsAttention: 0,
    expired: 0, checked: 1, cleared: 1, jobs: [{ deletionId, subjectId, cleared: true, errorCode: null,
      identities: 1, confirmed: 1 }] });
  // Exactly the credential the identity store sealed was handed to the provider, and the queue then
  // destroyed it with the confirmed revocation.
  assert.deepEqual(calls, [{ refreshToken: refresh }]);
  assert.deepEqual(await queueRow(identityId).then(row => [row.status, row.refresh_ciphertext,
    row.attempts, row.last_error_code, row.lease_id, row.lease_until]), ['revoked', null, 1, null, null, null]);
  // Only the provider dimension moved: the local dimension, the completion stamp and the job state are
  // exactly as the acceptance kernel left them.
  assert.deepEqual(await dimensionOf(subjectId), [false, null, false, null, 'accepted']);
  assert.deepEqual(await receipt().status({ deletionId, receiptSecret }),
    { serverDataDeleted: false, providerRevocationPending: false, completedAt: null, lastErrorCode: null });

  // A terminal queue row is never claimed twice and an already cleared dimension is never re-decided, so
  // a repeated sweep takes nothing and leaves the row it settled exactly as it was.
  const settled = await queueRow(identityId);
  const again = await runner.sweep();
  assert.deepEqual(again, { outcome: 'ran', attempts: 0, refused: 0, revoked: 0, retry: 0, needsAttention: 0, expired: 0,
    checked: 0, cleared: 0, jobs: [] });
  assert.equal(calls.length, 1);
  assert.deepEqual(await queueRow(identityId), settled);
  assert.deepEqual(await dimensionOf(subjectId), [false, null, false, null, 'accepted']);
});

test('一次扫描的尝试数受 limit 约束，未进入本批的撤销不会被尝试', async () => {
  const { clock } = fixture();
  const runner = runnerFor(clock);
  const targets = [];
  for (let index = 0; index < 3; index += 1) {
    const subjectId = await addSubject();
    const { identityId } = await addIdentity({ subjectId });
    const job = await addDeletionJob(subjectId);
    await enqueue(runner, subjectId);
    targets.push({ subjectId, identityId, deletionId: job.deletionId });
  }

  const batch = await runner.sweep({ limit: 2 });

  // The bound is a real one: two queue attempts were made, so two revocations were confirmed and the
  // third was never attempted. `checked` counts the attempted jobs plus the waiting one the bounded
  // coordination pass re-reported, which is why it is one larger than `attempts`.
  assert.equal(batch.attempts, 2);
  assert.equal(batch.revoked, 2);
  assert.equal(batch.checked, 3);
  assert.equal(batch.cleared, 2);
  assert.deepEqual(batch.jobs.map(job => job.cleared), [true, true, false]);
  const untouched = [];
  for (const target of targets) {
    const queued = await queueRow(target.identityId);
    if (queued.status === 'pending' && queued.attempts === 0) untouched.push(target);
  }
  assert.equal(untouched.length, 1, 'exactly one queued revocation stayed outside the bounded batch');
  // Its credential is still sealed and still queued, and its job keeps the open provider dimension with
  // the bounded code the pass wrote: not a success, and not lost.
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox
    WHERE identity_id=$1 AND status='pending' AND refresh_ciphertext IS NOT NULL`, untouched[0].identityId), 1);
  assert.deepEqual(await dimensionOf(untouched[0].subjectId),
    [true, 'apple_revocation_pending', false, null, 'accepted']);

  // The job that was left behind is still reachable rather than lost.
  const rest = await runner.sweep({ limit: 2 });
  assert.deepEqual([rest.attempts, rest.revoked, rest.checked, rest.cleared], [1, 1, 1, 1]);
  assert.deepEqual(rest.jobs.map(job => job.deletionId), [untouched[0].deletionId]);
  for (const target of targets)
    assert.deepEqual(await dimensionOf(target.subjectId), [false, null, false, null, 'accepted']);
});

test('provider 暂时不可用时只登记一次有界重试，同一扫描不重复尝试，退避到期后再完成', async () => {
  const { clock, advance } = fixture(), calls = [];
  let outcome = { outcome: 'unavailable' };
  const runner = runnerFor(clock, { revoke: async input => { calls.push(input); return outcome; } });
  const subjectId = await addSubject();
  const { identityId } = await addIdentity({ subjectId });
  const { deletionId } = await addDeletionJob(subjectId);
  await enqueue(runner, subjectId);

  const first = await runner.sweep();

  // One attempt, one settlement, one job decision: the attempt's own coordination and the pass below
  // report the same job once, with the pass's fresher evidence.
  assert.deepEqual(first, { outcome: 'ran', attempts: 1, refused: 0, revoked: 0, retry: 1, needsAttention: 0, expired: 0,
    checked: 1, cleared: 0, jobs: [{ deletionId, subjectId, cleared: false,
      errorCode: 'apple_revocation_pending', identities: 1, confirmed: 0 }] });
  assert.deepEqual(await queueRow(identityId).then(row => [row.status, row.attempts, row.last_error_code]),
    ['pending', 1, 'apple_provider_unavailable']);
  assert.ok(+((await queueRow(identityId)).available_at) >= +clock() + 1_000,
    'the queue moved its own availability instead of staying due');
  assert.deepEqual(await dimensionOf(subjectId), [true, 'apple_revocation_pending', false, null, 'accepted']);

  // The batch did not loop on the job it just deferred: the queue's own backoff is the only cadence, so
  // a scheduler that ticks this sweep every second cannot hammer an attempt it cannot finish.
  const deferred = await runner.sweep();
  assert.deepEqual(deferred, { outcome: 'ran', attempts: 0, refused: 0, revoked: 0, retry: 0, needsAttention: 0,
    expired: 0, checked: 1, cleared: 0, jobs: [{ deletionId, subjectId, cleared: false,
      errorCode: 'apple_revocation_pending', identities: 1, confirmed: 0 }] });
  assert.equal(calls.length, 1);

  outcome = { outcome: 'revoked' };
  advance(30_000);
  const recovered = await runner.sweep();
  assert.deepEqual(recovered, { outcome: 'ran', attempts: 1, refused: 0, revoked: 1, retry: 0, needsAttention: 0,
    expired: 0, checked: 1, cleared: 1, jobs: [{ deletionId, subjectId, cleared: true, errorCode: null,
      identities: 1, confirmed: 1 }] });
  assert.equal(calls.length, 2);
  assert.deepEqual(await dimensionOf(subjectId), [false, null, false, null, 'accepted']);
});

test('本端被拒是带错误码的终态，队列不会再取同一行', async () => {
  // Our own client authentication was refused. Repeating the identical call cannot help, so the queue
  // stops the job with an alert and keeps its bounded seal for an operator, never a false success.
  const { clock } = fixture(), alerts = [];
  const runner = runnerFor(clock, { alert: code => alerts.push(code),
    revoke: async () => ({ outcome: 'rejected', error: 'invalid_client' }) });
  const subjectId = await addSubject();
  const { identityId } = await addIdentity({ subjectId });
  const { deletionId } = await addDeletionJob(subjectId);
  await enqueue(runner, subjectId);

  const report = await runner.sweep();

  assert.deepEqual(report, { outcome: 'ran', attempts: 1, refused: 0, revoked: 0, retry: 0, needsAttention: 1,
    expired: 0, checked: 1, cleared: 0, jobs: [{ deletionId, subjectId, cleared: false,
      errorCode: 'apple_revocation_needs_attention', identities: 1, confirmed: 0 }] });
  assert.deepEqual(alerts, ['apple_revocation_needs_attention']);
  assert.deepEqual(await queueRow(identityId).then(row => [row.status, row.last_error_code,
    row.refresh_ciphertext === null]), ['needs_attention', 'apple_invalid_client', false]);
  assert.deepEqual(await dimensionOf(subjectId),
    [true, 'apple_revocation_needs_attention', false, null, 'accepted']);
  // The row is terminal, so no later sweep attempts it again -- yet the receipt keeps the same bounded
  // blocker instead of going quiet, because the coordination half still owns that job.
  const again = await runner.sweep();
  assert.deepEqual([again.attempts, again.checked, again.cleared, again.jobs[0].errorCode],
    [0, 1, 0, 'apple_revocation_needs_attention']);
  assert.deepEqual(await queueRow(identityId).then(row => [row.status, row.attempts]), ['needs_attention', 1]);
});

test('窗口到期在调用 provider 前销毁载荷并保留有界错误码', async () => {
  const { clock, advance } = fixture(), calls = [];
  const runner = runnerFor(clock, { windowMs: 60_000,
    revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
  const subjectId = await addSubject();
  const { identityId } = await addIdentity({ subjectId });
  const { deletionId } = await addDeletionJob(subjectId);
  await enqueue(runner, subjectId);
  advance(60_000);

  const report = await runner.sweep();

  // The closed window is settled before the credential is decrypted, so the provider is never reached
  // and the deletion stays open for the manual path design 13.3 describes.
  assert.deepEqual(report, { outcome: 'ran', attempts: 1, refused: 0, revoked: 0, retry: 0, needsAttention: 0,
    expired: 1, checked: 1, cleared: 0, jobs: [{ deletionId, subjectId, cleared: false,
      errorCode: 'apple_revocation_expired', identities: 1, confirmed: 0 }] });
  assert.deepEqual(calls, []);
  assert.deepEqual(await queueRow(identityId).then(row => [row.status, row.refresh_ciphertext]),
    ['expired', null]);
  assert.deepEqual(await dimensionOf(subjectId), [true, 'apple_revocation_expired', false, null, 'accepted']);
});

test('没有可用凭据的 Apple 身份从未入队，扫描给出有界错误码而不是成功', async () => {
  const { clock } = fixture(), calls = [];
  const runner = runnerFor(clock, { revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
  const subjectId = await addSubject();
  const { identityId } = await addIdentity({ subjectId, credential: false });
  const { deletionId, receiptSecret } = await addDeletionJob(subjectId);

  // A linked identity with no provider credential copies no seal, so nothing enters the queue and no
  // attempt can ever happen for this subject.
  assert.deepEqual(await enqueue(runner, subjectId), { identities: 0 });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox'), 0);

  const report = await runner.sweep();

  assert.deepEqual(report, { outcome: 'ran', attempts: 0, refused: 0, revoked: 0, retry: 0, needsAttention: 0,
    expired: 0, checked: 1, cleared: 0, jobs: [{ deletionId, subjectId, cleared: false,
      errorCode: 'apple_credential_missing', identities: 1, confirmed: 0 }] });
  assert.deepEqual(calls, []);
  // The identity row is untouched: absence of a credential is not an unlink, and it is not a success.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE id=$1', identityId), 1);
  assert.deepEqual(await dimensionOf(subjectId), [true, 'apple_credential_missing', false, null, 'accepted']);
  assert.deepEqual(await receipt().status({ deletionId, receiptSecret }),
    { serverDataDeleted: false, providerRevocationPending: true, completedAt: null,
      lastErrorCode: 'apple_credential_missing' });
  // Repetition never turns that silence into a confirmation.
  const again = await runner.sweep();
  assert.deepEqual([again.attempts, again.checked, again.cleared, again.jobs[0].errorCode],
    [0, 1, 0, 'apple_credential_missing']);
  assert.deepEqual(await dimensionOf(subjectId), [true, 'apple_credential_missing', false, null, 'accepted']);
});

test('同一实例在扫描进行中再次调用只报 busy，不会并发尝试', async () => {
  const { clock } = fixture();
  let entered, release;
  const enteredProvider = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const runner = runnerFor(clock,
    { revoke: async () => { entered(); await gate; return { outcome: 'revoked' }; } });
  const subjectId = await addSubject();
  const { identityId } = await addIdentity({ subjectId });
  await addDeletionJob(subjectId);
  await enqueue(runner, subjectId);

  const inFlight = runner.sweep();
  await enteredProvider;
  const overlapping = await runner.sweep();

  assert.deepEqual(overlapping, { outcome: 'busy', attempts: 0, refused: 0, revoked: 0, retry: 0, needsAttention: 0,
    expired: 0, checked: 0, cleared: 0, jobs: [] });
  release();
  const finished = await inFlight;
  assert.deepEqual([finished.outcome, finished.attempts, finished.revoked, finished.cleared],
    ['ran', 1, 1, 1]);
  assert.deepEqual(await queueRow(identityId).then(row => [row.status, row.attempts]), ['revoked', 1]);
});

test('两个实例的租约让一次撤销只有一个所有者，租约到期后继任者接管且迟到的结算被丢弃', async () => {
  const { clock, advance } = fixture(), calls = [];
  let entered, release;
  const enteredProvider = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const slow = runnerFor(clock, { revoke: async () => { calls.push('slow'); entered(); await gate;
    return { outcome: 'revoked' }; } });
  const subjectId = await addSubject();
  const { identityId } = await addIdentity({ subjectId });
  const { deletionId } = await addDeletionJob(subjectId);
  await enqueue(slow, subjectId);
  // The second instance stands for another process: its own pool, its own runner, the same database.
  const other = runnerFor(clock, { pool: db.poolFor('siyue_app'),
    revoke: async () => { calls.push('other'); return { outcome: 'revoked' }; } });

  const slowSweep = slow.sweep();
  await enteredProvider;
  // The attempt is leased to the first instance, so the second one takes no attempt at all and its
  // coordination pass reports the job exactly as waiting.
  const leased = await other.sweep();
  assert.deepEqual(leased, { outcome: 'ran', attempts: 0, refused: 0, revoked: 0, retry: 0, needsAttention: 0,
    expired: 0, checked: 1, cleared: 0, jobs: [{ deletionId, subjectId, cleared: false,
      errorCode: 'apple_revocation_pending', identities: 1, confirmed: 0 }] });
  assert.deepEqual(await queueRow(identityId).then(row => [row.status, row.attempts,
    row.lease_id === null]), ['sending', 1, false]);

  // Once the abandoned lease expires the same row is recoverable: the second instance leases it under a
  // new lease id, revokes it and finishes the dimension.
  advance(60_000);
  const taken = await other.sweep();
  assert.deepEqual([taken.attempts, taken.revoked, taken.checked, taken.cleared], [1, 1, 1, 1]);
  assert.deepEqual(await queueRow(identityId).then(row => [row.status, row.attempts, row.lease_id,
    row.refresh_ciphertext]), ['revoked', 2, null, null]);
  assert.deepEqual(await dimensionOf(subjectId), [false, null, false, null, 'accepted']);

  // The first attempt's settlement then arrives late and is discarded: its lease id is stale, so it
  // changes no row. Its own report still counts the provider answer it received, while the receipt half
  // shows that nothing moved for it -- an attempt is not a finished dimension.
  release();
  const late = await slowSweep;
  assert.deepEqual([late.attempts, late.revoked, late.checked, late.cleared], [1, 1, 0, 0]);
  assert.deepEqual(await queueRow(identityId).then(row => [row.status, row.attempts, row.last_error_code]),
    ['revoked', 2, null]);
  assert.deepEqual(await dimensionOf(subjectId), [false, null, false, null, 'accepted']);
  assert.deepEqual(calls, ['slow', 'other']);
});

test('非法扫描参数在取作业前被拒绝，默认批量受同一上限约束', async () => {
  const { clock } = fixture();
  const runner = runnerFor(clock);
  const subjectId = await addSubject();
  const { identityId } = await addIdentity({ subjectId });
  await addDeletionJob(subjectId);
  await enqueue(runner, subjectId);

  for (const bad of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { subjectId }, { limit: 50, extra: true }]) {
    const error = await runner.sweep(bad).then(() => null, failure => failure);
    assert.ok(error instanceof AccountDeletionRevocationRunError, JSON.stringify(bad));
    assert.equal(error.code, 'revocation_invalid_request');
  }
  // A refused request leased nothing and coordinated nothing.
  assert.deepEqual(await queueRow(identityId).then(row => [row.status, row.attempts]), ['pending', 0]);
  assert.deepEqual(await dimensionOf(subjectId), [true, null, false, null, 'accepted']);
  assert.equal((await runner.sweep()).attempts, 1);
  // The configured default is validated where it is set, so a batch bound cannot be built broken.
  assert.throws(() => runnerFor(clock, { limit: 0 }), error => error.name === 'ZodError');
});
