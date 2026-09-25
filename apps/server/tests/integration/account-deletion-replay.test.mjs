import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { createDeletionLedgerStore, createDeletionLedgerGate, createDeletionReplayKernel, DELETION_LEDGER_FORMAT }
  from '../../dist/account-deletion-ledger/index.js';

// Main-database restore replay kernel (design 13.4) against an isolated temporary PostgreSQL cluster
// only. The fixture builds a fresh cluster on a short Unix socket and never reads a database URL or the
// workspace .env; two independent temporary databases live in it -- the restorable main database
// `siyue_test` and the ledger `siyue_deletion_ledger` created by provision/deletion-ledger.sql. The
// kernel opens no route and makes no provider call, and every UUID, instant and secret below is
// synthetic. Cases that write re-check a bystander subject, because a replay may never touch an account
// that has no accepted marker.
const LEDGER_DATABASE = 'siyue_deletion_ledger';
const LEDGER_ROLE = 'siyue_deletion_ledger_app';
let db, ledger, ledgerAdmin, store, gate, replay, fx, now;
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
  await db.admin.query('TRUNCATE siyue.subjects, siyue.outbox_jobs, siyue.rate_limit_buckets, siyue.idempotency_records CASCADE');
  // Self-heal whatever a fail-closed case deliberately broke, so one case cannot poison the next.
  await db.admin.query('GRANT UPDATE ON siyue.subjects TO siyue_app');
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  await ledgerAdmin.query(`GRANT USAGE ON SCHEMA ledger TO ${LEDGER_ROLE}`);
  await ledgerAdmin.query(`INSERT INTO ledger.metadata(singleton,format,environment,seq,entry_count) VALUES(true,$1,'test',0,0)
    ON CONFLICT (singleton) DO UPDATE SET format=excluded.format, environment=excluded.environment, seq=0, entry_count=0`,
  [DELETION_LEDGER_FORMAT]);
  fx = await createEmailFixture(db);
  store = createDeletionLedgerStore(ledger, { database: LEDGER_DATABASE, environment: 'test' }, clock);
  gate = createDeletionLedgerGate(store);
  replay = createDeletionReplayKernel(db.app, store);
});
after(async () => { await db?.stop(); });

const uuid = () => randomUUID();
const subjectRow = subjectId => db.app.query('SELECT to_jsonb(s) AS row FROM siyue.subjects s WHERE id=$1',
  [subjectId]).then(result => result.rows[0]?.row ?? null);
const ledgerRow = subjectId => ledger.query(`SELECT subject_id,intent_id,status,prepared_at,accepted_at,
  cancelled_at FROM ledger.entries WHERE subject_id=$1`, [subjectId]).then(result => result.rows[0] ?? null);
const count = (sql, ...args) => db.app.query(sql, args).then(result => Number(result.rows[0].n));
const zero = { subject: 0, sessions: 0, refreshTokens: 0, reauthGrants: 0, challenges: 0, mailJobs: 0 };

/** A real adult with one live session, one live refresh token and one unconsumed reauth grant. */
async function liveAccount() {
  const { tokens } = await fx.register();
  const subjectId = tokens.session.subjectId;
  const session = (await db.app.query('SELECT id,credential_version FROM siyue.auth_sessions WHERE subject_id=$1',
    [subjectId])).rows[0];
  const reauthGrantId = randomUUID();
  await db.app.query(`INSERT INTO siyue.reauth_grants
    (id,subject_id,session_id,action,credential_version,secret_hash,expires_at)
    VALUES($1,$2,$3,'delete-account',$4,$5,$6)`,
  [reauthGrantId, subjectId, session.id, session.credential_version, 'a'.repeat(64), new Date(now + 600_000)]);
  const refreshTokenId = (await db.app.query('SELECT id FROM siyue.refresh_tokens WHERE session_id=$1',
    [session.id])).rows[0].id;
  return { subjectId, sessionId: session.id, refreshTokenId, reauthGrantId };
}

/** The ledger marker a committed acceptance leaves behind: prepared first, then accepted. */
async function acceptedMarker(subjectId) {
  const intentId = uuid();
  await store.prepare({ subjectId, intentId });
  now += 1_000;
  const accepted = await store.markAccepted({ subjectId, intentId });
  return { intentId, acceptedAt: accepted.acceptedAt };
}

/** A pending challenge that still names the subject, plus the queued mail carrying its code. The
 *  register purpose is the one that always enqueues mail for an address with no account yet. */
