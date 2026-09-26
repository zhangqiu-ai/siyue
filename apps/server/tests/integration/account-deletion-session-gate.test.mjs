import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, exportJWK, exportPKCS8 } from 'jose';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createAccessSigner, RecoveryCipher } from '../../dist/adapters/crypto/auth-crypto.js';
import { createSessionService } from '../../dist/modules/auth/sessions.js';
import { createDeletionLedgerStore, createDeletionLedgerGate, DELETION_LEDGER_FORMAT }
  from '../../dist/account-deletion-ledger/index.js';

// The optional per-subject deletion-ledger gate injected into createSessionService. This file proves
// the seam only: it wires the real ledger gate into a real session service over an isolated temporary
// PostgreSQL cluster, and deliberately does not touch index.ts, runtime-app.ts, config.ts or the
// ledger implementation. A second temporary database holds the independent anti-revival ledger, the
// same way account-deletion-ledger.test.mjs provisions it, so the decisions exercised here are the
// production ones and not hand-written stubs. No runtime path calls this gate after these tests end.
const LEDGER_DATABASE = 'siyue_deletion_ledger';
const LEDGER_ROLE = 'siyue_deletion_ledger_app';
let db, ledger, ledgerAdmin, store, gate;

const postgresBin = () => process.env.SIYUE_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
/** Provision the independent ledger database exactly as the checked-in operator script would. */
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
  store = createDeletionLedgerStore(ledger, { database: LEDGER_DATABASE, environment: 'test' });
  gate = createDeletionLedgerGate(store);
});
beforeEach(async () => {
  await db.admin.query('TRUNCATE siyue.subjects CASCADE');
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  // Reset the watermark together with the entries so an intact empty ledger is what the next case sees.
  await ledgerAdmin.query(`INSERT INTO ledger.metadata(singleton,format,environment,seq,entry_count)
    VALUES(true,$1,'test',0,0)
    ON CONFLICT (singleton) DO UPDATE SET format=excluded.format, environment=excluded.environment, seq=0, entry_count=0`,
  [DELETION_LEDGER_FORMAT]);
});
after(async () => { await db?.stop(); });

const rejection = (code, status) => error => error?.code === code && error?.status === status;
const addSubject = async kind => {
  const id = randomUUID();
  await db.app.query('INSERT INTO siyue.subjects(id,kind) VALUES($1,$2)', [id, kind]);
  return id;
};
const sessionCount = subjectId => db.app.query('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1',
  [subjectId]).then(result => result.rows[0].n);
const issue = (service, subjectId, installationId = randomUUID()) =>
  transaction(db.app, client => service.issue(client, subjectId, installationId, 'email'));
const refreshRow = id => db.app.query('SELECT used_at,replaced_by FROM siyue.refresh_tokens WHERE id=$1', [id])
  .then(result => result.rows[0]);

/** Counts the subject IDs the session service asks about, so ordering and resolved-subject semantics are visible. */
function countingGate(loginDecision) {
  const calls = [];
  return { calls, async loginDecision(subjectId) { calls.push(subjectId); return loginDecision(subjectId); } };
}
async function createHarness(loginGate) {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'gate-key', alg: 'ES256' };
  const config = { privateKey: await exportPKCS8(pair.privateKey), jwks: { keys: [jwk] }, kid: 'gate-key',
    issuer: 'https://siyue.test/auth', audience: 'siyue-test-api' };
  const signer = await createAccessSigner(config);
  const cipher = new RecoveryCipher('gate-v1', new Map([['gate-v1', randomBytes(32)]]));
  let now = Date.parse('2026-09-24T00:00:00.000Z');
  const clock = () => new Date(now);
  const service = createSessionService(db.app, signer, cipher, clock, loginGate ? { loginGate } : {});
  return { service, signer, cipher, config, pair, clock, advance: ms => { now += ms; } };
}
/** A minimal but schema-valid child grant; a denied issuance never reaches the session insert. */
async function addChildGrant() {
  const guardianId = randomUUID(), childId = randomUUID(), familyId = randomUUID(), grantId = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult'),($2,'child')", [guardianId, childId]);
  await db.app.query('INSERT INTO siyue.families(id,owner_subject_id) VALUES($1,$2)', [familyId, guardianId]);
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,
    guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios',1,1,'{}'::text[],$6)`,
  [grantId, childId, guardianId, familyId, randomUUID(), new Date(Date.now() + 86_400_000)]);
  return { grantId, childId };
}

