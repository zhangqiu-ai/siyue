// Runtime wiring E2E for account deletion recovery (design 13.4) against the real server process.
//
// What this file proves, and only this: `apps/server/dist/index.js` starts -- or refuses to start -- with
// its own environment, while the restorable main database and the independent deletion ledger live in two
// separately provisioned databases of one isolated temporary PostgreSQL cluster. The process boundary is
// the subject here, so the assertions are about what the real entry point does: readiness, the session
// route, one withdrawal of readiness and account authority while a process is already serving, and one
// ledger outage. The deletion kernels themselves have in-process tests under
// apps/server/tests/integration/account-deletion-*.test.mjs and are not re-derived here.
//
// Isolation: a fresh cluster built by the shared fixture on a short /tmp socket path. No database URL,
// workspace .env, real account database or network service is read or contacted; every HTTP call is
// loopback. All data is synthetic: fixture-minted roles and passwords, an ES256 key pair plus symmetric
// keys generated in this process, random subject/intent UUIDs, and only the rows this file inserts.
// Between cases the file restores the ledger's empty state (entries truncated, watermark back to 0) so
// each case starts from one known ledger state; the ledger instance identity itself is never replaced.
// Each case resets the main subjects and fence plus ledger entries, so it can run independently in
// this file's single worker while reusing one short-lived PostgreSQL cluster.
//
// Boundaries this file does not claim:
//   * A refused startup is observed as "the process exited 1 and never listened"; the internal refusal
//     reason (deletion_prepared_unresolved / deletion_recovery_incomplete) is deliberately not part of the
//     process output, so reason codes remain with the in-process kernel tests. A refusal can still leave
//     anti-revival writes committed (the restored session is revoked) while no fence gets certified.
//   * The ledger outage is simulated by revoking the ledger role's CONNECT privilege and terminating its
//     backends, so the main database keeps serving and the 503 is attributable to the ledger alone.
import { test, expect } from 'playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startPostgresFixture } from '../../apps/server/tests/integration/postgres-fixture.mjs';
import { createAuthFixture } from '../../apps/server/tests/integration/auth-fixture.mjs';
import { createDeletionLedgerStore } from '../../apps/server/dist/account-deletion-ledger/index.js';
import { transaction } from '../../apps/server/dist/adapters/postgres/database.js';
import { RecoveryCipher } from '../../apps/server/dist/adapters/crypto/auth-crypto.js';
import { createAppleRevocationPostgresStore } from '../../apps/server/dist/identities/apple/revocation-postgres.js';

const LEDGER_DATABASE = 'siyue_deletion_ledger';
const LEDGER_ROLE = 'siyue_deletion_ledger_app';
const SERVER_ENTRY = fileURLToPath(new URL('../../apps/server/dist/index.js', import.meta.url));
const STARTUP_TIMEOUT_MS = 25_000;
const POSTGRES_BIN = () => process.env.SIYUE_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';

let db, auth, ledger, ledgerAdmin, secretsDirectory, baseEnv, encryptionKey, appleConfigFile;

// The ledger store runs as the ledger's own runtime role against its own database: the fixture's
// connection string carries the cluster's Unix socket, so no TCP port or password is involved.
const ledgerStore = () => createDeletionLedgerStore(ledger, { database: LEDGER_DATABASE, environment: 'test' });

