import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { migrateDatabase, readMigrations } from '../../dist/adapters/postgres/migrate.js';

// Account-deletion job schema (design 13.1/13.3, migration 0015) against an isolated temporary
// PostgreSQL cluster only: the fixture always builds a fresh cluster on a short Unix socket and never
// reads a database URL or the workspace .env. Every identifier, digest and code below is synthetic,
// and no mail, provider, shell or network call happens. The anti-revival ledger deliberately has no
// test here because design 13.4 keeps it outside the restorable main database.
const day = 86_400_000;
const table = 'account_deletion_jobs';
// The complete fixed column contract: no email, display name, provider credential or receipt
// plaintext column may be added to this table.
const columns = ['id', 'subject_id', 'state', 'requested_at', 'local_data_deleted',
  'provider_revocation_pending', 'receipt_secret_hash', 'receipt_expires_at', 'completed_at', 'last_error_code'];
let db;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => { await db.admin.query(`TRUNCATE siyue.account_deletion_jobs,siyue.subjects CASCADE`); });
after(async () => { await db?.stop(); });

/** Tolerates both `rows(sql, a, b)` and `rows(sql, [a, b])` call styles. */
const bindings = args => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
const rows = (sql, ...args) => db.app.query(sql, bindings(args)).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
const sha256 = () => createHash('sha256').update(randomUUID()).digest('hex');
/** Asserts the database refused a statement with one SQLSTATE, quoting the constraint it broke. */
const failure = async (query, code, label) => {
  const error = await query.then(() => null, thrown => thrown);
  assert.equal(error?.code, code, `${label ?? ''} ${error?.constraint ?? error?.message}`.trim());
};
const addSubject = () => db.app
  .query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult') RETURNING id", [randomUUID()])
  .then(result => result.rows[0].id);
const tableColumns = async () => (await rows(`SELECT column_name FROM information_schema.columns
  WHERE table_schema='siyue' AND table_name=$1 ORDER BY ordinal_position`, [table])).map(entry => entry.column_name);
const indexesOf = () => rows(`SELECT indexname FROM pg_indexes WHERE schemaname='siyue' AND tablename=$1 ORDER BY indexname`, [table])
  .then(entries => entries.map(entry => entry.indexname));
/**
 * Inserts a job with every documented column present, so one override names one broken constraint.
 * Unless a caller names one, each row gets a fresh synthetic adult, so a refused row's constraint is
 * never confused with the one-job-per-subject uniqueness.
 */