async function pendingMail(subjectId) {
  const proof = await fx.request('register', `${uuid()}@example.test`);
  await db.app.query('UPDATE siyue.email_challenges SET subject_id=$2 WHERE id=$1', [proof.challengeId, subjectId]);
  const job = (await db.app.query('SELECT id FROM siyue.outbox_jobs WHERE aggregate_id=$1',
    [proof.challengeId])).rows[0];
  return { challengeId: proof.challengeId, mailJobId: job.id };
}

test('旧备份恢复出的已注销账户写回 deleted：撤销会话/刷新令牌/reauth、停发在途邮件，且第二次重放无变化', async () => {
  const who = await liveAccount();
  const mail = await pendingMail(who.subjectId);
  const before = await subjectRow(who.subjectId);
  const bystander = await liveAccount();
  const bystanderBefore = await subjectRow(bystander.subjectId);
  const { intentId, acceptedAt } = await acceptedMarker(who.subjectId);
  // A restored older backup brings the pre-deletion row back, so the account exists and is active
  // while the ledger -- in its own database -- still says the deletion was accepted.
  assert.equal(before.status, 'active');
  assert.deepEqual(await gate.loginDecision(who.subjectId), { allow: false, reason: 'deletion_accepted' });

  const result = await replay.replay();
  assert.deepEqual(result, { openLogin: true, ledgerError: null,
    accepted: [{ subjectId: who.subjectId, intentId, acceptedAt, alreadyDeleted: false,
      changes: { subject: 1, sessions: 1, refreshTokens: 1, reauthGrants: 1, challenges: 1, mailJobs: 1 } }],
    blocked: [], unresolved: [] });
  const subject = await subjectRow(who.subjectId);
  assert.equal(subject.status, 'deleted');
  assert.equal(subject.credential_version, before.credential_version + 1);
  assert.equal(Date.parse(subject.deleted_at), Date.parse(acceptedAt));
  assert.equal(Date.parse(subject.updated_at), Date.parse(acceptedAt));
  // Display name and personal rows are not this kernel's to destroy: only the terminal state is written.
  assert.equal(subject.display_name, before.display_name);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    who.subjectId), 1);
  const session = (await db.app.query('SELECT revoked_at,revoke_reason FROM siyue.auth_sessions WHERE id=$1',
    [who.sessionId])).rows[0];
  assert.equal(Date.parse(session.revoked_at), Date.parse(acceptedAt));
  assert.equal(session.revoke_reason, 'account_deletion');
  const token = (await db.app.query('SELECT revoked_at,retry_ciphertext FROM siyue.refresh_tokens WHERE id=$1',
    [who.refreshTokenId])).rows[0];
  assert.equal(Date.parse(token.revoked_at), Date.parse(acceptedAt));
  assert.equal(token.retry_ciphertext, null);
  assert.equal(Date.parse((await db.app.query('SELECT consumed_at FROM siyue.reauth_grants WHERE id=$1',
    [who.reauthGrantId])).rows[0].consumed_at), Date.parse(acceptedAt));
  assert.equal((await db.app.query('SELECT status FROM siyue.email_challenges WHERE id=$1',
    [mail.challengeId])).rows[0].status, 'superseded');
  const job = (await db.app.query('SELECT status,payload_ciphertext,completed_at FROM siyue.outbox_jobs WHERE id=$1',
    [mail.mailJobId])).rows[0];
  assert.equal(job.status, 'cancelled');
  assert.equal(job.payload_ciphertext, null);
  assert.equal(Date.parse(job.completed_at), Date.parse(acceptedAt));
  // Login stays refused by the marker itself; the replay only has to make the restored row agree with it.
  assert.deepEqual(await gate.loginDecision(who.subjectId), { allow: false, reason: 'deletion_accepted' });
  // A subject without a marker is untouched, in its row and in its credentials.
  assert.deepEqual(await subjectRow(bystander.subjectId), bystanderBefore);
  assert.equal((await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',
    [bystander.sessionId])).rows[0].revoked_at, null);

  // Idempotent: the same marker replays to zero changes, the same instant, and the ledger is unchanged.
  const marker = await ledgerRow(who.subjectId);
  const second = await replay.replay();
  assert.deepEqual(second, { openLogin: true, ledgerError: null,
    accepted: [{ subjectId: who.subjectId, intentId, acceptedAt, alreadyDeleted: true, changes: zero }],
    blocked: [], unresolved: [] });
  assert.deepEqual(await subjectRow(who.subjectId), subject);
  assert.deepEqual(await ledgerRow(who.subjectId), marker);
  assert.equal(marker.status, 'accepted');
});