/** One-time provisioning of the second, independent database, exactly as an operator would run it. */
async function provisionLedger() {
  const psql = join(POSTGRES_BIN(), 'psql');
  if (!existsSync(psql)) throw Error('PostgreSQL binaries missing; set SIYUE_TEST_POSTGRES_BIN');
  const socket = (await db.admin.query("SELECT current_setting('unix_socket_directories') AS socket")).rows[0].socket;
  execFileSync(psql, ['-h', socket, '-U', 'siyue_test_admin', '-d', 'postgres', '-f',
    fileURLToPath(new URL('../../apps/server/provision/deletion-ledger.sql', import.meta.url))], {
    env: { ...process.env, LC_ALL: 'C', SIYUE_DELETION_LEDGER_DATABASE: LEDGER_DATABASE,
      SIYUE_DELETION_LEDGER_ENVIRONMENT: 'test', SIYUE_DELETION_LEDGER_APP_PASSWORD: randomBytes(32).toString('hex') },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

/**
 * Return the ledger to the state a just-provisioned instance has: its entries and watermark cleared so
 * one case's marker cannot block the next, while the instance identity and format stay untouched.
 */
async function resetLedgerEntries() {
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  await ledgerAdmin.query('UPDATE ledger.metadata SET seq=0, entry_count=0 WHERE singleton');
  await ledgerAdmin.query(`GRANT USAGE ON SCHEMA ledger TO ${LEDGER_ROLE}`);
}

/** Start the real entry point on loopback with a free port and this file's synthetic environment. */
async function launch(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...baseEnv, SIYUE_SERVER_PORT: String(port), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise(resolve => child.once('close', code => resolve(code)));
  return {
    proc: child, closed, port, output: () => output,
    url: path => `http://127.0.0.1:${port}${path}`,
    async stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; },
  };
}

const probe = async (url, init) => { try { return await fetch(url, init); } catch { return null; } };
const sessionRequest = (child, accessToken) =>
  probe(child.url('/v1/account/session'), { headers: { authorization: `Bearer ${accessToken}` } });

/** Ready, or the process exited, or nothing answered within the bound. */
async function waitForReady(child, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.proc.exitCode !== null) return { exited: true, code: child.proc.exitCode };
    const response = await probe(child.url('/health/ready'));
    if (response) return { exited: false, status: response.status };
    await delay(100);
  }
  return { exited: false, status: null };
}

const exitWithin = (child, timeoutMs = 30_000) => Promise.race([child.closed, delay(timeoutMs, 'timeout')]);

