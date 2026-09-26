import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { migrateDatabase, readMigrations } from '../../dist/adapters/postgres/migrate.js';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { RecoveryCipher } from '../../dist/adapters/crypto/auth-crypto.js';
import { createAppleRevocationPostgresStore } from '../../dist/identities/apple/revocation-postgres.js';
import { createAppleRevocationOutbox } from '../../dist/identities/apple/revocation-outbox.js';

// Durable Apple revocation outbox (migration 0016) against an isolated temporary PostgreSQL cluster
// only: the fixture always builds a fresh cluster on a short Unix socket and never reads a database
// URL or the workspace .env. Every subject, identity, credential seal, error code and receipt below
// is synthetic; no Apple endpoint, mail transport, route or worker is reached, and the provider half
// of every case is a local stand-in. Nothing here claims a real account was revoked at Apple.
const day = 86_400_000;
const namespace = 'app.siyue.mobile';
const refresh = 'synthetic-apple-refresh-token';
const table = 'apple_revocation_outbox';
const start = Date.parse('2026-09-24T00:00:00Z');
// The complete fixed column contract: no plaintext provider token, email, display name or provider
// subject column may be added to this table. 0019 appends exactly one nullable instant, which the claim
// reads as a filter and clears while leasing.
const columns = ['id', 'identity_id', 'provider_namespace', 'refresh_ciphertext', 'status', 'attempts',
  'available_at', 'expires_at', 'lease_id', 'lease_until', 'last_error_code', 'created_at', 'settled_at',
  'retain_until', 'authorization_retry_at'];
const cipher = new RecoveryCipher('test', new Map([['test', randomBytes(32)]]));
let db;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => { await db.admin.query('TRUNCATE siyue.subjects CASCADE'); });
after(async () => { await db?.stop(); });

/** Tolerates both `rows(sql, a, b)` and `rows(sql, [a, b])` call styles. */
const bindings = args => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
const rows = (sql, ...args) => db.app.query(sql, bindings(args)).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
const total = () => count(`SELECT count(*)::int AS n FROM siyue.${table}`);
const jobRow = identityId => rows(`SELECT * FROM siyue.${table} WHERE identity_id=$1`, identityId).then(result => result[0]);
/** Asserts the database refused a statement with one SQLSTATE, quoting the constraint it broke. */
const failure = async (query, code, label) => {
  const error = await query.then(() => null, thrown => thrown);
  assert.equal(error?.code, code, `${label ?? ''} ${error?.constraint ?? error?.message}`.trim());
};
const tableColumns = async () => (await rows(`SELECT column_name FROM information_schema.columns
  WHERE table_schema='siyue' AND table_name=$1 ORDER BY ordinal_position`, [table])).map(entry => entry.column_name);
const indexesOf = () => rows(`SELECT indexname FROM pg_indexes WHERE schemaname='siyue' AND tablename=$1 ORDER BY indexname`, [table])
  .then(entries => entries.map(entry => entry.indexname));
/** The credential the Apple identity store seals: the revocation AAD is the identity id plus the
 * provider namespace, so a seal is only openable by the job that names exactly those two. */
const sealOf = (identityId, providerNamespace = namespace, token = refresh) =>
  cipher.seal({ refreshToken: token }, 'apple-identity:' + identityId + ':' + providerNamespace);
const addSubject = async () => db.app
  .query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult') RETURNING id", [randomUUID()])
  .then(result => result.rows[0].id);
/** One adult subject with its own Apple identity and, unless stripped, its sealed credential. */
const addIdentity = async ({ subjectId, status = 'active', credential = true, sealed } = {}) => {
  const subject = subjectId ?? await addSubject();
  const identityId = randomUUID();
  await db.app.query(`INSERT INTO siyue.external_identities(id,subject_id,provider,provider_namespace,
      provider_subject,client_id,issuer,status)
    VALUES($1,$2,'apple',$3,$4,$5,'https://appleid.apple.com',$6)`,
  [identityId, subject, namespace, `synthetic-apple-subject-${identityId.slice(0, 8)}`, namespace, status]);
  if (credential) await db.app.query('INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext) VALUES($1,$2)',
    [identityId, sealed ?? sealOf(identityId)]);
  return { subjectId: subject, identityId };
};
/** Synthetic clock shared by the store, the outbox and the assertions, so no test depends on wall time. */
function fixture({ retentionMs } = {}) {
  let time = start;
  const clock = () => new Date(time);
  const store = createAppleRevocationPostgresStore(db.app, { clock, ...retentionMs === undefined ? {} : { retentionMs } });
  return { store, clock, at: clock, advance: milliseconds => { time += milliseconds; } };
}
/** Queues one revocation through the caller's transaction, exactly as the deletion path does. */
const enqueue = (store, identityId, { availableAt = new Date(start), expiresAt = new Date(start + 7 * day),
  providerNamespace = namespace, refreshCiphertext } = {}) =>
  transaction(db.app, client => store.enqueue(client, { availableAt, expiresAt,
    job: { identityId, providerNamespace, refreshCiphertext: refreshCiphertext ?? sealOf(identityId, providerNamespace) } }));