const insertJob = async (overrides = {}) => {
  const requestedAt = overrides.requested_at instanceof Date ? overrides.requested_at : new Date();
  const subjectId = Object.hasOwn(overrides, 'subject_id') ? overrides.subject_id : await addSubject();
  const row = { id: randomUUID(), state: 'accepted', requested_at: requestedAt,
    local_data_deleted: false, provider_revocation_pending: false, receipt_secret_hash: sha256(),
    receipt_expires_at: new Date(+requestedAt + 30 * day), completed_at: null, last_error_code: null,
    ...overrides, subject_id: subjectId };
  return db.app.query(`INSERT INTO siyue.${table}(id,subject_id,state,requested_at,local_data_deleted,
      provider_revocation_pending,receipt_secret_hash,receipt_expires_at,completed_at,last_error_code)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
  [row.id, row.subject_id, row.state, row.requested_at, row.local_data_deleted,
    row.provider_revocation_pending, row.receipt_secret_hash, row.receipt_expires_at, row.completed_at, row.last_error_code]);
};
/** Inserts a job naming only the required columns, so the row shows what each DEFAULT produced. */
const insertDefaults = (subjectId) => {
  const requestedAt = new Date();
  return db.app.query(`INSERT INTO siyue.${table}(id,subject_id,requested_at,receipt_secret_hash,receipt_expires_at)
    VALUES($1,$2,$3,$4,$5) RETURNING *`,
  [randomUUID(), subjectId, requestedAt, sha256(), new Date(+requestedAt + day)]);
};

test('0015 upgrades 0014 in place, adds exactly one table and re-runs idempotently', async () => {
  // Fresh head: the checked-in manifest applied this migration as siyue_owner.
  assert.deepEqual(await tableColumns(), columns);
  const [owner] = await rows(`SELECT relowner='siyue_owner'::regrole AS owned FROM pg_class
    WHERE relnamespace='siyue'::regnamespace AND relname=$1`, [table]);
  assert.equal(owner.owned, true, 'the migrator owns the new table');
  assert.deepEqual((await rows(`SELECT version FROM siyue.schema_migrations WHERE version LIKE '0015\\_%'`))
    .map(entry => entry.version), ['0015_account_deletion_jobs.sql']);
  // Re-running the migrator against the same manifest changes nothing.
  assert.equal(await migrateDatabase(db.migrator, db.identity), 0);
  assert.deepEqual(await tableColumns(), columns, 'idempotent re-run leaves the column contract alone');

  // Additive upgrade from a real pre-0015 database: 0001..0014 applied without this table, existing
  // rows untouched, then only 0015 lands from the checked-in manifest.
  const legacy = await startPostgresFixture({ migrate: false });
  const directory = mkdtempSync('/tmp/siyue-deletion-upgrade-');
  const priorSubject = randomUUID();
  const priorSession = randomUUID();
  try {
    const previous = (await readMigrations()).filter(migration => migration.version <= '0014_apple_child_approval_reauth.sql');
    assert.equal(previous.length, 14);
    for (const migration of previous) writeFileSync(join(directory, migration.version), migration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 14);
    assert.equal((await legacy.admin.query('SELECT to_regclass($1) AS present', [`siyue.${table}`])).rows[0].present, null,
      '0014 has no deletion job table');
    const before = (await legacy.admin.query(`SELECT relname FROM pg_class
      WHERE relnamespace='siyue'::regnamespace AND relkind='r' ORDER BY relname`)).rows.map(entry => entry.relname);
    // A real pre-0015 adult with an active session: 0015 is purely additive, so both stay valid.
    await legacy.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'adult','Synthetic prior adult')", [priorSubject]);
    await legacy.app.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,credential_version,
        authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES($1,$2,$3,'email',1,now(),now(),now(),now()+interval '30 days',now()+interval '180 days')`,
    [priorSession, priorSubject, randomUUID()]);
    // Apply exactly 0015 in isolation before later additive migrations, so this assertion keeps
    // proving the deletion-job migration itself adds exactly one table.
    const jobsMigration=(await readMigrations()).find(migration=>migration.version==='0015_account_deletion_jobs.sql');
    assert.ok(jobsMigration);
    writeFileSync(join(directory,jobsMigration.version),jobsMigration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity,pathToFileURL(directory+'/')), 1);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity,pathToFileURL(directory+'/')), 0);
    const after = (await legacy.admin.query(`SELECT relname FROM pg_class
      WHERE relnamespace='siyue'::regnamespace AND relkind='r' ORDER BY relname`)).rows.map(entry => entry.relname);
    // Exactly one table arrives, so no anti-revival ledger crept into the restorable main database.
    assert.deepEqual(after.filter(name => !before.includes(name)), [table]);
    assert.deepEqual(before.filter(name => !after.includes(name)), [], 'no pre-existing table is dropped');
    const upgraded = (await legacy.admin.query('SELECT display_name FROM siyue.subjects WHERE id=$1', [priorSubject])).rows[0];
    assert.equal(upgraded.display_name, 'Synthetic prior adult');
    assert.equal((await legacy.admin.query('SELECT subject_id FROM siyue.auth_sessions WHERE id=$1', [priorSession])).rows[0].subject_id, priorSubject);
    assert.equal((await legacy.admin.query("SELECT has_table_privilege('siyue_app',$1,'SELECT,INSERT,UPDATE,DELETE') AS ok", [`siyue.${table}`])).rows[0].ok, true);
    assert.equal(await migrateDatabase(legacy.migrator,legacy.identity),(await readMigrations()).length-previous.length-1);
  } finally { rmSync(directory, { recursive: true, force: true }); await legacy.stop(); }
});