test.describe('deletion recovery runtime wiring', () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    db = await startPostgresFixture();
    await provisionLedger();
    ledger = db.poolFor(LEDGER_ROLE, LEDGER_DATABASE);
    ledgerAdmin = db.poolFor('siyue_test_admin', LEDGER_DATABASE);
    auth = await createAuthFixture(db);
    secretsDirectory = mkdtempSync(join(tmpdir(), 'siyue-ledger-e2e-'));
    const secretFile = (name, body) => {
      const path = join(secretsDirectory, name);
      writeFileSync(path, body, { mode: 0o600 });
      return path;
    };
    encryptionKey = randomBytes(32);
    appleConfigFile = secretFile('apple-config.json', JSON.stringify({
      teamId: 'TEAMID1234', keyId: 'APPLEKEY12', clientId: 'app.siyue.mobile',
      namespace: 'app.siyue.mobile', privateKeyFile: secretFile('apple-private.pem', auth.config.privateKey),
    }));
    baseEnv = {
      PATH: process.env.PATH, NODE_ENV: 'test', SIYUE_ENVIRONMENT: 'test', SIYUE_DATABASE_NAME: 'siyue_test',
      SIYUE_DATABASE_URL: db.app.options.connectionString,
      SIYUE_DELETION_LEDGER_URL: ledger.options.connectionString,
      SIYUE_DELETION_LEDGER_DATABASE: LEDGER_DATABASE,
      SIYUE_DELETION_LEDGER_ENVIRONMENT: 'test',
      SIYUE_JWT_ISSUER: auth.config.issuer, SIYUE_JWT_AUDIENCE: auth.config.audience, SIYUE_JWT_KEY_ID: auth.config.kid,
      SIYUE_JWT_PRIVATE_KEY_FILE: secretFile('private.pem', auth.config.privateKey),
      SIYUE_JWT_VERIFY_KEYS_FILE: secretFile('public.json', JSON.stringify(auth.config.jwks)),
      SIYUE_SECRET_ENCRYPTION_KEY_FILE: secretFile('encryption.json',
        JSON.stringify({ activeVersion: 'test-v1', keys: { 'test-v1': encryptionKey.toString('base64') } })),
      SIYUE_CHALLENGE_PEPPER_FILE: secretFile('pepper', randomBytes(32).toString('base64')),
    };
  });

  test.afterAll(async () => {
    await db?.stop();
    if (secretsDirectory) rmSync(secretsDirectory, { recursive: true, force: true });
  });

  test.beforeEach(async () => {
    await db.admin.query('TRUNCATE siyue.subjects CASCADE');
    await db.admin.query('DELETE FROM siyue.deletion_ledger_fence');
    await resetLedgerEntries();
  });

  test('fresh main database and fresh ledger: the runtime binds the fence, becomes ready and serves the session route', async () => {
    // A fresh restore target: migration seeds no fence row, so recovery has to prove the ledger first.
    expect((await db.admin.query('SELECT count(*)::int AS rows FROM siyue.deletion_ledger_fence')).rows[0].rows).toBe(0);
    const child = await launch();
    try {
      expect(await waitForReady(child), child.output()).toEqual({ exited: false, status: 200 });
      const tokens = await auth.issue();
      const response = await sessionRequest(child, tokens.accessToken);
      expect(response?.status).toBe(200);
      expect(await response.json()).toEqual(tokens.session);
      // The same auth surface stays closed without provider configuration, and a token that was never
      // issued is refused rather than reported as a temporary failure.
      expect((await probe(child.url('/v1/auth/providers')))?.status).toBe(200);
      expect((await sessionRequest(child, 'synthetic.invalid.token'))?.status).toBe(401);
      // Readiness is only reported after this main database recorded which ledger instance it replayed.
      const fence = (await db.admin.query(
        'SELECT ledger_instance_id, applied_sequence::text AS sequence FROM siyue.deletion_ledger_fence WHERE singleton')).rows[0];
      const highWater = await ledgerStore().highWater();
      expect(fence.ledger_instance_id).toBe(highWater.instanceId);
      expect(fence.sequence).toBe(highWater.sequence.toString());
      // Configuration secrets stay in the environment, never in the process output.
      expect(child.output()).not.toContain(tokens.accessToken);
      expect(child.output()).not.toContain(baseEnv.SIYUE_DELETION_LEDGER_URL);
    } finally { await child.stop(); }
  });

  test('ledger outage maps the session route to 503 while the main database keeps serving', async () => {
    const child = await launch();
    try {
      expect(await waitForReady(child), child.output()).toEqual({ exited: false, status: 200 });
      const tokens = await auth.issue();
      expect((await sessionRequest(child, tokens.accessToken))?.status).toBe(200);
      await db.admin.query(`REVOKE CONNECT ON DATABASE ${LEDGER_DATABASE} FROM ${LEDGER_ROLE}`);
      await db.admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [LEDGER_DATABASE]);
      try {
        // The per-login ledger read cannot answer, so the session read is retryable rather than a rejection.
        const unavailable = await sessionRequest(child, tokens.accessToken);
        expect(unavailable?.status).toBe(503);
        expect((await unavailable.json()).error).toBe('temporarily_unavailable');
        expect((await probe(child.url('/health/live')))?.status).toBe(200);
        expect((await probe(child.url('/health/ready')))?.status).toBe(503);
      } finally {
        await db.admin.query(`GRANT CONNECT ON DATABASE ${LEDGER_DATABASE} TO ${LEDGER_ROLE}`);
      }
    } finally { await child.stop(); }
  });

  test('a new accepted marker while the process is running is replayed and advances readiness', async () => {
    const child = await launch();
    try {
      expect(await waitForReady(child), child.output()).toEqual({ exited: false, status: 200 });
      const tokens = await auth.issue();
      const subjectId = tokens.session.subjectId, intentId = randomUUID();
      await ledgerStore().prepare({ subjectId, intentId });
      await transaction(db.app, async client => {
        await client.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1", [subjectId]);
        await client.query(`INSERT INTO siyue.account_deletion_jobs
          (id,subject_id,state,requested_at,local_data_deleted,receipt_secret_hash,receipt_expires_at)
          VALUES($1,$2,'accepted',now(),false,$3,now()+interval '1 hour')`,
          [intentId, subjectId, randomBytes(32).toString('hex')]);
      });
      await ledgerStore().markAccepted({ subjectId, intentId });
      expect((await probe(child.url('/health/ready')))?.status).toBe(503);
      await expect.poll(async () => (await probe(child.url('/health/ready')))?.status,
        { timeout: 45_000, intervals: [500] }).toBe(200);
      expect((await sessionRequest(child, tokens.accessToken))?.status).toBe(401);
      const fence = (await db.admin.query(
        'SELECT applied_sequence::text AS sequence FROM siyue.deletion_ledger_fence WHERE singleton')).rows[0];
      expect(fence.sequence).toBe((await ledgerStore().highWater()).sequence.toString());
      await expect.poll(async () => (await db.app.query(
        'SELECT state FROM siyue.account_deletion_jobs WHERE id=$1', [intentId])).rows[0].state,
      { timeout: 10_000, intervals: [250] }).toBe('completed');
    } finally { await child.stop(); }
  });

  test('the real timer skips an unmarked Apple queue row and revokes only a ledger-accepted deletion', async () => {
    const namespace = 'app.siyue.mobile';
    const cipher = new RecoveryCipher('test-v1', new Map([['test-v1', encryptionKey]]));
    const outbox = createAppleRevocationPostgresStore(db.app);
    const seed = async (accepted, availableAt) => {
      const subjectId = randomUUID(), identityId = randomUUID(), deletionId = randomUUID();
      if (accepted) await ledgerStore().prepare({ subjectId, intentId: deletionId });
      await transaction(db.app, async client => {
        await client.query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'adult','deletion_pending')",
          [subjectId]);
        await client.query(`INSERT INTO siyue.external_identities
          (id,subject_id,provider,provider_namespace,provider_subject,client_id,issuer,status)
          VALUES($1,$2,'apple',$3,$4,$3,'https://appleid.apple.com','active')`,
          [identityId, subjectId, namespace, `synthetic-${identityId}`]);
        const sealed = cipher.seal({ refreshToken: `synthetic-refresh-${identityId}` },
          `apple-identity:${identityId}:${namespace}`);
        await client.query('INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext) VALUES($1,$2)',
          [identityId, sealed]);
        await client.query(`INSERT INTO siyue.account_deletion_jobs
          (id,subject_id,state,requested_at,local_data_deleted,provider_revocation_pending,
            receipt_secret_hash,receipt_expires_at)
          VALUES($1,$2,'accepted',now(),false,true,$3,now()+interval '1 hour')`,
          [deletionId, subjectId, randomBytes(32).toString('hex')]);
        await outbox.enqueue(client, { availableAt, expiresAt: new Date(Date.now() + 7 * 86_400_000),
          job: { identityId, providerNamespace: namespace, refreshCiphertext: sealed } });
      });
      if (accepted) await ledgerStore().markAccepted({ subjectId, intentId: deletionId });
      return { subjectId, identityId, deletionId };
    };
    const unmarked = await seed(false, new Date(Date.now() - 1000));
    const accepted = await seed(true, new Date());
    const callsPath = join(secretsDirectory, 'apple-revoke-calls');
    const preload = join(secretsDirectory, 'mock-apple-revoke.mjs');
    writeFileSync(preload, `import { appendFileSync } from 'node:fs';
      globalThis.fetch = async url => {
        if (url !== 'https://appleid.apple.com/auth/revoke') throw Error('unexpected_external_request');
        appendFileSync(${JSON.stringify(callsPath)}, 'called\\n');
        return new Response(null, { status: 200 });
      };`, { mode: 0o600 });
    const child = await launch({ SIYUE_APPLE_ENABLED: 'true', SIYUE_APPLE_CONFIG_FILE: appleConfigFile,
      NODE_OPTIONS: `--import=${preload}` });
    try {
      expect(await waitForReady(child), child.output()).toEqual({ exited: false, status: 200 });
      await expect.poll(async () => (await db.app.query(
        'SELECT state FROM siyue.account_deletion_jobs WHERE id=$1', [accepted.deletionId])).rows[0].state,
      { timeout: 45_000, intervals: [500] }).toBe('completed');
      expect(readFileSync(callsPath, 'utf8').trim().split('\n')).toEqual(['called']);
      const unmarkedJob = (await db.app.query(`SELECT state,local_data_deleted,provider_revocation_pending,
        last_error_code FROM siyue.account_deletion_jobs WHERE id=$1`, [unmarked.deletionId])).rows[0];
      expect(unmarkedJob).toMatchObject({ state: 'accepted', local_data_deleted: false,
        provider_revocation_pending: true, last_error_code: null });
      const unmarkedQueue = (await db.app.query(`SELECT status,refresh_ciphertext,authorization_retry_at
        FROM siyue.apple_revocation_outbox WHERE identity_id=$1`, [unmarked.identityId])).rows[0];
      expect(unmarkedQueue.status).toBe('pending');
      expect(unmarkedQueue.refresh_ciphertext).not.toBeNull();
      expect(unmarkedQueue.authorization_retry_at).not.toBeNull();
    } finally { await child.stop(); }
  });

  test('a prepared marker the main database cannot certify keeps the runtime closed', async () => {
    const subjectId = randomUUID(), intentId = randomUUID();
    await ledgerStore().prepare({ subjectId, intentId });
    const tokens = await auth.issue();
    const child = await launch();
    try {
      expect(await exitWithin(child), child.output()).toBe(1);
      expect(child.output()).toMatch(/startup failed/);
      expect(await probe(child.url('/health/ready'))).toBeNull();
      expect(await sessionRequest(child, tokens.accessToken)).toBeNull();
      expect(child.output()).not.toContain(baseEnv.SIYUE_DELETION_LEDGER_URL);
    } finally {
      await child.stop();
      // Leave the ledger as the fixture found it: a cancelled intent is not a deletion marker for anyone.
      await ledgerStore().cancel({ subjectId, intentId });
    }
  });

  test('a replaced ledger is rejected before prepared reconciliation mutates its marker', async () => {
    const first = await launch();
    try { expect(await waitForReady(first), first.output()).toEqual({ exited: false, status: 200 }); }
    finally { await first.stop(); }
    const originalInstanceId = (await ledgerStore().highWater()).instanceId;
    const subjectId = randomUUID(), intentId = randomUUID();
    await db.app.query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'adult','deletion_pending')",
      [subjectId]);
    await db.app.query(`INSERT INTO siyue.account_deletion_jobs
      (id,subject_id,state,requested_at,local_data_deleted,receipt_secret_hash,receipt_expires_at)
      VALUES($1,$2,'accepted',now(),false,$3,now()+interval '1 hour')`,
      [intentId, subjectId, randomBytes(32).toString('hex')]);
    await ledgerStore().prepare({ subjectId, intentId });
    await ledgerAdmin.query('UPDATE ledger.metadata SET instance_id=$1 WHERE singleton',
      [randomUUID()]);
    try {
      const second = await launch();
      try {
        expect(await exitWithin(second), second.output()).toBe(1);
        expect((await ledgerStore().lookup(subjectId)).status).toBe('prepared');
        expect(await probe(second.url('/health/ready'))).toBeNull();
      } finally { await second.stop(); }
    } finally {
      await ledgerAdmin.query('UPDATE ledger.metadata SET instance_id=$1 WHERE singleton',
        [originalInstanceId]);
    }
  });

  test('an accepted marker over a restored main state refuses startup instead of reviving the account', async () => {
    const subjectId = randomUUID(), intentId = randomUUID();
    await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [subjectId]);
    const tokens = await transaction(db.app, client => auth.service.issue(client, subjectId, randomUUID(), 'email'));
    // The ledger holds the terminal marker -- it is kept outside the database that was restored -- while the
    // restored main database still shows the live account and carries no deletion job for it. That state
    // cannot be reconciled with the marker, so no start may open login on the strength of it.
    await ledgerStore().prepare({ subjectId, intentId });
    await ledgerStore().markAccepted({ subjectId, intentId });
    expect((await db.app.query('SELECT status FROM siyue.subjects WHERE id=$1', [subjectId])).rows[0].status).toBe('active');
    const child = await launch();
    try {
      expect(await exitWithin(child), child.output()).toBe(1);
      expect(child.output()).toMatch(/startup failed/);
      expect(await probe(child.url('/health/ready'))).toBeNull();
      expect(await sessionRequest(child, tokens.accessToken)).toBeNull();
      // The restored session cannot outlive the deletion even though the process never opened.
      const row = (await db.app.query(
        'SELECT p.status, s.revoked_at FROM siyue.subjects p JOIN siyue.auth_sessions s ON s.subject_id=p.id WHERE p.id=$1',
        [subjectId])).rows[0];
      expect(row.status).not.toBe('active');
      expect(row.revoked_at).not.toBeNull();
      // A refused start certifies nothing: the fence is either absent or still behind the ledger point, so
      // the next start has to prove the recovery again instead of finding a bound fence.
      const fence = (await db.admin.query(
        'SELECT applied_sequence::text AS sequence FROM siyue.deletion_ledger_fence WHERE singleton')).rows[0];
      const ledgerPoint = await ledgerStore().highWater();
      expect(fence === undefined || BigInt(fence.sequence) < ledgerPoint.sequence).toBe(true);
      expect(child.output()).not.toContain(baseEnv.SIYUE_DELETION_LEDGER_URL);
    } finally { await child.stop(); }
  });

  test('a restored family still owned by a deleting account prevents the real server from opening', async () => {
    const subjectId=randomUUID(), intentId=randomUUID(), familyId=randomUUID();
    await db.app.query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'adult','deletion_pending')",
      [subjectId]);
    await db.app.query(`INSERT INTO siyue.account_deletion_jobs
      (id,subject_id,state,requested_at,local_data_deleted,receipt_secret_hash,receipt_expires_at)
      VALUES($1,$2,'accepted',now(),false,$3,now()+interval '1 hour')`,
    [intentId,subjectId,randomBytes(32).toString('hex')]);
    await db.app.query("INSERT INTO siyue.families(id,owner_subject_id,status) VALUES($1,$2,'active')",
      [familyId,subjectId]);
    await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner')",
      [familyId,subjectId]);
    await ledgerStore().prepare({subjectId,intentId});
    await ledgerStore().markAccepted({subjectId,intentId});
    const child=await launch();
    try {
      expect(await exitWithin(child),child.output()).toBe(1);
      expect(await probe(child.url('/health/ready'))).toBeNull();
      expect((await db.admin.query('SELECT count(*)::int AS n FROM siyue.deletion_ledger_fence')).rows[0].n).toBe(0);
      expect((await db.app.query('SELECT owner_subject_id FROM siyue.families WHERE id=$1',
        [familyId])).rows[0].owner_subject_id).toBe(subjectId);
    } finally {await child.stop();}
  });

  test('a recorded frozen-family review lets unrelated accounts use the real server while deletion stays pending', async () => {
    const owner=await auth.issue(),member=await auth.issue();
    const familyId=randomUUID(),intentId=randomUUID(),reviewId=randomUUID();
    await ledgerStore().prepare({subjectId:owner.session.subjectId,intentId});
    await transaction(db.app,async client=>{
      await client.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",
        [owner.session.subjectId]);
      await client.query(`INSERT INTO siyue.account_deletion_jobs
        (id,subject_id,state,requested_at,local_data_deleted,receipt_secret_hash,receipt_expires_at)
        VALUES($1,$2,'accepted',now(),false,$3,now()+interval '1 hour')`,
      [intentId,owner.session.subjectId,randomBytes(32).toString('hex')]);
      await client.query("INSERT INTO siyue.families(id,owner_subject_id,status) VALUES($1,$2,'frozen')",
        [familyId,owner.session.subjectId]);
      await client.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",
        [familyId,owner.session.subjectId,member.session.subjectId]);
      await client.query(`INSERT INTO siyue.account_deletion_family_reviews
        (id,deletion_id,family_id,deleting_subject_id,state,opened_at)
        VALUES($1,$2,$3,$4,'pending',now())`,
      [reviewId,intentId,familyId,owner.session.subjectId]);
    });
    await ledgerStore().markAccepted({subjectId:owner.session.subjectId,intentId});
    const child=await launch();
    try {
      expect(await waitForReady(child),child.output()).toEqual({exited:false,status:200});
      expect((await sessionRequest(child,member.accessToken))?.status).toBe(200);
      expect((await sessionRequest(child,owner.accessToken))?.status).toBe(401);
      const families=await probe(child.url('/v1/families'),
        {headers:{authorization:`Bearer ${member.accessToken}`}});
      expect(families?.status).toBe(200);
      expect(JSON.stringify(await families.json())).not.toContain(familyId);
      expect((await db.app.query('SELECT state,local_data_deleted FROM siyue.account_deletion_jobs WHERE id=$1',
        [intentId])).rows[0]).toMatchObject({local_data_deleted:false});
      expect((await db.app.query('SELECT state FROM siyue.account_deletion_family_reviews WHERE id=$1',
        [reviewId])).rows[0].state).toBe('pending');
    } finally {await child.stop();}
  });

  test('a running process stops claiming readiness and serving account authority when a pending deletion still owns an active family, until the family is repaired', async () => {
    const subjectId = randomUUID(), replacementId = randomUUID(), intentId = randomUUID(), familyId = randomUUID();
    // Read as two points that must stay equal: the main database's fence row and the ledger's own
    // high-water mark. They are equal before and after the tampering below, which is what makes this
    // case about the family state rather than about a restore or a ledger outage.
    const fencePoint = async () => {
      const row = (await db.admin.query(`SELECT ledger_instance_id, ledger_format, applied_sequence::text AS sequence
        FROM siyue.deletion_ledger_fence WHERE singleton`)).rows[0];
      return { instance: row.ledger_instance_id, format: row.ledger_format, sequence: row.sequence };
    };
    const ledgerPoint = async () => {
      const point = await ledgerStore().highWater();
      return { instance: point.instanceId, format: point.format, sequence: point.sequence.toString() };
    };
    const child = await launch();
    try {
      // Baseline: the process is serving, the fence mirrors the ledger, and one unrelated active adult
      // holds a session that this route already answered. The withdrawal below therefore has to come
      // from the running process itself, not from a credential that had never been valid.
      expect(await waitForReady(child), child.output()).toEqual({ exited: false, status: 200 });
      expect(await fencePoint()).toEqual(await ledgerPoint());
      const bystander = await auth.issue();
      expect((await sessionRequest(child, bystander.accessToken))?.status).toBe(200);

      // Only the restorable main database changes, and only through rows this file inserts: the ledger
      // receives no marker and the database stays reachable. What is left behind is exactly the shape
      // startup recovery refuses -- a deleting adult that still owns an active family and holds its
      // active membership -- but no restart happens here, so nothing but the live process can notice.
      await transaction(db.app, async client => {
        await client.query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'adult','deletion_pending')",
          [subjectId]);
        await client.query(`INSERT INTO siyue.account_deletion_jobs
          (id,subject_id,state,requested_at,local_data_deleted,receipt_secret_hash,receipt_expires_at)
          VALUES($1,$2,'accepted',now(),false,$3,now()+interval '1 hour')`,
        [intentId, subjectId, randomBytes(32).toString('hex')]);
        await client.query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'adult','active')",
          [replacementId]);
        await client.query("INSERT INTO siyue.families(id,owner_subject_id,status) VALUES($1,$2,'active')",
          [familyId, subjectId]);
        await client.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner')",
          [familyId, subjectId]);
        await client.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
          [familyId, replacementId]);
      });
      expect(await fencePoint()).toEqual(await ledgerPoint());
      // The ledger holds no marker for this subject, so a 503 below can only be attributable to the
      // family state the main database now contradicts.
      expect(await ledgerStore().lookup(subjectId)).toBeNull();

      // Readiness and account authority are two promises of one service. While it cannot certify the
      // family state it must stop making both, so a single bounded wait requires the same observation to
      // show /health/ready withdrawn and the bystander's session answered with 503 rather than a payload.
      await expect.poll(async () => ({ ready: (await probe(child.url('/health/ready')))?.status,
        session: (await sessionRequest(child, bystander.accessToken))?.status }),
      { timeout: 45_000, intervals: [500] }).toEqual({ ready: 503, session: 503 });
      // Liveness is a different promise: the process is still up, it is authority it withholds.
      expect((await probe(child.url('/health/live')))?.status).toBe(200);

      // Repair the family the way deletion acceptance would: the surviving adult takes ownership and the
      // deleting adult keeps no active membership. No other row of either account is touched.
      await transaction(db.app, async client => {
        await client.query(`UPDATE siyue.family_memberships SET active=false, role='member', version=version+1
          WHERE family_id=$1 AND subject_id=$2 AND active AND role='owner'`, [familyId, subjectId]);
        await client.query(`UPDATE siyue.family_memberships SET role='owner', version=version+1
          WHERE family_id=$1 AND subject_id=$2 AND active AND role<>'owner'`, [familyId, replacementId]);
        await client.query(`UPDATE siyue.families SET owner_subject_id=$3, version=version+1
          WHERE id=$1 AND owner_subject_id=$2 AND status='active'`, [familyId, subjectId, replacementId]);
      });
      await expect.poll(async () => ({ ready: (await probe(child.url('/health/ready')))?.status,
        session: (await sessionRequest(child, bystander.accessToken))?.status }),
      { timeout: 45_000, intervals: [500] }).toEqual({ ready: 200, session: 200 });
      // Recovered means the same session read that was withdrawn, not a new one.
      expect(await (await sessionRequest(child, bystander.accessToken)).json()).toEqual(bystander.session);
    } finally { await child.stop(); }
  });

  test('an accepted marker with a provable committed deletion replays before login opens', async () => {
    const subjectId = randomUUID(), intentId = randomUUID();
    const unmarkedSubjectId = randomUUID(), unmarkedJobId = randomUUID();
    await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [subjectId]);
    const tokens = await transaction(db.app, client => auth.service.issue(client, subjectId, randomUUID(), 'email'));
    await ledgerStore().prepare({ subjectId, intentId });
    // The restored backup carries the committed deletion too: the subject is pending and its job row holds the
    // same intent, which is the one shape the startup coordinator accepts as proved cleanup work.
    await transaction(db.app, async client => {
      await client.query("UPDATE siyue.subjects SET status='deletion_pending', updated_at=now() WHERE id=$1", [subjectId]);
      await client.query(`INSERT INTO siyue.account_deletion_jobs
        (id,subject_id,state,requested_at,local_data_deleted,receipt_secret_hash,receipt_expires_at)
        VALUES($1,$2,'accepted',now(),false,$3,now()+interval '1 hour')`,
      [intentId, subjectId, randomBytes(32).toString('hex')]);
    });
    await ledgerStore().markAccepted({ subjectId, intentId });
    // A main-database-only job is the unsafe shape a restored backup might contain. The same real
    // timer may scan it, but its missing independent marker must prevent any cleanup.
    await db.app.query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'adult','deletion_pending')",
      [unmarkedSubjectId]);
    await db.app.query(`INSERT INTO siyue.account_deletion_jobs
      (id,subject_id,state,requested_at,local_data_deleted,receipt_secret_hash,receipt_expires_at)
      VALUES($1,$2,'accepted',now(),false,$3,now()+interval '1 hour')`,
      [unmarkedJobId, unmarkedSubjectId, randomBytes(32).toString('hex')]);
    const child = await launch();
    try {
      // Letting a deleted account back in is the failure this whole path exists to prevent.
      expect(await waitForReady(child), child.output()).toEqual({ exited: false, status: 200 });
      const row = (await db.app.query(
        'SELECT p.status, s.revoked_at FROM siyue.subjects p JOIN siyue.auth_sessions s ON s.subject_id=p.id WHERE p.id=$1',
        [subjectId])).rows[0];
      expect(row.status).not.toBe('active');
      expect(row.revoked_at).not.toBeNull();
      expect((await sessionRequest(child, tokens.accessToken))?.status).toBe(401);
      // Login opened only because this run bound the fence to the ledger point it replayed.
      const fence = (await db.admin.query(
        'SELECT applied_sequence::text AS sequence FROM siyue.deletion_ledger_fence WHERE singleton')).rows[0];
      expect(fence.sequence).toBe((await ledgerStore().highWater()).sequence.toString());
      // The real process schedules the ledger-guarded cleanup after startup. This assertion waits for
      // its 30-second cadence, rather than calling the kernel from the test process.
      await expect.poll(async () => (await db.app.query(
        'SELECT state,local_data_deleted FROM siyue.account_deletion_jobs WHERE id=$1',
        [intentId])).rows[0], { timeout: 45_000, intervals: [500] })
        .toMatchObject({ state: 'completed', local_data_deleted: true });
      expect((await db.app.query('SELECT status FROM siyue.subjects WHERE id=$1',
        [subjectId])).rows[0].status).toBe('deleted');
      const unmarked = (await db.app.query(`SELECT p.status,j.state,j.local_data_deleted
        FROM siyue.subjects p JOIN siyue.account_deletion_jobs j ON j.subject_id=p.id
        WHERE p.id=$1`, [unmarkedSubjectId])).rows[0];
      expect(unmarked).toMatchObject({ status: 'deletion_pending', state: 'accepted',
        local_data_deleted: false });
    } finally { await child.stop(); }
  });
});
