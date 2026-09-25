import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createAccountDeletionJobStore } from '../../dist/modules/auth/account-deletion-jobs.js';
import { createAccountDeletionCleanupKernel } from '../../dist/modules/auth/account-deletion-cleanup.js';
import { createAccountDeletionIdempotencyStore, ACCOUNT_DELETION_IDEMPOTENCY_SCOPE,
  ACCOUNT_DELETION_METADATA_MS, ACCOUNT_DELETION_RECEIPT_RECOVERY_MS }
  from '../../dist/modules/auth/account-deletion-idempotency.js';
import { createDeletionLedgerStore, DELETION_LEDGER_FORMAT }
  from '../../dist/account-deletion-ledger/index.js';

// Account-deletion submission idempotency cache (design 14.5) against an isolated temporary
// PostgreSQL cluster only. The fixture builds a fresh cluster on a short Unix socket and never reads a
// database URL or the workspace .env: it holds the restorable main database siyue_test plus the
// independent siyue_deletion_ledger the caller confirms an accepted deletion against. Every key,
// bearer, grant, receipt and instant below is synthetic, and no route, session gate or provider is
// opened here.
//
// The store deliberately keeps no session of its own: the replay cases revoke the sessions they used,
// exactly as acceptance does, and still expect the same bearer to recover the sealed receipt. Cases
// that write re-check the whole record afterwards, because a conflict must change nothing.
const LEDGER_DATABASE = 'siyue_deletion_ledger';
const day = 86_400_000;
let db, fx, store, jobs, cleanup, ledger, ledgerAdmin, ledgerPool;
const query = (sql, ...args) => db.app.query(sql, args).then(result => result.rows);
const count = (sql, ...args) => query(sql, ...args).then(result => Number(result[0].n));

