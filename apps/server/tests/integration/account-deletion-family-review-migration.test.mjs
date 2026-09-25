import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { migrateDatabase, readMigrations } from '../../dist/adapters/postgres/migrate.js';

// Account-deletion frozen-family review markers (design 13.2, migration 0022) against an isolated
// temporary PostgreSQL cluster only: the fixture always builds a fresh cluster on a short Unix socket
// and never reads a database URL or the workspace .env. Every identifier and instant below is
// synthetic, and no mail, provider, shell or network call happens. The table only records that a
// frozen family is still owed a review; the internal process that resolves markers is deliberately
// not modelled here.
const day = 86_400_000;
const table = 'account_deletion_family_reviews';
// The 0022 contract this migration installed, kept separate from the head contract below so the upgrade
// leg can still assert what 0022 alone did. No work, message, homework, file, room or archive content
// column, no email, display name or provider credential column, no child identifier, guardian flag or
// scope column, and no assignee, resolver, outcome or reason column may be added to this table.
const columnsAt022 = ['id', 'deletion_id', 'family_id', 'deleting_subject_id', 'state', 'opened_at',
  'resolved_at'];
// The head contract: 0022's columns plus migration 0026's `deleting_redacted_at`, the instant a closed
// marker's owner link was cleared for an account deletion. It names no subject and carries no profile
// field, and it is the only column 0026 adds here -- appended, so 0022's own ordinal positions stand.
const columns = [...columnsAt022, 'deleting_redacted_at'];
const pendingIndex = 'account_deletion_family_reviews_pending_family';
const jobPairIndex = 'account_deletion_family_reviews_deletion_id_family_id_key';
let db;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => { await db.admin.query('TRUNCATE siyue.subjects CASCADE'); });
after(async () => { await db?.stop(); });

/** Tolerates both `rows(sql, a, b)` and `rows(sql, [a, b])` call styles. */
const bindings = args => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
const rows = (sql, ...args) => db.app.query(sql, bindings(args)).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
/** Counts rows through an explicit pool, for checks made as the administrator rather than siyue_app. */
const countOn = (pool, sql, ...args) => pool.query(sql, bindings(args)).then(result => Number(result.rows[0].n));
const sha256 = () => createHash('sha256').update(randomUUID()).digest('hex');
/** Asserts the database refused a statement with one SQLSTATE, quoting the constraint it broke. */
const failure = async (query, code, label) => {
  const error = await query.then(() => null, thrown => thrown);
  assert.equal(error?.code, code, `${label ?? ''} ${error?.constraint ?? error?.message}`.trim());
};
const addSubject = (kind = 'adult') => db.app
  .query('INSERT INTO siyue.subjects(id,kind) VALUES($1,$2) RETURNING id', [randomUUID(), kind])
  .then(result => result.rows[0].id);
/**
 * A real frozen family: the sole owner asked to be deleted, so the family waits for a review while
 * its owner membership still exists. This is the state design 13.2 leaves behind, not a fixture that
 * rearranges existing rows.
 */
const addFrozenFamily = async () => {
  const owner = await addSubject();
  const familyId = randomUUID();
  await db.app.query("INSERT INTO siyue.families(id,status,owner_subject_id,version) VALUES($1,'frozen',$2,2)",
    [familyId, owner]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner')",
    [familyId, owner]);
  return { owner, familyId };
};
/** The durable deletion job whose acceptance froze a family, so a marker can bind the real job. */
const addJob = subjectId => db.app.query(`INSERT INTO siyue.account_deletion_jobs
    (id,subject_id,requested_at,receipt_secret_hash,receipt_expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id`,
  [randomUUID(), subjectId, new Date(), sha256(), new Date(Date.now() + 30 * day)]).then(result => result.rows[0].id);
/**
 * Inserts a marker with every documented column present, so one override names one broken constraint.
 * Unless a caller names one, each row gets a fresh frozen family and deletion job, so a refused row's
 * constraint is never confused with the one-pending-per-family backstop.
 */