/** Inserts a row with every documented column present, so one override names one broken constraint. */
const insertRow = async (overrides = {}) => {
  const identityId = Object.hasOwn(overrides, 'identity_id') ? overrides.identity_id : (await addIdentity()).identityId;
  const availableAt = new Date(start);
  const row = { id: randomUUID(), identity_id: identityId, provider_namespace: namespace,
    refresh_ciphertext: sealOf(identityId), status: 'pending', attempts: 0, available_at: availableAt,
    expires_at: new Date(start + day), lease_id: null, lease_until: null, last_error_code: null,
    created_at: availableAt, settled_at: null, retain_until: null, authorization_retry_at: null,
    ...overrides, identity_id: identityId };
  await db.app.query(`INSERT INTO siyue.${table}(id,identity_id,provider_namespace,refresh_ciphertext,status,
      attempts,available_at,expires_at,lease_id,lease_until,last_error_code,created_at,settled_at,retain_until,
      authorization_retry_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
  [row.id, row.identity_id, row.provider_namespace, row.refresh_ciphertext, row.status, row.attempts,
    row.available_at, row.expires_at, row.lease_id, row.lease_until, row.last_error_code, row.created_at,
    row.settled_at, row.retain_until, row.authorization_retry_at]);
  return row;
};

test('0016 upgrades 0015 in place, adds exactly one table and re-runs idempotently', async () => {
  // Fresh head: the checked-in manifest applied this migration as siyue_owner.
  assert.deepEqual(await tableColumns(), columns);
  const [owner] = await rows(`SELECT relowner='siyue_owner'::regrole AS owned FROM pg_class
    WHERE relnamespace='siyue'::regnamespace AND relname=$1`, [table]);
  assert.equal(owner.owned, true, 'the migrator owns the new table');
  assert.deepEqual((await rows(`SELECT version FROM siyue.schema_migrations WHERE version LIKE '0016\\_%'`))
    .map(entry => entry.version), ['0016_apple_revocation_outbox.sql']);
  // The identity link is a real reference that is not allowed to cascade: a still-queued revocation
  // must not disappear because the identity row it names is deleted.
  const [link] = await rows(`SELECT confrelid='siyue.external_identities'::regclass AS target, confdeltype, condeferrable
    FROM pg_constraint WHERE conname='apple_revocation_outbox_identity_id_fkey'`);
  assert.deepEqual([link.target, link.confdeltype, link.condeferrable], [true, 'a', false]);
  // 0019 appends one nullable instant to the same table rather than a table of its own: the claim reads it
  // as a filter and clears it while leasing, so the column needs no default, no index and no constraint on
  // top of the column contract, and the runtime role's table-level grant already covers it.
  assert.deepEqual((await rows(`SELECT version FROM siyue.schema_migrations WHERE version LIKE '0019\\_%'`))
    .map(entry => entry.version), ['0019_apple_revocation_authorization_retry.sql']);
  assert.deepEqual(await rows(`SELECT data_type,is_nullable,column_default FROM information_schema.columns
    WHERE table_schema='siyue' AND table_name=$1 AND column_name='authorization_retry_at'`, [table]),
  [{ data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null }]);
  assert.equal((await rows(`SELECT has_column_privilege('siyue_app',$1,'authorization_retry_at','UPDATE') AS ok`,
    [`siyue.${table}`]))[0].ok, true, 'the additive column inherits the table grant');
  // Re-running the migrator against the same manifest changes nothing.
  assert.equal(await migrateDatabase(db.migrator, db.identity), 0);
  assert.deepEqual(await tableColumns(), columns, 'idempotent re-run leaves the column contract alone');

  // Additive upgrade from a real pre-0016 database: 0001..0015 applied without this table, existing
  // rows untouched, then only 0016 lands from the checked-in manifest.
  const legacy = await startPostgresFixture({ migrate: false });
  const directory = mkdtempSync('/tmp/siyue-revocation-upgrade-');
  try {
    const previous = (await readMigrations()).filter(migration => migration.version <= '0015_account_deletion_jobs.sql');
    assert.equal(previous.length, 15);
    for (const migration of previous) writeFileSync(join(directory, migration.version), migration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 15);
    assert.equal((await legacy.admin.query('SELECT to_regclass($1) AS present', [`siyue.${table}`])).rows[0].present, null,
      '0015 has no revocation outbox table');
    const before = (await legacy.admin.query(`SELECT relname FROM pg_class
      WHERE relnamespace='siyue'::regnamespace AND relkind='r' ORDER BY relname`)).rows.map(entry => entry.relname);
    // A real pre-0016 adult with an active Apple identity and its sealed credential: 0016 is purely
    // additive, so the subject, the identity and the credential all stay valid and stay queued for
    // nobody until the deletion path writes a job.
    const subjectId = randomUUID(), identityId = randomUUID(), legacySeal = sealOf(identityId);
    await legacy.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'adult','Synthetic prior adult')", [subjectId]);
    await legacy.app.query(`INSERT INTO siyue.external_identities(id,subject_id,provider,provider_namespace,
        provider_subject,client_id,issuer) VALUES($1,$2,'apple',$3,'synthetic-prior-provider-subject',$3,'https://appleid.apple.com')`,
    [identityId, subjectId, namespace]);
    await legacy.app.query('INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext) VALUES($1,$2)',
      [identityId, legacySeal]);
    // Only the migrations after 0015 remain in the real manifest. Later migrations may be added to
    // this shared checkout at any time, so the count is derived instead of assuming 0016 is last.
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity), (await readMigrations()).length - 15);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity), 0);
    const after = (await legacy.admin.query(`SELECT relname FROM pg_class
      WHERE relnamespace='siyue'::regnamespace AND relkind='r' ORDER BY relname`)).rows.map(entry => entry.relname);
    assert.ok(after.filter(name => !before.includes(name)).includes(table), '0016 adds its own table');
    assert.deepEqual(before.filter(name => !after.includes(name)), [], 'no pre-existing table is dropped');
    // The upgraded database carries exactly this migration's version row and column contract.
    assert.deepEqual((await legacy.admin.query(`SELECT version FROM siyue.schema_migrations WHERE version LIKE '0016\\_%'`))
      .rows.map(entry => entry.version), ['0016_apple_revocation_outbox.sql']);
    assert.deepEqual((await legacy.admin.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='siyue' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows.map(entry => entry.column_name),
    columns);
    const upgraded = (await legacy.admin.query('SELECT display_name FROM siyue.subjects WHERE id=$1', [subjectId])).rows[0];
    assert.equal(upgraded.display_name, 'Synthetic prior adult');
    assert.equal((await legacy.admin.query('SELECT refresh_ciphertext FROM siyue.apple_provider_credentials WHERE identity_id=$1',
      [identityId])).rows[0].refresh_ciphertext, legacySeal);
    assert.equal((await legacy.admin.query("SELECT has_table_privilege('siyue_app',$1,'SELECT,INSERT,UPDATE,DELETE') AS ok",
      [`siyue.${table}`])).rows[0].ok, true);
  } finally { rmSync(directory, { recursive: true, force: true }); await legacy.stop(); }

  // The claim and retention sweeps stay bounded by their own indexes.
  assert.deepEqual(await indexesOf(), ['apple_revocation_outbox_abandoned', 'apple_revocation_outbox_claimable',
    'apple_revocation_outbox_identity_id_key', 'apple_revocation_outbox_pkey', 'apple_revocation_outbox_retain_until']);
  const [claimable] = await rows(`SELECT indexdef FROM pg_indexes WHERE schemaname='siyue' AND indexname='apple_revocation_outbox_claimable'`);
  assert.match(claimable.indexdef, /WHERE \(status = 'pending'::text\)/);
  // Access comes from the schema default privileges, not from an explicit GRANT in 0016: the runtime
  // role may progress rows but owns nothing, has no DDL and cannot truncate the queue.
  const privilege = (role, what) => rows('SELECT has_table_privilege($1,$2,$3) AS ok', [role, `siyue.${table}`, what])
    .then(entries => entries[0].ok);
  assert.equal(await privilege('siyue_app', 'SELECT,INSERT,UPDATE,DELETE'), true);
  assert.equal(await privilege('siyue_app', 'TRUNCATE'), false);
  await db.admin.query('CREATE ROLE synthetic_revocation_probe LOGIN');
  try { assert.equal(await privilege('synthetic_revocation_probe', 'SELECT'), false); }
  finally { await db.admin.query('DROP ROLE synthetic_revocation_probe'); }
  for (const sql of [`DROP TABLE siyue.${table}`, `ALTER TABLE siyue.${table} ADD COLUMN forbidden int`,
    `CREATE INDEX forbidden_revocation ON siyue.${table}(status)`, `TRUNCATE siyue.${table}`, 'SET ROLE siyue_owner']) {
    await failure(db.app.query(sql), '42501', sql);
  }
  assert.deepEqual(await tableColumns(), columns);
});

test('0019 appends the authorization retry instant without rewriting an already queued row', async () => {
  // A real pre-0019 database: 0001..0018 taken from the checked-in files, with a queued revocation and an
  // abandoned attempt already in the outbox. Re-running the real manifest afterwards re-checks every
  // recorded checksum, so an edit to any already-applied file fails here instead of landing silently.
  const legacy = await startPostgresFixture({ migrate: false });
  const directory = mkdtempSync('/tmp/siyue-revocation-retry-upgrade-');
  try {
    const previous = (await readMigrations()).filter(migration => migration.version <= '0018_deletion_ledger_fence.sql');
    assert.equal(previous.length, 18);
    for (const migration of previous) writeFileSync(join(directory, migration.version), migration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 18);
    assert.deepEqual((await legacy.admin.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='siyue' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows.map(entry => entry.column_name),
    columns.slice(0, -1), '0018 has no authorization retry instant');
    // One subject with two Apple identities: a queued revocation and an attempt whose lease is still live.
    // Both are ordinary pre-0019 rows, so neither may be rewritten by the upgrade.
    const subjectId = randomUUID(), queuedIdentity = randomUUID(), leasedIdentity = randomUUID();
    const createdAt = new Date(start - 60_000), expiresAt = new Date(start + 7 * day), leaseUntil = new Date(start + 60_000);
    await legacy.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [subjectId]);
    for (const identityId of [queuedIdentity, leasedIdentity]) {
      await legacy.app.query(`INSERT INTO siyue.external_identities(id,subject_id,provider,provider_namespace,
          provider_subject,client_id,issuer) VALUES($1,$2,'apple',$3,$4,$5,'https://appleid.apple.com')`,
      [identityId, subjectId, namespace, `synthetic-prior-${identityId.slice(0, 8)}`, namespace]);
    }
    const queuedSeal = sealOf(queuedIdentity), leasedSeal = sealOf(leasedIdentity), liveLease = randomUUID();
    await legacy.app.query(`INSERT INTO siyue.${table}(id,identity_id,provider_namespace,refresh_ciphertext,
        status,attempts,available_at,expires_at,lease_id,lease_until,last_error_code,created_at,settled_at,retain_until)
      VALUES($1,$2,$3,$4,'pending',0,$5,$6,NULL,NULL,NULL,$7,NULL,NULL)`,
    [randomUUID(), queuedIdentity, namespace, queuedSeal, new Date(start), expiresAt, createdAt]);
    await legacy.app.query(`INSERT INTO siyue.${table}(id,identity_id,provider_namespace,refresh_ciphertext,
        status,attempts,available_at,expires_at,lease_id,lease_until,last_error_code,created_at,settled_at,retain_until)
      VALUES($1,$2,$3,$4,'sending',1,$5,$6,$7,$8,NULL,$9,NULL,NULL)`,
    [randomUUID(), leasedIdentity, namespace, leasedSeal, new Date(start), expiresAt, liveLease, leaseUntil, createdAt]);
    // Only the migrations after 0018 remain to apply, and the second run proves the 0001..0019 checksums.
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity), (await readMigrations()).length - 18);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity), 0);
    assert.deepEqual((await legacy.admin.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='siyue' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows.map(entry => entry.column_name),
    columns, '0019 only appended its own column');
    const upgraded = new Map((await legacy.admin.query(`SELECT identity_id,status,attempts,refresh_ciphertext,
      available_at,expires_at,lease_id,lease_until,created_at,authorization_retry_at FROM siyue.${table}`))
      .rows.map(row => [row.identity_id, row]));
    const queued = upgraded.get(queuedIdentity), leased = upgraded.get(leasedIdentity);
    assert.deepEqual([queued.status, queued.attempts, queued.refresh_ciphertext, queued.lease_id, +queued.available_at,
      +queued.expires_at, +queued.created_at, queued.authorization_retry_at],
    ['pending', 0, queuedSeal, null, +new Date(start), +expiresAt, +createdAt, null]);
    assert.deepEqual([leased.status, leased.attempts, leased.refresh_ciphertext, leased.lease_id,
      +leased.lease_until, leased.authorization_retry_at],
    ['sending', 1, leasedSeal, liveLease, +leaseUntil, null]);
    assert.equal((await legacy.admin.query(`SELECT has_column_privilege('siyue_app',$1,'authorization_retry_at','UPDATE') AS ok`,
      [`siyue.${table}`])).rows[0].ok, true);
  } finally { rmSync(directory, { recursive: true, force: true }); await legacy.stop(); }
});

test('one queued revocation per identity keeps only the sealed credential and joins the caller transaction', async () => {
  const { store, at } = fixture();
  const { identityId } = await addIdentity();
  const job = { identityId, providerNamespace: namespace, refreshCiphertext: sealOf(identityId) };
  await enqueue(store, identityId, { refreshCiphertext: job.refreshCiphertext });
  const row = await jobRow(identityId);
  // A freshly queued revocation is a recorded request: no attempt, no lease, no settlement, no code.
  assert.deepEqual([row.status, row.attempts, row.lease_id, row.lease_until, row.last_error_code, row.settled_at,
    row.retain_until], ['pending', 0, null, null, null, null, null]);
  assert.deepEqual([row.provider_namespace, row.refresh_ciphertext, +row.created_at],
    [namespace, job.refreshCiphertext, +at()]);
  assert.equal(+row.expires_at - +row.available_at, 7 * day);
  // The row keeps the seal, never the plaintext provider token the seal was made from.
  assert.equal(JSON.stringify(row).includes(refresh), false);
  // A repeated enqueue for the same identity is a no-op instead of a second job, and it never
  // overwrites the window or the seal that is already queued.
  await enqueue(store, identityId, { availableAt: new Date(start + day), expiresAt: new Date(start + 30 * day),
    providerNamespace: 'another.app.siyue', refreshCiphertext: 'synthetic-other-seal' });
  assert.equal(await total(), 1);
  const kept = await jobRow(identityId);
  assert.deepEqual([kept.provider_namespace, kept.refresh_ciphertext, +kept.available_at],
    [namespace, job.refreshCiphertext, +at()]);
  // A Pool has no transaction of its own, so it is refused instead of committing outside the deletion.
  await assert.rejects(store.enqueue(db.app, { job, availableAt: at(), expiresAt: new Date(+at() + day) }),
    /apple_revocation_enqueue_requires_transaction_client/);
  // The identity reference, the window and the sealed payload shape are all enforced on write.
  await assert.rejects(enqueue(store, randomUUID()), error => error.code === '23503');
  await assert.rejects(transaction(db.app, client => store.enqueue(client, { job,
    availableAt: at(), expiresAt: at() })), /invalid_apple_revocation_window/);
  for (const broken of [{ ...job, identityId: 'not-a-uuid' }, { ...job, providerNamespace: 'not a namespace' },
    { ...job, refreshCiphertext: '' }, { ...job, extra: 'synthetic' }]) {
    await assert.rejects(transaction(db.app, client => store.enqueue(client, { job: broken,
      availableAt: at(), expiresAt: new Date(+at() + day) })), error => error.name === 'ZodError');
  }
  assert.equal(await total(), 1, 'no refused enqueue left a row behind');
});

test('a rolled back deletion transaction queues nothing and a committed one queues every live identity', async () => {
  const { store, clock } = fixture();
  const outbox = createAppleRevocationOutbox({ store, cipher, clock, revoke: async () => ({ outcome: 'revoked' }) });
  const subjectId = await addSubject();
  const first = await addIdentity({ subjectId }), second = await addIdentity({ subjectId });
  // The accepted deletion and its queued revocations are one transaction: a rollback leaves no job.
  await assert.rejects(transaction(db.app, async client => {
    assert.equal((await outbox.enqueueForSubject(client, { subjectId })).identities, 2);
    throw new Error('synthetic_rollback');
  }), /synthetic_rollback/);
  assert.equal(await total(), 0, 'a rolled back deletion left no queued revocation');
  assert.equal((await transaction(db.app, client => outbox.enqueueForSubject(client, { subjectId }))).identities, 2);
  assert.equal(await total(), 2);
  for (const identityId of [first.identityId, second.identityId]) {
    const [queued] = await rows(`SELECT * FROM siyue.${table} WHERE identity_id=$1`, [identityId]);
    const [stored] = await rows('SELECT refresh_ciphertext FROM siyue.apple_provider_credentials WHERE identity_id=$1', [identityId]);
    assert.equal(queued.status, 'pending');
    // The queue keeps exactly the seal the identity store wrote; it never re-seals the credential.
    assert.equal(queued.refresh_ciphertext, stored.refresh_ciphertext);
    assert.equal(JSON.stringify(queued).includes(refresh), false);
  }
  // Only live Apple identities that still carry a credential qualify: an unlinked identity and an
  // identity whose credential row is gone are not copied into the queue at all.
  const unlinked = await addIdentity({ subjectId, status: 'unlinked' });
  const stripped = await addIdentity({ subjectId, credential: false });
  assert.equal((await transaction(db.app, client => outbox.enqueueForSubject(client, { subjectId }))).identities, 2);
  assert.equal(await total(), 2);
  assert.equal(await jobRow(unlinked.identityId), undefined);
  assert.equal(await jobRow(stripped.identityId), undefined);
});

test('claims take distinct jobs with SKIP LOCKED and never hand one job to two workers', async () => {
  const { store, at } = fixture();
  const first = await addIdentity(), second = await addIdentity();
  await enqueue(store, first.identityId);
  await enqueue(store, second.identityId);
  // While another transaction holds the first job's row lock, one claim takes the second job instead
  // of waiting for the lock (the pool's 5s statement timeout would fail a blocking claim).
  const held = await db.app.connect();
  try {
    await held.query('BEGIN');
    await held.query(`SELECT id FROM siyue.${table} WHERE identity_id=$1 FOR UPDATE`, [first.identityId]);
    const skipped = await store.claim(at(), new Date(+at() + 60_000));
    assert.equal(skipped.job.identityId, second.identityId);
    assert.equal(skipped.attempt, 1);
  } finally { await held.query('ROLLBACK'); held.release(); }
  // The released job is claimable, and a job whose lease is still live is not claimable again.
  assert.equal((await store.claim(at(), new Date(+at() + 60_000))).job.identityId, first.identityId);
  assert.equal(await store.claim(at(), new Date(+at() + 60_000)), undefined);
  // Eight concurrent claims against three fresh jobs take exactly three distinct rows.
  const fresh = [await addIdentity(), await addIdentity(), await addIdentity()];
  for (const identity of fresh) await enqueue(store, identity.identityId);
  const claimed = (await Promise.all(Array.from({ length: 8 }, () => store.claim(at(), new Date(+at() + 60_000)))))
    .filter(claim => claim !== undefined);
  assert.equal(claimed.length, 3, 'one lease per job, no job claimed twice');
  assert.deepEqual(claimed.map(claim => claim.job.identityId).sort(), fresh.map(identity => identity.identityId).sort());
  assert.equal(new Set(claimed.map(claim => claim.leaseId)).size, 3, 'every lease has its own owner');
  assert.deepEqual(claimed.map(claim => claim.attempt), [1, 1, 1]);
  const leased = await rows(`SELECT status,attempts,lease_id FROM siyue.${table} WHERE status='sending'`);
  assert.equal(leased.length, 5, 'two earlier jobs and three fresh ones are all leased exactly once');
  assert.deepEqual(leased.map(row => row.attempts), [1, 1, 1, 1, 1]);
  assert.equal(new Set(leased.map(row => row.lease_id)).size, 5);
  // Each claimed job can be settled by its own lease, so no attempt was lost to the concurrency.
  for (const claim of claimed) await store.settle(claim, { state: 'revoked' }, at());
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.${table} WHERE status='revoked'`), 3);
  // One available job and eight concurrent claims: exactly one worker owns that attempt.
  const solo = await addIdentity();
  await enqueue(store, solo.identityId);
  const winners = (await Promise.all(Array.from({ length: 8 }, () => store.claim(at(), new Date(+at() + 60_000)))))
    .filter(claim => claim !== undefined);
  assert.equal(winners.length, 1, 'one job can only ever be leased once');
  assert.equal(winners[0].job.identityId, solo.identityId);
  assert.equal((await jobRow(solo.identityId)).attempts, 1);
});

