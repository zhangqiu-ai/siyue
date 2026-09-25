import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { createDeletionLedgerStore, createDeletionReplayKernel, DELETION_LEDGER_FORMAT }
  from '../../dist/account-deletion-ledger/index.js';
import { createDeletionLedgerFenceStore } from '../../dist/account-deletion-ledger/fence.js';
import { createDeletionStartupRecovery } from '../../dist/account-deletion-ledger/startup-recovery.js';

// Startup recovery coordinator (design 13.4) against an isolated temporary PostgreSQL cluster only. The
// fixture builds a fresh cluster on a short Unix socket and never reads a database URL or the workspace
// .env; two independent temporary databases live in it -- the restorable main database `siyue_test` and
// the ledger `siyue_deletion_ledger` created by provision/deletion-ledger.sql. The coordinator opens no
// route, calls no provider and writes nothing outside the two databases, and every UUID, instant and
// secret below is synthetic. Cases that refuse re-check the main-database subject row, because a refused
// run may not change an account or certify a fence.
const LEDGER_DATABASE = 'siyue_deletion_ledger';
const LEDGER_ROLE = 'siyue_deletion_ledger_app';
const FENCE = 'siyue.deletion_ledger_fence';
let db, ledger, ledgerAdmin, store, replay, fence, fx, now, ledgerInstanceId;
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
  // Self-heal whatever a fail-closed case deliberately broke, so one case cannot poison the next: the
  // fence table starts empty and the app role holds exactly the privileges the fence store needs.
  await db.admin.query('DELETE FROM siyue.deletion_ledger_fence');
  await db.admin.query('GRANT SELECT, INSERT, UPDATE ON siyue.deletion_ledger_fence TO siyue_app');
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  await ledgerAdmin.query(`GRANT USAGE ON SCHEMA ledger TO ${LEDGER_ROLE}`);
  await ledgerAdmin.query(`INSERT INTO ledger.metadata(singleton,format,environment,seq,entry_count) VALUES(true,$1,'test',0,0)
    ON CONFLICT (singleton) DO UPDATE SET format=excluded.format, environment=excluded.environment, seq=0, entry_count=0`,
  [DELETION_LEDGER_FORMAT]);
  ledgerInstanceId = (await ledgerAdmin.query('SELECT instance_id FROM ledger.metadata WHERE singleton')).rows[0].instance_id;
  fx = await createEmailFixture(db);
  store = createDeletionLedgerStore(ledger, { database: LEDGER_DATABASE, environment: 'test' }, clock);
  replay = createDeletionReplayKernel(db.app, store);
  fence = createDeletionLedgerFenceStore(db.app);
});
after(async () => { await db?.stop(); });

const uuid = () => randomUUID();
const recovery = (overrides = {}) => createDeletionStartupRecovery({ pool: db.app, fence, ledger: store, replay, ...overrides });
const subjectRow = subjectId => db.app.query('SELECT to_jsonb(s) AS row FROM siyue.subjects s WHERE id=$1',
  [subjectId]).then(result => result.rows[0]?.row ?? null);
const ledgerRow = subjectId => ledger.query('SELECT status,intent_id FROM ledger.entries WHERE subject_id=$1',
  [subjectId]).then(result => result.rows[0] ?? null);
/** Writes the fence directly, as the admin: deliberately able to set states the store's own advance
 *  refuses (another instance, a higher sequence) so the coordinator's comparison can be tested. */
const setFence = point => db.admin.query(`INSERT INTO siyue.deletion_ledger_fence
    (singleton,ledger_instance_id,ledger_format,applied_sequence,applied_at) VALUES(true,$1,$2,$3,$4)
  ON CONFLICT (singleton) DO UPDATE SET ledger_instance_id=EXCLUDED.ledger_instance_id,
    ledger_format=EXCLUDED.ledger_format, applied_sequence=EXCLUDED.applied_sequence,
    applied_at=EXCLUDED.applied_at`,
  [point.instanceId, point.format, point.sequence.toString(), new Date(now)]);