const insertReview = async (overrides = {}) => {
  const scene = overrides.scene ?? await addFrozenFamily();
  const field = (name, fallback) => Object.hasOwn(overrides, name) ? overrides[name] : fallback;
  const row = {
    id: field('id', randomUUID()),
    deletion_id: Object.hasOwn(overrides, 'deletion_id') ? overrides.deletion_id : await addJob(scene.owner),
    family_id: field('family_id', scene.familyId),
    deleting_subject_id: field('deleting_subject_id', scene.owner),
    state: field('state', 'pending'),
    opened_at: field('opened_at', new Date()),
    resolved_at: field('resolved_at', null),
  };
  return db.app.query(`INSERT INTO siyue.${table}
      (id,deletion_id,family_id,deleting_subject_id,state,opened_at,resolved_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
  [row.id, row.deletion_id, row.family_id, row.deleting_subject_id, row.state, row.opened_at, row.resolved_at]);
};
/**
 * Inserts exactly the columns the internal acceptance kernel writes, so this file proves the migration
 * against the wired statement rather than a convenience variant of it.
 */
const insertAcceptanceMarker = async (scene) => {
  const target = scene ?? await addFrozenFamily();
  const row = { id: randomUUID(), deletionId: await addJob(target.owner), openedAt: new Date() };
  return db.app.query(`INSERT INTO siyue.${table}
      (id,deletion_id,family_id,deleting_subject_id,state,opened_at)
    VALUES($1,$2,$3,$4,'pending',$5) RETURNING *`,
  [row.id, row.deletionId, target.familyId, target.owner, row.openedAt]).then(result => ({ ...result.rows[0], deletionId: row.deletionId }));
};
/** Inserts a marker naming only the required columns, so the row shows what each DEFAULT produced. */
const insertWithoutState = async (scene) => {
  const target = scene ?? await addFrozenFamily();
  return db.app.query(`INSERT INTO siyue.${table}
      (id,deletion_id,family_id,deleting_subject_id,opened_at) VALUES($1,$2,$3,$4,$5) RETURNING *`,
  [randomUUID(), await addJob(target.owner), target.familyId, target.owner, new Date()]);
};
const resolveReview = id => db.app.query(
  `UPDATE siyue.${table} SET state='resolved',resolved_at=$2 WHERE id=$1 RETURNING *`, [id, new Date()]);
const tableColumns = async () => (await rows(`SELECT column_name FROM information_schema.columns
  WHERE table_schema='siyue' AND table_name=$1 ORDER BY ordinal_position`, [table])).map(entry => entry.column_name);
const indexesOf = () => rows(`SELECT indexname FROM pg_indexes WHERE schemaname='siyue' AND tablename=$1 ORDER BY indexname`, [table])
  .then(entries => entries.map(entry => entry.indexname));

test('0022 upgrades 0021 in place, adds exactly one table and re-runs idempotently', async () => {
  // Fresh head: the checked-in manifest applied this migration as siyue_owner.
  assert.deepEqual(await tableColumns(), columns);
  // The head is 0022's table plus 0026's redaction stamp, and only the owner link became nullable: the
  // redaction is expressed by clearing that one column and recording when, never by deleting the row.
  assert.deepEqual(await rows(`SELECT column_name,is_nullable FROM information_schema.columns
    WHERE table_schema='siyue' AND table_name=$1 AND is_nullable='YES' ORDER BY column_name`, [table]),
  [{ column_name: 'deleting_redacted_at', is_nullable: 'YES' },
    { column_name: 'deleting_subject_id', is_nullable: 'YES' },
    { column_name: 'resolved_at', is_nullable: 'YES' }]);
  const [owner] = await rows(`SELECT relowner='siyue_owner'::regrole AS owned FROM pg_class
    WHERE relnamespace='siyue'::regnamespace AND relname=$1`, [table]);
  assert.equal(owner.owned, true, 'the migrator owns the new table');
  assert.deepEqual((await rows(`SELECT version FROM siyue.schema_migrations WHERE version LIKE '0022\\_%'`))
    .map(entry => entry.version), ['0022_account_deletion_family_reviews.sql']);
  // Re-running the migrator against the same manifest changes nothing.
  assert.equal(await migrateDatabase(db.migrator, db.identity), 0);
  assert.deepEqual(await tableColumns(), columns, 'idempotent re-run leaves the column contract alone');

  // Additive upgrade from a real pre-0022 database: 0001..0021 applied without this table, then only
  // 0022 lands. The pre-existing rows below stand in for a frozen family whose sole owner already
  // asked to be deleted, which is exactly the state a marker is written for.
  const legacy = await startPostgresFixture({ migrate: false });
  const directory = mkdtempSync('/tmp/siyue-family-review-upgrade-');
  const deletingSubject = randomUUID();
  const frozenFamily = randomUUID();
  const priorSession = randomUUID();
  const priorJob = randomUUID();
  try {
    const migrations = await readMigrations();
    const previous = migrations.filter(migration => migration.version <= '0021_family_management_acceptance.sql');
    assert.equal(previous.length, 21);
    for (const migration of previous) writeFileSync(join(directory, migration.version), migration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 21);
    assert.equal((await legacy.admin.query('SELECT to_regclass($1) AS present', [`siyue.${table}`])).rows[0].present, null,
      '0021 has no family review table');
    const before = (await legacy.admin.query(`SELECT relname FROM pg_class
      WHERE relnamespace='siyue'::regnamespace AND relkind='r' ORDER BY relname`)).rows.map(entry => entry.relname);
    await legacy.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'adult','Synthetic prior adult')", [deletingSubject]);
    await legacy.app.query("INSERT INTO siyue.families(id,status,owner_subject_id,version) VALUES($1,'frozen',$2,2)",
      [frozenFamily, deletingSubject]);
    await legacy.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner')",
      [frozenFamily, deletingSubject]);
    await legacy.app.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,credential_version,
        authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES($1,$2,$3,'email',1,now(),now(),now(),now()+interval '30 days',now()+interval '180 days')`,
    [priorSession, deletingSubject, randomUUID()]);
    await legacy.app.query(`INSERT INTO siyue.account_deletion_jobs(id,subject_id,requested_at,receipt_secret_hash,receipt_expires_at)
      VALUES($1,$2,now(),$3,now()+interval '30 days')`, [priorJob, deletingSubject, sha256()]);
    const familyBefore = (await legacy.admin.query('SELECT id,status,owner_subject_id,version FROM siyue.families WHERE id=$1',
      [frozenFamily])).rows[0];
    // Apply exactly 0022 in isolation, so this assertion keeps proving the review migration itself
    // adds exactly one table and leaves every earlier row alone.
    const reviewMigration = migrations.find(migration => migration.version === '0022_account_deletion_family_reviews.sql');
    assert.ok(reviewMigration);
    writeFileSync(join(directory, reviewMigration.version), reviewMigration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 1);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 0);
    // The checked-in 0022 entry is exactly what this upgrade applied: same version, same checksum.
    // Later additive migrations may exist in the manifest, so the recorded row for 0022 is compared
    // directly instead of asserting that the manifest has nothing newer than this migration.
    assert.deepEqual((await legacy.admin.query('SELECT version, checksum FROM siyue.schema_migrations WHERE version=$1',
      [reviewMigration.version])).rows[0], { version: reviewMigration.version, checksum: reviewMigration.checksum });
    const after = (await legacy.admin.query(`SELECT relname FROM pg_class
      WHERE relnamespace='siyue'::regnamespace AND relkind='r' ORDER BY relname`)).rows.map(entry => entry.relname);
    assert.deepEqual(after.filter(name => !before.includes(name)), [table]);
    assert.deepEqual(before.filter(name => !after.includes(name)), [], 'no pre-existing table is dropped');
    // The frozen family, its owner membership and the deleting subject's own rows read exactly as they
    // did before the marker table arrived: this migration freezes nothing and rewrites nothing.
    assert.deepEqual((await legacy.admin.query('SELECT id,status,owner_subject_id,version FROM siyue.families WHERE id=$1',
      [frozenFamily])).rows[0], familyBefore, 'the frozen family is left exactly as the acceptance froze it');
    assert.equal((await legacy.admin.query('SELECT display_name FROM siyue.subjects WHERE id=$1',
      [deletingSubject])).rows[0].display_name, 'Synthetic prior adult');
    assert.equal((await legacy.admin.query('SELECT subject_id FROM siyue.auth_sessions WHERE id=$1',
      [priorSession])).rows[0].subject_id, deletingSubject);
    assert.equal((await legacy.admin.query('SELECT subject_id FROM siyue.account_deletion_jobs WHERE id=$1',
      [priorJob])).rows[0].subject_id, deletingSubject);
    // A marker may bind those pre-existing rows, and the runtime role keeps its schema-default DML.
    await legacy.app.query(`INSERT INTO siyue.${table}(id,deletion_id,family_id,deleting_subject_id,state,opened_at)
      VALUES($1,$2,$3,$4,'pending',now())`, [randomUUID(), priorJob, frozenFamily, deletingSubject]);
    assert.equal(await countOn(legacy.admin, `SELECT count(*)::int AS n FROM siyue.${table}
      WHERE deletion_id=$1 AND family_id=$2`, [priorJob, frozenFamily]), 1);
    // 0022 itself kept the owner link NOT NULL and had no redaction stamp: the nullable link and its
    // instant arrive with the separate 0026 migration, so this leg asserts the older contract and does
    // not read the head's structure into the upgrade being proved here.
    assert.deepEqual(await legacy.admin.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='siyue' AND table_name=$1 ORDER BY ordinal_position`, [table]).then(result =>
      result.rows.map(entry => entry.column_name)), columnsAt022);
    const otherSubject = randomUUID(), otherFamily = randomUUID(), otherJob = randomUUID();
    await legacy.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [otherSubject]);
    await legacy.app.query("INSERT INTO siyue.families(id,status,owner_subject_id,version) VALUES($1,'frozen',$2,2)",
      [otherFamily, otherSubject]);
    await legacy.app.query(`INSERT INTO siyue.account_deletion_jobs(id,subject_id,requested_at,
        receipt_secret_hash,receipt_expires_at) VALUES($1,$2,now(),$3,now()+interval '30 days')`,
    [otherJob, otherSubject, sha256()]);
    await failure(legacy.app.query(`INSERT INTO siyue.${table}
        (id,deletion_id,family_id,deleting_subject_id,state,opened_at)
        VALUES($1,$2,$3,NULL,'pending',now())`, [randomUUID(), otherJob, otherFamily]), '23502',
    'a 0022 marker requires its owner link');
    assert.equal((await legacy.admin.query("SELECT has_table_privilege('siyue_app',$1,'SELECT,INSERT,UPDATE,DELETE') AS ok",
      [`siyue.${table}`])).rows[0].ok, true);
  } finally { rmSync(directory, { recursive: true, force: true }); await legacy.stop(); }
});

test('the wired acceptance insert records one pending marker bound to the job, family and deleting subject', async () => {
  const scene = await addFrozenFamily();
  const marker = await insertAcceptanceMarker(scene);
  const jobId = (await rows('SELECT id FROM siyue.account_deletion_jobs WHERE subject_id=$1', [scene.owner]))[0].id;
  assert.deepEqual([marker.deletionId, marker.deletion_id], [jobId, jobId]);
  assert.deepEqual([marker.family_id, marker.deleting_subject_id], [scene.familyId, scene.owner]);
  assert.deepEqual([marker.state, marker.resolved_at], ['pending', null]);
  assert.ok(marker.opened_at);
  // Writing only the required columns produces the same open marker, so neither the state nor the
  // stamp has to be sent by the accepting transaction.
  const bare = (await insertWithoutState(await addFrozenFamily())).rows[0];
  assert.deepEqual([bare.state, bare.resolved_at], ['pending', null]);
  // Every binding is required and must name a real row: an unknown or missing job, family or subject
  // is refused by the database.
  await failure(insertReview({ scene: await addFrozenFamily(), deletion_id: randomUUID() }), '23503', 'unknown deletion job');
  await failure(insertReview({ scene: await addFrozenFamily(), deletion_id: null }), '23502', 'deletion link required');
  await failure(insertReview({ scene: await addFrozenFamily(), family_id: randomUUID() }), '23503', 'unknown family');
  await failure(insertReview({ scene: await addFrozenFamily(), family_id: null }), '23502', 'family link required');
  await failure(insertReview({ scene: await addFrozenFamily(), deleting_subject_id: randomUUID() }), '23503', 'unknown deleting subject');
  // At the head the owner link is nullable, but only for a closed marker and only together with the
  // instant it was cleared: 0022's NOT NULL is relaxed by 0026 and replaced by these two checks, so a
  // null link without its stamp, and a null link on a still-pending marker, are both refused.
  await failure(insertReview({ scene: await addFrozenFamily(), deleting_subject_id: null }), '23514',
    'cleared owner link needs its stamp');
  await failure(insertReview({ scene: await addFrozenFamily(), state: null }), '23502', 'state required');
  // One acceptance cannot open a second marker for the same job and family.
  await failure(insertReview({ scene, deletion_id: marker.deletion_id, family_id: scene.familyId }), '23505',
    'second marker for one job and family');
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.${table}`), 2);
});