test('an abandoned lease is re-claimed with a new owner and the stale owner can no longer settle', async () => {
  const { store, at, advance } = fixture();
  const { identityId } = await addIdentity();
  await enqueue(store, identityId, { availableAt: at(), expiresAt: new Date(+at() + day) });
  const abandoned = await store.claim(at(), new Date(+at() + 60_000));
  assert.deepEqual([abandoned.attempt, +abandoned.expiresAt], [1, +at() + day]);
  assert.equal(await store.claim(at(), new Date(+at() + 60_000)), undefined, 'a live lease stays owned');
  // The lease expires (a crashed worker, a lost process), so the job is recoverable instead of stuck.
  advance(60_000);
  const recovered = await store.claim(at(), new Date(+at() + 60_000));
  assert.equal(recovered.jobId, abandoned.jobId);
  assert.deepEqual([recovered.attempt, recovered.job.refreshCiphertext], [2, abandoned.job.refreshCiphertext]);
  assert.notEqual(recovered.leaseId, abandoned.leaseId);
  // The abandoned owner's settlement fences on its lease: the row keeps the newer owner's state.
  await store.settle(abandoned, { state: 'revoked' }, at());
  const held = await jobRow(identityId);
  assert.deepEqual([held.status, held.attempts, held.lease_id, held.refresh_ciphertext],
    ['sending', 2, recovered.leaseId, abandoned.job.refreshCiphertext]);
  // The current owner settles normally, and a terminal job is never claimed or reopened again.
  await store.settle(recovered, { state: 'revoked' }, at());
  const terminal = await jobRow(identityId);
  assert.deepEqual([terminal.status, terminal.attempts, terminal.refresh_ciphertext, terminal.lease_id],
    ['revoked', 2, null, null]);
  await store.settle(recovered, { state: 'retry', availableAt: at(), errorCode: 'apple_provider_unavailable' }, at());
  assert.equal((await jobRow(identityId)).status, 'revoked', 'a settled job cannot be reopened');
  assert.equal(await store.claim(at(), new Date(+at() + 60_000)), undefined);
});

