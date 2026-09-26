import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { migrateDatabase, readMigrations } from '../../dist/adapters/postgres/migrate.js';
import { transaction } from '../../dist/adapters/postgres/database.js';

// Isolated temporary PostgreSQL cluster only: the fixture always builds a fresh cluster on a short
// Unix socket and never reads a database URL or the workspace .env. Every identifier, digest and
// label below is synthetic, and no mail, provider, shell or network call happens.
const minute = 60_000;
const day = 86_400_000;
const tables = ['consent_records', 'guardian_relationships', 'device_pairing_requests', 'device_grants'];
let db;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query(`TRUNCATE siyue.auth_sessions,siyue.device_grants,siyue.device_pairing_requests,
    siyue.guardian_relationships,siyue.consent_records,siyue.family_invitations,siyue.family_memberships,
    siyue.family_create_requests,siyue.families,siyue.subjects CASCADE`);
});
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
/** Inserts a subject with the application role; adults and children differ only in `kind`. */
const addSubject = kind => db.app
  .query('INSERT INTO siyue.subjects(id,kind) VALUES($1,$2) RETURNING id', [randomUUID(), kind])
  .then(result => result.rows[0].id);
const addFamily = async () => db.app
  .query('INSERT INTO siyue.families(id,owner_subject_id) VALUES($1,$2) RETURNING id', [randomUUID(), await addSubject('adult')])
  .then(result => result.rows[0].id);
const insertConsent = (overrides = {}) => {
  const row = { id: randomUUID(), actor_subject_id: null, subject_id: null, purpose: 'guardian-child-device',
    policy_version: 'child-device-pairing-v1', recorded_at: new Date(), withdrawn_at: null, ...overrides };
  return db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version,recorded_at,withdrawn_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
  [row.id, row.actor_subject_id, row.subject_id, row.purpose, row.policy_version, row.recorded_at, row.withdrawn_at]);
};
const insertGuardian = (overrides = {}) => {
  const row = { family_id: null, guardian_subject_id: null, child_subject_id: null, active: true, version: 1,
    consent_record_id: null, created_at: new Date(), ...overrides };
  return db.app.query(`INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,active,version,
      consent_record_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
  [row.family_id, row.guardian_subject_id, row.child_subject_id, row.active, row.version, row.consent_record_id, row.created_at]);
};
const insertPairing = (overrides = {}) => {
  const createdAt = overrides.created_at ?? new Date();
  const row = { id: randomUUID(), request_token_hash: sha256(), poll_secret_hash: sha256(),
    installation_id: randomUUID(), platform: 'ios', device_label: 'Synthetic child iPad', status: 'pending',
    approved_by: null, child_subject_id: null, family_id: null,
    approved_guardian_version: null, approved_credential_version: null, approved_at: null, consumed_at: null,
    created_at: createdAt, expires_at: new Date(+createdAt + 2 * minute), ...overrides };
  return db.app.query(`INSERT INTO siyue.device_pairing_requests(id,request_token_hash,poll_secret_hash,installation_id,platform,
      device_label,status,approved_by,child_subject_id,family_id,approved_guardian_version,approved_credential_version,
      created_at,expires_at,approved_at,consumed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
  [row.id, row.request_token_hash, row.poll_secret_hash, row.installation_id, row.platform, row.device_label,
    row.status, row.approved_by, row.child_subject_id, row.family_id, row.approved_guardian_version,
    row.approved_credential_version, row.created_at, row.expires_at,
    row.approved_at, row.consumed_at]);
};
/** Inserts a device grant, optionally on a caller-supplied client that already set the session state. */
const insertGrant = (overrides = {}, client = db.app) => {
  const createdAt = overrides.created_at ?? new Date();
  const row = { id: randomUUID(), child_subject_id: null, guardian_id: null, family_id: null,
    installation_id: randomUUID(), platform: 'ios', device_label: 'Synthetic child iPad',
    guardian_relationship_version: 1, guardian_credential_version: 1, scopes: ['room.join', 'board.read'],
    version: 1, created_at: createdAt, expires_at: new Date(+createdAt + 30 * day), revoked_at: null, ...overrides };
  return client.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,
      platform,device_label,guardian_relationship_version,guardian_credential_version,scopes,version,created_at,expires_at,revoked_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [row.id, row.child_subject_id, row.guardian_id, row.family_id, row.installation_id,
    row.platform, row.device_label, row.guardian_relationship_version, row.guardian_credential_version,
    row.scopes, row.version, row.created_at, row.expires_at, row.revoked_at]);
};
const insertSession = (overrides = {}) => {
  const now = overrides.created_at ?? new Date();
  const row = { id: randomUUID(), subject_id: null, installation_id: randomUUID(), auth_method: 'child',
    credential_version: 1, authenticated_at: now, created_at: now, last_seen_at: now,
    idle_expires_at: new Date(+now + 30 * day), absolute_expires_at: new Date(+now + 180 * day),
    grant_expires_at: new Date(+now + 30 * day), device_grant_id: null, ...overrides };
  return db.app.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,credential_version,
      authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at,grant_expires_at,device_grant_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
  [row.id, row.subject_id, row.installation_id, row.auth_method, row.credential_version, row.authenticated_at,
    row.created_at, row.last_seen_at, row.idle_expires_at, row.absolute_expires_at, row.grant_expires_at,
    row.device_grant_id]);
};