test('clear ledger allows adult issue, verify, verifyForMutation and refresh', async () => {
  const g = countingGate(subjectId => gate.loginDecision(subjectId));
  const h = await createHarness(g);
  const subjectId = await addSubject('adult');
  const issued = await issue(h.service, subjectId);
  assert.deepEqual(await h.service.verify(issued.accessToken), issued.session);
  assert.deepEqual(await transaction(db.app, client => h.service.verifyForMutation(client, issued.accessToken)), issued.session);
  const rotated = await h.service.refresh(issued.refreshToken, randomUUID());
  assert.notEqual(rotated.refreshToken, issued.refreshToken);
  assert.deepEqual(await h.service.verify(rotated.accessToken), rotated.session);
  // Every checked path asked about the subject resolved from the token/session, not a caller-supplied id.
  assert.ok(g.calls.filter(call => call === subjectId).length >= 5);
  // Signature validation happens before the ledger check.
  const callsBeforeInvalid = g.calls.length;
  await assert.rejects(h.service.verify('not-a-jwt'), rejection('AUTH_ACCESS_INVALID', 401));
  assert.equal(g.calls.length, callsBeforeInvalid);
  // A signed token whose subject claim disagrees with the session row is rejected before the gate too.
  const clock = h.clock();
  const forgedSubject = await h.signer.sign(randomUUID(), issued.session.sessionId, 1, clock, new Date(+clock + 900_000));
  await assert.rejects(h.service.verify(forgedSubject), rejection('AUTH_SESSION_INVALID', 401));
  assert.equal(g.calls.length, callsBeforeInvalid);
  // A cancelled intent is not a deletion marker.
  const cancelledSubject = await addSubject('adult');
  const cancelledIntent = randomUUID();
  await store.prepare({ subjectId: cancelledSubject, intentId: cancelledIntent });
  await store.cancel({ subjectId: cancelledSubject, intentId: cancelledIntent });
  assert.ok(await issue(h.service, cancelledSubject));
});

test('accepted deletion marker blocks issue, verify, verifyForMutation and refresh without writes', async () => {
  const g = countingGate(subjectId => gate.loginDecision(subjectId));
  const h = await createHarness(g);
  const subjectId = await addSubject('adult');
  const issued = await issue(h.service, subjectId);
  const intentId = randomUUID();
  await store.prepare({ subjectId, intentId });
  await store.markAccepted({ subjectId, intentId });

  await assert.rejects(issue(h.service, subjectId), rejection('AUTH_SESSION_INVALID', 401));
  assert.equal(await sessionCount(subjectId), 1);
  await assert.rejects(h.service.verify(issued.accessToken), rejection('AUTH_SESSION_INVALID', 401));
  // A caller mutation issued in the same transaction as verifyForMutation must roll back with the denial.
  await assert.rejects(transaction(db.app, async client => {
    await client.query("UPDATE siyue.subjects SET display_name='ledger-blocked' WHERE id=$1", [subjectId]);
    await h.service.verifyForMutation(client, issued.accessToken);
  }), rejection('AUTH_SESSION_INVALID', 401));
  assert.equal((await db.app.query('SELECT display_name FROM siyue.subjects WHERE id=$1', [subjectId])).rows[0].display_name, '');
  // A denied refresh must not rotate the token, extend the session or write a successor.
  const beforeToken = await refreshRow(issued.refreshToken.split('.')[0]);
  const beforeSession = (await db.app.query('SELECT idle_expires_at FROM siyue.auth_sessions WHERE id=$1',
    [issued.session.sessionId])).rows[0];
  await assert.rejects(h.service.refresh(issued.refreshToken, randomUUID()), rejection('AUTH_SESSION_INVALID', 401));
  assert.deepEqual(await refreshRow(issued.refreshToken.split('.')[0]), beforeToken);
  assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.refresh_tokens WHERE session_id=$1',
    [issued.session.sessionId])).rows[0].n, 1);
  assert.deepEqual((await db.app.query('SELECT idle_expires_at FROM siyue.auth_sessions WHERE id=$1',
    [issued.session.sessionId])).rows[0], beforeSession);
  assert.ok(g.calls.length > 0 && g.calls.every(call => call === subjectId));
});

test('prepared deletion marker blocks issuance and refresh fail closed', async () => {
  const g = countingGate(subjectId => gate.loginDecision(subjectId));
  const h = await createHarness(g);
  const subjectId = await addSubject('adult');
  const issued = await issue(h.service, subjectId);
  await store.prepare({ subjectId, intentId: randomUUID() });
  await assert.rejects(issue(h.service, subjectId), rejection('AUTH_SESSION_INVALID', 401));
  await assert.rejects(h.service.verify(issued.accessToken), rejection('AUTH_SESSION_INVALID', 401));
  await assert.rejects(h.service.refresh(issued.refreshToken, randomUUID()), rejection('AUTH_SESSION_INVALID', 401));
  assert.equal(await sessionCount(subjectId), 1);
  assert.deepEqual(await refreshRow(issued.refreshToken.split('.')[0]), { used_at: null, replaced_by: null });
  assert.ok(g.calls.length > 0 && g.calls.every(call => call === subjectId));
});

