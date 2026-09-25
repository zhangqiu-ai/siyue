import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createFamilyRepository } from '../../dist/modules/families/repository.js';
import { createAccountDeletionJobStore } from '../../dist/modules/auth/account-deletion-jobs.js';
import { AccountDeletionCleanupError, createAccountDeletionCleanupKernel }
  from '../../dist/modules/auth/account-deletion-cleanup.js';
import { createAccountDeletionCleanupRunner }
  from '../../dist/modules/auth/account-deletion-cleanup-runner.js';

// Bounded cleanup sweep over the deletion-job table (design chapter 13), against an isolated temporary
// PostgreSQL cluster only. The fixture builds a fresh cluster on a short Unix socket and never reads a
// database URL or the workspace .env; every UUID, address, instant and secret below is synthetic, and
// the runner makes no provider call and opens no route.
//
// The cases below are one per property the runner claims: a bound on how much work one sweep takes, a
// bound on how often a job it cannot finish is retried, a refusal that is never reported as a success,
// an unexpected error that is not swallowed, one in-flight sweep per instance, and two instances that
// may attempt the same job without deleting twice.
const day = 86_400_000;
const zero = { emails: 0, passwordCredentials: 0, challenges: 0, sessions: 0, refreshTokens: 0,
  reauthGrants: 0, appleLoginFlows: 0, roomSeats: 0, accountConsents: 0, idempotencyRecords: 0,
  familyCreateRequests: 0, familyMemberships: 0, mailJobs: 0, appleCredentials: 0,
  appleRevocationJobs: 0, appleIdentities: 0,
  // The layered historical pass reports its own counts beside the credential and temporary material.
  history: { invitationsDeleted: 0, invitationsRedacted: 0, invitationsClosed: 0, pairingRequests: 0,
    deviceGrants: 0, guardianships: 0, consents: 0, rooms: 0, roomInvitationsDeleted: 0,
    roomInvitationsRedacted: 0, reviews: 0, reviewAcceptances: 0, acceptances: 0, families: 0 } };

let db, fx, jobs, kernel, runner;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query('TRUNCATE siyue.subjects, siyue.rate_limit_buckets, siyue.idempotency_records, siyue.outbox_jobs CASCADE');
  fx = await createEmailFixture(db);
  jobs = createAccountDeletionJobStore(db.app, fx.clock);
  kernel = createAccountDeletionCleanupKernel(db.app, fx.clock);
  runner = createAccountDeletionCleanupRunner(db.app, { kernel, clock: fx.clock });
});
after(async () => { await db?.stop(); });

const query = (sql, ...args) => db.app.query(sql, args);
const rows = (sql, ...args) => query(sql, ...args).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
const keyHash = () => createHash('sha256').update(randomUUID()).digest('hex');
const jobRow = deletionId => rows(
  'SELECT state,local_data_deleted,provider_revocation_pending,completed_at,last_error_code FROM siyue.account_deletion_jobs WHERE id=$1',
  deletionId).then(result => result[0]);

/** One accepted adult deletion: pending subject, live personal rows and its own job. */
async function accepted({ providerRevocationPending = false } = {}) {
  const { tokens, address } = await fx.register();
  const subjectId = tokens.session.subjectId;
  await query('UPDATE siyue.subjects SET display_name=$2 WHERE id=$1', subjectId, '练习账号');
  await query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1", subjectId);
  const receipt = await transaction(db.app, client => jobs.insertPending(client,
    { subjectId, receiptExpiresAt: new Date(+fx.clock() + day), providerRevocationPending }));
  return { subjectId, address, receipt };
}

/** The live family membership the cleanup kernel refuses to decide, so the job must stop instead. */
async function memberOfLiveFamily(subjectId) {
  const owner = await fx.issue();
  const family = await transaction(db.app, client =>
    createFamilyRepository(db.app).create(client, owner.session.subjectId, keyHash()));
  await query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    family.familyId, subjectId);
  return family;
}