test('one deletion job per subject and one receipt digest per job', async () => {
  const subject = await addSubject();
  const job = (await insertJob({ subject_id: subject })).rows[0];
  assert.equal(job.subject_id, subject);
  // A second job for the same subject is refused by the database instead of racing a read, so a
  // repeated request updates the existing job.
  await failure(insertJob({ subject_id: subject }), '23505', 'second job for one subject');
  await failure(insertJob({ subject_id: null }), '23502', 'subject link required');
  await failure(insertJob({ subject_id: randomUUID() }), '23503', 'unknown subject');
  // The receipt digest identifies exactly one job, so a colliding digest cannot read another job.
  await failure(insertJob({ subject_id: await addSubject(), receipt_secret_hash: job.receipt_secret_hash }), '23505', 'duplicate receipt digest');
  await failure(insertJob({ id: job.id, subject_id: await addSubject() }), '23505', 'duplicate job id');
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.${table}`), 1);
});

test('deletion jobs hold their state, defaults, receipt window and bounded error code', async () => {
  const required = await insertDefaults(await addSubject());
  const defaults = required.rows[0];
  // The accepted default is a recorded request only: neither cleanup dimension claims to be done.
  assert.deepEqual([defaults.state, defaults.local_data_deleted, defaults.provider_revocation_pending],
    ['accepted', false, false]);
  assert.deepEqual([defaults.completed_at, defaults.last_error_code], [null, null]);
  assert.equal(+defaults.receipt_expires_at - +defaults.requested_at, day);

  const requestedAt = new Date();
  const job = (overrides = {}) => insertJob({ requested_at: requestedAt, ...overrides });
  // Every documented state is accepted, including the attention branch an operator reads.
  for (const state of ['accepted', 'processing', 'needs_attention']) {
    assert.equal((await insertJob({ subject_id: await addSubject(), state })).rows[0].state, state);
  }
  await failure(job({ state: 'pending' }), '23514', 'unknown state');
  await failure(job({ state: null }), '23502', 'state required');
  await failure(job({ requested_at: null }), '23502', 'request time required');
  await failure(job({ receipt_expires_at: null }), '23502', 'receipt expiry required');
  // The receipt can never outlive the request it belongs to, but it may expire later than a job that
  // is still being processed.
  await failure(job({ receipt_expires_at: requestedAt }), '23514', 'receipt expiring at request time');
  await failure(job({ receipt_expires_at: new Date(+requestedAt - day) }), '23514', 'receipt expiring before the request');
  assert.ok((await job({ receipt_expires_at: new Date(+requestedAt + day) })).rows[0].receipt_expires_at);
  // Only a 64-character lowercase hex digest is stored; the secret itself never lands here.
  await failure(job({ receipt_secret_hash: sha256().toUpperCase() }), '23514', 'uppercase digest');
  await failure(job({ receipt_secret_hash: 'ab'.repeat(31) }), '23514', 'short digest');
  await failure(job({ receipt_secret_hash: 'z'.repeat(64) }), '23514', 'non-hex digest');
  await failure(job({ receipt_secret_hash: null }), '23502', 'digest required');
  assert.equal((await job({ receipt_secret_hash: 'a'.repeat(64) })).rows[0].receipt_secret_hash, 'a'.repeat(64));
  // The stored code is a bounded snake_case token a client may show, never a message or stack.
  assert.equal((await job({ last_error_code: 'provider_revoke_timeout' })).rows[0].last_error_code, 'provider_revoke_timeout');
  assert.equal((await job({ last_error_code: `code_${'x'.repeat(59)}` })).rows[0].last_error_code.length, 64);
  await failure(job({ last_error_code: 'Provider Timeout' }), '23514', 'code with spaces and capitals');
  await failure(job({ last_error_code: '_leading' }), '23514', 'code starting with a separator');
  await failure(job({ last_error_code: '9numeric' }), '23514', 'code starting with a digit');
  await failure(job({ last_error_code: 'a'.repeat(65) }), '23514', 'code above the bound');
  await failure(job({ last_error_code: 'delete-account failed' }), '23514', 'code with a hyphen and spaces');
});

test('a completion stamp is only accepted once nothing is outstanding', async () => {
  const requestedAt = new Date();
  const completedAt = new Date(+requestedAt + day);
  const job = (overrides = {}) => insertJob({ requested_at: requestedAt, ...overrides });
  // A completion stamp on a job whose local data is still present would claim the account was
  // deleted when it was not.
  await failure(job({ completed_at: completedAt }), '23514', 'completion without local deletion');
  await failure(job({ state: 'completed', local_data_deleted: true }), '23514', 'completed state without stamp');
  await failure(job({ state: 'accepted', local_data_deleted: true, completed_at: completedAt }), '23514', 'stamp without completed state');
  await failure(job({ state: 'completed', local_data_deleted: true, completed_at: new Date(+requestedAt - 1) }),
    '23514', 'completion before request');
  // A pending external revocation is not a completed job: the design forbids merging the two
  // dimensions into one "all done" answer.
  await failure(job({ state: 'completed', completed_at: completedAt, local_data_deleted: true, provider_revocation_pending: true }),
    '23514', 'completion with an outstanding revocation');
  await failure(job({ completed_at: completedAt, local_data_deleted: false, provider_revocation_pending: false }),
    '23514', 'completion without local deletion');
  // The refused rows never landed, and the accepted shape is the only completed one.
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.${table}`), 0);
  const finished = (await job({ state: 'completed', local_data_deleted: true, completed_at: completedAt })).rows[0];
  assert.deepEqual([finished.state, finished.local_data_deleted, finished.provider_revocation_pending], ['completed', true, false]);
  assert.ok(finished.completed_at);
  // An unfinished job may still be waiting on the provider without carrying a completion stamp.
  const waiting = (await job({ state: 'needs_attention', local_data_deleted: true, provider_revocation_pending: true,
    last_error_code: 'provider_revoke_timeout' })).rows[0];
  assert.deepEqual([waiting.completed_at, waiting.provider_revocation_pending], [null, true]);
});