test('a deferred authorization retry skips the refused queue head and re-leases it only when it opens', async () => {
  const { store, at, advance } = fixture();
  const refused = await addIdentity(), later = await addIdentity();
  await enqueue(store, refused.identityId, { availableAt: at(), expiresAt: new Date(+at() + 7 * day) });
  const refusedAttempt = await store.claim(at(), new Date(+at() + 60_000));
  assert.equal(refusedAttempt.job.identityId, refused.identityId);
  const sealed = refusedAttempt.job.refreshCiphertext;
  // The independent ledger refused this identity, so the attempt it leased is put back behind a persisted
  // retry instant instead of being settled. Nothing else about the row moves.
  const until = new Date(+at() + 5 * 60_000);
  await store.deferAuthorization(refusedAttempt, until);
  const deferred = await jobRow(refused.identityId);
  assert.deepEqual([deferred.status, deferred.attempts, deferred.lease_id, deferred.lease_until,
    +deferred.authorization_retry_at, +deferred.available_at, +deferred.expires_at, deferred.last_error_code,
    deferred.settled_at, deferred.retain_until, deferred.refresh_ciphertext],
  ['pending', 1, null, null, +until, +at(), +at() + 7 * day, null, null, null, sealed]);
  // The refused lease is gone for good: it can no longer settle the attempt it lost...
  await store.settle(refusedAttempt, { state: 'revoked' }, at());
  const afterStaleSettle = await jobRow(refused.identityId);
  assert.deepEqual([afterStaleSettle.status, afterStaleSettle.refresh_ciphertext, afterStaleSettle.attempts],
    ['pending', sealed, 1]);
  // ...nor defer it a second time, so one refusal cannot keep rewriting the retry instant it names.
  await store.deferAuthorization(refusedAttempt, new Date(+at() + day));
  const stillWaiting = await jobRow(refused.identityId);
  assert.deepEqual([stillWaiting.attempts, stillWaiting.status, +stillWaiting.authorization_retry_at],
    [1, 'pending', +until]);
  // The queue behind the refused row is not starved: the next claim takes the later job.
  await enqueue(store, later.identityId, { availableAt: at(), expiresAt: new Date(+at() + 7 * day) });
  const second = await store.claim(at(), new Date(+at() + 60_000));
  assert.deepEqual([second.job.identityId, second.attempt], [later.identityId, 1]);
  await store.settle(second, { state: 'revoked' }, at());
  // One millisecond before the authorization window opens, the refused row is still skipped and intact.
  advance(5 * 60_000 - 1);
  assert.equal(await store.claim(at(), new Date(+at() + 60_000)), undefined);
  const waiting = await jobRow(refused.identityId);
  assert.deepEqual([waiting.status, waiting.refresh_ciphertext, waiting.authorization_retry_at !== null],
    ['pending', sealed, true]);
  // At the instant itself the row is due again, and the claim that takes it clears the deferral.
  advance(1);
  const resumed = await store.claim(at(), new Date(+at() + 60_000));
  assert.deepEqual([resumed.job.identityId, resumed.job.refreshCiphertext, resumed.attempt],
    [refused.identityId, sealed, 2]);
  const leased = await jobRow(refused.identityId);
  assert.deepEqual([leased.status, leased.attempts, leased.lease_id, leased.authorization_retry_at],
    ['sending', 2, resumed.leaseId, null]);
});