/** Minimal synthetic household: one family, one adult guardian and one child subject with consent. */
async function scene() {
  const owner = await addSubject('adult');
  const familyId = await addFamily();
  const guardian = await addSubject('adult');
  const child = await addSubject('child');
  const consentRecordId = (await insertConsent({ actor_subject_id: owner, subject_id: child })).rows[0].id;
  return { owner, familyId, guardian, child, consentRecordId };
}

const indexesOf = table => rows("SELECT indexname FROM pg_indexes WHERE schemaname='siyue' AND tablename=$1 ORDER BY indexname", [table])
  .then(entries => entries.map(entry => entry.indexname));

test('0011 keeps least privilege, upgrades 0010 in place and leaves older child sessions valid', async () => {
  const privilege = (role, table, what) => rows('SELECT has_table_privilege($1,$2,$3) AS ok', [role, `siyue.${table}`, what])
    .then(entries => entries[0].ok);
  for (const table of tables) {
    assert.equal(await privilege('siyue_app', table, 'SELECT,INSERT,UPDATE,DELETE'), true, table);
    // The application role can use rows but cannot wipe pairing, consent or grant history.
    assert.equal(await privilege('siyue_app', table, 'TRUNCATE'), false, table);
  }
  // Access comes from the schema default privileges, not from an explicit GRANT in 0011.
  assert.deepEqual((await rows(`SELECT relname FROM pg_class WHERE relnamespace='siyue'::regnamespace AND relname = ANY($1)
    AND relowner='siyue_owner'::regrole ORDER BY relname`, [tables])).map(entry => entry.relname), [...tables].sort());
  assert.deepEqual(await rows("SELECT table_name FROM information_schema.table_privileges WHERE grantee='siyue_app' AND table_schema='siyue' AND privilege_type='TRUNCATE'"), []);
  // An unrelated login role is granted nothing on the new tables.
  await db.admin.query('CREATE ROLE synthetic_child_device_probe LOGIN');
  try {
    assert.equal(await privilege('synthetic_child_device_probe', 'device_grants', 'SELECT'), false);
    assert.equal(await privilege('synthetic_child_device_probe', 'consent_records', 'SELECT'), false);
  } finally { await db.admin.query('DROP ROLE synthetic_child_device_probe'); }

  // Index inventory is part of the migration contract.
  assert.deepEqual(await indexesOf('consent_records'), ['consent_records_pkey', 'consent_records_subject']);
  assert.deepEqual(await indexesOf('guardian_relationships'), ['guardian_relationships_child', 'guardian_relationships_consent',
    'guardian_relationships_guardian', 'guardian_relationships_pkey']);
  assert.deepEqual(await indexesOf('device_pairing_requests'), ['device_pairing_requests_approver', 'device_pairing_requests_child',
    'device_pairing_requests_family', 'device_pairing_requests_pending', 'device_pairing_requests_pkey',
    'device_pairing_requests_poll_secret_hash_key', 'device_pairing_requests_request_token_hash_key']);
  assert.deepEqual(await indexesOf('device_grants'), ['device_grants_child', 'device_grants_family', 'device_grants_guardian',
    'device_grants_live', 'device_grants_pkey']);
  assert.ok((await indexesOf('auth_sessions')).includes('auth_sessions_device_grant'));
  const link = (await rows("SELECT indexdef FROM pg_indexes WHERE schemaname='siyue' AND indexname='auth_sessions_device_grant'"))[0].indexdef;
  // One grant backs at most one child session, and NULL links stay out of the uniqueness.
  assert.match(link, /CREATE UNIQUE INDEX/);
  assert.match(link, /WHERE \(device_grant_id IS NOT NULL\)/);

  // Additive upgrade: 0011 can already exist with its original checksum, then 0012 corrects its
  // time bound without rewriting migration history or touching existing sessions.
  const legacy = await startPostgresFixture({ migrate: false });
  const directory = mkdtempSync('/tmp/siyue-child-device-upgrade-');
  const priorSubject = randomUUID(), priorSession = randomUUID();
  try {
    const previous = (await readMigrations()).filter(migration => migration.version <= '0010_family_invitations.sql');
    assert.equal(previous.length, 10);
    for (const migration of previous) writeFileSync(join(directory, migration.version), migration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 10);
    for (const table of tables) {
      assert.equal((await legacy.admin.query('SELECT to_regclass($1) AS present', [`siyue.${table}`])).rows[0].present, null, table);
    }
    // A real pre-0011 restricted session: kind=child, auth_method=child and no grant column yet.
    const checksBefore = Number((await legacy.admin.query("SELECT count(*) AS n FROM pg_constraint WHERE conrelid='siyue.auth_sessions'::regclass AND contype='c'")).rows[0].n);
    await legacy.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')", [priorSubject]);
    await legacy.app.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,credential_version,
        authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES($1,$2,$3,'child',1,now(),now(),now(),now()+interval '30 days',now()+interval '180 days')`,
    [priorSession, priorSubject, randomUUID()]);
    const pairingMigration = (await readMigrations()).find(migration => migration.version === '0011_child_device_pairing.sql');
    assert.ok(pairingMigration);
    writeFileSync(join(directory, pairingMigration.version), pairingMigration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 1);
    // The checked-in manifest may gain later additive migrations; only 0011 was applied from the
    // temporary directory, so the full migrator must apply exactly those remaining entries.
    const later = (await readMigrations()).filter(migration => migration.version > pairingMigration.version);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity), later.length);
    // 0011 only adds the nullable link: no new CHECK can invalidate the session that already exists.
    assert.equal(Number((await legacy.admin.query("SELECT count(*) AS n FROM pg_constraint WHERE conrelid='siyue.auth_sessions'::regclass AND contype='c'")).rows[0].n), checksBefore);
    for (const table of tables) {
      assert.equal((await legacy.admin.query('SELECT to_regclass($1) IS NOT NULL AS present', [`siyue.${table}`])).rows[0].present, true, table);
    }
    const upgraded = (await legacy.admin.query('SELECT subject_id, auth_method, device_grant_id FROM siyue.auth_sessions WHERE id=$1',
      [priorSession])).rows[0];
    assert.deepEqual([upgraded.subject_id, upgraded.auth_method, upgraded.device_grant_id], [priorSubject, 'child', null]);
    assert.equal((await legacy.admin.query("SELECT has_table_privilege('siyue_app','siyue.device_grants','SELECT,INSERT,UPDATE,DELETE') AS ok")).rows[0].ok, true);
    assert.equal((await legacy.admin.query("SELECT has_table_privilege('siyue_app','siyue.consent_records','TRUNCATE') AS ok")).rows[0].ok, false);
  } finally { rmSync(directory, { recursive: true, force: true }); await legacy.stop(); }
});

test('consent records and guardian relationships hold their links, patterns and one row per triple', async () => {
  const { owner, familyId, guardian, child, consentRecordId } = await scene();
  // Account-level consent needs no subject; guardian consent names the child it covers.
  assert.equal((await insertConsent({ actor_subject_id: owner, purpose: 'terms-of-service', policy_version: 'terms-v1' })).rows[0].subject_id, null);
  const stored = (await insertConsent({ actor_subject_id: owner, subject_id: child })).rows[0];
  assert.deepEqual([stored.subject_id, stored.withdrawn_at], [child, null]);
  await failure(insertConsent({ actor_subject_id: randomUUID(), subject_id: child }), '23503', 'unknown actor');
  await failure(insertConsent({ actor_subject_id: owner, subject_id: randomUUID() }), '23503', 'unknown subject');
  await failure(insertConsent({ actor_subject_id: owner, purpose: 'Guardian Child Device' }), '23514', 'purpose pattern');
  await failure(insertConsent({ actor_subject_id: owner, policy_version: 'Child Device Pairing v1' }), '23514', 'policy pattern');
  await failure(insertConsent({ actor_subject_id: owner, purpose: '' }), '23514', 'empty purpose');
  await failure(insertConsent({ actor_subject_id: owner, recorded_at: new Date(), withdrawn_at: new Date(Date.now() - minute) }), '23514', 'withdrawal before record');
  await failure(insertConsent({ id: stored.id, actor_subject_id: owner, subject_id: child }), '23505', 'duplicate consent id');
  // A withdrawal after the record is accepted and the row stays readable instead of being deleted.
  await db.app.query("UPDATE siyue.consent_records SET withdrawn_at = recorded_at + interval '1 minute' WHERE id=$1", [stored.id]);
  assert.ok((await rows('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1', [stored.id]))[0].withdrawn_at);

  const relationship = (overrides = {}) => insertGuardian({ family_id: familyId, guardian_subject_id: guardian,
    child_subject_id: child, consent_record_id: consentRecordId, ...overrides });
  const held = (await relationship()).rows[0];
  assert.deepEqual([held.active, held.version, held.consent_record_id], [true, 1, consentRecordId]);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.guardian_relationships'), 1);
  // A fresh triple is used where the refusal must come from the link and not from the primary key.
  const sibling = await addSubject('child');
  await failure(relationship(), '23505', 'one relationship per family/guardian/child');
  await failure(relationship({ family_id: randomUUID() }), '23503', 'unknown family');
  await failure(relationship({ guardian_subject_id: randomUUID() }), '23503', 'unknown guardian');
  await failure(relationship({ child_subject_id: randomUUID() }), '23503', 'unknown child');
  await failure(relationship({ child_subject_id: sibling, consent_record_id: randomUUID() }), '23503', 'unknown consent record');
  await failure(relationship({ consent_record_id: null }), '23502', 'consent link required');
  await failure(relationship({ guardian_subject_id: child }), '23514', 'self-guardian');
  await failure(relationship({ version: 0 }), '23514', 'relationship version bound');
  await failure(relationship({ active: null }), '23502', 'active required');
  // A different child, and the same pair in another family, are distinct relationships.
  assert.equal((await relationship({ child_subject_id: sibling })).rows.length, 1);
  assert.equal((await relationship({ family_id: await addFamily() })).rows.length, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.guardian_relationships'), 3);
});

test('pairing requests hold two digests, a bounded window and an all-or-nothing approval', async () => {
  const { guardian, child, familyId } = await scene();
  const createdAt = new Date();
  const approval = { status: 'approved', approved_by: guardian, approved_at: new Date(+createdAt + minute),
    child_subject_id: child, family_id: familyId, approved_guardian_version: 1, approved_credential_version: 1 };
  const request = (overrides = {}) => insertPairing({ created_at: createdAt, ...overrides });

  const pending = (await request()).rows[0];
  assert.deepEqual([pending.status, pending.approved_by, pending.approved_at, pending.child_subject_id, pending.family_id,
    pending.consumed_at], ['pending', null, null, null, null, null]);
  const approved = (await request(approval)).rows[0];
  const consumed = (await request({ ...approval, status: 'consumed', consumed_at: new Date(+createdAt + 2 * minute) })).rows[0];
  assert.deepEqual([approved.consumed_at, consumed.consumed_at !== null], [null, true]);
  assert.deepEqual([approved.approved_guardian_version, approved.approved_credential_version], [1, 1]);
  // An expired request is either never approved or fully approved, and never consumable.
  assert.equal((await request({ status: 'expired' })).rows[0].approved_by, null);
  assert.equal((await request({ ...approval, status: 'expired' })).rows[0].child_subject_id, child);
  // The default clock path: with no explicit created_at the window stays inside five minutes.
  const defaulted = (await db.app.query(`INSERT INTO siyue.device_pairing_requests(id,request_token_hash,poll_secret_hash,installation_id,platform,expires_at)
    VALUES($1,$2,$3,$4,'ios',now() + interval '4 minutes') RETURNING created_at, expires_at`,
  [randomUUID(), sha256(), sha256(), randomUUID()])).rows[0];
  assert.equal(+defaulted.expires_at - +defaulted.created_at, 4 * minute);

  const countRows = await count('SELECT count(*)::int AS n FROM siyue.device_pairing_requests');
  await failure(request({ status: 'denied' }), '23514', 'unknown status');
  await failure(request({ platform: null }), '23502', 'pairing platform required');
  await failure(request({ ...approval, approved_guardian_version: null }), '23514', 'approval without guardian version');
  await failure(request({ ...approval, approved_credential_version: 0 }), '23514', 'invalid credential version');
  await failure(request({ status: 'consumed' }), '23514', 'consumed without consumption');
  await failure(request({ expires_at: new Date(+createdAt + 5 * minute + 1_000) }), '23514', 'window above five minutes');
  await failure(request({ expires_at: createdAt }), '23514', 'window equal to creation');
  await failure(request({ created_at: createdAt, expires_at: new Date(+createdAt - minute) }), '23514', 'window before creation');
  await failure(request({ request_token_hash: pending.request_token_hash }), '23505', 'duplicate request digest');
  await failure(request({ poll_secret_hash: pending.poll_secret_hash }), '23505', 'duplicate poll digest');
  await failure(request({ request_token_hash: pending.request_token_hash.toUpperCase() }), '23514', 'digest case');
  await failure(request({ poll_secret_hash: 'short' }), '23514', 'digest length');
  // The two secrets are independent: one digest can never satisfy the other's uniqueness.
  const shared = sha256();
  await failure(request({ request_token_hash: shared, poll_secret_hash: shared }), '23514', 'request digest reused as poll digest');
  await failure(request({ installation_id: '' }), '23514', 'empty installation');
  await failure(request({ installation_id: 'x'.repeat(201) }), '23514', 'long installation');
  await failure(request({ platform: 'watch' }), '23514', 'unknown platform');
  await failure(request({ device_label: 'x'.repeat(101) }), '23514', 'long label');
  await failure(request({ approved_by: guardian, approved_at: new Date() }), '23514', 'pending with approval');
  await failure(request({ consumed_at: new Date() }), '23514', 'pending with consumption');
  await failure(request({ status: 'approved', approved_by: guardian, approved_at: new Date(), child_subject_id: child }), '23514', 'approval without family');
  await failure(request({ status: 'approved', approved_by: guardian, child_subject_id: child, family_id: familyId }), '23514', 'approval without timestamp');
  await failure(request({ status: 'approved', approved_at: new Date(), child_subject_id: child, family_id: familyId }), '23514', 'approval without approver');
  await failure(request({ ...approval, consumed_at: new Date() }), '23514', 'approved with consumption');
  await failure(request({ status: 'expired', approved_by: guardian, approved_at: new Date() }), '23514', 'expired with half approval');
  await failure(request({ status: 'expired', consumed_at: new Date() }), '23514', 'expired with consumption');
  await failure(request({ ...approval, family_id: randomUUID() }), '23503', 'unknown family');
  await failure(request({ ...approval, child_subject_id: randomUUID() }), '23503', 'unknown child');
  await failure(request({ ...approval, approved_by: randomUUID() }), '23503', 'unknown approver');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.device_pairing_requests'), countRows);
});

test('device grants bound lifetime, scope and authority versions while sessions link once', async () => {
  const { guardian, child, familyId } = await scene();
  const createdAt = new Date();
  const grant = (overrides = {}) => insertGrant({ child_subject_id: child, guardian_id: guardian, family_id: familyId,
    created_at: createdAt, ...overrides });

  const held = (await grant()).rows[0];
  assert.deepEqual([held.version, held.guardian_relationship_version, held.guardian_credential_version, held.revoked_at], [1, 1, 1, null]);
  assert.deepEqual(held.scopes, ['room.join', 'board.read']);
  // The guardian device list reads these two copied columns; only the label may be absent.
  assert.deepEqual([held.platform, held.device_label], ['ios', 'Synthetic child iPad']);
  await failure(grant({ platform: null }), '23502', 'platform required for device list');
  assert.deepEqual((await grant({ device_label: null })).rows[0].device_label, null);
  // Revoked history stays as a row; the live index simply stops covering it.
  assert.ok((await grant({ revoked_at: new Date(+createdAt + minute) })).rows[0].revoked_at);
  await failure(grant({ expires_at: new Date(+createdAt + 30 * day + 1_000) }), '23514', 'grant above thirty days');
  await failure(grant({ expires_at: createdAt }), '23514', 'grant expiring at creation');
  await failure(grant({ revoked_at: new Date(+createdAt - minute) }), '23514', 'revocation before creation');
  assert.deepEqual((await grant({ scopes: [] })).rows[0].scopes, [], 'empty scopes grant no room or board capability');
  await failure(grant({ scopes: ['room.join', null] }), '23514', 'null scope');
  await failure(grant({ scopes: [''] }), '23514', 'empty scope name');
  await failure(grant({ scopes: null }), '23502', 'scopes required');
  await failure(grant({ platform: 'watch' }), '23514', 'unknown grant platform');
  await failure(grant({ device_label: 'x'.repeat(101) }), '23514', 'long grant label');
  await failure(grant({ version: 0 }), '23514', 'grant version bound');
  await failure(grant({ guardian_relationship_version: 0 }), '23514', 'relationship version bound');
  await failure(grant({ guardian_credential_version: 0 }), '23514', 'credential version bound');
  await failure(grant({ guardian_relationship_version: null }), '23502', 'relationship version required');
  await failure(grant({ guardian_credential_version: null }), '23502', 'credential version required');
  await failure(grant({ guardian_id: child }), '23514', 'self-granted device');
  await failure(grant({ guardian_id: randomUUID() }), '23503', 'unknown guardian');
  await failure(grant({ child_subject_id: randomUUID() }), '23503', 'unknown child');
  await failure(grant({ family_id: randomUUID() }), '23503', 'unknown family');

  // A child session may point at its grant, and a synthetic grantless session still inserts.
  const live = (await grant()).rows[0];
  const session = (overrides = {}) => insertSession({ subject_id: child, created_at: createdAt, ...overrides });
  const grantless = (await session()).rows[0];
  assert.equal(grantless.device_grant_id, null);
  const linked = (await session({ device_grant_id: live.id })).rows[0];
  assert.equal(linked.device_grant_id, live.id);
  // A completed pairing cannot mint a second live session for the same grant.
  await failure(session({ device_grant_id: live.id }), '23505', 'second session for one grant');
  await failure(session({ device_grant_id: randomUUID() }), '23503', 'unknown grant');
  // Revoking the grant does not silently rewrite or delete the session that already used it.
  await db.app.query('UPDATE siyue.device_grants SET revoked_at=now(), version=version+1 WHERE id=$1', [live.id]);
  assert.equal((await rows('SELECT device_grant_id FROM siyue.auth_sessions WHERE id=$1', [linked.id]))[0].device_grant_id, live.id);

  const [column] = await rows("SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema='siyue' AND table_name='auth_sessions' AND column_name='device_grant_id'");
  assert.deepEqual([column.is_nullable, column.data_type], ['YES', 'uuid']);
  const constraints = await rows("SELECT conname, contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='siyue.auth_sessions'::regclass");
  assert.deepEqual(constraints.filter(entry => entry.definition.includes('device_grant')).map(entry => [entry.conname, entry.contype]),
    [['auth_sessions_device_grant_id_fkey', 'f']]);
  // No CHECK ties auth_method/kind to the grant, so older synthetic child sessions stay valid.
  assert.equal(constraints.filter(entry => entry.contype === 'c' && entry.definition.includes('device_grant')).length, 0);
});

test('device grants keep an exact 720-hour bound across a DST spring-forward', async () => {
  const { guardian, child, familyId } = await scene();
  const hours = 3_600_000;
  // America/New_York springs forward on 2026-03-08, inside a 30-day window that opens on 2026-03-01.
  // Calendar arithmetic is applied in the session timezone, so `created_at + interval '30 days'` covers
  // only 719 hours across that shift, while the service always writes `now + 30 * 24h`. The bound has
  // to be hour-based, or a valid grant is refused and pairing completion fails as a 503.
  const createdAt = new Date('2026-03-01T05:00:00.000Z');
  const grant = (expiresAt, client) => insertGrant({ child_subject_id: child, guardian_id: guardian,
    family_id: familyId, created_at: createdAt, expires_at: expiresAt }, client);
  // One connection and one transaction, so the timezone below is the timezone the CHECK is evaluated in.
  await transaction(db.app, async client => {
    await client.query("SET LOCAL TIME ZONE 'America/New_York'");
    const window = async interval => Number((await client.query(
      `SELECT EXTRACT(EPOCH FROM (($1::timestamptz + ${interval}) - $1::timestamptz)) AS seconds`,
      [createdAt])).rows[0].seconds);
    assert.equal(await window("interval '30 days'"), 719 * 3600, 'calendar days are one hour short here');
    assert.equal(await window("interval '720 hours'"), 720 * 3600, 'the bound counts exact hours');
    // The exact lifetime the service writes is accepted...
    const stored = (await grant(new Date(+createdAt + 720 * hours), client)).rows[0];
    assert.equal(+stored.expires_at - +createdAt, 720 * hours);
    // ...and one millisecond past the bound is still refused, so the bound still bounds.
    await client.query('SAVEPOINT rejected_grant');
    await failure(grant(new Date(+createdAt + 720 * hours + 1), client), '23514', 'grant above 720 hours');
    await client.query('ROLLBACK TO SAVEPOINT rejected_grant');
  });
  // Only the accepted grant survives; the refused row never landed.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.device_grants'), 1);
});