test('receipt expiry is indexed and the runtime role stays DML-only on the new table', async () => {
  // Index inventory is part of the migration contract: the primary key, the subject uniqueness, the
  // receipt uniqueness and the one explicit expiry index used by sweeps.
  assert.deepEqual(await indexesOf(), ['account_deletion_jobs_pkey', 'account_deletion_jobs_receipt_expires_at',
    'account_deletion_jobs_receipt_secret_hash_key', 'account_deletion_jobs_subject_id_key']);
  const [expiry] = await rows(`SELECT indexdef FROM pg_indexes WHERE schemaname='siyue' AND indexname='account_deletion_jobs_receipt_expires_at'`);
  assert.match(expiry.indexdef, /CREATE INDEX/);
  assert.match(expiry.indexdef, /ON siyue\.account_deletion_jobs USING btree \(receipt_expires_at\)/);
  // The subject uniqueness is the database backstop for "at most one job per account".
  const [unique] = await rows(`SELECT indexdef FROM pg_indexes WHERE schemaname='siyue' AND indexname='account_deletion_jobs_subject_id_key'`);
  assert.match(unique.indexdef, /CREATE UNIQUE INDEX/);

  const privilege = (role, what) => rows('SELECT has_table_privilege($1,$2,$3) AS ok', [role, `siyue.${table}`, what])
    .then(entries => entries[0].ok);
  // Access comes from the schema default privileges, not from an explicit GRANT in 0015.
  assert.equal(await privilege('siyue_app', 'SELECT,INSERT,UPDATE,DELETE'), true);
  // This is a mutable job table, not the independent anti-revival ledger; the application can
  // progress and eventually remove job rows, while the separate ledger must retain deletion proof.
  assert.equal(await privilege('siyue_app', 'TRUNCATE'), false);
  assert.deepEqual(await rows("SELECT table_name FROM information_schema.table_privileges WHERE grantee='siyue_app' AND table_schema='siyue' AND privilege_type='TRUNCATE'"), []);
  // An unrelated login role is granted nothing on the job table.
  await db.admin.query('CREATE ROLE synthetic_deletion_probe LOGIN');
  try {
    assert.equal(await privilege('synthetic_deletion_probe', 'SELECT'), false);
    assert.equal(await privilege('synthetic_deletion_probe', 'INSERT'), false);
  } finally { await db.admin.query('DROP ROLE synthetic_deletion_probe'); }

  // The runtime role may write rows...
  const subject = await addSubject();
  const id = (await insertDefaults(subject)).rows[0].id;
  await db.app.query(`UPDATE siyue.${table} SET state='processing' WHERE id=$1`, [id]);
  assert.equal((await rows(`SELECT state FROM siyue.${table} WHERE id=$1`, [id]))[0].state, 'processing');
  // ...but has no DDL, no ownership and no way to reach the migrator role.
  for (const sql of [`CREATE TABLE siyue.forbidden_deletion(id int)`, `CREATE TABLE public.forbidden_deletion(id int)`,
    `ALTER TABLE siyue.${table} ADD COLUMN forbidden int`, `ALTER TABLE siyue.${table} DROP COLUMN last_error_code`,
    `DROP TABLE siyue.${table}`, `CREATE INDEX forbidden_deletion ON siyue.${table}(state)`,
    `CREATE SCHEMA forbidden_deletion`, 'SET ROLE siyue_owner']) {
    await failure(db.app.query(sql), '42501', sql);
  }
  // The refused DDL changed neither the table nor its index inventory.
  assert.deepEqual(await tableColumns(), columns);
  assert.deepEqual(await indexesOf(), ['account_deletion_jobs_pkey', 'account_deletion_jobs_receipt_expires_at',
    'account_deletion_jobs_receipt_secret_hash_key', 'account_deletion_jobs_subject_id_key']);
  // Nothing was added to the schema beyond the one job table this migration owns.
  assert.equal((await rows(`SELECT to_regclass('siyue.forbidden_deletion') AS present`))[0].present, null);
});