test('prepared deletion marker blocks child session issuance before any session row exists', async () => {
  const g = countingGate(subjectId => gate.loginDecision(subjectId));
  const h = await createHarness(g);
  const { grantId, childId } = await addChildGrant();
  await store.prepare({ subjectId: childId, intentId: randomUUID() });
  await assert.rejects(transaction(db.app, client => h.service.issueChild(client, grantId)),
    rejection('AUTH_SESSION_INVALID', 401));
  assert.equal(await sessionCount(childId), 0);
  assert.ok(g.calls.includes(childId));
});

test('refresh denial precedes replay revocation so no revocation is committed', async () => {
  const g = countingGate(subjectId => gate.loginDecision(subjectId));
  const h = await createHarness(g);
  const subjectId = await addSubject('adult');
  const issued = await issue(h.service, subjectId);
  await h.service.refresh(issued.refreshToken, randomUUID());
  const intentId = randomUUID();
  await store.prepare({ subjectId, intentId });
  await store.markAccepted({ subjectId, intentId });
  // Without the gate this branch revokes the session as a replay; the gate must run first and roll back.
  await assert.rejects(h.service.refresh(issued.refreshToken, randomUUID()), rejection('AUTH_SESSION_INVALID', 401));
  const session = (await db.app.query('SELECT revoked_at,revoke_reason FROM siyue.auth_sessions WHERE id=$1',
    [issued.session.sessionId])).rows[0];
  assert.equal(session.revoked_at, null);
  assert.equal(session.revoke_reason, null);
});

test('unreachable and unreadable ledgers fail closed with temporary semantics', async () => {
  const g = countingGate(subjectId => gate.loginDecision(subjectId));
  const h = await createHarness(g);
  const subjectId = await addSubject('adult');
  const issued = await issue(h.service, subjectId);

  try {
    await ledgerAdmin.query(`REVOKE USAGE ON SCHEMA ledger FROM ${LEDGER_ROLE}`);
    await assert.rejects(issue(h.service, subjectId), rejection('AUTH_TEMPORARILY_UNAVAILABLE', 503));
    await assert.rejects(h.service.verify(issued.accessToken), rejection('AUTH_TEMPORARILY_UNAVAILABLE', 503));
    await assert.rejects(h.service.refresh(issued.refreshToken, randomUUID()),
      rejection('AUTH_TEMPORARILY_UNAVAILABLE', 503));
  } finally {
    await ledgerAdmin.query(`GRANT USAGE ON SCHEMA ledger TO ${LEDGER_ROLE}`);
  }
  // Recovery is visible again and none of the failed paths wrote anything.
  assert.equal(await sessionCount(subjectId), 1);
  assert.deepEqual(await h.service.verify(issued.accessToken), issued.session);
  assert.deepEqual(await refreshRow(issued.refreshToken.split('.')[0]), { used_at: null, replaced_by: null });

  try {
    await ledgerAdmin.query("UPDATE ledger.metadata SET format='siyue-deletion-ledger-v0'");
    await assert.rejects(issue(h.service, subjectId), rejection('AUTH_TEMPORARILY_UNAVAILABLE', 503));
  } finally {
    await ledgerAdmin.query('UPDATE ledger.metadata SET format=$1', [DELETION_LEDGER_FORMAT]);
  }
  assert.equal(await sessionCount(subjectId), 1);
  assert.deepEqual(await h.service.verify(issued.accessToken), issued.session);
});

test('a throwing or malformed gate answer fails closed as temporary unavailable', async () => {
  const cases = [
    { async loginDecision() { throw new Error('ledger_transport_closed'); } },
    { async loginDecision() {} },
    { async loginDecision() { return {}; } },
    { async loginDecision() { return { allow: true, reason: 'not_ledger_clear' }; } },
    { async loginDecision() { return { allow: false, reason: 'unexpected_answer' }; } },
  ];
  for (const loginGate of cases) {
    const h = await createHarness(loginGate);
    const subjectId = await addSubject('adult');
    await assert.rejects(issue(h.service, subjectId), rejection('AUTH_TEMPORARILY_UNAVAILABLE', 503));
    assert.equal(await sessionCount(subjectId), 0);
  }
});

test('a gate that is absent preserves the previous session behavior', async () => {
  const subjectId = await addSubject('adult');
  const intentId = randomUUID();
  await store.prepare({ subjectId, intentId });
  await store.markAccepted({ subjectId, intentId });
  const h = await createHarness(undefined);
  const issued = await issue(h.service, subjectId);
  assert.deepEqual(await h.service.verify(issued.accessToken), issued.session);
  const rotated = await h.service.refresh(issued.refreshToken, randomUUID());
  assert.deepEqual(await h.service.verify(rotated.accessToken), rotated.session);
  assert.equal(await sessionCount(subjectId), 1);
});