/** A real adult with one live session and one live refresh token, so a replay has something to revoke. */
async function liveAccount() {
  const { tokens } = await fx.register();
  return { subjectId: tokens.session.subjectId };
}

/** The ledger marker a committed acceptance leaves behind: prepared first, then accepted. */
async function acceptedMarker(subjectId) {
  const intentId = uuid();
  await store.prepare({ subjectId, intentId });
  now += 1_000;
  const accepted = await store.markAccepted({ subjectId, intentId });
  const exists = await db.app.query('SELECT 1 FROM siyue.subjects WHERE id=$1', [subjectId]);
  if (exists.rowCount) {
    await db.app.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1", [subjectId]);
    await db.app.query(`INSERT INTO siyue.account_deletion_jobs
      (id,subject_id,state,requested_at,receipt_secret_hash,receipt_expires_at)
      VALUES($1,$2,'accepted',$3,$4,$5)`,
    [intentId, subjectId, new Date(now), randomBytes(32).toString('hex'), new Date(now + 86_400_000)]);
  }
  return { intentId, acceptedAt: accepted.acceptedAt, point: await store.highWater() };
}

test('全新安装没有围栏：先重放空集再绑定账本实例，第二次启动直接 already_current', async () => {
  const point = await store.highWater();
  assert.deepEqual(await recovery().recover(), { openLogin: true, action: 'replayed', reason: null, fence: null,
    ledger: point, accepted: [], blocked: [], unresolved: [] });
  // The run bound the ledger instance before reporting ready: a missing fence row is not proof by
  // itself, so it is written rather than treated as "nothing to do".
  assert.deepEqual(await fence.read(), point);
  let replayed = 0;
  const counting = { replay: async () => { replayed += 1; return replay.replay(); } };
  const second = await recovery({ replay: counting }).recover();
  assert.deepEqual(second, { openLogin: true, action: 'already_current', reason: null, fence: point,
    ledger: point, accepted: [], blocked: [], unresolved: [] });
  assert.equal(replayed, 0);
});

test('受理后恢复：待清理作业保持 deletion_pending，并把围栏推进到账本序号', async () => {
  const who = await liveAccount();
  const bystander = await liveAccount();
  const bystanderBefore = await subjectRow(bystander.subjectId);
  const marker = await acceptedMarker(who.subjectId);
  // The restored backup: the fence still records the point proved before this deletion was accepted.
  const restoredPoint = { instanceId: ledgerInstanceId, format: DELETION_LEDGER_FORMAT, sequence: 0n };
  await setFence(restoredPoint);

  const result = await recovery().recover();
  assert.equal(result.openLogin, true);
  assert.equal(result.action, 'replayed');
  assert.deepEqual(result.fence, restoredPoint);
  assert.deepEqual(result.ledger, marker.point);
  assert.deepEqual(result.accepted.map(entry => [entry.subjectId, entry.intentId, entry.acceptedAt,
    entry.alreadyDeleted, entry.changes.subject]), [[who.subjectId, marker.intentId, marker.acceptedAt, false, 0]]);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.unresolved, []);
  assert.equal((await subjectRow(who.subjectId)).status, 'deletion_pending');
  // The fence now carries the ledger's own point, so the next start has nothing to replay.
  assert.deepEqual(await fence.read(), marker.point);
  // A subject with no marker is untouched by the run, and the ledger is not written by the coordinator.
  assert.deepEqual(await subjectRow(bystander.subjectId), bystanderBefore);
  assert.deepEqual(await ledgerRow(who.subjectId), { status: 'accepted', intent_id: marker.intentId });
  let replayed = 0;
  const counting = { replay: async () => { replayed += 1; return replay.replay(); } };
  const second = await recovery({ replay: counting }).recover();
  assert.equal(second.action, 'already_current');
  assert.equal(second.openLogin, true);
  assert.equal(replayed, 0);
});