test('prepared 保持启动门禁关闭：不重放、不删除、不动会话', async () => {
  const who = await liveAccount();
  const before = await subjectRow(who.subjectId);
  const intentId = uuid();
  await store.prepare({ subjectId: who.subjectId, intentId });

  const result = await replay.replay();
  assert.deepEqual(result, { openLogin: false, ledgerError: null, accepted: [],
    blocked: [{ subjectId: who.subjectId, intentId, preparedAt: new Date(now).toISOString() }], unresolved: [] });
  // Nothing about the unresolved intent may be applied to the account or its credentials: a prepared
  // marker is not evidence that a main transaction committed, so nothing is deleted or revoked for it.
  assert.deepEqual(await subjectRow(who.subjectId), before);
  assert.equal((await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',
    [who.sessionId])).rows[0].revoked_at, null);
  assert.equal((await db.app.query('SELECT consumed_at FROM siyue.reauth_grants WHERE id=$1',
    [who.reauthGrantId])).rows[0].consumed_at, null);
  assert.deepEqual(await ledgerRow(who.subjectId), { subject_id: who.subjectId, intent_id: intentId,
    status: 'prepared', prepared_at: new Date(now), accepted_at: null, cancelled_at: null });
  // The startup gate remains closed until the prepared intent is reconciled. The per-login decision
  // also rejects this subject if a later runtime safely opens access for unrelated accounts.
  assert.deepEqual(await gate.restoreGate({ restored: true }), { openLogin: false, reason: 'replay_required',
    replay: { accepted: [], prepared: [who.subjectId] } });
  assert.deepEqual(await gate.loginDecision(who.subjectId),
    { allow: false, reason: 'deletion_prepared_unresolved' });
});

test('缺数据 fail closed：accepted 主体在主库没有行时 unresolved，登录不放开，其余主体仍可推进', async () => {
  const missing = uuid();
  const missingMarker = await acceptedMarker(missing);
  const who = await liveAccount();
  const bystander = await liveAccount();
  await acceptedMarker(who.subjectId);

  const result = await replay.replay();
  assert.equal(result.openLogin, false);
  assert.equal(result.ledgerError, null);
  assert.deepEqual(result.unresolved,
    [{ subjectId: missing, intentId: missingMarker.intentId, reason: 'subject_missing' }]);
  // The provable marker is still applied -- login stays closed for the one that is not -- so an operator
  // who repairs the missing row and re-runs does not start over.
  assert.deepEqual(result.accepted.map(entry => entry.subjectId), [who.subjectId]);
  assert.equal((await subjectRow(who.subjectId)).status, 'deleted');
  assert.equal((await subjectRow(bystander.subjectId)).status, 'active');
  // Nothing was invented for the subject the restored database cannot show.
  assert.equal(await subjectRow(missing), null);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.subjects'), 2);
});

test('不一致 fail closed：作业行与主体状态互相矛盾、或 accepted 主体不是成人时，不写入任何主体', async () => {
  // (a) a job row exists while the subject is still active: the accept transaction never commits that way.
  const conflicted = await liveAccount();
  await db.app.query(`INSERT INTO siyue.account_deletion_jobs
    (id,subject_id,state,requested_at,local_data_deleted,receipt_secret_hash,receipt_expires_at)
    VALUES($1,$2,'accepted',$3,true,$4,$5)`,
  [uuid(), conflicted.subjectId, new Date(now), 'b'.repeat(64), new Date(now + 86_400_000)]);
  await acceptedMarker(conflicted.subjectId);
  // (b) local_data_deleted is only stamped after the subject row became deleted in the same transaction,
  // so a pending subject carrying that flag is corruption rather than a deletion to apply.
  const halfCleaned = await liveAccount();
  await db.app.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1", [halfCleaned.subjectId]);
  await db.app.query(`INSERT INTO siyue.account_deletion_jobs
    (id,subject_id,state,requested_at,local_data_deleted,receipt_secret_hash,receipt_expires_at)
    VALUES($1,$2,'processing',$3,true,$4,$5)`,
  [uuid(), halfCleaned.subjectId, new Date(now), 'c'.repeat(64), new Date(now + 86_400_000)]);
  await acceptedMarker(halfCleaned.subjectId);
  // (c) the acceptance kernel only accepts an adult, so an accepted child subject cannot be explained.
  const child = uuid();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')", [child]);
  await acceptedMarker(child);

  const result = await replay.replay();
  assert.equal(result.openLogin, false);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.unresolved.map(entry => [entry.subjectId, entry.reason]),
    [[conflicted.subjectId, 'job_inconsistent'], [halfCleaned.subjectId, 'job_inconsistent'],
     [child, 'subject_not_adult']]);
  // Not one of them was rewritten, and the conflicting job rows are left exactly as the restore had them.
  const conflictedRow = await subjectRow(conflicted.subjectId);
  assert.equal(conflictedRow.status, 'active');
  assert.equal(conflictedRow.credential_version, 1);
  assert.equal((await subjectRow(halfCleaned.subjectId)).status, 'deletion_pending');
  const childRow = await subjectRow(child);
  assert.equal(childRow.kind, 'child');
  assert.equal(childRow.status, 'active');
  assert.equal((await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',
    [conflicted.sessionId])).rows[0].revoked_at, null);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs'), 2);
});