test('a deferral may outlive the revocation window and a closed unauthorized window keeps its seal', async () => {
  const { store, at, advance } = fixture();
  const { identityId } = await addIdentity();
  const availableAt = at(), expiresAt = new Date(+at() + 60_000);
  await enqueue(store, identityId, { availableAt, expiresAt });
  const refused = await store.claim(at(), new Date(+at() + 60_000));
  const sealed = refused.job.refreshCiphertext;
  // The authorization is an independent fact: it may only arrive after the bounded window closed, so a
  // retry instant past expires_at is an ordinary deferral rather than an impossible interval.
  const until = new Date(+at() + 30 * day);
  await store.deferAuthorization(refused, until);
  advance(day);
  // The window is closed and nobody authorized this attempt, so the row is neither claimed nor settled nor
  // purged: the sealed credential survives for the authorization that is still missing.
  assert.equal(await store.claim(at(), new Date(+at() + 60_000)), undefined);
  await store.settle(refused, { state: 'expired', errorCode: 'revocation_window_expired' }, at());
  assert.equal(await store.purge(at()), 0);
  const waiting = await jobRow(identityId);
  assert.deepEqual([waiting.status, waiting.refresh_ciphertext, waiting.last_error_code, waiting.settled_at,
    waiting.retain_until, +waiting.available_at, +waiting.expires_at, +waiting.authorization_retry_at],
  ['pending', sealed, null, null, null, +availableAt, +expiresAt, +until]);
  // When the authorization window opens, the row is leaseable again and still carries its seal, so only an
  // attempt that was authorized to look at a closed window can decide what happens to the credential.
  advance(30 * day - day);
  const resumed = await store.claim(at(), new Date(+at() + 60_000));
  assert.deepEqual([resumed.job.identityId, resumed.job.refreshCiphertext, resumed.attempt],
    [identityId, sealed, 2]);
  assert.equal((await jobRow(identityId)).authorization_retry_at, null);
  await store.settle(resumed, { state: 'expired', errorCode: 'revocation_window_expired' }, at());
  const gone = await jobRow(identityId);
  assert.deepEqual([gone.status, gone.refresh_ciphertext, gone.last_error_code, +gone.settled_at],
    ['expired', null, 'revocation_window_expired', +at()]);
});

