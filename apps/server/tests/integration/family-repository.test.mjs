import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateFamilyPolicy } from '@siyue/domain';
import { familySummarySchema } from '@siyue/contracts';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { migrateDatabase, readMigrations } from '../../dist/adapters/postgres/migrate.js';
import { createFamilyRepository, FamilyRepositoryError } from '../../dist/modules/families/repository.js';

// Isolated temporary PostgreSQL cluster only, never a database URL from the workspace. The repository
// is exercised through caller-owned transactions, exactly as a verified session path will call it.
let db, repo;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query('TRUNCATE siyue.families, siyue.family_memberships, siyue.family_create_requests, siyue.subjects CASCADE');
  repo = createFamilyRepository(db.app);
});
after(async () => { await db?.stop(); });

const key = () => createHash('sha256').update(randomUUID()).digest('hex');
const codeIs = code => error => error instanceof FamilyRepositoryError && error.code === code;
const rawCodeIs = code => error => error?.code === code;
const count = async table => Number((await db.admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
const sortById = list => [...list].sort((a, b) => (a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0));
async function adult(kind = 'adult', status = 'active') {
  const id = randomUUID();
  await db.app.query('INSERT INTO siyue.subjects(id,kind,status) VALUES($1,$2,$3)', [id, kind, status]);
  return id;
}
const create = (subjectId, keyHash) => transaction(db.app, client => repo.create(client, subjectId, keyHash));
const list = subjectId => repo.list(subjectId);
const get = (subjectId, familyId) => repo.get(subjectId, familyId);
const snapshot = (subjectId, familyId) => transaction(db.app, client => repo.snapshot(client, subjectId, familyId));
const addMembership = (familyId, subjectId, role, version = 1) => db.app.query(
  'INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,$3,true,$4)', [familyId, subjectId, role, version]);

test('the new tables inherit the schema default privileges for the application role', async () => {
  const privilege = async (table, what) => (await db.admin.query('SELECT has_table_privilege($1,$2,$3) AS ok', ['siyue_app', `siyue.${table}`, what])).rows[0].ok;
  for (const table of ['families', 'family_memberships', 'family_create_requests']) {
    assert.equal(await privilege(table, 'SELECT,INSERT,UPDATE,DELETE'), true, table);
    // The application role can use the rows but cannot drop or wipe family data.
    assert.equal(await privilege(table, 'TRUNCATE'), false, table);
  }
});

test('0009 applies to an existing 0008 database and leaves the repository usable there', async () => {
  const legacy = await startPostgresFixture({ migrate: false });
  const directory = mkdtempSync('/tmp/siyue-family-upgrade-');
  try {
    // Rebuild the pre-0009 history byte for byte, pinned to 0008 instead of "everything but the newest".
    const migrations = await readMigrations();
    const previous = migrations.filter(migration => migration.version <= '0008_apple_reauth_actions.sql');
    assert.equal(previous.length, 8);
    for (const migration of previous) writeFileSync(join(directory, migration.version), migration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 8);
    assert.equal((await legacy.admin.query("SELECT to_regclass('siyue.families') AS present")).rows[0].present, null);
    // Apply precisely 0009 before later family migrations, so a new migration cannot change
    // what this upgrade case proves.
    const familyMigration = migrations.find(migration => migration.version === '0009_family_core.sql');
    assert.ok(familyMigration);
    writeFileSync(join(directory, familyMigration.version), familyMigration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 1);
    for (const table of ['families', 'family_memberships', 'family_create_requests'])
      assert.equal((await legacy.admin.query(`SELECT to_regclass('siyue.${table}') IS NOT NULL AS present`)).rows[0].present, true, table);
    assert.equal((await legacy.admin.query("SELECT has_table_privilege('siyue_app','siyue.families','SELECT,INSERT,UPDATE,DELETE') AS ok")).rows[0].ok, true);
    // A subject that predates the upgrade creates a family with the application role afterwards.
    const subjectId = randomUUID();
    await legacy.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [subjectId]);
    const upgraded = createFamilyRepository(legacy.app);
    const summary = await transaction(legacy.app, client => upgraded.create(client, subjectId, key()));
    assert.equal(summary.ownerSubjectId, subjectId);
    assert.deepEqual(await upgraded.list(subjectId), [summary]);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity), migrations.length - previous.length - 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await legacy.stop();
  }
});