test('at most one pending marker per family, and only a resolved row is replaced', async () => {
  const { owner, familyId } = await addFrozenFamily();
  const first = (await insertReview({ scene: { owner, familyId } })).rows[0];
  // A second deletion job touching the same frozen family cannot open a second pending marker. The
  // refusal is the one-per-family backstop index, not the per-job uniqueness.
  const refused = await insertReview({ scene: { owner: await addSubject(), familyId } })
    .then(() => null, thrown => thrown);
  assert.equal(refused?.code, '23505');
  assert.equal(refused?.constraint, pendingIndex);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.${table}`), 1);
  // Closing the marker releases the family while the closed row stays readable as history.
  const resolved = (await resolveReview(first.id)).rows[0];
  assert.deepEqual([resolved.state, typeof resolved.resolved_at], ['resolved', 'object']);
  const replacement = (await insertReview({ scene: { owner: await addSubject(), familyId } })).rows[0];
  assert.notEqual(replacement.id, first.id);
  assert.deepEqual([replacement.state, replacement.resolved_at], ['pending', null]);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.${table} WHERE family_id=$1`, [familyId]), 2);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.${table} WHERE family_id=$1 AND state='pending'`, [familyId]), 1);
  // The job and family pair stays unique for the life of the row, so the original job cannot reopen a
  // marker after its own row was resolved.
  await resolveReview(replacement.id);
  const reused = await insertReview({ scene: { owner: await addSubject(), familyId }, deletion_id: first.deletion_id })
    .then(() => null, thrown => thrown);
  assert.equal(reused?.code, '23505');
  assert.equal(reused?.constraint, jobPairIndex);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.${table} WHERE family_id=$1 AND state='pending'`, [familyId]), 0);
});