test('a deferred retry instant fences an abandoned lease as well as a queued row', async () => {
  const { store, at, advance } = fixture();
  const { identityId } = await addIdentity();
  const leaseId = randomUUID(), sealed = sealOf(identityId), until = new Date(+at() + 5 * 60_000);
  // An attempt whose owner died after it was deferred: the lease has already expired, so only the retry
  // instant still keeps this row out of the queue.
  const row = await insertRow({ identity_id: identityId, refresh_ciphertext: sealed, status: 'sending', attempts: 1,
    available_at: at(), expires_at: new Date(+at() + 7 * day), lease_id: leaseId,
    lease_until: new Date(+at() - 1000), authorization_retry_at: until });
  assert.equal(await store.claim(at(), new Date(+at() + 60_000)), undefined);
  advance(5 * 60_000 - 1);
  assert.equal(await store.claim(at(), new Date(+at() + 60_000)), undefined);
  advance(1);
  const resumed = await store.claim(at(), new Date(+at() + 60_000));
  assert.deepEqual([resumed.jobId, resumed.attempt, resumed.job.refreshCiphertext], [row.id, 2, sealed]);
  const leased = await jobRow(identityId);
  assert.deepEqual([leased.status, leased.authorization_retry_at, leased.lease_id], ['sending', null, resumed.leaseId]);
});

test('a deferral refuses an unusable retry instant and leaves the attempt to its owner', async () => {
  const { store, at } = fixture();
  const { identityId } = await addIdentity();
  await enqueue(store, identityId, { availableAt: at(), expiresAt: new Date(+at() + 7 * day) });
  const attempt = await store.claim(at(), new Date(+at() + 60_000));
  const sealed = attempt.job.refreshCiphertext;
  // A retry instant that already passed is not a window: the row would be claimable again in the same
  // instant, which is the starvation a deferral exists to end. A NaN instant would be stored as NULL and
  // mean the same thing, and anything that is not a timestamp is not an instant at all.
  for (const unusable of [at(), new Date(+at() - 1), new Date('not-an-instant'), new Date(NaN), 'tomorrow',
    undefined, null]) {
    await assert.rejects(store.deferAuthorization(attempt, unusable), /invalid_apple_revocation_authorization_retry/);
  }
  // The refusals wrote nothing, so the attempt is still exactly as its owner leased it.
  const held = await jobRow(identityId);
  assert.deepEqual([held.status, held.attempts, held.lease_id, +held.lease_until, held.authorization_retry_at,
    held.refresh_ciphertext], ['sending', 1, attempt.leaseId, +at() + 60_000, null, sealed]);
  // A claim that is not a lease cannot defer anything either.
  await assert.rejects(store.deferAuthorization({ ...attempt, leaseId: 'not-a-lease' }, new Date(+at() + day)),
    error => error.name === 'ZodError');
  await assert.rejects(store.deferAuthorization(undefined, new Date(+at() + day)), error => error.name === 'ZodError');
  assert.equal((await jobRow(identityId)).status, 'sending', 'a refused deferral changes no row');
  // The lease that still owns the attempt defers it normally: the row returns to the queue behind its own
  // retry instant, which is what the next claim reads.
  await store.deferAuthorization(attempt, new Date(+at() + day));
  const deferred = await jobRow(identityId);
  assert.deepEqual([deferred.status, deferred.lease_id, +deferred.authorization_retry_at],
    ['pending', null, +at() + day]);
});

test('settlement separates the four outcomes, destroys the closed seal and bounds retention', async () => {
  const { store, at, advance } = fixture({ retentionMs: 3_600_000 });
  const revoked = await addIdentity(), expired = await addIdentity(), attention = await addIdentity(), retried = await addIdentity();
  // The queue's own claim order is availability and then id, so each identity owns one outcome
  // instead of the test assuming which of four equally due jobs a worker picks first.
  const outcomes = new Map([[revoked.identityId, 'revoked'], [expired.identityId, 'expired'],
    [attention.identityId, 'needs_attention'], [retried.identityId, 'retry']]);
  const settlement = { revoked: { state: 'revoked' },
    expired: { state: 'expired', errorCode: 'revocation_window_expired' },
    needs_attention: { state: 'needs_attention', errorCode: 'credential_unreadable' },
    retry: { state: 'retry', availableAt: new Date(+at() + 30_000), errorCode: 'apple_provider_unavailable' } };
  // A seal is randomized, so the queued ciphertext is captured once instead of recomputed later.
  const seals = new Map();
  for (const identity of [revoked, expired, attention, retried]) {
    seals.set(identity.identityId, sealOf(identity.identityId));
    await enqueue(store, identity.identityId, { availableAt: at(), expiresAt: new Date(+at() + day),
      refreshCiphertext: seals.get(identity.identityId) });
  }
  // Each of the four outcomes is applied once, by the lease that claimed that very job.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const claim = await store.claim(at(), new Date(+at() + 60_000));
    await store.settle(claim, settlement[outcomes.get(claim.job.identityId)], at());
  }
  const revokedRow = await jobRow(revoked.identityId), expiredRow = await jobRow(expired.identityId);
  const attentionRow = await jobRow(attention.identityId), retriedRow = await jobRow(retried.identityId);
  // A confirmed revocation is the only settlement with no error code, and it destroys the seal: there
  // is nothing left to revoke, so the main database keeps no credential material for it.
  assert.deepEqual([revokedRow.status, revokedRow.refresh_ciphertext, revokedRow.last_error_code], ['revoked', null, null]);
  // A closed window never pretended Apple was told, so it keeps that bounded queue-local code.
  assert.deepEqual([expiredRow.status, expiredRow.refresh_ciphertext, expiredRow.last_error_code],
    ['expired', null, 'revocation_window_expired']);
  // An unreadable seal is terminal for the queue but keeps its bounded seal so an operator can fix
  // the client configuration and revoke inside the window.
  assert.deepEqual([attentionRow.status, attentionRow.refresh_ciphertext, attentionRow.last_error_code],
    ['needs_attention', seals.get(attention.identityId), 'credential_unreadable']);
  // A retry returns to the queue with the provider code kept and no terminal stamp at all.
  assert.deepEqual([retriedRow.status, +retriedRow.available_at, retriedRow.last_error_code, retriedRow.lease_id,
    retriedRow.lease_until, retriedRow.settled_at, retriedRow.retain_until],
  ['pending', +at() + 30_000, 'apple_provider_unavailable', null, null, null, null]);
  assert.equal(retriedRow.refresh_ciphertext, seals.get(retried.identityId));
  // Terminal rows are settled, and retention never truncates the window they belong to: a narrowed
  // 1h retention still keeps the row until its 1-day window closes.
  for (const row of [revokedRow, expiredRow, attentionRow]) {
    assert.equal(+row.settled_at, +at());
    assert.equal(+row.retain_until, Math.max(+at() + 3_600_000, +row.expires_at));
    assert.equal(+row.retain_until, +row.expires_at);
  }
  // Nothing is dropped while the window is open, including the needs_attention seal.
  advance(3_600_000);
  assert.equal(await store.purge(at()), 0);
  // After the bound, purge removes exactly the terminal rows and leaves the queued job alone.
  advance(day);
  assert.equal(await store.purge(at()), 3);
  assert.equal(await total(), 1);
  assert.equal((await jobRow(retried.identityId)).status, 'pending');
  // Purging is what frees the identity's queue slot, so a later deletion can queue that identity again.
  await enqueue(store, attention.identityId, { availableAt: at(), expiresAt: new Date(+at() + day) });
  assert.equal(await total(), 2);
  assert.equal((await jobRow(attention.identityId)).status, 'pending');
  // The default retention is bounded by the store's own ceiling, not by the window a caller passed.
  const plain = fixture();
  const long = await addIdentity();
  await enqueue(plain.store, long.identityId, { availableAt: plain.at(), expiresAt: new Date(+plain.at() + day) });
  await plain.store.settle(await plain.store.claim(plain.at(), new Date(+plain.at() + 60_000)), { state: 'revoked' }, plain.at());
  const longRow = await jobRow(long.identityId);
  assert.equal(+longRow.retain_until, +plain.at() + 30 * day);
  assert.equal(await plain.store.purge(new Date(+plain.at() + 30 * day - 1)), 0);
  assert.equal(await plain.store.purge(new Date(+plain.at() + 30 * day)), 1);
});