/** An Apple link plus one durable revocation attempt, the state an Apple-linked deletion leaves behind. */
async function appleIdentity(subjectId, { outbox = 'pending', windowDays = 7 } = {}) {
  const identityId = randomUUID();
  await query(`INSERT INTO siyue.external_identities
    (id,subject_id,provider,provider_namespace,provider_subject,client_id,issuer)
    VALUES($1,$2,'apple','synthetic-team',$3,'app.siyue.synthetic','https://appleid.apple.com')`,
  identityId, subjectId, randomUUID());
  await query('INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext) VALUES($1,$2)',
    identityId, 'sealed-' + identityId);
  const now = +fx.clock();
  const expiresAt = new Date(now + windowDays * day);
  const createdAt = new Date(+expiresAt - 7 * day);
  await query(`INSERT INTO siyue.apple_revocation_outbox
    (id,identity_id,provider_namespace,refresh_ciphertext,status,attempts,available_at,expires_at,created_at)
    VALUES($1,$2,'synthetic-team',$3,$4,0,$5,$6,$5)`,
  randomUUID(), identityId, 'sealed-' + identityId, outbox, createdAt, expiresAt);
  return identityId;
}

/** The runner the case asserts on, with the kernel calls it made recorded in order. */
function counted() {
  const calls = [];
  return { calls, runner: createAccountDeletionCleanupRunner(db.app, { clock: fx.clock, kernel: {
    cleanupSubject: input => { calls.push(input.subjectId); return kernel.cleanupSubject(input); } } }) };
}

test('一次扫描只取有限批量并逐项清理，已完成的作业不再被取', async () => {
  const first = await accepted();
  fx.advance(1_000);
  const second = await accepted();
  fx.advance(1_000);
  const third = await accepted();
  const watched = counted();

  const batch = await watched.runner.sweep({ limit: 2 });

  assert.deepEqual(watched.calls, [first.subjectId, second.subjectId]);
  assert.equal(batch.outcome, 'ran');
  assert.equal(batch.taken, 2);
  assert.equal(batch.completed, 2);
  assert.equal(batch.cleaned, 0);
  assert.equal(batch.needsAttention, 0);
  assert.equal(batch.failed, 0);
  assert.equal(batch.deferred, 0);
  assert.deepEqual(batch.jobs.map(job => job.status), ['completed', 'completed']);
  assert.deepEqual(batch.jobs.map(job => job.subjectId), [first.subjectId, second.subjectId]);
  assert.deepEqual(batch.jobs.map(job => job.deletionId),
    [first.receipt.deletionId, second.receipt.deletionId]);
  assert.deepEqual(batch.jobs.map(job => job.errorCode), [null, null]);
  assert.deepEqual(batch.jobs.map(job => job.blockers), [[], []]);
  assert.deepEqual(batch.jobs.map(job => job.removed.emails), [1, 1]);
  assert.deepEqual(batch.jobs.map(job => job.removed.sessions), [1, 1]);
  assert.deepEqual(batch.jobs.map(job => ({
    serverDataDeleted: job.serverDataDeleted, providerRevocationPending: job.providerRevocationPending,
  })), [{ serverDataDeleted: true, providerRevocationPending: false },
    { serverDataDeleted: true, providerRevocationPending: false }]);

  // The batch is a real bound, not a report-only one: the third account is untouched.
  assert.deepEqual((await rows('SELECT status,display_name,deleted_at FROM siyue.subjects WHERE id=$1',
    third.subjectId))[0], { status: 'deletion_pending', display_name: '练习账号', deleted_at: null });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    third.subjectId), 1);
  assert.deepEqual(await jobRow(third.receipt.deletionId), { state: 'accepted', local_data_deleted: false,
    provider_revocation_pending: false, completed_at: null, last_error_code: null });

  const rest = await watched.runner.sweep({ limit: 2 });
  assert.equal(rest.taken, 1);
  assert.equal(rest.completed, 1);
  assert.deepEqual(rest.jobs.map(job => job.subjectId), [third.subjectId]);
  for (const who of [first, second, third]) {
    assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
      who.subjectId), 0);
    assert.equal((await rows('SELECT status FROM siyue.subjects WHERE id=$1', who.subjectId))[0].status, 'deleted');
  }

  // A finished sweep is empty and, more than that, writes nothing: every finished row is unchanged.
  const finished = [first, second, third].map(who => jobRow(who.receipt.deletionId));
  const before = await Promise.all(finished);
  const idle = await watched.runner.sweep();
  assert.deepEqual(idle, { outcome: 'ran', taken: 0, completed: 0, cleaned: 0, needsAttention: 0,
    failed: 0, deferred: 0, jobs: [] });
  assert.deepEqual(await Promise.all(finished), before);
  assert.equal(watched.calls.length, 3);
});