test('a marker is pending until it is stamped resolved, and never resolved before it opened', async () => {
  const openedAt = new Date();
  const open = (await insertReview({ scene: await addFrozenFamily(), opened_at: openedAt })).rows[0];
  assert.deepEqual([open.state, open.resolved_at], ['pending', null]);
  // Every documented state is accepted, including the closed one the internal process writes.
  assert.equal((await insertReview({ scene: await addFrozenFamily(), state: 'resolved', opened_at: openedAt,
    resolved_at: new Date(+openedAt + day) })).rows[0].state, 'resolved');
  await failure(insertReview({ scene: await addFrozenFamily(), state: 'open', opened_at: openedAt }), '23514', 'unknown state');
  await failure(insertReview({ scene: await addFrozenFamily(), opened_at: null }), '23502', 'open time required');
  // A row is never both waiting and closed, in either direction.
  await failure(insertReview({ scene: await addFrozenFamily(), state: 'pending', opened_at: openedAt,
    resolved_at: new Date(+openedAt + day) }), '23514', 'pending with a stamp');
  await failure(insertReview({ scene: await addFrozenFamily(), state: 'resolved', opened_at: openedAt }),
    '23514', 'resolved without a stamp');
  // Closing cannot predate opening, while closing exactly at opening time is allowed.
  await failure(insertReview({ scene: await addFrozenFamily(), state: 'resolved', opened_at: openedAt,
    resolved_at: new Date(+openedAt - day) }), '23514', 'resolved before it opened');
  assert.ok((await insertReview({ scene: await addFrozenFamily(), state: 'resolved', opened_at: openedAt,
    resolved_at: openedAt })).rows[0].resolved_at);
  // The runtime role closes a marker in place, and the check constraint refuses reopening it.
  const closed = (await insertReview({ scene: await addFrozenFamily(), opened_at: openedAt })).rows[0];
  await db.app.query(`UPDATE siyue.${table} SET state='resolved',resolved_at=$2 WHERE id=$1`,
    [closed.id, new Date(+openedAt + day)]);
  await failure(db.app.query(`UPDATE siyue.${table} SET state='pending' WHERE id=$1`, [closed.id]), '23514', 'reopened marker');
  await failure(db.app.query(`UPDATE siyue.${table} SET resolved_at=NULL WHERE id=$1`, [closed.id]), '23514', 'closed marker without a stamp');
});