test('retention is bounded on both sides and a refused outcome changes nothing', async () => {
  const { store, at } = fixture({ retentionMs: 3_600_000 });
  // A caller can narrow retention but never widen it past the longest window the outbox can use.
  assert.throws(() => createAppleRevocationPostgresStore(db.app, { retentionMs: 31 * day }), /invalid_apple_revocation_retention/);
  assert.throws(() => createAppleRevocationPostgresStore(db.app, { retentionMs: 1000 }), /invalid_apple_revocation_retention/);
  const { identityId } = await addIdentity();
  await enqueue(store, identityId, { availableAt: at(), expiresAt: new Date(+at() + 1000) });
  const lease = await store.claim(at(), new Date(+at() + 60_000));
  assert.equal(lease.job.identityId, identityId);
  // A retry that would land outside the job's own window is not a queue state: the outbox settles it
  // as expired instead, so the store refuses it and leaves the attempt in flight for its owner.
  await assert.rejects(store.settle(lease, { state: 'retry',
    availableAt: new Date(+at() + 2000), errorCode: 'apple_provider_unavailable' }, at()),
  /invalid_apple_revocation_window/);
  // A code that is not a bounded lowercase snake_case token is refused before any row is written.
  for (const errorCode of ['Credential Unreadable', 'Revocation Window Expired', 'a'.repeat(65)]) {
    await assert.rejects(store.settle(lease, { state: 'expired', errorCode }, at()), error => error.name === 'ZodError');
  }
  const held = await jobRow(identityId);
  assert.deepEqual([held.status, held.lease_id, held.refresh_ciphertext !== null], ['sending', lease.leaseId, true]);
  // The lease that still owns the attempt settles normally afterwards.
  await store.settle(lease, { state: 'revoked' }, at());
  const settledRow = await jobRow(identityId);
  assert.deepEqual([settledRow.status, settledRow.refresh_ciphertext], ['revoked', null]);
});

test('the table itself refuses impossible states and the runtime role stays DML-only', async () => {
  const { identityId } = await addIdentity();
  const settled = new Date(start);
  const terminal = { settled_at: settled, retain_until: new Date(start + day) };
  // One job per identity, and only for an identity that exists.
  await insertRow({ identity_id: identityId });
  await failure(insertRow({ identity_id: identityId }), '23505', 'second job for one identity');
  await failure(insertRow({ identity_id: randomUUID() }), '23503', 'unknown identity');
  await failure(insertRow({ identity_id: null }), '23502', 'identity link required');
  await failure(insertRow({ id: (await rows(`SELECT id FROM siyue.${table}`))[0].id }), '23505', 'duplicate job id');
  // Only the five documented states are accepted.
  await failure(insertRow({ status: 'sent' }), '23514', 'unknown status');
  await failure(insertRow({ status: null }), '23502', 'status required');
  await failure(insertRow({ attempts: -1 }), '23514', 'negative attempt count');
  // A claimable job is always inside a real window.
  await failure(insertRow({ expires_at: settled }), '23514', 'window ending at creation');
  await failure(insertRow({ expires_at: new Date(start - 1) }), '23514', 'window before creation');
  await failure(insertRow({ available_at: new Date(start + day), expires_at: new Date(start + day) }), '23514', 'job available at its own deadline');
  await failure(insertRow({ expires_at: null }), '23502', 'window required');
  // A lease belongs to an attempt in flight and to nothing else.
  await failure(insertRow({ status: 'sending' }), '23514', 'attempt in flight without a lease');
  await failure(insertRow({ lease_id: randomUUID(), lease_until: new Date(start + 60_000) }), '23514', 'lease on a queued job');
  await failure(insertRow({ status: 'sending', lease_id: randomUUID() }), '23514', 'lease id without its expiry');
  await failure(insertRow({ status: 'sending', lease_id: null, lease_until: new Date(start + 60_000) }), '23514', 'lease expiry without its owner');
  // Credential material exists exactly while the queue may still have to send it: revoked and
  // expired jobs hold no credential, needs_attention and queued jobs always do.
  await failure(insertRow({ status: 'revoked', ...terminal }), '23514', 'revoked job keeping its seal');
  await failure(insertRow({ status: 'expired', ...terminal, last_error_code: 'revocation_window_expired' }), '23514', 'expired job keeping its seal');
  await failure(insertRow({ status: 'needs_attention', refresh_ciphertext: null, ...terminal,
    last_error_code: 'credential_unreadable' }), '23514', 'unreadable seal with no seal');
  await failure(insertRow({ refresh_ciphertext: null }), '23514', 'queued job without its seal');
  await failure(insertRow({ refresh_ciphertext: '' }), '23514', 'empty seal');
  // Terminal states are exactly the settled and retained ones.
  await failure(insertRow({ status: 'revoked' }), '23514', 'terminal job without a settlement stamp');
  await failure(insertRow({ settled_at: settled, retain_until: new Date(start + day) }), '23514', 'queued job with a settlement stamp');
  await failure(insertRow({ status: 'revoked', settled_at: settled }), '23514', 'terminal job without a retention bound');
  await failure(insertRow({ status: 'revoked', ...terminal, retain_until: settled }), '23514', 'retention ending at settlement');
  // A confirmed revocation has no error to report; the two terminal states that are not success must
  // carry one, and every stored code is a bounded lowercase snake_case token.
  await failure(insertRow({ status: 'revoked', ...terminal, last_error_code: 'apple_revocation_failed' }), '23514', 'revoked job with an error code');
  await failure(insertRow({ status: 'expired', ...terminal }), '23514', 'expired job without an error code');
  await failure(insertRow({ status: 'needs_attention', ...terminal }), '23514', 'needs_attention job without an error code');
  await failure(insertRow({ last_error_code: 'Provider Timeout' }), '23514', 'code with spaces and capitals');
  await failure(insertRow({ last_error_code: '9numeric' }), '23514', 'code starting with a digit');
  await failure(insertRow({ last_error_code: 'a'.repeat(65) }), '23514', 'code above the bound');
  assert.equal((await insertRow({ last_error_code: 'apple_provider_unavailable' })).last_error_code,
    'apple_provider_unavailable');
  assert.equal((await insertRow({ status: 'expired', refresh_ciphertext: null, ...terminal,
    last_error_code: 'revocation_not_attempted' })).status, 'expired');
  // The refusals never landed, so only the accepted shapes are in the table.
  assert.equal(await total(), 3);
  const sending = await insertRow({ status: 'sending', lease_id: randomUUID(), lease_until: new Date(start + 60_000) });
  await db.app.query(`UPDATE siyue.${table} SET status='sending',lease_id=$2,lease_until=$3 WHERE id=$1`,
    [sending.id, randomUUID(), new Date(start + 120_000)]);
  assert.equal((await rows(`SELECT status FROM siyue.${table} WHERE id=$1`, [sending.id]))[0].status, 'sending');
  await failure(db.app.query(`UPDATE siyue.${table} SET lease_until=NULL WHERE id=$1`, [sending.id]), '23514', 'attempt without a lease expiry');
  await failure(db.app.query(`UPDATE siyue.${table} SET status='revoked' WHERE id=$1`, [sending.id]), '23514', 'in-flight job settled without a stamp');
});