test('an active adult session creates one family with an atomic owner membership', async () => {
  const owner = await adult();
  const summary = await create(owner, key());
  assert.deepEqual(Object.keys(summary).sort(), ['familyId', 'familyVersion', 'membershipVersion', 'ownerSubjectId', 'role']);
  assert.equal(typeof summary.familyId, 'string');
  assert.equal(summary.ownerSubjectId, owner);
  assert.equal(summary.role, 'owner');
  assert.equal(summary.membershipVersion, 1);
  assert.equal(summary.familyVersion, 1);
  // The summary is exactly the shared strict contract: no extra field can leave this boundary.
  assert.deepEqual(familySummarySchema.parse(summary), summary);
  assert.equal(familySummarySchema.safeParse({ ...summary, role: 'superuser' }).success, false);
  assert.equal(familySummarySchema.safeParse({ ...summary, familyId: 'family-a' }).success, false);
  const family = (await db.app.query('SELECT * FROM siyue.families WHERE id=$1', [summary.familyId])).rows[0];
  assert.equal(family.status, 'active');
  assert.equal(family.version, 1);
  assert.equal(family.owner_subject_id, owner);
  assert.ok(family.created_at instanceof Date);
  const membership = (await db.app.query('SELECT * FROM siyue.family_memberships WHERE family_id=$1', [summary.familyId])).rows[0];
  assert.equal(membership.subject_id, owner);
  assert.equal(membership.role, 'owner');
  assert.equal(membership.active, true);
  assert.equal(membership.version, 1);
  assert.deepEqual(await list(owner), [summary]);
  assert.deepEqual(await get(owner, summary.familyId), summary);
  // Rejected input never reaches a write.
  for (const badKey of ['', ' ', key().toUpperCase(), key().slice(0, 63), 'not-a-digest', undefined, 42]) {
    await assert.rejects(create(owner, badKey), codeIs('FAMILY_INVALID_REQUEST'));
  }
  await assert.rejects(create('', key()), codeIs('FAMILY_INVALID_REQUEST'));
  await assert.rejects(create(`${owner} `, key()), codeIs('FAMILY_INVALID_REQUEST'));
  await assert.rejects(get(owner, ''), codeIs('FAMILY_INVALID_REQUEST'));
  await assert.rejects(list('  '), codeIs('FAMILY_INVALID_REQUEST'));
  await assert.rejects(snapshot(owner, 'x'.repeat(201)), codeIs('FAMILY_INVALID_REQUEST'));
  // A malformed id is refused before it can reach a uuid column instead of surfacing a database error.
  await assert.rejects(get(owner, 'not-a-uuid'), codeIs('FAMILY_INVALID_REQUEST'));
  await assert.rejects(list('not-a-uuid'), codeIs('FAMILY_INVALID_REQUEST'));
  await assert.rejects(snapshot('not-a-uuid', summary.familyId), codeIs('FAMILY_INVALID_REQUEST'));
  assert.equal(await count('siyue.families'), 1);
});

test('the empty-body create is idempotent per subject and key, and conflicts after a dissolve', async () => {
  const owner = await adult(), other = await adult();
  const digest = key();
  const first = await create(owner, digest);
  assert.deepEqual(await create(owner, digest), first);
  assert.equal(await count('siyue.families'), 1);
  assert.equal(await count('siyue.family_memberships'), 1);
  assert.equal(await count('siyue.family_create_requests'), 1);
  assert.deepEqual(await list(owner), [first]);
  // The same key belongs to one subject, so another subject replays into their own new family.
  const foreign = await create(other, digest);
  assert.notEqual(foreign.familyId, first.familyId);
  assert.deepEqual(await get(other, first.familyId), null);
  // A different key is a second family for the same adult: the design constrains owners per family,
  // not families per adult.
  const second = await create(owner, key());
  assert.notEqual(second.familyId, first.familyId);
  assert.equal(await count('siyue.families'), 3);
  assert.equal(await count('siyue.family_create_requests'), 3);
  assert.deepEqual(new Set((await list(owner)).map(entry => entry.familyId)), new Set([first.familyId, second.familyId]));
  // A dissolved family is not resurrected by replay and is no longer visible to its owner.
  await db.app.query("UPDATE siyue.families SET status='dissolved' WHERE id=$1", [first.familyId]);
  await assert.rejects(create(owner, digest), codeIs('FAMILY_CREATE_CONFLICT'));
  assert.deepEqual(await list(owner), [second]);
  assert.equal(await get(owner, first.familyId), null);
  const replacement = await create(owner, key());
  assert.notEqual(replacement.familyId, first.familyId);
  assert.deepEqual(new Set((await list(owner)).map(entry => entry.familyId)), new Set([second.familyId, replacement.familyId]));
});

