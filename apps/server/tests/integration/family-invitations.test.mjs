import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { familyInvitationCreatedSchema, familySummarySchema } from '@siyue/contracts';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { migrateDatabase, readMigrations } from '../../dist/adapters/postgres/migrate.js';
import { createFamilyRepository } from '../../dist/modules/families/repository.js';
import { createFamilyInvitationService } from '../../dist/modules/families/invitations.js';

// Isolated temporary PostgreSQL cluster only; never a database URL from the workspace. Tokens,
// addresses and credentials are synthetic, no mailbox or provider is contacted and no mail is sent.
// The pepper is stable for the whole file so stored digests can be recomputed independently.
const pepper = randomBytes(32);
const day = 86_400_000;
const minute = 60_000;

let db, fx, families, invitations;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query(`TRUNCATE siyue.family_invitations,siyue.families,siyue.family_memberships,siyue.family_create_requests,
    siyue.idempotency_records,siyue.security_events,siyue.account_emails,siyue.password_credentials,siyue.email_challenges,
    siyue.outbox_jobs,siyue.rate_limit_buckets,siyue.subjects CASCADE`);
  fx = await createEmailFixture(db);
  families = createFamilyRepository(db.app);
  invitations = createFamilyInvitationService(db.app, fx.service, fx.cipher, pepper, fx.clock);
});
after(async () => { await db?.stop(); });

/** Tolerates both `rows(sql, a, b)` and `rows(sql, [a, b])` call styles. */
const bindings = args => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
const rows = (sql, ...args) => db.app.query(sql, bindings(args)).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
const refuses = (code, status) => error => error?.code === code && (status === undefined || error?.status === status);
const tokenDigest = token => createHmac('sha256', pepper).update(JSON.stringify(['invitation-token', token])).digest('hex');
const keyHash = () => createHash('sha256').update(randomUUID()).digest('hex');
/** Accepts session tokens directly, session tokens wrapped as `{tokens}` and the child session shape. */
const tokensOf = who => who.tokens ?? who;
const subjectOf = who => tokensOf(who).session?.subjectId ?? who.subjectId;
const tokenOf = who => tokensOf(who).accessToken;

/** Real adult session created through the session service. */
const adult = () => fx.issue();
/** Fresh session for a subject that already exists: access tokens live 15 minutes. */
const sessionFor = subjectId => transaction(db.app, client => fx.service.issue(client, subjectId, randomUUID(), 'email'));
/** Real child session backed by this family's explicit guardian relationship and device grant. */
async function child(owner, summary) {
  const subjectId = randomUUID(), consentId = randomUUID(), grantId = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')", [subjectId]);
  await addMembership(summary.familyId, subjectId, 'member', 1);
  await db.app.query("INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version) VALUES($1,$2,$3,'child-guardianship','0.0.1')",
    [consentId, subjectOf(owner), subjectId]);
  await db.app.query('INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)',
    [summary.familyId, subjectOf(owner), subjectId, consentId]);
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,
    guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios',1,1,ARRAY[]::text[],$6)`,
  [grantId, subjectId, subjectOf(owner), summary.familyId, randomUUID(), new Date(+fx.clock() + 30 * day - 1_000)]);
  return {subjectId, ...await transaction(db.app, client => fx.service.issueChild(client, grantId))};
}
const family = owner => transaction(db.app, client => families.create(client, subjectOf(owner), keyHash()));
const addMembership = (familyId, subjectId, role, version = 1) => db.app.query(
  'INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,$3,true,$4)', [familyId, subjectId, role, version]);
const invite = (who, summary, overrides = {}, requestKey = randomUUID()) => invitations.create(tokenOf(who), {
  familyId: summary.familyId, expectedMembershipVersion: summary.membershipVersion, expectedFamilyVersion: summary.familyVersion, ...overrides,
}, requestKey);
const acceptWith = (accessToken, token, requestKey = randomUUID()) => invitations.accept(accessToken, token, requestKey);
const accept = (who, token, requestKey = randomUUID()) => acceptWith(tokenOf(who), token, requestKey);
const inviteRows = () => count('SELECT count(*)::int AS n FROM siyue.family_invitations');
const members = familyId => count('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1', familyId);