test('依赖未解除的作业报告为 needs_attention，同一实例在延迟窗口内不重试，解除后完成', async () => {
  const who = await accepted();
  const family = await memberOfLiveFamily(who.subjectId);
  const watched = counted();

  const first = await watched.runner.sweep();

  assert.deepEqual(watched.calls, [who.subjectId]);
  assert.equal(first.taken, 1);
  assert.equal(first.needsAttention, 1);
  assert.equal(first.completed, 0);
  assert.equal(first.cleaned, 0);
  assert.equal(first.failed, 0);
  assert.deepEqual(first.jobs, [{
    deletionId: who.receipt.deletionId, subjectId: who.subjectId, status: 'needs_attention',
    errorCode: null, serverDataDeleted: false, providerRevocationPending: false,
    blockers: ['family_membership'], removed: zero,
  }]);
  assert.deepEqual(await jobRow(who.receipt.deletionId), { state: 'needs_attention',
    local_data_deleted: false, provider_revocation_pending: false, completed_at: null,
    last_error_code: 'family_membership' });

  // The next sweep of the same instance leaves it alone: the kernel is not called at all, so a
  // scheduler that ticks every second cannot hammer a job that cannot be finished yet.
  const heldBack = await watched.runner.sweep();
  assert.deepEqual(heldBack, { outcome: 'ran', taken: 0, completed: 0, cleaned: 0, needsAttention: 0,
    failed: 0, deferred: 1, jobs: [] });
  assert.deepEqual(watched.calls, [who.subjectId]);
  assert.deepEqual(await jobRow(who.receipt.deletionId), { state: 'needs_attention',
    local_data_deleted: false, provider_revocation_pending: false, completed_at: null,
    last_error_code: 'family_membership' });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    who.subjectId), 1);

  // The dependency clears and the delay passes: the same instance takes it again and finishes it.
  await query('DELETE FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    family.familyId, who.subjectId);
  fx.advance(15 * 60_000);
  const resolved = await watched.runner.sweep();
  assert.deepEqual(watched.calls, [who.subjectId, who.subjectId]);
  assert.equal(resolved.taken, 1);
  assert.equal(resolved.completed, 1);
  assert.equal(resolved.deferred, 0);
  assert.equal(resolved.jobs[0].removed.emails, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs WHERE id=$1 AND state=$2',
    who.receipt.deletionId, 'completed'), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.families WHERE id=$1', family.familyId), 1);
});

test('一个暂时无法完成的作业不会挤掉新受理的作业', async () => {
  const blocked = await accepted();
  await memberOfLiveFamily(blocked.subjectId);
  // No hold-back at all, so the blocked job is a candidate on every sweep: what keeps it from starving
  // the queue is the order the batch is taken in.
  const ordered = createAccountDeletionCleanupRunner(db.app,
    { clock: fx.clock, needsAttentionRetryDelayMs: 0 });
  const first = await ordered.sweep({ limit: 1 });
  assert.deepEqual(first.jobs.map(job => job.subjectId), [blocked.subjectId]);
  assert.equal(first.needsAttention, 1);

  fx.advance(1_000);
  const fresh = await accepted();
  const second = await ordered.sweep({ limit: 1 });
  assert.deepEqual(second.jobs.map(job => job.subjectId), [fresh.subjectId]);
  assert.equal(second.completed, 1);
  assert.equal(second.deferred, 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    blocked.subjectId), 1);

  // The blocked job is still reachable rather than lost: it is taken once the queue ahead of it is gone.
  const third = await ordered.sweep();
  assert.deepEqual(third.jobs.map(job => job.subjectId), [blocked.subjectId]);
  assert.equal(third.needsAttention, 1);
});