test('concurrent creates stay idempotent per key and never leave a partial write', async () => {
  const shared = await adult();
  const digest = key();
  const both = await Promise.all([create(shared, digest), create(shared, digest)]);
  assert.deepEqual(both[0], both[1]);
  assert.equal(await count('siyue.families'), 1);
  assert.equal(await count('siyue.family_memberships'), 1);
  assert.equal(await count('siyue.family_create_requests'), 1);
  // Two different keys race for one owner: both are new families, and neither call writes twice.
  const owner = await adult(), winnerKey = key(), loserKey = key();
  const raced = await Promise.allSettled([create(owner, winnerKey), create(owner, loserKey)]);
  assert.deepEqual(raced.map(result => result.status), ['fulfilled', 'fulfilled']);
  const raceFamilies = (await list(owner)).map(entry => entry.familyId);
  assert.equal(raceFamilies.length, 2);
  assert.notEqual(raceFamilies[0], raceFamilies[1]);
  assert.equal(await count('siyue.families'), 3);
  assert.equal(await count('siyue.family_memberships'), 3);
  assert.equal(await count('siyue.family_create_requests'), 3);
  // Each racer replays its own key into the family that key created, and neither key is reusable.
  assert.deepEqual(await create(owner, winnerKey), raced[0].value);
  assert.deepEqual(await create(owner, loserKey), raced[1].value);
  assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.family_create_requests WHERE subject_id=$1', [owner])).rows[0].n, 2);
});

test('a child, a blocked, a pending-deletion and an unknown subject cannot own a family', async () => {
  const subjects = [await adult('child'), await adult('adult', 'blocked'), await adult('adult', 'deletion_pending'), await adult('adult', 'deleted'), randomUUID()];
  for (const subjectId of subjects) await assert.rejects(create(subjectId, key()), codeIs('FAMILY_SUBJECT_NOT_ELIGIBLE'));
  assert.equal(await count('siyue.families'), 0);
  assert.equal(await count('siyue.family_memberships'), 0);
  assert.equal(await count('siyue.family_create_requests'), 0);
  // The same subject becomes eligible once it is an active adult again.
  const promoted = subjects[0];
  await db.app.query("UPDATE siyue.subjects SET kind='adult', status='active' WHERE id=$1", [promoted]);
  const summary = await create(promoted, key());
  assert.equal(summary.ownerSubjectId, promoted);
});

test('another subject cannot list, read or snapshot a family they do not belong to', async () => {
  const owner = await adult(), stranger = await adult(), member = await adult();
  const { familyId } = await create(owner, key());
  await addMembership(familyId, member, 'member');
  assert.deepEqual(await list(stranger), []);
  assert.equal(await get(stranger, familyId), null);
  assert.equal(await get(stranger, randomUUID()), null);
  assert.equal(await get(owner, randomUUID()), null);
  assert.equal(await snapshot(stranger, familyId), null);
  assert.equal(await snapshot(stranger, randomUUID()), null);
  assert.equal(await snapshot(owner, randomUUID()), null);
  assert.equal(await snapshot(randomUUID(), familyId), null);
  // A deactivated membership removes visibility without touching the family.
  await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2', [familyId, member]);
  assert.deepEqual(await list(member), []);
  assert.equal(await snapshot(member, familyId), null);
  assert.deepEqual(await list(owner), [{ familyId, ownerSubjectId: owner, role: 'owner', membershipVersion: 1, familyVersion: 1 }]);
  // A blocked subject reads nothing even while the membership row is still active. The route verifies
  // the session; the repository does not depend on that and filters the subject itself.
  const blocked = await adult();
  await addMembership(familyId, blocked, 'member');
  assert.deepEqual((await list(blocked)).map(entry => entry.role), ['member']);
  await db.app.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1", [blocked]);
  assert.deepEqual(await list(blocked), []);
  assert.equal(await get(blocked, familyId), null);
  assert.equal(await snapshot(blocked, familyId), null);
  assert.deepEqual(await list(owner), [{ familyId, ownerSubjectId: owner, role: 'owner', membershipVersion: 1, familyVersion: 1 }]);
});