test('旧备份缺少已受理作业时保持关闭，不能把阻断复活误称为资料已清理', async () => {
  const who = await liveAccount(), intentId = uuid();
  await store.prepare({ subjectId: who.subjectId, intentId });
  await store.markAccepted({ subjectId: who.subjectId, intentId });
  const result = await recovery().recover();
  assert.equal(result.openLogin, false);
  assert.equal(result.reason, 'replay_unresolved');
  assert.deepEqual(result.unresolved, [{ subjectId: who.subjectId, intentId, reason: 'job_missing' }]);
  assert.equal(await fence.read(), null);
});

test('restored family ownership keeps startup closed even with a matching deletion job or fence', async () => {
  const who=await liveAccount();
  const marker=await acceptedMarker(who.subjectId);
  const familyId=uuid();
  await db.app.query("INSERT INTO siyue.families(id,owner_subject_id,status) VALUES($1,$2,'active')",
    [familyId,who.subjectId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner')",
    [familyId,who.subjectId]);
  const first=await recovery().recover();
  assert.equal(first.openLogin,false);
  assert.equal(first.reason,'deletion_state_unresolved');
  assert.equal(await fence.read(),null);
  await setFence(marker.point);
  const equalFence=await recovery().recover();
  assert.equal(equalFence.openLogin,false);
  assert.equal(equalFence.reason,'deletion_state_unresolved');
  assert.deepEqual(equalFence.accepted,[]);
  assert.deepEqual(await fence.read(),marker.point);
  await db.app.query("UPDATE siyue.families SET status='dissolved' WHERE id=$1",[familyId]);
  assert.equal((await recovery().recover()).openLogin,true);
});

test('a recorded frozen-family review is visible as pending work without closing unrelated service', async () => {
  const who=await liveAccount(),member=await liveAccount();
  const marker=await acceptedMarker(who.subjectId),familyId=uuid();
  await db.app.query("INSERT INTO siyue.families(id,owner_subject_id,status) VALUES($1,$2,'frozen')",
    [familyId,who.subjectId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",
    [familyId,who.subjectId,member.subjectId]);
  const reviewId=uuid();
  await db.app.query(`INSERT INTO siyue.account_deletion_family_reviews
    (id,deletion_id,family_id,deleting_subject_id,state,opened_at)
    VALUES($1,$2,$3,$4,'pending',now())`,[reviewId,marker.intentId,familyId,who.subjectId]);
  const first=await recovery().recover();
  assert.equal(first.openLogin,true);
  assert.equal(first.action,'replayed');
  assert.equal((await db.app.query('SELECT state FROM siyue.account_deletion_family_reviews WHERE id=$1',
    [reviewId])).rows[0].state,'pending');
  await db.app.query('UPDATE siyue.account_deletion_jobs SET local_data_deleted=true WHERE id=$1',
    [marker.intentId]);
  assert.equal((await recovery().recover()).reason,'deletion_state_unresolved');
  await db.app.query('UPDATE siyue.account_deletion_jobs SET local_data_deleted=false WHERE id=$1',
    [marker.intentId]);
  assert.equal((await recovery().recover()).openLogin,true);
  await db.app.query("UPDATE siyue.account_deletion_family_reviews SET state='resolved',resolved_at=now() WHERE id=$1",
    [reviewId]);
  assert.equal((await recovery().recover()).reason,'deletion_state_unresolved');
});

test('a frozen-family review cannot excuse an orphaned guardianship consent after restore', async () => {
  const who=await liveAccount(),member=await liveAccount(),childId=uuid(),consentId=uuid();
  const marker=await acceptedMarker(who.subjectId),familyId=uuid();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')",[childId]);
  await db.app.query("INSERT INTO siyue.families(id,owner_subject_id,status) VALUES($1,$2,'frozen')",
    [familyId,who.subjectId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",
    [familyId,who.subjectId,member.subjectId]);
  await db.app.query(`INSERT INTO siyue.account_deletion_family_reviews
    (id,deletion_id,family_id,deleting_subject_id,state,opened_at)
    VALUES($1,$2,$3,$4,'pending',now())`,[uuid(),marker.intentId,familyId,who.subjectId]);
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-guardianship','1.0')`,[consentId,who.subjectId,childId]);
  assert.equal((await recovery().recover()).reason,'deletion_state_unresolved');
  assert.equal(await fence.read(),null);
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=now() WHERE id=$1',[consentId]);
  assert.equal((await recovery().recover()).openLogin,true);
});

test('restored guardianship alone keeps startup closed until its authority is withdrawn', async () => {
  const who=await liveAccount(),owner=await liveAccount(),childId=uuid(),consentId=uuid(),familyId=uuid();
  const marker=await acceptedMarker(who.subjectId);
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')",[childId]);
  await db.app.query("INSERT INTO siyue.families(id,owner_subject_id,status) VALUES($1,$2,'active')",
    [familyId,owner.subjectId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [familyId,childId]);
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-guardianship','1.0')`,[consentId,who.subjectId,childId]);
  await db.app.query(`INSERT INTO siyue.guardian_relationships
    (family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)`,
  [familyId,who.subjectId,childId,consentId]);
  await setFence(marker.point);
  assert.equal((await recovery().recover()).reason,'deletion_state_unresolved');
  await db.app.query('UPDATE siyue.guardian_relationships SET active=false WHERE consent_record_id=$1',[consentId]);
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=now() WHERE id=$1',[consentId]);
  assert.equal((await recovery().recover()).openLogin,true);
});

test('a deletion job cannot certify an active subject even when the fence is current', async () => {
  const who=await liveAccount();
  const marker=await acceptedMarker(who.subjectId);
  await setFence(marker.point);
  await db.app.query("UPDATE siyue.subjects SET status='active' WHERE id=$1",[who.subjectId]);
  const result=await recovery().recover();
  assert.equal(result.openLogin,false);
  assert.equal(result.reason,'deletion_state_unresolved');
  assert.deepEqual(await fence.read(),marker.point);
  await db.app.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",[who.subjectId]);
  assert.equal((await recovery().recover()).openLogin,true);
});

test('prepared 未决：拒绝开启、不推进围栏、不动主体，撤销之后同一启动才绑定', async () => {
  const who = await liveAccount();
  const before = await subjectRow(who.subjectId);
  const intentId = uuid();
  await store.prepare({ subjectId: who.subjectId, intentId });
  const preparedPoint = await store.highWater();

  const result = await recovery().recover();
  assert.deepEqual(result, { openLogin: false, action: 'refused', reason: 'prepared_markers_pending',
    fence: null, ledger: preparedPoint, accepted: [], blocked: [who.subjectId], unresolved: [] });
  assert.equal(await fence.read(), null);
  assert.deepEqual(await subjectRow(who.subjectId), before);
  // Once the intent is withdrawn the same startup resumes: the empty replay set is then bound.
  await store.cancel({ subjectId: who.subjectId, intentId });
  const second = await recovery().recover();
  assert.equal(second.openLogin, true);
  assert.equal(second.action, 'replayed');
  assert.deepEqual(await fence.read(), await store.highWater());
});

test('缺数据：accepted 主体在主库没有行时拒绝开启且不推进围栏，已证明的主体仍写回', async () => {
  const missing = uuid();
  const missingMarker = await acceptedMarker(missing);
  const who = await liveAccount();
  await acceptedMarker(who.subjectId);

  const result = await recovery().recover();
  assert.equal(result.openLogin, false);
  assert.equal(result.action, 'refused');
  assert.equal(result.reason, 'replay_unresolved');
  assert.deepEqual(result.unresolved, [{ subjectId: missing, intentId: missingMarker.intentId, reason: 'subject_missing' }]);
  // The provable marker was applied, so an operator who repairs the missing row resumes instead of
  // starting over -- but the fence still records nothing, because one marker stayed open.
  assert.equal((await subjectRow(who.subjectId)).status, 'deletion_pending');
  assert.equal(await fence.read(), null);
  assert.equal(await subjectRow(missing), null);
});

test('账本被替换：围栏绑定另一个实例或格式时拒绝开启，且不写主库', async () => {
  const who = await liveAccount();
  await acceptedMarker(who.subjectId);
  const before = await subjectRow(who.subjectId);
  await setFence({ instanceId: uuid(), format: DELETION_LEDGER_FORMAT, sequence: 0n });

  const replaced = await recovery().recover();
  assert.equal(replaced.openLogin, false);
  assert.equal(replaced.reason, 'ledger_replaced');
  assert.deepEqual(replaced.accepted, []);
  assert.deepEqual(await subjectRow(who.subjectId), before);
  // A format change on the same instance is the same answer: this is not the ledger the fence bound.
  await setFence({ instanceId: ledgerInstanceId, format: 'siyue-deletion-ledger-v1', sequence: 0n });
  assert.equal((await recovery().recover()).reason, 'ledger_replaced');
  assert.deepEqual(await subjectRow(who.subjectId), before);
});

test('账本回退：围栏序号高于账本时不重放、不覆盖围栏', async () => {
  const who = await liveAccount();
  const before = await subjectRow(who.subjectId);
  const ahead = { instanceId: ledgerInstanceId, format: DELETION_LEDGER_FORMAT, sequence: 5n };
  await setFence(ahead);

  const result = await recovery().recover();
  assert.equal(result.openLogin, false);
  assert.equal(result.reason, 'ledger_regressed');
  assert.deepEqual(result.fence, ahead);
  assert.deepEqual(result.ledger, await store.highWater());
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(await fence.read(), ahead);
  assert.deepEqual(await subjectRow(who.subjectId), before);
});

test('账本不可读或不可用：拒绝开启，不重放、不绑定', async () => {
  const who = await liveAccount();
  await acceptedMarker(who.subjectId);
  const before = await subjectRow(who.subjectId);
  // Format marker missing: an emptied or foreign ledger must never read as "nothing to replay".
  await ledgerAdmin.query('DELETE FROM ledger.metadata');
  assert.equal((await recovery().recover()).reason, 'ledger_unreadable');
  // Right format, wrong environment: still not this ledger.
  await ledgerAdmin.query(`INSERT INTO ledger.metadata(singleton,format,environment) VALUES(true,$1,'production')`,
    [DELETION_LEDGER_FORMAT]);
  assert.equal((await recovery().recover()).reason, 'ledger_unreadable');
  // Unreachable ledger database: the same refusal, and still no fence.
  const unreachable = recovery({ ledger: createDeletionLedgerStore(db.poolFor(LEDGER_ROLE, `${LEDGER_DATABASE}_missing`),
    { database: `${LEDGER_DATABASE}_missing`, environment: 'test' }, clock) });
  assert.equal((await unreachable.recover()).reason, 'ledger_unavailable');
  // Reachable but unreadable: the runtime role lost the schema privilege, so the ledger cannot answer.
  await ledgerAdmin.query(`REVOKE USAGE ON SCHEMA ledger FROM ${LEDGER_ROLE}`);
  try { assert.equal((await recovery().recover()).reason, 'ledger_unavailable'); }
  finally { await ledgerAdmin.query(`GRANT USAGE ON SCHEMA ledger TO ${LEDGER_ROLE}`); }
  assert.equal(await fence.read(), null);
  assert.deepEqual(await subjectRow(who.subjectId), before);
});

test('围栏不可读：拒绝开启，不重放任何主体', async () => {
  const who = await liveAccount();
  await acceptedMarker(who.subjectId);
  const before = await subjectRow(who.subjectId);
  await db.admin.query('REVOKE SELECT ON siyue.deletion_ledger_fence FROM siyue_app');
  try {
    const result = await recovery().recover();
    assert.equal(result.openLogin, false);
    assert.equal(result.reason, 'fence_unreadable');
    assert.equal(result.fence, null);
    assert.deepEqual(result.ledger, await store.highWater());
    assert.deepEqual(await subjectRow(who.subjectId), before);
  } finally { await db.admin.query('GRANT SELECT ON siyue.deletion_ledger_fence TO siyue_app'); }
});

test('围栏写入被拒：主体已重放但不认证，权限恢复后同一次启动继续并绑定', async () => {
  const who = await liveAccount();
  await acceptedMarker(who.subjectId);
  await db.admin.query('REVOKE INSERT, UPDATE ON siyue.deletion_ledger_fence FROM siyue_app');
  try {
    const result = await recovery().recover();
    assert.equal(result.openLogin, false);
    assert.equal(result.reason, 'fence_advance_failed');
    assert.deepEqual(result.accepted.map(entry => entry.subjectId), [who.subjectId]);
    assert.equal(await fence.read(), null);
  } finally { await db.admin.query('GRANT INSERT, UPDATE ON siyue.deletion_ledger_fence TO siyue_app'); }
  const retry = await recovery().recover();
  assert.equal(retry.openLogin, true);
  assert.equal(retry.action, 'replayed');
  assert.deepEqual(await fence.read(), await store.highWater());
});

test('并发写入：重放期间账本前进时拒绝推进围栏，下一次启动才认证新的点', async () => {
  const who = await liveAccount();
  const bystander = await liveAccount();
  const marker = await acceptedMarker(who.subjectId);
  const captured = await store.highWater();
  // The concurrent writer: a deletion accepted on another connection while this startup replays.
  const interleaved = { replay: async () => {
    const result = await replay.replay();
    await acceptedMarker(bystander.subjectId);
    return result;
  } };

  const result = await recovery({ replay: interleaved }).recover();
  assert.equal(result.openLogin, false);
  assert.equal(result.action, 'refused');
  assert.equal(result.reason, 'ledger_moved_during_recovery');
  assert.deepEqual(result.ledger, captured);
  assert.deepEqual(result.accepted.map(entry => entry.subjectId), [who.subjectId]);
  assert.equal(await fence.read(), null);
  // The marker this run did read was applied and the ledger now stands past the captured point, so the
  // next start proves the newer set instead of certifying a stale one.
  assert.equal((await subjectRow(who.subjectId)).status, 'deletion_pending');
  assert.equal((await subjectRow(bystander.subjectId)).status, 'deletion_pending');
  const next = await recovery().recover();
  assert.equal(next.openLogin, true);
  assert.equal(next.action, 'replayed');
  assert.deepEqual(next.accepted.map(entry => entry.subjectId).sort(), [who.subjectId, bystander.subjectId].sort());
  assert.deepEqual(await fence.read(), await store.highWater());
  assert.notDeepEqual((await fence.read()).sequence, captured.sequence);
  assert.equal(marker.point.sequence < (await fence.read()).sequence, true);
});

test('围栏写入期间账本前进也拒绝开放，下次启动继续重放', async () => {
  const who = await liveAccount();
  const marker = await acceptedMarker(who.subjectId);
  const bystander = await liveAccount();
  const interleavedFence = {
    read: () => fence.read(),
    advance: async (client, point) => {
      await fence.advance(client, point);
      await store.prepare({ subjectId: bystander.subjectId, intentId: uuid() });
    },
  };
  const result = await recovery({ fence: interleavedFence }).recover();
  assert.equal(result.openLogin, false);
  assert.equal(result.reason, 'ledger_moved_during_recovery');
  assert.equal((await fence.read()).sequence, marker.point.sequence);
  assert.equal((await store.lookup(bystander.subjectId)).status, 'prepared');
  const next = await recovery().recover();
  assert.equal(next.openLogin, false);
  assert.equal(next.reason, 'prepared_markers_pending');
});

test('重放内核没有作证时拒绝：不合约的回答与抛出的失败都不认证', async () => {
  const who = await liveAccount();
  await acceptedMarker(who.subjectId);
  const before = await subjectRow(who.subjectId);
  for (const replayStub of [{ replay: async () => ({ openLogin: true }) },
    { replay: async () => { throw new Error('replay_transport_failed'); } }]) {
    const result = await recovery({ replay: replayStub }).recover();
    assert.equal(result.openLogin, false);
    assert.equal(result.reason, 'replay_unproven');
    assert.deepEqual(result.accepted, []);
    assert.equal(await fence.read(), null);
    assert.deepEqual(await subjectRow(who.subjectId), before);
  }
});