test('the outbox state machine runs over the durable store without any provider call', async () => {
  // 1. Apple confirms the revocation: the seal is destroyed, the queue is done, one token was sent.
  {
    const { store, at } = fixture();
    const calls = [];
    const outbox = createAppleRevocationOutbox({ store, cipher, clock: at,
      revoke: async input => { calls.push(input); return { outcome: 'revoked' }; } });
    const subjectId = await addSubject();
    const { identityId } = await addIdentity({ subjectId });
    await transaction(db.app, client => outbox.enqueueForSubject(client, { subjectId }));
    assert.equal(await outbox.tick(), 'revoked');
    const row = await jobRow(identityId);
    assert.deepEqual([row.status, row.refresh_ciphertext, row.last_error_code, row.attempts], ['revoked', null, null, 1]);
    // Exactly the credential the identity store sealed was opened under the job's own AAD.
    assert.deepEqual(calls, [{ refreshToken: refresh }]);
    assert.equal(await outbox.tick(), undefined, 'a terminal job is never claimed twice');
    assert.equal(calls.length, 1);
  }
  // 2. A provider outage backs off inside the window and the durable row carries the retry state.
  {
    const { store, at, advance } = fixture();
    const calls = [];
    let outcome = { outcome: 'unavailable' };
    const outbox = createAppleRevocationOutbox({ store, cipher, clock: at, retryDelayMs: 1000,
      maxRetryDelayMs: 4000, revoke: async input => { calls.push(input); return outcome; } });
    const subjectId = await addSubject();
    const { identityId } = await addIdentity({ subjectId });
    await transaction(db.app, client => outbox.enqueueForSubject(client, { subjectId }));
    assert.equal(await outbox.tick(), 'retry');
    const waiting = await jobRow(identityId);
    assert.deepEqual([waiting.status, waiting.last_error_code, +waiting.available_at],
      ['pending', 'apple_provider_unavailable', +at() + 1000]);
    assert.equal(await outbox.tick(), undefined, 'the backoff is honoured before the next attempt');
    outcome = { outcome: 'revoked' };
    advance(1000);
    assert.equal(await outbox.tick(), 'revoked');
    assert.deepEqual([(await jobRow(identityId)).attempts, calls.length], [2, 2]);
  }
  // 3. A seal that cannot be opened under this job's own AAD is never sent anywhere: the job stops
  // with an alert and keeps the bounded seal for an operator instead of pretending Apple was told.
  {
    const { store, at } = fixture();
    const calls = [], alerts = [];
    const outbox = createAppleRevocationOutbox({ store, cipher, clock: at,
      revoke: async input => { calls.push(input); return { outcome: 'revoked' }; }, alert: code => alerts.push(code) });
    const subjectId = await addSubject();
    // The stored credential is sealed for a different identity, so the queued job cannot open it.
    const { identityId } = await addIdentity({ subjectId, sealed: sealOf(randomUUID()) });
    await transaction(db.app, client => outbox.enqueueForSubject(client, { subjectId }));
    assert.equal(await outbox.tick(), 'needs_attention');
    const row = await jobRow(identityId);
    assert.deepEqual([row.status, row.last_error_code, row.refresh_ciphertext !== null],
      ['needs_attention', 'credential_unreadable', true]);
    assert.deepEqual(alerts, ['apple_revocation_needs_attention']);
    assert.deepEqual(calls, [], 'an unreadable credential is never sent to the provider');
    assert.equal(await outbox.tick(), undefined);
  }
  // 4. A window that closed before the first attempt ends the job without sending anything, and the
  // queued credential is destroyed rather than kept for a revocation the window no longer allows.
  {
    const { store, at, advance } = fixture();
    const calls = [], alerts = [];
    const outbox = createAppleRevocationOutbox({ store, cipher, clock: at, windowMs: 60_000,
      revoke: async input => { calls.push(input); return { outcome: 'revoked' }; }, alert: code => alerts.push(code) });
    const subjectId = await addSubject();
    const { identityId } = await addIdentity({ subjectId });
    await transaction(db.app, client => outbox.enqueueForSubject(client, { subjectId }));
    assert.equal(+((await jobRow(identityId)).expires_at) - +at(), 60_000);
    advance(60_000);
    assert.equal(await outbox.tick(), 'expired');
    const row = await jobRow(identityId);
    assert.deepEqual([row.status, row.last_error_code, row.refresh_ciphertext], ['expired', 'revocation_not_attempted', null]);
    assert.deepEqual([calls, alerts], [[], ['apple_revocation_expired']]);
    // The expired row stayed in the window's retention bound and was not claimable again.
    assert.equal(+row.retain_until, Math.max(+row.settled_at + 30 * day, +row.expires_at));
    assert.equal(await outbox.tick(), undefined);
  }
});