test('membership roles stay separate and membership versions are read back from the database', async () => {
  const owner = await adult(), admin = await adult(), member = await adult();
  const { familyId } = await create(owner, key());
  await addMembership(familyId, admin, 'admin', 3);
  await addMembership(familyId, member, 'member', 2);
  assert.deepEqual(await list(owner), [{ familyId, ownerSubjectId: owner, role: 'owner', membershipVersion: 1, familyVersion: 1 }]);
  assert.deepEqual(await list(admin), [{ familyId, ownerSubjectId: owner, role: 'admin', membershipVersion: 3, familyVersion: 1 }]);
  assert.deepEqual(await list(member), [{ familyId, ownerSubjectId: owner, role: 'member', membershipVersion: 2, familyVersion: 1 }]);
  await db.app.query('UPDATE siyue.family_memberships SET version=5 WHERE family_id=$1 AND subject_id=$2', [familyId, member]);
  assert.deepEqual(await get(member, familyId), { familyId, ownerSubjectId: owner, role: 'member', membershipVersion: 5, familyVersion: 1 });
  await db.app.query('UPDATE siyue.families SET version=7 WHERE id=$1', [familyId]);
  assert.deepEqual(await get(owner, familyId), { familyId, ownerSubjectId: owner, role: 'owner', membershipVersion: 1, familyVersion: 7 });
});