test('0010 keeps least privilege, upgrades 0009 in place and holds every invitation constraint', async () => {
  const privilege = async (role, table, what) => (await rows('SELECT has_table_privilege($1,$2,$3) AS ok', [role, `siyue.${table}`, what]))[0].ok;
  assert.equal(await privilege('siyue_app', 'family_invitations', 'SELECT,INSERT,UPDATE,DELETE'), true);
  // The application role can use rows but cannot wipe invitation history.
  assert.equal(await privilege('siyue_app', 'family_invitations', 'TRUNCATE'), false);
  // An unrelated login role is granted nothing on the new table.
  await db.admin.query('CREATE ROLE synthetic_invitation_probe LOGIN');
  try {
    assert.equal(await privilege('synthetic_invitation_probe', 'family_invitations', 'SELECT'), false);
  } finally { await db.admin.query('DROP ROLE synthetic_invitation_probe'); }
  assert.deepEqual((await rows("SELECT indexname FROM pg_indexes WHERE schemaname='siyue' AND tablename='family_invitations' ORDER BY indexname"))
    .map(entry => entry.indexname), ['family_invitations_expiring', 'family_invitations_family', 'family_invitations_pkey',
    'family_invitations_recovery', 'family_invitations_token_hash_key']);

  // The migration is additive: a database pinned to 0009 gains exactly this table.
  const legacy = await startPostgresFixture({ migrate: false });
  const directory = mkdtempSync('/tmp/siyue-invitation-upgrade-');
  try {
    const previous = (await readMigrations()).filter(migration => migration.version <= '0009_family_core.sql');
    const invitationMigration = (await readMigrations()).find(migration => migration.version === '0010_family_invitations.sql');
    assert.ok(invitationMigration);
    assert.equal(previous.length, 9);
    for (const migration of previous) writeFileSync(join(directory, migration.version), migration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 9);
    assert.equal((await legacy.admin.query("SELECT to_regclass('siyue.family_invitations') AS present")).rows[0].present, null);
    writeFileSync(join(directory, invitationMigration.version), invitationMigration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 1);
    assert.equal((await legacy.admin.query("SELECT to_regclass('siyue.family_invitations') IS NOT NULL AS present")).rows[0].present, true);
    assert.equal((await legacy.admin.query("SELECT has_table_privilege('siyue_app','siyue.family_invitations','SELECT,INSERT,UPDATE,DELETE') AS ok")).rows[0].ok, true);
    const later = (await readMigrations()).filter(migration => migration.version > invitationMigration.version);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity), later.length);
  } finally { rmSync(directory, { recursive: true, force: true }); await legacy.stop(); }

  // Column-level constraints, exercised with the application role on a real family.
  const owner = await adult();
  const own = await family(owner);
  const created = await invite(owner, own);
  const stored = (await rows('SELECT * FROM siyue.family_invitations WHERE id=$1', [created.invitationId]))[0];
  const insertInvitation = (overrides = {}) => {
    const row = { id: randomUUID(), family_id: stored.family_id, inviter_id: stored.inviter_id, intended_email: null,
      token_hash: tokenDigest(randomUUID()), status: 'pending', policy_version: 'family-invitation-v1',
      inviter_membership_version: 1, family_version: 1, token_ciphertext: null, token_ciphertext_expires_at: null,
      expires_at: new Date(+fx.clock() + day), accepted_by: null, accepted_at: null, ...overrides };
    return db.app.query(`INSERT INTO siyue.family_invitations(id,family_id,inviter_id,intended_email,token_hash,status,policy_version,
        inviter_membership_version,family_version,token_ciphertext,token_ciphertext_expires_at,expires_at,accepted_by,accepted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [row.id, row.family_id, row.inviter_id, row.intended_email, row.token_hash, row.status, row.policy_version,
      row.inviter_membership_version, row.family_version, row.token_ciphertext, row.token_ciphertext_expires_at,
      row.expires_at, row.accepted_by, row.accepted_at]);
  };
  const failure = async (query, code, label) => {
    const error = await query.then(() => null, thrown => thrown);
    assert.equal(error?.code, code, `${label ?? ''} ${error?.constraint ?? error?.message}`);
  };
  await failure(insertInvitation({ status: 'paused' }), '23514', 'status');
  await failure(insertInvitation({ token_hash: stored.token_hash }), '23505', 'duplicate digest');
  await failure(insertInvitation({ token_hash: tokenDigest(randomUUID()).toUpperCase() }), '23514', 'digest case');
  await failure(insertInvitation({ token_hash: 'short' }), '23514', 'digest length');
  await failure(insertInvitation({ family_id: randomUUID() }), '23503', 'unknown family');
  await failure(insertInvitation({ inviter_id: randomUUID() }), '23503', 'unknown inviter');
  await failure(insertInvitation({ status: 'accepted', accepted_by: randomUUID(), accepted_at: fx.clock() }), '23503', 'unknown acceptor');
  await failure(insertInvitation({ accepted_by: stored.inviter_id, accepted_at: fx.clock() }), '23514', 'accepted flag');
  await failure(insertInvitation({ status: 'accepted' }), '23514', 'accepted without acceptor');
  await failure(insertInvitation({ intended_email: 'Family@example.test' }), '23514', 'address case');
  await failure(insertInvitation({ inviter_membership_version: 0 }), '23514', 'membership version');
  await failure(insertInvitation({ policy_version: 'Family Invitation' }), '23514', 'policy version');
  await failure(insertInvitation({ token_ciphertext: 'sealed' }), '23514', 'ciphertext without deadline');
  await failure(insertInvitation({ expires_at: new Date(+fx.clock() - minute) }), '23514', 'deadline before creation');
  assert.equal(await inviteRows(), 1);
});

test('an owner creates one targeted 24-hour invitation and only keyed material is stored', async () => {
  const owner = await adult();
  const own = await family(owner);
  const requestKey = randomUUID();
  const address = `Family.Invite.${randomUUID().slice(0, 8)}@Example.Test`;
  const now = fx.clock();
  const created = await invite(owner, own, { intendedEmail: `  ${address}  ` }, requestKey);

  assert.deepEqual(familyInvitationCreatedSchema.parse(created), created);
  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.expiresAt, new Date(+now + day).toISOString());
  const stored = (await rows('SELECT * FROM siyue.family_invitations WHERE id=$1', [created.invitationId]))[0];
  assert.deepEqual([stored.status, stored.family_id, stored.inviter_id], ['pending', own.familyId, subjectOf(owner)]);
  assert.equal(stored.intended_email, address.toLowerCase());
  assert.equal(stored.token_hash, tokenDigest(created.token));
  assert.notEqual(stored.token_hash, created.token);
  assert.deepEqual([stored.policy_version, stored.inviter_membership_version, stored.family_version],
    ['family-invitation-v1', own.membershipVersion, own.familyVersion]);
  assert.deepEqual([stored.accepted_by, stored.accepted_at], [null, null]);
  assert.equal(+stored.expires_at, +now + day);
  assert.equal(+stored.token_ciphertext_expires_at, +now + minute);
  assert.ok(stored.token_ciphertext && !stored.token_ciphertext.includes(created.token));

  // No raw token, raw request key or raw address reaches any stored row.
  const dump = JSON.stringify(await rows('SELECT * FROM siyue.family_invitations'))
    + JSON.stringify(await rows('SELECT * FROM siyue.idempotency_records'))
    + JSON.stringify(await rows('SELECT * FROM siyue.security_events'));
  for (const secret of [created.token, requestKey, `  ${address}  `]) assert.equal(dump.includes(secret), false, secret);
  const [event] = await rows("SELECT * FROM siyue.security_events WHERE event_type='family.invitation.create'");
  assert.deepEqual([event.outcome, event.subject_id, event.session_id, event.redacted_metadata],
    ['success', subjectOf(owner), tokensOf(owner).session.sessionId, { invitationId: created.invitationId }]);
  assert.equal(event.request_id.includes(requestKey), false);
  assert.equal(JSON.stringify(event).includes(address.toLowerCase()), false);
  // The invitation alone grants nothing: the family still has its single owner membership.
  assert.equal(await members(own.familyId), 1);

  // A second, differently keyed invitation is a distinct secret and a distinct row.
  const second = await invite(owner, own, { intendedEmail: address });
  assert.notEqual(second.invitationId, created.invitationId);
  assert.notEqual(second.token, created.token);
  assert.equal(await inviteRows(), 2);
});

test('only a current owner or admin of an active family can invite, and no refusal writes', async () => {
  const owner = await adult(), admin = await adult(), member = await adult(), stranger = await adult(), blocked = await adult();
  const own = await family(owner);
  await addMembership(own.familyId, subjectOf(admin), 'admin', 3);
  await addMembership(own.familyId, subjectOf(member), 'member', 2);
  await addMembership(own.familyId, subjectOf(blocked), 'member', 1);
  const before = await inviteRows();

  // A foreign subject and an unknown family stay indistinguishable.
  await assert.rejects(invite(stranger, own), refuses('FAMILY_NOT_FOUND', 404));
  await assert.rejects(invite(owner, { familyId: randomUUID(), membershipVersion: 1, familyVersion: 1 }), refuses('FAMILY_NOT_FOUND', 404));
  // The existing domain policy keeps a plain member below the invite action.
  await assert.rejects(invite(member, { familyId: own.familyId, membershipVersion: 2, familyVersion: 1 }), refuses('FAMILY_INVITE_FORBIDDEN', 403));
  // Stale versions are refused for the owner too, and never silently corrected.
  await assert.rejects(invite(owner, { familyId: own.familyId, membershipVersion: 2, familyVersion: 1 }), refuses('FAMILY_STALE_AUTHORIZATION', 409));
  await assert.rejects(invite(owner, { familyId: own.familyId, membershipVersion: 1, familyVersion: 4 }), refuses('FAMILY_STALE_AUTHORIZATION', 409));
  // A child session never holds family management, whatever its membership row says.
  const kid = await child(owner, own);
  await assert.rejects(invite(kid, { familyId: own.familyId, membershipVersion: 1, familyVersion: 1 }), refuses('FAMILY_ADULT_REQUIRED', 403));
  // A blocked subject cannot even hold a usable session.
  await db.app.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1", [subjectOf(blocked)]);
  await assert.rejects(invite(blocked, { familyId: own.familyId, membershipVersion: 1, familyVersion: 1 }), refuses('AUTH_SESSION_INVALID', 401));
  // Malformed requests, unknown fields and invalid keys are refused before any work.
  for (const bad of [
    { familyId: 'not-a-uuid', expectedMembershipVersion: 1, expectedFamilyVersion: 1 },
    { familyId: own.familyId, expectedMembershipVersion: 0, expectedFamilyVersion: 1 },
    { familyId: own.familyId, expectedMembershipVersion: 1, expectedFamilyVersion: 1.5 },
    { familyId: own.familyId, expectedMembershipVersion: 1, expectedFamilyVersion: 1, role: 'admin' },
    { familyId: own.familyId, expectedMembershipVersion: 1, expectedFamilyVersion: 1, intendedEmail: 'not-an-email' },
    {}, null, undefined,
  ]) await assert.rejects(invitations.create(tokenOf(owner), bad, randomUUID()), refuses('FAMILY_INVALID_REQUEST', 400));
  for (const badKey of ['', 'not-a-uuid', `${randomUUID()} `, randomUUID().slice(0, 35), randomUUID().replace('-', '_'), 42, null]) {
    await assert.rejects(invite(owner, own, {}, badKey), refuses('FAMILY_INVALID_REQUEST', 400), String(badKey));
  }
  // A missing key is refused too; it never falls back to a default value.
  await assert.rejects(invitations.create(tokenOf(owner), { familyId: own.familyId, expectedMembershipVersion: 1, expectedFamilyVersion: 1 }, undefined),
    refuses('FAMILY_INVALID_REQUEST', 400));
  // An unusable access token is refused by the session layer, not by a family decision.
  await assert.rejects(acceptWith('not-a-token', 'x'.repeat(43)), refuses('AUTH_ACCESS_INVALID', 401));
  await assert.rejects(invitations.create('', { familyId: own.familyId, expectedMembershipVersion: 1, expectedFamilyVersion: 1 },
    randomUUID()), refuses('AUTH_ACCESS_INVALID', 401));
  // A dissolved family and a deactivated membership remove management without rewriting versions.
  await db.app.query("UPDATE siyue.families SET status='dissolved', version=version+1 WHERE id=$1", [own.familyId]);
  await assert.rejects(invite(owner, { familyId: own.familyId, membershipVersion: 1, familyVersion: 2 }), refuses('FAMILY_INVITATION_FAMILY_INACTIVE', 409));
  await db.app.query("UPDATE siyue.families SET status='active', version=1 WHERE id=$1", [own.familyId]);
  await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2', [own.familyId, subjectOf(admin)]);
  await assert.rejects(invite(admin, { familyId: own.familyId, membershipVersion: 3, familyVersion: 1 }), refuses('FAMILY_NOT_FOUND', 404));

  assert.equal(await inviteRows(), before);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.invitation.create'"), 0);
  assert.deepEqual((await rows('SELECT owner_subject_id, version FROM siyue.families WHERE id=$1', [own.familyId]))[0],
    { owner_subject_id: subjectOf(owner), version: 1 });
});

test('a current admin invites with the versions it read and the invitation records that authority', async () => {
  const owner = await adult(), admin = await adult();
  const own = await family(owner);
  await addMembership(own.familyId, subjectOf(admin), 'admin', 3);
  await db.app.query('UPDATE siyue.families SET version=2 WHERE id=$1', [own.familyId]);
  const created = await invite(admin, { familyId: own.familyId, membershipVersion: 3, familyVersion: 2 });
  const stored = (await rows('SELECT * FROM siyue.family_invitations WHERE id=$1', [created.invitationId]))[0];
  assert.deepEqual([stored.inviter_id, stored.inviter_membership_version, stored.family_version], [subjectOf(admin), 3, 2]);
});

test('one create key replays its invitation, conflicts on another payload and closes its recovery window', async () => {
  const owner = await adult(), admin = await adult(), other = await adult();
  const own = await family(owner);
  await addMembership(own.familyId, subjectOf(admin), 'admin', 1);
  const requestKey = randomUUID();
  const first = await invite(owner, own, {}, requestKey);
  assert.deepEqual(await invite(owner, own, {}, requestKey), first);
  assert.equal(await inviteRows(), 1);
  // The same key with another payload is a conflict instead of a second invitation.
  await assert.rejects(invite(owner, own, { intendedEmail: 'other.target@example.test' }, requestKey), refuses('FAMILY_INVITATION_CONFLICT', 409));
  await assert.rejects(invite(owner, own, { expectedFamilyVersion: 9 }, requestKey), refuses('FAMILY_INVITATION_CONFLICT', 409));
  assert.equal(await inviteRows(), 1);
  // A key belongs to one inviter, so another inviter may reuse the same value.
  const adminInvite = await invite(admin, { familyId: own.familyId, membershipVersion: 1, familyVersion: 1 }, {}, requestKey);
  assert.notEqual(adminInvite.invitationId, first.invitationId);
  assert.equal(await inviteRows(), 2);
  // Concurrent identical creates converge on one invitation and one response.
  const raceKey = randomUUID(), otherFamily = await family(other);
  const raced = await Promise.all([invite(other, otherFamily, {}, raceKey), invite(other, otherFamily, {}, raceKey)]);
  assert.deepEqual(raced[0], raced[1]);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_invitations WHERE family_id=$1', [otherFamily.familyId]), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope=$1', [`family-invitation:${otherFamily.familyId}`]), 1);
  // The stored response is recoverable only inside its short window; afterwards the key is closed.
  fx.advance(minute + 1_000);
  await assert.rejects(invite(owner, own, {}, requestKey), refuses('FAMILY_INVITATION_RECOVERY_EXPIRED', 409));
  const stored = (await rows('SELECT status,token_ciphertext,token_ciphertext_expires_at FROM siyue.family_invitations WHERE id=$1', [first.invitationId]))[0];
  assert.deepEqual([stored.status, stored.token_ciphertext, stored.token_ciphertext_expires_at], ['pending', null, null]);
  assert.equal(await inviteRows(), 3);
  const third = await invite(owner, own);
  assert.notEqual(third.invitationId, first.invitationId);
  assert.notEqual(third.token, first.token);
});

test('a revoked inviter cannot recover the invitation token with the original create key', async () => {
  const owner = await adult(), admin = await adult();
  const own = await family(owner);
  await addMembership(own.familyId, subjectOf(admin), 'admin', 1);
  const key = randomUUID();
  const created = await invite(admin, { familyId: own.familyId, membershipVersion: 1, familyVersion: 1 }, {}, key);
  await db.app.query("UPDATE siyue.family_memberships SET role='member' WHERE family_id=$1 AND subject_id=$2",
    [own.familyId, subjectOf(admin)]);
  await assert.rejects(invite(admin, { familyId: own.familyId, membershipVersion: 1, familyVersion: 1 }, {}, key),
    refuses('FAMILY_INVITE_FORBIDDEN', 403));
  assert.equal(await inviteRows(), 1);
  const stored = (await rows('SELECT status,token_ciphertext FROM siyue.family_invitations WHERE id=$1', [created.invitationId]))[0];
  assert.equal(stored.status, 'pending');
  assert.ok(stored.token_ciphertext);
});

test('an invited adult accepts once into a plain member membership and never gains a higher role', async () => {
  const owner = await adult(), invitee = await adult();
  const own = await family(owner);
  const created = await invite(owner, own);
  const summary = await accept(invitee, created.token);
  assert.deepEqual(familySummarySchema.parse(summary), summary);
  assert.deepEqual(summary, { familyId: own.familyId, ownerSubjectId: subjectOf(owner), role: 'member', membershipVersion: 1, familyVersion: 1 });

  const membership = (await rows('SELECT * FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2', [own.familyId, subjectOf(invitee)]))[0];
  assert.deepEqual([membership.role, membership.active, membership.version], ['member', true, 1]);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1 AND role IN ('owner','admin')", [own.familyId]), 1);
  assert.deepEqual((await rows('SELECT owner_subject_id, version FROM siyue.families WHERE id=$1', [own.familyId]))[0],
    { owner_subject_id: subjectOf(owner), version: 1 });
  // The invitation is consumed once and its recoverable response is destroyed.
  const invitation = (await rows('SELECT * FROM siyue.family_invitations WHERE id=$1', [created.invitationId]))[0];
  assert.deepEqual([invitation.status, invitation.accepted_by, invitation.token_ciphertext, invitation.token_ciphertext_expires_at],
    ['accepted', subjectOf(invitee), null, null]);
  assert.equal(+invitation.accepted_at, +fx.clock());
  // The membership is real for the existing repository, with the same versions.
  assert.deepEqual(await families.list(subjectOf(invitee)), [summary]);
  // Minimal audit bound to the accepting session, without token or address material.
  const [event] = await rows("SELECT * FROM siyue.security_events WHERE event_type='family.invitation.accept' AND outcome='success'");
  assert.deepEqual([event.subject_id, event.session_id, event.redacted_metadata],
    [subjectOf(invitee), tokensOf(invitee).session.sessionId, { invitationId: created.invitationId }]);
  assert.equal(JSON.stringify(event).includes(created.token), false);
  // Being a member is not being an admin: the accepted role cannot invite.
  await assert.rejects(invite(invitee, summary), refuses('FAMILY_INVITE_FORBIDDEN', 403));
});

test('a repeat accept with the same key and actor is the same result while other claims are refused', async () => {
  const owner = await adult(), first = await adult(), second = await adult();
  const own = await family(owner);
  const created = await invite(owner, own);
  const acceptKey = randomUUID();
  const accepted = await accept(first, created.token, acceptKey);
  assert.deepEqual(await accept(first, created.token, acceptKey), accepted);
  assert.equal(await members(own.familyId), 2);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.invitation.accept' AND outcome='success'"), 1);
  // Another key for the same actor is a different request, not a second membership.
  await assert.rejects(accept(first, created.token, randomUUID()), refuses('FAMILY_INVITATION_ALREADY_ACCEPTED', 409));
  // Another actor cannot claim the consumed invitation, with the same or another key.
  await assert.rejects(accept(second, created.token, acceptKey), refuses('FAMILY_INVITATION_ALREADY_ACCEPTED', 409));
  await assert.rejects(accept(second, created.token, randomUUID()), refuses('FAMILY_INVITATION_ALREADY_ACCEPTED', 409));
  assert.equal(await members(own.familyId), 2);
  // Once the record window closed, an identical repeat is refused instead of being restored.
  fx.advance(day + minute);
  const later = await sessionFor(subjectOf(first));
  await assert.rejects(acceptWith(later.accessToken, created.token, acceptKey), refuses('FAMILY_INVITATION_ALREADY_ACCEPTED', 409));
  assert.equal(await members(own.familyId), 2);
});

test('accept refuses unknown, malformed, revoked, unauthorized and duplicate invitations', async () => {
  const owner = await adult(), invitee = await adult(), existing = await adult();
  const own = await family(owner);
  const created = await invite(owner, own);
  // A valid-looking unknown token is the same answer as a token that never existed.
  await assert.rejects(accept(invitee, randomBytes(32).toString('base64url')), refuses('FAMILY_INVITATION_NOT_FOUND', 404));
  for (const bad of ['', 'short', 'x'.repeat(42), 'x'.repeat(44), `${'x'.repeat(42)}+`, `${created.token.slice(0, 42)}é`, 42, null, undefined]) {
    await assert.rejects(accept(invitee, bad), refuses('FAMILY_INVALID_REQUEST', 400), String(bad));
  }
  await assert.rejects(acceptWith(tokenOf(invitee), created.token, 'not-a-uuid'), refuses('FAMILY_INVALID_REQUEST', 400));
  await assert.rejects(acceptWith('not-a-token', created.token), refuses('AUTH_ACCESS_INVALID', 401));
  const kid = await child(owner, own);
  await assert.rejects(acceptWith(kid.accessToken, created.token), refuses('FAMILY_ADULT_REQUIRED', 403));
  // The inviter is already a member: no self-join and no duplicate membership.
  await assert.rejects(accept(owner, created.token), refuses('FAMILY_INVITATION_SELF_ACCEPT', 409));
  await addMembership(own.familyId, subjectOf(existing), 'member', 5);
  await assert.rejects(accept(existing, created.token), refuses('FAMILY_ALREADY_MEMBER', 409));
  // A removed member is not silently re-added by an old invitation, and their row is untouched.
  await db.app.query('UPDATE siyue.family_memberships SET active=false, version=6 WHERE family_id=$1 AND subject_id=$2', [own.familyId, subjectOf(existing)]);
  await assert.rejects(accept(existing, created.token), refuses('FAMILY_ALREADY_MEMBER', 409));
  assert.deepEqual((await rows('SELECT active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2', [own.familyId, subjectOf(existing)]))[0],
    { active: false, version: 6 });
  assert.equal(await members(own.familyId), 3); // owner, grant-backed child and inactive former member
  // A revoked invitation is refused and stays unusable.
  await db.app.query("UPDATE siyue.family_invitations SET status='revoked' WHERE id=$1", [created.invitationId]);
  await assert.rejects(accept(invitee, created.token), refuses('FAMILY_INVITATION_REVOKED', 409));
  await assert.rejects(accept(invitee, created.token), refuses('FAMILY_INVITATION_REVOKED', 409));

  // Every authority the invitation was issued under is re-checked before joining.
  const damaged = [
    ['membership version', fam => db.app.query('UPDATE siyue.family_memberships SET version=version+1 WHERE family_id=$1 AND role=$2', [fam.familyId, 'owner'])],
    ['demotion', fam => db.app.query("UPDATE siyue.family_memberships SET role='member' WHERE family_id=$1 AND role='owner'", [fam.familyId])],
    ['deactivated membership', fam => db.app.query("UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND role='owner'", [fam.familyId])],
    ['blocked inviter', (_fam, owner) => db.app.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1", [subjectOf(owner)])],
    ['child inviter', (_fam, owner) => db.app.query("UPDATE siyue.subjects SET kind='child' WHERE id=$1", [subjectOf(owner)])],
    ['family version', fam => db.app.query('UPDATE siyue.families SET version=version+1 WHERE id=$1', [fam.familyId])],
    ['dissolved family', fam => db.app.query("UPDATE siyue.families SET status='dissolved' WHERE id=$1", [fam.familyId])],
  ];
  for (const [label, damage] of damaged) {
    const damageOwner = await adult(), damageInvitee = await adult();
    const damageFamily = await family(damageOwner);
    const invitation = await invite(damageOwner, damageFamily);
    await damage(damageFamily, damageOwner);
    await assert.rejects(accept(damageInvitee, invitation.token), refuses('FAMILY_INVITATION_INVITER_INELIGIBLE', 409), label);
    // A changed authority leaves the invitation pending and unusable; only the deadline destroys it.
    assert.deepEqual((await rows('SELECT status,token_ciphertext FROM siyue.family_invitations WHERE id=$1', [invitation.invitationId]))
      .map(row => [row.status, row.token_ciphertext !== null]), [['pending', true]], label);
    assert.equal(await members(damageFamily.familyId), 1, label);
  }
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.invitation.accept' AND outcome='success'"), 0);

  // Deadline: after 24 hours the token is refused, the row expires and its response is destroyed.
  const lateOwner = await adult(), lateInvitee = await adult();
  const lateFamily = await family(lateOwner);
  const lateInvitation = await invite(lateOwner, lateFamily);
  fx.advance(day + 1_000);
  const late = await sessionFor(subjectOf(lateInvitee));
  await assert.rejects(acceptWith(late.accessToken, lateInvitation.token), refuses('FAMILY_INVITATION_EXPIRED', 409));
  assert.deepEqual((await rows('SELECT status,token_ciphertext,token_ciphertext_expires_at,accepted_by FROM siyue.family_invitations WHERE id=$1',
    [lateInvitation.invitationId])).map(row => [row.status, row.token_ciphertext, row.token_ciphertext_expires_at, row.accepted_by]),
  [['expired', null, null, null]]);
  assert.equal(await members(lateFamily.familyId), 1);
  await assert.rejects(acceptWith(late.accessToken, lateInvitation.token), refuses('FAMILY_INVITATION_EXPIRED', 409));
});

test('a targeted invitation only matches the acceptor’s own verified login email with a password', async () => {
  const owner = await adult();
  const own = await family(owner);
  // A real email registration: verified login address plus a password credential.
  const registered = await fx.register(`  Parent.${randomUUID().slice(0, 8)}@Example.Test  `);
  assert.equal(await members(own.familyId), 1);
  // Another subject holding the token cannot accept an invitation addressed to someone else.
  const otherTarget = await invite(owner, own, { intendedEmail: `stranger.${randomUUID().slice(0, 8)}@example.test` });
  await assert.rejects(accept({ tokens: registered.tokens }, otherTarget.token), refuses('FAMILY_INVITATION_TARGET_MISMATCH', 403));
  // A profile address that equals the target is not a login method.
  const profileTarget = `profile.${randomUUID().slice(0, 8)}@example.test`;
  const profileInvitation = await invite(owner, own, { intendedEmail: profileTarget });
  const profileOnly = await adult();
  await db.app.query(`INSERT INTO siyue.account_emails(id,subject_id,email_original,email_normalized,verified_at,login_enabled)
    VALUES($1,$2,$3,$4,now(),false)`, [randomUUID(), subjectOf(profileOnly), profileTarget, profileTarget]);
  await assert.rejects(accept(profileOnly, profileInvitation.token), refuses('FAMILY_INVITATION_TARGET_MISMATCH', 403));
  // A verified login address without a usable password credential is refused as well.
  const passwordlessTarget = `passwordless.${randomUUID().slice(0, 8)}@example.test`;
  const passwordlessInvitation = await invite(owner, own, { intendedEmail: passwordlessTarget });
  const noPassword = await adult();
  await db.app.query(`INSERT INTO siyue.account_emails(id,subject_id,email_original,email_normalized,verified_at,login_enabled)
    VALUES($1,$2,$3,$4,now(),true)`, [randomUUID(), subjectOf(noPassword), passwordlessTarget, passwordlessTarget]);
  await assert.rejects(accept(noPassword, passwordlessInvitation.token), refuses('FAMILY_INVITATION_TARGET_MISMATCH', 403));
  for (const subjectId of [subjectOf(profileOnly), subjectOf(noPassword)]) assert.equal(await members(own.familyId), 1, subjectId);
  // Every refusal is audited minimally, without address material.
  const rejected = await rows("SELECT * FROM siyue.security_events WHERE event_type='family.invitation.accept' AND outcome='rejected'");
  assert.equal(rejected.length, 3);
  assert.deepEqual(rejected.map(event => event.redacted_metadata.reason), ['target_mismatch', 'target_mismatch', 'target_mismatch']);
  assert.equal(JSON.stringify(rejected).includes('example.test'), false);
  // The matching verified login email accepts exactly once.
  const targeted = await invite(owner, own, { intendedEmail: registered.address });
  const summary = await accept({ tokens: registered.tokens }, targeted.token);
  assert.deepEqual(summary, { familyId: own.familyId, ownerSubjectId: subjectOf(owner), role: 'member', membershipVersion: 1, familyVersion: 1 });
  assert.equal(await members(own.familyId), 2);
  assert.deepEqual((await rows('SELECT intended_email FROM siyue.family_invitations WHERE id=$1', [targeted.invitationId]))[0].intended_email,
    registered.address.trim().toLowerCase());
});

test('a failure inside acceptance rolls back the membership, the invitation and the audit', async () => {
  const owner = await adult(), invitee = await adult();
  const own = await family(owner);
  const created = await invite(owner, own);
  const acceptKey = randomUUID();
  const broken = { async connect() {
    const client = await db.app.connect();
    return new Proxy(client, { get(target, property) {
      if (property === 'query') return (text, params) => (typeof text === 'string' && text.includes('INSERT INTO siyue.security_events')
        ? Promise.reject(new Error('synthetic_invitation_audit_failure')) : target.query(text, params));
      if (property === 'release') return target.release.bind(target);
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const failing = createFamilyInvitationService(broken, fx.service, fx.cipher, pepper, fx.clock);
  // The injected failure lands after the membership insert and the invitation update, so only a real
  // rollback can leave the family, the invitation and the audit trail untouched.
  await assert.rejects(failing.accept(tokenOf(invitee), created.token, acceptKey), /synthetic_invitation_audit_failure/);
  assert.equal(await members(own.familyId), 1);
  const pending = (await rows('SELECT status,token_ciphertext,accepted_by FROM siyue.family_invitations WHERE id=$1', [created.invitationId]))[0];
  assert.deepEqual([pending.status, pending.accepted_by], ['pending', null]);
  assert.ok(pending.token_ciphertext !== null);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.invitation.accept'"), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope=$1', [`family-invitation-accept:${created.invitationId}`]), 0);
  // The same key completes the invitation on a healthy connection; nothing was half-committed.
  assert.deepEqual((await accept(invitee, created.token, acceptKey)).role, 'member');
  assert.equal(await members(own.familyId), 2);
});

test('a failure inside create rolls the invitation and its key record back', async () => {
  const owner = await adult();
  const own = await family(owner);
  const requestKey = randomUUID();
  const broken = { async connect() {
    const client = await db.app.connect();
    return new Proxy(client, { get(target, property) {
      if (property === 'query') return (text, params) => (typeof text === 'string' && text.includes('INSERT INTO siyue.security_events')
        ? Promise.reject(new Error('synthetic_invitation_create_failure')) : target.query(text, params));
      if (property === 'release') return target.release.bind(target);
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const failing = createFamilyInvitationService(broken, fx.service, fx.cipher, pepper, fx.clock);
  await assert.rejects(failing.create(tokenOf(owner), { familyId: own.familyId, expectedMembershipVersion: 1, expectedFamilyVersion: 1 },
    requestKey), /synthetic_invitation_create_failure/);
  assert.equal(await inviteRows(), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records'), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.invitation.create'"), 0);
  assert.equal((await invite(owner, own, {}, requestKey)).token.length, 43);
  assert.equal(await inviteRows(), 1);
});

test('competing claimants and identical retries converge on one membership', async () => {
  const owner = await adult(), first = await adult(), second = await adult();
  const own = await family(owner);
  const created = await invite(owner, own);
  const raced = await Promise.allSettled([accept(first, created.token), accept(second, created.token)]);
  assert.deepEqual(raced.map(entry => entry.status), ['fulfilled', 'rejected']);
  assert.equal(raced[1].reason.code, 'FAMILY_INVITATION_ALREADY_ACCEPTED');
  assert.equal(await members(own.familyId), 2);
  assert.deepEqual((await rows('SELECT status FROM siyue.family_invitations WHERE id=$1', [created.invitationId]))[0].status, 'accepted');

  // Identical concurrent retries of one actor and key return the same result once.
  const otherOwner = await adult(), otherInvitee = await adult();
  const otherFamily = await family(otherOwner);
  const otherInvitation = await invite(otherOwner, otherFamily);
  const acceptKey = randomUUID();
  const both = await Promise.all([accept(otherInvitee, otherInvitation.token, acceptKey), accept(otherInvitee, otherInvitation.token, acceptKey)]);
  assert.deepEqual(both[0], both[1]);
  assert.equal(await members(otherFamily.familyId), 2);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.invitation.accept' AND outcome='success'"), 2);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope=$1', [`family-invitation-accept:${otherInvitation.invitationId}`]), 1);
});

test('cleanup destroys closed recovery responses, expires deadlines and drops only its own records', async () => {
  const owner = await adult(), invitee = await adult();
  const own = await family(owner);
  const pending = await invite(owner, own);
  const accepted = await invite(owner, own);
  const summary = await accept(invitee, accepted.token);
  // A closed recovery window clears the sealed response while the invitation can still be used.
  fx.advance(minute + 1_000);
  await invitations.cleanupExpired();
  assert.deepEqual((await rows('SELECT status,token_ciphertext,token_ciphertext_expires_at FROM siyue.family_invitations WHERE id=$1',
    [pending.invitationId])).map(row => [row.status, row.token_ciphertext, row.token_ciphertext_expires_at]), [['pending', null, null]]);
  // Accepted invitations, memberships and the audit trail survive a cleanup run.
  assert.deepEqual((await rows('SELECT status,accepted_by FROM siyue.family_invitations WHERE id=$1', [accepted.invitationId]))
    .map(row => [row.status, row.accepted_by]), [['accepted', subjectOf(invitee)]]);
  assert.deepEqual(await families.list(subjectOf(invitee)), [summary]);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type LIKE 'family.invitation.%'"), 3);
  // After the deadline the invitation expires and its key record is dropped.
  fx.advance(day);
  await invitations.cleanupExpired();
  assert.deepEqual((await rows('SELECT status,token_ciphertext FROM siyue.family_invitations WHERE id=$1', [pending.invitationId]))
    .map(row => [row.status, row.token_ciphertext]), [['expired', null]]);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope LIKE 'family-invitation%'"), 0);
  // Records of other modules are left alone, and a repeated cleanup stays a no-op.
  await db.app.query(`INSERT INTO siyue.idempotency_records(scope,key_hash,request_mac,status,expires_at)
    VALUES('email-request',$1,'synthetic',$2,$3)`, [keyHash(), 'complete', new Date(+fx.clock() - minute)]);
  await invitations.cleanupExpired();
  await invitations.cleanupExpired();
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope='email-request'"), 1);
  assert.equal(await members(own.familyId), 2);
});

test('create-key recovery re-checks the inviter and never returns the token after authority is lost', async () => {
  const owner = await adult();
  const own = await family(owner);
  const requestKey = randomUUID();
  const created = await invite(owner, own, {}, requestKey);
  // Control: while the authority is unchanged the same key still recovers the same response.
  assert.deepEqual(await invite(owner, own, {}, requestKey), created);

  // Every way of losing that authority refuses the replay instead of handing back the sealed token.
  const damaged = [
    ['membership version', (fam, who) => db.app.query('UPDATE siyue.family_memberships SET version=version+1 WHERE family_id=$1 AND subject_id=$2',
      [fam.familyId, subjectOf(who)]), 'FAMILY_STALE_AUTHORIZATION', 409],
    ['demotion', (fam, who) => db.app.query("UPDATE siyue.family_memberships SET role='member' WHERE family_id=$1 AND subject_id=$2",
      [fam.familyId, subjectOf(who)]), 'FAMILY_INVITE_FORBIDDEN', 403],
    ['removed membership', (fam, who) => db.app.query('DELETE FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
      [fam.familyId, subjectOf(who)]), 'FAMILY_NOT_FOUND', 404],
    ['deactivated membership', (fam, who) => db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2',
      [fam.familyId, subjectOf(who)]), 'FAMILY_NOT_FOUND', 404],
    ['family version', fam => db.app.query('UPDATE siyue.families SET version=version+1 WHERE id=$1', [fam.familyId]),
      'FAMILY_STALE_AUTHORIZATION', 409],
    ['dissolved family', fam => db.app.query("UPDATE siyue.families SET status='dissolved' WHERE id=$1", [fam.familyId]),
      'FAMILY_INVITATION_FAMILY_INACTIVE', 409],
    // A blocked or demoted-to-child inviter cannot even present a usable session any more.
    ['blocked inviter', (_fam, who) => db.app.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1", [subjectOf(who)]),
      'AUTH_SESSION_INVALID', 401],
    ['child inviter', (_fam, who) => db.app.query("UPDATE siyue.subjects SET kind='child' WHERE id=$1", [subjectOf(who)]),
      'AUTH_SESSION_INVALID', 401],
  ];
  for (const [label, damage, code, status] of damaged) {
    const damageOwner = await adult();
    const damageFamily = await family(damageOwner);
    const damageKey = randomUUID();
    const invitation = await invite(damageOwner, damageFamily, {}, damageKey);
    await damage(damageFamily, damageOwner);
    await assert.rejects(invite(damageOwner, damageFamily, {}, damageKey), refuses(code, status), label);
    // Repeating the retry stays refused, and the row keeps only the keyed digest of the token.
    await assert.rejects(invite(damageOwner, damageFamily, {}, damageKey), refuses(code, status), label);
    const stored = (await rows('SELECT status,token_hash,token_ciphertext FROM siyue.family_invitations WHERE id=$1', [invitation.invitationId]))[0];
    assert.deepEqual([stored.status, stored.token_hash, stored.token_ciphertext !== null], ['pending', tokenDigest(invitation.token), true], label);
    // The invitation is unusable for acceptance as well, so no live token was ever handed out.
    if (status !== 401) {
      const damageInvitee = await adult();
      await assert.rejects(accept(damageInvitee, invitation.token), refuses('FAMILY_INVITATION_INVITER_INELIGIBLE', 409), label);
    }
  }

  // Losing the authority does not leave a token anywhere an actor or a reader can pick it up.
  const dump = JSON.stringify([await rows('SELECT * FROM siyue.family_invitations'), await rows('SELECT * FROM siyue.idempotency_records'),
    await rows('SELECT * FROM siyue.security_events')]);
  for (const secret of [created.token, requestKey]) assert.equal(dump.includes(secret), false, secret);
  // Only the original, still authorized creation was audited: a refused recovery writes nothing.
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.invitation.create'"), 1 + damaged.length);
});

test('create and accept audits stay minimal while target email is confined to its invitation row', async () => {
  const owner = await adult(), invitee = await adult();
  const own = await family(owner);
  const requestKey = randomUUID();
  const target = `audit.${randomUUID().slice(0, 8)}@example.test`;
  const created = await invite(owner, own, { intendedEmail: target }, requestKey);
  // A legitimate same-key recovery is not a new operation and must not add an audit row.
  assert.deepEqual(await invite(owner, own, { intendedEmail: target }, requestKey), created);
  const open = await invite(owner, own);
  const summary = await accept(invitee, open.token);
  assert.deepEqual(summary.role, 'member');

  // Refusals write no audit row and no invitation: a member cannot invite, and a stale family version is refused.
  await assert.rejects(invite(invitee, summary), refuses('FAMILY_INVITE_FORBIDDEN', 403));
  await assert.rejects(invite(owner, own, { expectedFamilyVersion: 9 }, randomUUID()), refuses('FAMILY_STALE_AUTHORIZATION', 409));
  assert.equal(await inviteRows(), 2);
  const events = await rows('SELECT * FROM siyue.security_events ORDER BY event_type');
  assert.deepEqual(events.map(event => [event.event_type, event.outcome, event.subject_id, event.session_id, event.redacted_metadata]), [
    ['family.invitation.accept', 'success', subjectOf(invitee), tokensOf(invitee).session.sessionId, { invitationId: open.invitationId }],
    ['family.invitation.create', 'success', subjectOf(owner), tokensOf(owner).session.sessionId, { invitationId: created.invitationId }],
    ['family.invitation.create', 'success', subjectOf(owner), tokensOf(owner).session.sessionId, { invitationId: open.invitationId }],
  ]);
  // Neither the raw tokens nor the raw request key exists in any table. The target address is
  // deliberately stored on its invitation row to enforce a matching verified login at acceptance.
  const dump = JSON.stringify([await rows('SELECT * FROM siyue.family_invitations'), await rows('SELECT * FROM siyue.idempotency_records'),
    await rows('SELECT * FROM siyue.security_events'), await rows('SELECT * FROM siyue.outbox_jobs'), await rows('SELECT * FROM siyue.account_emails')]);
  for (const secret of [created.token, open.token, requestKey]) assert.equal(dump.includes(secret), false, secret);
  assert.equal(dump.includes(target), true);
  // What the row stores is the keyed digest, and the audit trail carries no address or token at all.
  assert.equal((await rows('SELECT token_hash FROM siyue.family_invitations WHERE id=$1', [created.invitationId]))[0].token_hash, tokenDigest(created.token));
  assert.equal(JSON.stringify(events).includes('example.test'), false);
});