test('the marker holds only ids and instants, and the runtime role stays DML-only', async () => {
  // Index inventory is part of the migration contract: the primary key, the per-job uniqueness and
  // the one-pending-per-family backstop.
  assert.deepEqual(await indexesOf(), [jobPairIndex, pendingIndex, `${table}_pkey`]);
  const [pending] = await rows(`SELECT indexdef FROM pg_indexes WHERE schemaname='siyue' AND indexname=$1`, [pendingIndex]);
  assert.match(pending.indexdef, /CREATE UNIQUE INDEX/);
  assert.match(pending.indexdef, /\(family_id\)/);
  assert.match(pending.indexdef, /WHERE .*'pending'/);
  const [pair] = await rows(`SELECT indexdef FROM pg_indexes WHERE schemaname='siyue' AND indexname=$1`, [jobPairIndex]);
  assert.match(pair.indexdef, /CREATE UNIQUE INDEX/);
  assert.match(pair.indexdef, /\(deletion_id, family_id\)/);
  // No column may name shared content, a profile or a child, and none may name a resolver or assignee.
  assert.deepEqual(columns.filter(name =>
    /content|homework|message|file|room|archive|attachment|email|display|child|guardian|scope|assign|handled|resolver|outcome|reason|note|actor/i.test(name)), []);

  const privilege = (role, what) => rows('SELECT has_table_privilege($1,$2,$3) AS ok', [role, `siyue.${table}`, what])
    .then(entries => entries[0].ok);
  // Access comes from the schema default privileges, not from an explicit GRANT in 0022.
  assert.equal(await privilege('siyue_app', 'SELECT,INSERT,UPDATE,DELETE'), true);
  // A marker is mutable history, so the application opens and closes rows, while nothing grants the
  // runtime role a way to empty the table in one statement.
  assert.equal(await privilege('siyue_app', 'TRUNCATE'), false);
  assert.deepEqual(await rows("SELECT table_name FROM information_schema.table_privileges WHERE grantee='siyue_app' AND table_schema='siyue' AND privilege_type='TRUNCATE'"), []);
  // An unrelated login role is granted nothing on the marker table.
  await db.admin.query('CREATE ROLE synthetic_family_review_probe LOGIN');
  try {
    assert.equal(await privilege('synthetic_family_review_probe', 'SELECT'), false);
    assert.equal(await privilege('synthetic_family_review_probe', 'INSERT'), false);
  } finally { await db.admin.query('DROP ROLE synthetic_family_review_probe'); }

  // The runtime role may open and close markers...
  const marker = (await insertWithoutState(await addFrozenFamily())).rows[0];
  await db.app.query(`UPDATE siyue.${table} SET state='resolved',resolved_at=$2 WHERE id=$1`, [marker.id, new Date()]);
  assert.equal((await rows(`SELECT state FROM siyue.${table} WHERE id=$1`, [marker.id]))[0].state, 'resolved');
  // ...but has no DDL, no ownership and no way to reach the migrator role, so the internal process is
  // a runtime path over this table and not a schema edit.
  for (const sql of [`CREATE TABLE siyue.forbidden_family_review(id int)`, `ALTER TABLE siyue.${table} ADD COLUMN forbidden int`,
    `ALTER TABLE siyue.${table} DROP COLUMN state`, `DROP TABLE siyue.${table}`,
    `CREATE INDEX forbidden_family_review ON siyue.${table}(family_id)`, `CREATE SCHEMA forbidden_family_review`, 'SET ROLE siyue_owner']) {
    await failure(db.app.query(sql), '42501', sql);
  }
  // The refused DDL changed neither the column contract nor the schema inventory.
  assert.deepEqual(await tableColumns(), columns);
  assert.deepEqual(await indexesOf(), [jobPairIndex, pendingIndex, `${table}_pkey`]);
  assert.equal((await rows(`SELECT to_regclass('siyue.forbidden_family_review') AS present`))[0].present, null);
});