test('内核拒绝是失败而不是成功，同一批其余作业继续处理', async () => {
  const broken = await accepted();
  // An accepted job whose subject is active again -- a restored or hand-repaired row must not be read
  // as a completed deletion, and it must not stop the job behind it either.
  await query("UPDATE siyue.subjects SET status='active' WHERE id=$1", broken.subjectId);
  fx.advance(1_000);
  const healthy = await accepted();

  const report = await runner.sweep();

  assert.equal(report.taken, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.completed, 1);
  assert.equal(report.needsAttention, 0);
  assert.equal(report.deferred, 0);
  assert.deepEqual(report.jobs[0], {
    deletionId: broken.receipt.deletionId, subjectId: broken.subjectId, status: 'failed',
    errorCode: 'cleanup_target_not_pending', serverDataDeleted: false,
    providerRevocationPending: false, blockers: [], removed: null,
  });
  assert.equal(report.jobs[1].subjectId, healthy.subjectId);
  assert.equal(report.jobs[1].status, 'completed');
  // The refused job was left exactly as it was, and the healthy one was really cleaned.
  assert.deepEqual(await jobRow(broken.receipt.deletionId), { state: 'accepted', local_data_deleted: false,
    provider_revocation_pending: false, completed_at: null, last_error_code: null });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    broken.subjectId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    healthy.subjectId), 0);
  // A failure is held back like a dependency, so the same instance does not retry it on every tick.
  const again = await runner.sweep();
  assert.equal(again.taken, 0);
  assert.equal(again.failed, 0);
  assert.equal(again.deferred, 1);
});

test('内核的意外错误让扫描失败，而不是被算成清理成功', async () => {
  const who = await accepted();
  let failures = 1;
  const flaky = createAccountDeletionCleanupRunner(db.app, { clock: fx.clock, kernel: {
    cleanupSubject: input => {
      if (failures > 0) { failures -= 1; throw new Error('pool_exhausted'); }
      return kernel.cleanupSubject(input);
    } } });

  await assert.rejects(flaky.sweep(), error => error.message === 'pool_exhausted');

  // Nothing was reported, nothing was cleaned, and the job is still the same accepted job.
  assert.deepEqual(await jobRow(who.receipt.deletionId), { state: 'accepted', local_data_deleted: false,
    provider_revocation_pending: false, completed_at: null, last_error_code: null });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    who.subjectId), 1);
  // A rejected sweep released the in-flight flag, so the next one really runs.
  const recovered = await flaky.sweep();
  assert.equal(recovered.taken, 1);
  assert.equal(recovered.completed, 1);
  assert.equal(recovered.jobs[0].removed.emails, 1);
});

test('同一实例在扫描进行中再次调用只报告 busy，不并发运行', async () => {
  await accepted();
  let entered, release;
  const enteredKernel = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const gated = createAccountDeletionCleanupRunner(db.app, { clock: fx.clock, kernel: {
    cleanupSubject: async input => { calls += 1; entered(); await gate; return kernel.cleanupSubject(input); } } });

  const inFlight = gated.sweep();
  await enteredKernel;
  const overlapping = await gated.sweep();

  assert.deepEqual(overlapping, { outcome: 'busy', taken: 0, completed: 0, cleaned: 0, needsAttention: 0,
    failed: 0, deferred: 0, jobs: [] });
  assert.equal(calls, 1);
  release();
  const finished = await inFlight;
  assert.equal(finished.outcome, 'ran');
  assert.equal(finished.completed, 1);
  assert.equal(calls, 1);
});