test('重放失败 fail closed：主库写入报错时按主体整体回滚，不留下半写的主体', async () => {
  const who = await liveAccount();
  const before = await subjectRow(who.subjectId);
  const accepted = await acceptedMarker(who.subjectId);
  await db.admin.query('REVOKE UPDATE ON siyue.subjects FROM siyue_app');
  try {
    const result = await replay.replay();
    assert.deepEqual(result, { openLogin: false, ledgerError: null, accepted: [], blocked: [],
      unresolved: [{ subjectId: who.subjectId, intentId: accepted.intentId, reason: 'replay_failed' }] });
    // The whole subject transaction rolled back: no status, no version step, no revocation.
    assert.deepEqual(await subjectRow(who.subjectId), before);
    assert.equal((await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',
      [who.sessionId])).rows[0].revoked_at, null);
  } finally { await db.admin.query('GRANT UPDATE ON siyue.subjects TO siyue_app'); }
  // The same marker is applied once the write can succeed: nothing about the failed run was cached.
  assert.deepEqual((await replay.replay()).accepted.map(entry => entry.subjectId), [who.subjectId]);
  assert.equal((await subjectRow(who.subjectId)).status, 'deleted');
});

test('账本不可读或不可用时 fail closed：不返回任何重放集，不写主库', async () => {
  const who = await liveAccount();
  const before = await subjectRow(who.subjectId);
  await acceptedMarker(who.subjectId);
  const empty = { openLogin: false, accepted: [], blocked: [], unresolved: [] };
  // Format marker missing: an emptied or foreign ledger must never read as "nothing to replay".
  await ledgerAdmin.query('DELETE FROM ledger.metadata');
  assert.deepEqual(await replay.replay(), { ...empty, ledgerError: 'ledger_unreadable' });
  assert.deepEqual(await subjectRow(who.subjectId), before);
  // Right format, wrong environment: still not this ledger.
  await ledgerAdmin.query(`INSERT INTO ledger.metadata(singleton,format,environment) VALUES(true,$1,'production')`,
    [DELETION_LEDGER_FORMAT]);
  assert.deepEqual(await replay.replay(), { ...empty, ledgerError: 'ledger_unreadable' });
  assert.deepEqual(await subjectRow(who.subjectId), before);
  // Unreachable ledger database: the same fail-closed answer, and the same untouched main database.
  const missing = createDeletionReplayKernel(db.app, createDeletionLedgerStore(
    db.poolFor(LEDGER_ROLE, `${LEDGER_DATABASE}_missing`),
    { database: `${LEDGER_DATABASE}_missing`, environment: 'test' }, clock));
  assert.deepEqual(await missing.replay(), { ...empty, ledgerError: 'ledger_unavailable' });
  assert.deepEqual(await subjectRow(who.subjectId), before);
  // Reachable but unreadable: the runtime role lost the schema privilege, so the ledger cannot answer.
  await ledgerAdmin.query(`REVOKE USAGE ON SCHEMA ledger FROM ${LEDGER_ROLE}`);
  try {
    assert.deepEqual(await replay.replay(), { ...empty, ledgerError: 'ledger_unavailable' });
  } finally { await ledgerAdmin.query(`GRANT USAGE ON SCHEMA ledger TO ${LEDGER_ROLE}`); }
  assert.deepEqual(await subjectRow(who.subjectId), before);
  assert.equal((await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',
    [who.sessionId])).rows[0].revoked_at, null);
});