test('the database constrains family ownership, membership identity, roles and key digests', async () => {
  const failure = async (sql, params, code) => {
    const error = await db.app.query(sql, params).then(() => null, thrown => thrown);
    assert.equal(error?.code, code, `${sql} -> ${error?.code}`);
  };
  const owner = await adult(), other = await adult(), fresh = await adult();
  const ownerFamily = await create(owner, key());
  const { familyId: otherFamily } = await create(other, key());
  // An adult may own several active families at once: only the owner side of a family is constrained.
  const secondFamily = randomUUID();
  await db.app.query("INSERT INTO siyue.families(id,status,owner_subject_id) VALUES($1,'active',$2)", [secondFamily, owner]);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM siyue.families WHERE owner_subject_id=$1 AND status='active'", [owner])).rows[0].n, 2);
  // A family never reports two active owners; the repository already created the first owner row.
  await failure("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner')", [ownerFamily.familyId, other], '23505');
  await failure("INSERT INTO siyue.families(id,status,owner_subject_id) VALUES($1,'paused',$2)", [randomUUID(), fresh], '23514');
  await failure("INSERT INTO siyue.families(id,status,owner_subject_id,version) VALUES($1,'active',$2,0)", [randomUUID(), fresh], '23514');
  await failure("INSERT INTO siyue.families(id,status,owner_subject_id) VALUES($1,'active',$2)", [randomUUID(), randomUUID()], '23503');
  await failure("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'superuser')", [otherFamily, owner], '23514');
  await failure("INSERT INTO siyue.family_memberships(family_id,subject_id,role,version) VALUES($1,$2,'member',0)", [otherFamily, owner], '23514');
  await failure("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')", [randomUUID(), owner], '23503');
  await failure("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')", [otherFamily, randomUUID()], '23503');
  await addMembership(otherFamily, owner, 'member');
  await failure("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'admin')", [otherFamily, owner], '23505');
  await failure('INSERT INTO siyue.family_create_requests(subject_id,key_hash,family_id) VALUES($1,$2,$3)', [fresh, 'not-a-digest', otherFamily], '23514');
  await failure('INSERT INTO siyue.family_create_requests(subject_id,key_hash,family_id) VALUES($1,$2,$3)', [fresh, key().toUpperCase(), otherFamily], '23514');
  await failure('INSERT INTO siyue.family_create_requests(subject_id,key_hash,family_id) VALUES($1,$2,$3)', [fresh, key(), randomUUID()], '23503');
  await failure('INSERT INTO siyue.family_create_requests(subject_id,key_hash,family_id) VALUES($1,$2,$3)', [randomUUID(), key(), otherFamily], '23503');
  const digest = key();
  await db.app.query('INSERT INTO siyue.family_create_requests(subject_id,key_hash,family_id) VALUES($1,$2,$3)', [fresh, digest, otherFamily]);
  await failure('INSERT INTO siyue.family_create_requests(subject_id,key_hash,family_id) VALUES($1,$2,$3)', [fresh, digest, otherFamily], '23505');
  // The same digest under another subject is a different request, which is what keeps replays scoped.
  await db.app.query('INSERT INTO siyue.family_create_requests(subject_id,key_hash,family_id) VALUES($1,$2,$3)', [other, digest, otherFamily]);
  // One active owner per family, ordered as a transfer must be: demote the current owner, then promote.
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner')", [secondFamily, owner]);
  await db.app.query("UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2", [secondFamily, owner]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner')", [secondFamily, other]);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1 AND role='owner' AND active", [secondFamily])).rows[0].n, 1);
});

test('the trusted snapshot drives the existing policy and never escalates a role', async () => {
  const owner = await adult(), admin = await adult(), member = await adult(), outsider = await adult();
  const { familyId } = await create(owner, key());
  await addMembership(familyId, admin, 'admin', 3);
  await addMembership(familyId, member, 'member', 2);
  const decision = async (subjectId, request) => evaluateFamilyPolicy(await snapshot(subjectId, familyId), request);
  const dissolve = { kind: 'family', familyId, action: 'dissolve', expectedMembershipVersion: 1 };
  assert.deepEqual(await decision(owner, dissolve), { allowed: true });
  // An admin and a member stay below the owner, and stale membership versions are refused.
  assert.deepEqual(await decision(admin, { ...dissolve, expectedMembershipVersion: 3 }), { allowed: false, reason: 'role_denied' });
  assert.deepEqual(await decision(member, { ...dissolve, expectedMembershipVersion: 2 }), { allowed: false, reason: 'role_denied' });
  assert.deepEqual(await decision(owner, { ...dissolve, expectedMembershipVersion: 9 }), { allowed: false, reason: 'stale_authorization' });
  assert.deepEqual(await decision(admin, { kind: 'family', familyId, action: 'invite', expectedMembershipVersion: 3 }), { allowed: true });
  assert.deepEqual(await decision(member, { kind: 'family', familyId, action: 'invite', expectedMembershipVersion: 2 }), { allowed: false, reason: 'role_denied' });
  assert.deepEqual(await decision(admin, { kind: 'family', familyId, action: 'remove-member', targetSubjectId: member, expectedMembershipVersion: 3 }), { allowed: true });
  assert.deepEqual(await decision(admin, { kind: 'family', familyId, action: 'remove-member', targetSubjectId: owner, expectedMembershipVersion: 3 }), { allowed: false, reason: 'target_denied' });
  assert.deepEqual(await decision(member, { kind: 'family', familyId, action: 'remove-member', targetSubjectId: admin, expectedMembershipVersion: 2 }), { allowed: false, reason: 'role_denied' });
  assert.deepEqual(evaluateFamilyPolicy(await snapshot(outsider, familyId), dissolve), { allowed: false, reason: 'invalid_input' });
  // A child subject is assembled as a child and can never manage the family.
  const child = await adult('child');
  await addMembership(familyId, child, 'member');
  assert.deepEqual(await decision(child, { ...dissolve, expectedMembershipVersion: 1 }), { allowed: false, reason: 'child_management' });
  // Record requests stay denied while grants are empty, so no shared object is reachable yet.
  assert.deepEqual(await decision(owner, { kind: 'record', context: 'family', action: 'read', familyId, sourceSpaceId: 'space-a', recordId: 'record-a' }), { allowed: false, reason: 'scope_mismatch' });
  // The repository exposes no membership, role or version write path at all.
  assert.deepEqual(Object.keys(repo).sort(), ['create', 'get', 'list', 'snapshot']);
  // Being a member of one family does not make that member its owner when they create a new family.
  const own = await create(member, key());
  assert.notEqual(own.familyId, familyId);
  assert.deepEqual(await get(member, own.familyId), { familyId: own.familyId, ownerSubjectId: member, role: 'owner', membershipVersion: 1, familyVersion: 1 });
  assert.deepEqual(await get(member, familyId), { familyId, ownerSubjectId: owner, role: 'member', membershipVersion: 2, familyVersion: 1 });
  const rows = (await db.app.query('SELECT subject_id,role FROM siyue.family_memberships WHERE family_id=$1 ORDER BY role', [familyId])).rows;
  assert.deepEqual(rows.map(row => [row.role, row.subject_id === owner]), [['admin', false], ['member', false], ['member', false], ['owner', true]]);
  assert.equal((await db.app.query('SELECT owner_subject_id FROM siyue.families WHERE id=$1', [familyId])).rows[0].owner_subject_id, owner);
});

test('the snapshot is assembled from database rows and preserves the family policy version', async () => {
  const owner = await adult(), admin = await adult(), member = await adult();
  const { familyId } = await create(owner, key());
  await addMembership(familyId, admin, 'admin', 3);
  await addMembership(familyId, member, 'member', 2);
  const assembled = await snapshot(owner, familyId);
  assert.deepEqual(assembled, {
    subject: { id: owner, kind: 'adult' },
    family: { id: familyId, active: true },
    record: null,
    grants: [],
    memberships: sortById([
      { familyId, subjectId: owner, subjectKind: 'adult', role: 'owner', active: true, version: 1 },
      { familyId, subjectId: admin, subjectKind: 'adult', role: 'admin', active: true, version: 3 },
      { familyId, subjectId: member, subjectKind: 'adult', role: 'member', active: true, version: 2 },
    ]),
  });
  // The snapshot follows committed database state, including deactivation and a bumped version.
  await db.app.query('UPDATE siyue.family_memberships SET active=false, version=6 WHERE family_id=$1 AND subject_id=$2', [familyId, admin]);
  const refreshed = await snapshot(owner, familyId);
  assert.deepEqual(refreshed.memberships.find(entry => entry.subjectId === admin), { familyId, subjectId: admin, subjectKind: 'adult', role: 'admin', active: false, version: 6 });
  assert.equal(refreshed.memberships.length, 3);
  await db.app.query('UPDATE siyue.family_memberships SET version=4 WHERE family_id=$1 AND subject_id=$2', [familyId, member]);
  const bumped = await snapshot(member, familyId);
  assert.equal(bumped.memberships.find(entry => entry.subjectId === member).version, 4);
  assert.deepEqual(evaluateFamilyPolicy(bumped, { kind: 'family', familyId, action: 'dissolve', expectedMembershipVersion: 4 }), { allowed: false, reason: 'role_denied' });
  assert.deepEqual(evaluateFamilyPolicy(bumped, { kind: 'family', familyId, action: 'dissolve', expectedMembershipVersion: 2 }), { allowed: false, reason: 'stale_authorization' });
  // A dissolved family keeps its real policy state for members instead of a fabricated active one.
  await db.app.query("UPDATE siyue.families SET status='dissolved', version=version+1 WHERE id=$1", [familyId]);
  const dissolved = await snapshot(owner, familyId);
  assert.deepEqual(dissolved.family, { id: familyId, active: false });
  assert.deepEqual(evaluateFamilyPolicy(dissolved, { kind: 'family', familyId, action: 'dissolve', expectedMembershipVersion: 1 }), { allowed: false, reason: 'inactive_family' });
  assert.deepEqual(await list(owner), []);
  assert.equal(await get(owner, familyId), null);
  assert.equal(await snapshot(await adult(), familyId), null);
});