test('非法扫描参数与内核同样被拒绝，且不取作业', async () => {
  const who = await accepted();
  for (const bad of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { subjectId: who.subjectId }]) {
    const error = await runner.sweep(bad).then(() => null, failure => failure);
    assert.ok(error instanceof AccountDeletionCleanupError);
    assert.equal(error.code, 'cleanup_invalid_request');
  }
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.account_deletion_jobs WHERE state='completed'"), 0);
  assert.equal(await runner.sweep({}).then(report => report.taken), 1);
});

test('两个实例并发扫描同一批作业不会重复删除', async () => {
  const targets = [await accepted(), await accepted(), await accepted()];
  const other = createAccountDeletionCleanupRunner(db.app, { clock: fx.clock });

  const [left, right] = await Promise.all([runner.sweep({ limit: 5 }), other.sweep({ limit: 5 })]);

  assert.equal(left.failed + right.failed, 0);
  assert.equal(left.needsAttention + right.needsAttention, 0);
  assert.equal(left.outcome, 'ran');
  assert.equal(right.outcome, 'ran');
  const attempts = [...left.jobs, ...right.jobs];
  // Every job was attempted, and the two reports together account for each row once: an instance that
  // lost the race to the kernel's lock reports the job as already completed and removes nothing.
  assert.deepEqual([...new Set(attempts.map(job => job.deletionId))].sort(),
    targets.map(target => target.receipt.deletionId).sort());
  const removals = new Map();
  for (const job of attempts)
    removals.set(job.deletionId, (removals.get(job.deletionId) ?? 0) + job.removed.emails);
  assert.deepEqual([...removals.values()], [1, 1, 1]);
  assert.equal(attempts.reduce((sum, job) => sum + job.removed.emails, 0), 3);
  assert.equal(attempts.reduce((sum, job) => sum + job.removed.sessions, 0), 3);
  for (const target of targets) {
    assert.equal((await jobRow(target.receipt.deletionId)).state, 'completed');
    assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
      target.subjectId), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1',
      target.subjectId), 0);
  }
});

test('外部撤销未决的作业受控轮询，不挤掉新受理的注销', async () => {
  const who = await accepted({ providerRevocationPending: true });
  const identityId = await appleIdentity(who.subjectId);

  const first = await runner.sweep();

  assert.equal(first.taken, 1);
  assert.equal(first.cleaned, 1);
  assert.equal(first.completed, 0);
  const { removed, ...summary } = first.jobs[0];
  assert.deepEqual(summary, {
    deletionId: who.receipt.deletionId, subjectId: who.subjectId, status: 'cleaned', errorCode: null,
    serverDataDeleted: true, providerRevocationPending: true, blockers: [],
  });
  assert.deepEqual({ emails: removed.emails, appleCredentials: removed.appleCredentials,
    appleIdentities: removed.appleIdentities },
  { emails: 1, appleCredentials: 1, appleIdentities: 0 });
  assert.deepEqual(await jobRow(who.receipt.deletionId), { state: 'processing', local_data_deleted: true,
    provider_revocation_pending: true, completed_at: null, last_error_code: null });
  // Inside its window the queue keeps the one seal that can still reach Apple.
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox WHERE identity_id=$1 AND status='pending' AND refresh_ciphertext IS NOT NULL",
    identityId), 1);

  // The provider dimension may take days; polling it on every tick would keep selecting the oldest
  // processing job and starve newly accepted deletions in a bounded batch.
  const fresh = await accepted();
  const second = await runner.sweep();
  assert.equal(second.taken, 1);
  assert.equal(second.deferred, 1);
  assert.equal(second.jobs[0].subjectId, fresh.subjectId);
  assert.equal(second.jobs[0].status, 'completed');
  fx.advance(30_000);
  const polled = await runner.sweep();
  assert.equal(polled.taken, 1);
  assert.equal(polled.jobs[0].subjectId, who.subjectId);
  assert.equal(polled.jobs[0].removed.emails, 0);
  assert.equal(polled.jobs[0].status, 'cleaned');
});