before(async () => {
  db = await startPostgresFixture();
  const socket = (await db.admin.query("SELECT current_setting('unix_socket_directories') AS socket")).rows[0].socket;
  const bin = process.env.SIYUE_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
  execFileSync(join(bin, 'psql'), ['-h', socket, '-U', 'siyue_test_admin', '-d', 'postgres', '-f',
    fileURLToPath(new URL('../../provision/deletion-ledger.sql', import.meta.url))], {
    env: { ...process.env, LC_ALL: 'C', SIYUE_DELETION_LEDGER_DATABASE: LEDGER_DATABASE,
      SIYUE_DELETION_LEDGER_ENVIRONMENT: 'test',
      SIYUE_DELETION_LEDGER_APP_PASSWORD: randomBytes(32).toString('hex') },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  ledgerAdmin = db.poolFor('siyue_test_admin', LEDGER_DATABASE);
  ledgerPool = db.poolFor('siyue_deletion_ledger_app', LEDGER_DATABASE);
});
beforeEach(async () => {
  await db.admin.query('TRUNCATE siyue.subjects, siyue.idempotency_records, siyue.account_deletion_jobs,'
    + ' siyue.auth_sessions, siyue.refresh_tokens, siyue.reauth_grants, siyue.security_events,'
    + ' siyue.rate_limit_buckets, siyue.outbox_jobs CASCADE');
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  await ledgerAdmin.query("UPDATE ledger.metadata SET format=$1, environment='test', seq=0, entry_count=0",
    [DELETION_LEDGER_FORMAT]);
  fx = await createEmailFixture(db);
  store = createAccountDeletionIdempotencyStore(db.app, fx.cipher, randomBytes(32), fx.clock);
  jobs = createAccountDeletionJobStore(db.app, fx.clock);
  cleanup = createAccountDeletionCleanupKernel(db.app, fx.clock);
  ledger = createDeletionLedgerStore(ledgerPool, { database: LEDGER_DATABASE, environment: 'test' }, fx.clock);
});
after(async () => { await db?.stop(); });

const bearer = () => 'header.' + randomBytes(24).toString('base64url') + '.signature';
const grantProof = () => randomUUID() + '.' + randomBytes(32).toString('base64url');
const request = (overrides = {}) => ({ key: randomUUID(), accessToken: bearer(), reauthGrant: grantProof(),
  confirmation: true, dependencyDisposition: { kind: 'none' }, ...overrides });
const receiptFor = (intentId = randomUUID()) => ({ deletionId: intentId,
  receiptSecret: randomBytes(32).toString('base64url'),
  expiresAt: new Date(+fx.clock() + 30 * day).toISOString() });
const insert = (input, receipt) => transaction(db.app, client => store.insert(client, input, { receipt }));
const records = () => query('SELECT * FROM siyue.idempotency_records');

test('insert 只写 HMAC 且无 subject，回执加密 60 秒、元数据保留 24 小时', async () => {
  const input = request(), receipt = receiptFor();
  await insert(input, receipt);
  const [row] = await records();
  assert.equal(row.scope, ACCOUNT_DELETION_IDEMPOTENCY_SCOPE);
  assert.equal(row.subject_id, null);
  assert.equal(row.resource_id, receipt.deletionId);
  assert.equal(row.status, 'complete');
  assert.equal(+row.response_expires_at - +fx.clock(), ACCOUNT_DELETION_RECEIPT_RECOVERY_MS);
  assert.equal(+row.expires_at - +fx.clock(), ACCOUNT_DELETION_METADATA_MS);
  assert.match(row.key_hash, /^[0-9a-f]{64}$/);
  assert.match(row.request_mac, /^[0-9a-f]{64}$/);
  assert.notEqual(row.key_hash, row.request_mac);
  const dump = JSON.stringify(await records());
  for (const secret of [input.key, input.accessToken, input.reauthGrant, receipt.receiptSecret])
    assert.equal(dump.includes(secret), false, 'plaintext must not be stored: ' + secret.slice(0, 12));
});

test('60 秒内同 bearer／授权／键／请求体精确回放返回同一回执，字段顺序不影响绑定', async () => {
  const input = request(), receipt = receiptFor();
  await insert(input, receipt);
  const reordered = { dependencyDisposition: { kind: 'none' }, confirmation: true,
    reauthGrant: input.reauthGrant, accessToken: input.accessToken, key: input.key };
  assert.deepEqual(await store.lookup(reordered),
    { kind: 'cached', deletionId: receipt.deletionId, receipt });
  fx.advance(ACCOUNT_DELETION_RECEIPT_RECOVERY_MS);
  assert.deepEqual(await store.lookup(input), { kind: 'expired', deletionId: receipt.deletionId });
  assert.equal((await records()).length, 1);
});

test('会话已被撤销时仍可回放，换 bearer 是冲突、换键是 absent', async () => {
  const who = await fx.issue();
  const grant = await transaction(db.app, client =>
    fx.service.issueReauth(client, who.session.sessionId, 'delete-account'));
  const input = request({ accessToken: who.accessToken, reauthGrant: grant.reauthGrant });
  const receipt = receiptFor();
  await insert(input, receipt);
  await db.app.query('UPDATE siyue.auth_sessions SET revoked_at=$2 WHERE subject_id=$1',
    [who.session.subjectId, fx.clock()]);
  await assert.rejects(fx.service.verify(who.accessToken), error => error.code === 'AUTH_SESSION_INVALID');
  assert.deepEqual(await store.lookup(input),
    { kind: 'cached', deletionId: receipt.deletionId, receipt });
  assert.equal((await store.lookup({ ...input, accessToken: bearer() })).kind, 'conflict');
  assert.deepEqual(await store.lookup({ ...input, key: randomUUID() }), { kind: 'absent' });
});

test('同键不同 bearer／授权／处置一律冲突，confirmation 不是 true 则拒绝请求', async () => {
  const input = request(), receipt = receiptFor();
  await insert(input, receipt);
  const before = JSON.stringify(await records());
  for (const other of [{ accessToken: bearer() }, { reauthGrant: grantProof() },
    { dependencyDisposition: { kind: 'per-family', families: [{ familyId: randomUUID(), kind: 'end-family-access' }] } },
    { dependencyDisposition: { kind: 'per-family', families: [{ familyId: randomUUID(), kind: 'transfer', recipientSubjectId: randomUUID() }] } }])
    assert.equal((await store.lookup({ ...input, ...other })).kind, 'conflict');
  assert.equal(JSON.stringify(await records()), before);
  const invalid = await store.lookup({ ...input, confirmation: false }).then(() => null, error => error);
  assert.equal(invalid?.code, 'AUTH_INVALID_REQUEST');
  const malformedKey = await store.lookup({ ...input, key: '' }).then(() => null, error => error);
  assert.equal(malformedKey?.code, 'AUTH_INVALID_REQUEST');
});

test('逐家庭处置按家庭 ID 规范化，重排不改变回执，换任一家处置则冲突', async () => {
  const familyA=randomUUID(),familyB=randomUUID(),recipient=randomUUID();
  const families=[{familyId:familyA,kind:'transfer',recipientSubjectId:recipient},
    {familyId:familyB,kind:'end-family-access'}];
  const input=request({dependencyDisposition:{kind:'per-family',families}}),receipt=receiptFor();
  await insert(input,receipt);
  assert.deepEqual(await store.lookup({...input,dependencyDisposition:{kind:'per-family',families:[...families].reverse()}}),
    {kind:'cached',deletionId:receipt.deletionId,receipt});
  assert.equal((await store.lookup({...input,dependencyDisposition:{kind:'per-family',families:[
    {familyId:familyA,kind:'transfer',recipientSubjectId:randomUUID()},families[1]]}})).kind,'conflict');
  assert.equal((await store.lookup({...input,dependencyDisposition:{kind:'per-family',families:[
    families[0],{familyId:familyB,kind:'transfer',recipientSubjectId:recipient}]}})).kind,'conflict');
});

test('越过 24 小时窗口，同键仍不可覆盖也不会被当成新操作', async () => {
  const input = request(), receipt = receiptFor();
  await insert(input, receipt);
  fx.advance(ACCOUNT_DELETION_METADATA_MS + 1);
  assert.deepEqual(await store.lookup(input), { kind: 'expired', deletionId: receipt.deletionId });
  const before = JSON.stringify(await records());
  assert.equal((await store.lookup({ ...input, accessToken: bearer() })).kind, 'conflict');
  const rejected = await insert(input, receiptFor()).then(() => null, error => error);
  assert.equal(rejected?.code, 'AUTH_IDEMPOTENCY_CONFLICT');
  assert.equal((await records()).length, 1);
  assert.equal(JSON.stringify(await records()), before);
});

test('运行期维护先清空 60 秒后的密文，再删除 24 小时后的元数据', async () => {
  const subjectId = randomUUID(), intentId = randomUUID();
  await ledger.prepare({ subjectId, intentId });
  await ledger.markAccepted({ subjectId, intentId });
  const input = request(), receipt = receiptFor(intentId);
  await insert(input, receipt);
  assert.deepEqual(await store.lookup(input), { kind: 'cached', deletionId: intentId, receipt });
  fx.advance(ACCOUNT_DELETION_RECEIPT_RECOVERY_MS);
  await fx.email.cleanup();
  const [cleared] = await records();
  assert.equal(cleared.response_ciphertext, null);
  assert.deepEqual(await store.lookup(input), { kind: 'expired', deletionId: intentId });
  fx.advance(ACCOUNT_DELETION_METADATA_MS);
  await fx.email.cleanup();
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records'), 0);
  assert.deepEqual(await store.lookup(input), { kind: 'absent' });
  // absent 只说明本缓存没有元数据；已受理的独立账本仍是拒绝再次删除的依据。
  assert.equal((await ledger.lookup(subjectId))?.status, 'accepted');
});

test('回放给出的 deletionId 就是主层要在独立账本确认的意图 UUID', async () => {
  const subjectId = randomUUID(), intentId = randomUUID();
  await ledger.prepare({ subjectId, intentId });
  const input = request(), receipt = receiptFor(intentId);
  await insert(input, receipt);
  const replay = await store.lookup(input);
  assert.equal(replay.kind, 'cached');
  assert.equal(replay.deletionId, intentId);
  assert.equal((await ledger.lookup(subjectId))?.intentId, intentId);
  assert.equal((await ledger.lookup(subjectId))?.status, 'prepared');
  await ledger.markAccepted({ subjectId, intentId });
  assert.equal((await ledger.lookup(subjectId))?.status, 'accepted');
});

test('注销清理删掉本人幂等记录，但保留 subject 为空的回执缓存', async () => {
  const subjectId = randomUUID(), intentId = randomUUID();
  await db.admin.query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'adult','deletion_pending')",
    [subjectId]);
  const input = request();
  let saved;
  await transaction(db.app, async client => {
    saved = await jobs.insertPending(client, { subjectId, deletionId: intentId,
      receiptExpiresAt: new Date(+fx.clock() + 30 * day), providerRevocationPending: false });
    await store.insert(client, input, { receipt: saved });
  });
  await db.app.query('INSERT INTO siyue.idempotency_records'
    + " (scope,key_hash,request_mac,subject_id,status,expires_at) VALUES('email-request',$1,'mac',$2,'complete',$3)",
  [randomBytes(32).toString('hex'), subjectId, new Date(+fx.clock() + day)]);
  const result = await cleanup.cleanupSubject({ subjectId, expectedDeletionId: intentId });
  assert.equal(result.removed.idempotencyRecords, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope=$1',
    ACCOUNT_DELETION_IDEMPOTENCY_SCOPE), 1);
  assert.equal((await records())[0].subject_id, null);
  assert.deepEqual(await store.lookup(input), { kind: 'cached', deletionId: intentId, receipt: saved });
});

test('并发预留同一个键：先提交者胜出，另一个事务失败关闭且不改写缓存', async () => {
  const input = request(), first = receiptFor(), second = receiptFor();
  const winner = await db.app.connect(), loser = await db.app.connect();
  try {
    await winner.query('BEGIN');
    await loser.query('BEGIN');
    await store.insert(winner, input, { receipt: first });
    // The second transaction waits on the advisory lock until the first one commits.
    const blocked = store.insert(loser, input, { receipt: second }).then(() => null, error => error);
    await winner.query('COMMIT');
    const rejected = await blocked;
    await loser.query('ROLLBACK');
    assert.equal(rejected?.code, 'AUTH_IDEMPOTENCY_CONFLICT');
  } finally {
    winner.release(); loser.release();
  }
  const rows = await records();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource_id, first.deletionId);
  assert.deepEqual(await store.lookup(input),
    { kind: 'cached', deletionId: first.deletionId, receipt: first });
});
