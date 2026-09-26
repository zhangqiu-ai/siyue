import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createAuthFixture } from './auth-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { migrateDatabase, readMigrations } from '../../dist/adapters/postgres/migrate.js';
import { roomCapacityRepository } from '../../dist/modules/rooms/capacity.js';
import { roomInvitationRepository, RoomInvitationError } from '../../dist/modules/rooms/invitations.js';

// Family-room invitations (C11, design 16.5, spec VWC-02) against an isolated temporary PostgreSQL
// cluster only: the fixture always builds a fresh cluster on a short Unix socket and never reads a
// database URL or the workspace .env. Every subject, session, family, room and invitation below is
// synthetic, and no mail, provider, RTC vendor, shell or network call happens here.
//
// The invitation repository is internal and has no HTTP surface, so the calls below run inside
// caller-owned transactions the way the future authorized route must: verify the session with the
// session kernel in that same transaction, decide the confirmed C11 parent authorization, accept the
// invitation, then take a join verdict and seat the device through the seat kernel. The positive paths
// use child devices the pairing flow really granted, which is the only path that also re-checks the
// grant, guardian relationship, consent and family state. A few identity-shape refusals use a
// synthesized `auth_sessions` row and are labelled as such: they prove this repository's own session
// check only, never the session kernel's child authorization, and this file is not child-auth coverage.
let db, fx;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query(`TRUNCATE siyue.room_invitations,siyue.room_seats,siyue.rooms,siyue.auth_sessions,
    siyue.refresh_tokens,siyue.reauth_grants,siyue.device_grants,siyue.guardian_relationships,
    siyue.consent_records,siyue.device_pairing_requests,siyue.family_invitations,siyue.family_memberships,
    siyue.family_create_requests,siyue.families,siyue.subjects CASCADE`);
  fx = await createAuthFixture(db);
});
after(async () => { await db?.stop(); });

/** Tolerates both `rows(sql, a, b)` and `rows(sql, [a, b])` call styles. */
const bindings = args => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
const rows = (sql, ...args) => db.app.query(sql, bindings(args)).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
const refuses = expected => error => error instanceof RoomInvitationError && error.code === expected;
/** Asserts the database refused a statement with one SQLSTATE, quoting the constraint it broke. */
const failure = async (query, code, label) => {
  const error = await query.then(() => null, thrown => thrown);
  assert.equal(error?.code, code, `${label ?? ''} ${error?.constraint ?? error?.message}`.trim());
};
const identityOf = who => ({ sessionId: who.session.sessionId, subjectId: who.session.subjectId });
const invitationRow = (roomId, inviteeSubjectId) => rows(`SELECT id, room_id, inviter_subject_id, invitee_subject_id,
  status, inviter_membership_version, invitee_membership_version, family_version,
  expires_at, accepted_at, revoked_at, created_at
  FROM siyue.room_invitations WHERE room_id=$1 AND invitee_subject_id=$2`, roomId, inviteeSubjectId).then(result => result[0]);
const invitationCount = () => count('SELECT count(*)::int AS n FROM siyue.room_invitations');
const future = () => new Date(+fx.clock() + 3_600_000);

/** A real adult session issued by the session service; the kernel never builds identity from input. */
const adult = () => fx.issue();
/**
 * A synthesized `auth_sessions` row with no device grant, used only to drive this repository's own
 * "is this a session the server issued?" check. It is not a granted child device: nothing here proves
 * the session kernel's grant, guardian, consent or family checks, so every case that depends on those
 * uses `grantedChildDevice` and `verifyForMutation` instead.
 */
async function synthesizedSessionRow(subjectId, grantExpiresAt = new Date(Date.now() + 3_600_000)) {
  const sessionId = randomUUID();
  await db.app.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,credential_version,
      authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at,grant_expires_at)
    VALUES($1,$2,$3,'child',1,now(),now(),now(),now()+interval '30 days',now()+interval '180 days',$4)`,
  [sessionId, subjectId, randomUUID(), grantExpiresAt]);
  return { session: { sessionId, subjectId } };
}
/**
 * The pairing flow's own outcome, built the way that flow builds it: an approved device grant bounded by
 * the live guardianship versions, then `issueChild`, so the returned access token is one the session
 * kernel really issued for a granted child device. The guardian in the grant must be the recorded
 * guardian of the child, and its versions are the ones the relationship and the guardian subject carry.
 */
async function grantedChildDevice(familyId, guardianSubjectId, childSubjectId) {
  const grantId = randomUUID(), now = fx.clock();
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,
      device_label,guardian_relationship_version,guardian_credential_version,scopes,version,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios','Synthetic child device',1,1,$6,1,$7,$8)`,
  [grantId, childSubjectId, guardianSubjectId, familyId, randomUUID(), [], now, new Date(+now + 86_400_000)]);
  return transaction(db.app, async client => ({ ...await fx.service.issueChild(client, grantId), deviceGrantId: grantId }));
}
/** A family whose owner subject owns a real adult session and an active owner membership. */
async function familyWithOwner() {
  const owner = await adult();
  const familyId = randomUUID();
  await db.app.query('INSERT INTO siyue.families(id,owner_subject_id) VALUES($1,$2)', [familyId, owner.session.subjectId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,'owner',true,1)",
    [familyId, owner.session.subjectId]);
  return { familyId, owner };
}
/** One more active member of the family, with an adult session of its own. */
async function addAdultMember(familyId, role = 'member') {
  const who = await adult();
  await db.app.query('INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,$3,true,1)',
    [familyId, who.session.subjectId, role]);
  return who;
}
/**
 * An active child member with one recorded guardianship (and the consent behind it). `consentWithdrawn`
 * keeps the relationship row but closes its consent, which is exactly the state in which the session
 * kernel refuses to consider a child session usable, so those children get no device and no session.
 */
async function addChildMember(familyId, guardianSubjectId, { consentWithdrawn = false, device = true } = {}) {
  const subjectId = randomUUID(), consentRecordId = randomUUID(), recordedAt = fx.clock();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'child','active')", [subjectId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,'member',true,1)",
    [familyId, subjectId]);
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version,recorded_at,withdrawn_at)
    VALUES($1,$2,$3,'child-guardianship','child-guardianship-v1',$4,$5)`,
  [consentRecordId, guardianSubjectId, subjectId, recordedAt, consentWithdrawn ? new Date(+recordedAt + 1_000) : null]);
  await db.app.query(`INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,active,version,consent_record_id,created_at)
    VALUES($1,$2,$3,true,1,$4,$5)`, [familyId, guardianSubjectId, subjectId, consentRecordId, recordedAt]);
  // With a device the child carries the same shape as any other verified caller: an access token and
  // the session the kernel issued, so callers can verify it rather than trusting the id alone.
  return device ? { subjectId, ...await grantedChildDevice(familyId, guardianSubjectId, subjectId) } : { subjectId };
}
/** A family, its guardian member, a second adult member, a guarded child and one open room. */
async function scene() {
  const { familyId, owner } = await familyWithOwner();
  const child = await addChildMember(familyId, owner.session.subjectId);
  const peer = await addAdultMember(familyId);
  const room = await openRoom(familyId, owner.session.subjectId);
  return { familyId, guardian: owner, child, peer, roomId: room.id };
}
/** One pending invitation for the peer of a fresh scene, issued by the guardian member. */
async function pendingInvitation() {
  const value = await scene();
  const { invitation } = await createInvitation(value.roomId, value.peer.session.subjectId, value.guardian);
  return { ...value, invitation };
}

// Every call is a caller-owned transaction on the repositories, never an accessToken entry point.
const openRoom = (familyId, createdBySubjectId) => transaction(db.app, client =>
  roomCapacityRepository.openRoom(client, familyId, createdBySubjectId, fx.clock()));
const claim = (roomId, who) => transaction(db.app, client =>
  roomCapacityRepository.claimSeat(client, roomId, identityOf(who), fx.clock()));
const endRoom = (roomId, expectedVersion) => transaction(db.app, client =>
  roomCapacityRepository.endRoom(client, roomId, expectedVersion, fx.clock()));
const createInvitation = (roomId, inviteeSubjectId, inviter, overrides = {}) => transaction(db.app, client =>
  roomInvitationRepository.createInvitation(client, { roomId, inviteeSubjectId, inviter: identityOf(inviter),
    parentAuthority: 'verified', expiresAt: future(), ...overrides }, fx.clock()));
const acceptInvitation = (roomId, invitee) => transaction(db.app, client =>
  roomInvitationRepository.acceptInvitation(client, { roomId, invitee: identityOf(invitee) }, fx.clock()));
const revokeInvitation = (roomId, inviteeSubjectId, actor) => transaction(db.app, client =>
  roomInvitationRepository.revokeInvitation(client, { roomId, inviteeSubjectId, actor: identityOf(actor) }, fx.clock()));
const authorizeJoin = (roomId, who) => transaction(db.app, client =>
  roomInvitationRepository.authorizeJoin(client, { roomId, participant: identityOf(who) }, fx.clock()));
/**
 * The documented caller pattern for every mutating call: verify the session with the session kernel
 * inside the very transaction that uses the identity, then hand the verified pair to the repository. No
 * access token reaches this module, and a child session's device grant, guardian relationship, consent
 * and family state are all re-read by the kernel on each call - which is the only place they are
 * enforced. The `parentAuthority` verdict below stands for the caller's own already-applied C11 rule.
 */
const createdAs = (roomId, inviteeSubjectId, inviter, overrides = {}) => transaction(db.app, async client => {
  const session = await fx.service.verifyForMutation(client, inviter.accessToken);
  return roomInvitationRepository.createInvitation(client, { roomId, inviteeSubjectId,
    inviter: { sessionId: session.sessionId, subjectId: session.subjectId },
    parentAuthority: 'verified', expiresAt: future(), ...overrides }, fx.clock());
});
const acceptedAs = (roomId, invitee) => transaction(db.app, async client => {
  const session = await fx.service.verifyForMutation(client, invitee.accessToken);
  return roomInvitationRepository.acceptInvitation(client, { roomId,
    invitee: { sessionId: session.sessionId, subjectId: session.subjectId } }, fx.clock());
});
const authorizeJoinAs = (roomId, participant) => transaction(db.app, async client => {
  const session = await fx.service.verifyForMutation(client, participant.accessToken);
  return roomInvitationRepository.authorizeJoin(client, { roomId,
    participant: { sessionId: session.sessionId, subjectId: session.subjectId } }, fx.clock());
});

test('a verified member invites an existing child of the family and only that child accepts it', async () => {
  const value = await scene();
  // The inviter is verified by the session kernel in the same transaction; the parent verdict below is
  // the trusted caller's own decision, never a client field forwarded into the repository.
  const { invitation, room } = await createdAs(value.roomId, value.child.subjectId, value.guardian);
  assert.deepEqual([invitation.status, invitation.room_id, invitation.inviter_subject_id, invitation.invitee_subject_id],
    ['pending', value.roomId, value.guardian.session.subjectId, value.child.subjectId]);
  assert.deepEqual([invitation.inviter_membership_version, invitation.invitee_membership_version,
    invitation.family_version], [1, 1, 1]);
  assert.deepEqual([invitation.accepted_at, invitation.revoked_at, room.status], [null, null, 'open']);
  // The child is invited through the room's own table, never through the adult-only family invitation
  // path: that table stays empty and this one shares no foreign key with it.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_invitations'), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='siyue.room_invitations'::regclass
    AND contype='f' AND confrelid='siyue.family_invitations'::regclass`), 0);

  // The invited child's own granted device accepts: the documented caller pattern verifies the session
  // with the session kernel inside the same transaction before the invitation is touched.
  const accepted = await acceptedAs(value.roomId, value.child);
  assert.equal(accepted.invitation.status, 'accepted');
  assert.ok(accepted.invitation.accepted_at instanceof Date);
  const seated = await claim(value.roomId, value.child);
  assert.deepEqual([seated.seat.seat_index, seated.seat.subject_id], [1, value.child.subjectId]);

  // A second acceptance by the same member is idempotent: no second row and no rewritten instant.
  const repeated = await acceptedAs(value.roomId, value.child);
  assert.deepEqual(repeated.invitation, accepted.invitation);
  assert.equal(await invitationCount(), 1);
  // The same member on a second real device accepts the existing invitation, not a new one.
  const secondDevice = await grantedChildDevice(value.familyId, value.guardian.session.subjectId, value.child.subjectId);
  assert.equal((await acceptedAs(value.roomId, secondDevice)).invitation.id, invitation.id);
  assert.equal(await invitationCount(), 1);
});

test("the parent verdict is the caller's and never derived from an owner or admin membership", async () => {
  const value = await scene();
  // An undecided verdict refuses before anything is written, whoever the caller is.
  await assert.rejects(createInvitation(value.roomId, value.peer.session.subjectId, value.guardian,
    { parentAuthority: 'unresolved' }), refuses('ROOM_INVITATION_PARENT_AUTHORITY_UNRESOLVED'));
  await assert.rejects(createInvitation(value.roomId, value.peer.session.subjectId, value.guardian,
    { parentAuthority: 'owner' }), refuses('ROOM_INVITATION_INVALID_REQUEST'));
  // A role, a subject kind, a device or a status in the call is refused by the strict shape, so no
  // request body can claim the parent verdict, the inviter or the invitation state.
  for (const smuggled of [{ role: 'owner' }, { subjectKind: 'adult' }, { isParent: true }, { installationId: randomUUID() },
    { status: 'accepted' }, { inviter_subject_id: randomUUID() }])
    await assert.rejects(transaction(db.app, client => roomInvitationRepository.createInvitation(client,
      { roomId: value.roomId, inviteeSubjectId: value.peer.session.subjectId, inviter: identityOf(value.guardian),
        parentAuthority: 'verified', expiresAt: future(), ...smuggled }, fx.clock())),
      refuses('ROOM_INVITATION_INVALID_REQUEST'));
  assert.equal(await invitationCount(), 0);

  // The repository verifies the inviter's own session instead of its claim: a forged or revoked pair
  // is refused, and the stored inviter is the session's subject rather than anything the caller passed.
  const mismatch = await adult();
  await assert.rejects(createInvitation(value.roomId, value.peer.session.subjectId,
    { session: { sessionId: value.guardian.session.sessionId, subjectId: mismatch.session.subjectId } }),
    refuses('ROOM_INVITATION_SESSION_INVALID'));
  await assert.rejects(createInvitation(value.roomId, value.peer.session.subjectId,
    { session: { sessionId: randomUUID(), subjectId: value.guardian.session.subjectId } }),
    refuses('ROOM_INVITATION_SESSION_INVALID'));
  // This synthesized row only exercises the repository's own session check: a session past its own
  // deadline is refused, and an unaccepted/grant-less child row is a shape the session kernel would
  // already have rejected before this module is reached.
  const lapsed = await synthesizedSessionRow(value.guardian.session.subjectId, new Date(Date.now() - 300_000));
  await assert.rejects(createInvitation(value.roomId, value.peer.session.subjectId, lapsed),
    refuses('ROOM_INVITATION_SESSION_INVALID'));
  const revoked = await adult();
  await fx.service.logoutAccess(revoked.accessToken);
  await assert.rejects(createInvitation(value.roomId, value.peer.session.subjectId, revoked),
    refuses('ROOM_INVITATION_SESSION_INVALID'));
  assert.equal(await invitationCount(), 0);

  // An owner or admin membership is not the verdict, but it is also not a substitute for one: with the
  // caller's verdict the same membership passes, and an ordinary member is refused as an inviter only
  // by the memberships it actually holds, not by a role the caller names.
  const admin = await addAdultMember(value.familyId, 'admin');
  const { invitation } = await createInvitation(value.roomId, value.peer.session.subjectId, admin);
  assert.equal(invitation.inviter_subject_id, admin.session.subjectId);
  const outsider = await adult();
  await assert.rejects(createInvitation(value.roomId, value.peer.session.subjectId, outsider),
    refuses('ROOM_INVITATION_INVITER_INELIGIBLE'));
  await assert.rejects(createInvitation(value.roomId, value.peer.session.subjectId, value.child),
    refuses('ROOM_INVITATION_INVITER_INELIGIBLE'));
});

test('an invitation only ever reaches an existing active member of the same family', async () => {
  const value = await scene();
  // Cross-family: a real adult who is a member of another family is not an invitee of this room.
  const other = await scene();
  await assert.rejects(createInvitation(value.roomId, other.peer.session.subjectId, value.guardian),
    refuses('ROOM_INVITATION_INVITEE_INELIGIBLE'));
  // Unknown subject, a member of no family, and a deactivated membership are all refused.
  await assert.rejects(createInvitation(value.roomId, randomUUID(), value.guardian),
    refuses('ROOM_INVITATION_INVITEE_INELIGIBLE'));
  await assert.rejects(createInvitation(value.roomId, (await adult()).session.subjectId, value.guardian),
    refuses('ROOM_INVITATION_INVITEE_INELIGIBLE'));
  const left = await addAdultMember(value.familyId);
  await db.app.query('UPDATE siyue.family_memberships SET active=false,version=version+1 WHERE family_id=$1 AND subject_id=$2',
    [value.familyId, left.session.subjectId]);
  await assert.rejects(createInvitation(value.roomId, left.session.subjectId, value.guardian),
    refuses('ROOM_INVITATION_INVITEE_INELIGIBLE'));
  // A member is never invited by itself, and the room of another family grants nothing here.
  await assert.rejects(createInvitation(value.roomId, value.guardian.session.subjectId, value.guardian),
    refuses('ROOM_INVITATION_SELF_INVITE'));
  assert.equal(await invitationCount(), 0);

  // An uninvited member of this family holds no row: the same answer as a member of another family.
  await assert.rejects(acceptInvitation(value.roomId, value.peer), refuses('ROOM_INVITATION_NOT_FOUND'));
  await assert.rejects(acceptInvitation(value.roomId, other.peer), refuses('ROOM_INVITATION_NOT_FOUND'));
  // An invitation of one room is not usable in another room of the same family.
  const second = await openRoom(value.familyId, value.guardian.session.subjectId);
  await createInvitation(value.roomId, value.peer.session.subjectId, value.guardian);
  await assert.rejects(acceptInvitation(second.id, value.peer), refuses('ROOM_INVITATION_NOT_FOUND'));
  assert.equal((await invitationRow(second.id, value.peer.session.subjectId)), undefined);
});

test('a child invitee is only reachable through the inviter\'s own recorded guardianship', async () => {
  const { familyId, owner } = await familyWithOwner();
  const stranger = await addAdultMember(familyId);
  // These two are refused before any session matters, so they get no device grant: a child whose
  // guardianship is inactive or whose consent was withdrawn cannot hold a usable child session at all.
  const unguarded = await addChildMember(familyId, owner.session.subjectId, { device: false });
  await db.app.query('UPDATE siyue.guardian_relationships SET active=false,version=version+1 WHERE family_id=$1 AND child_subject_id=$2',
    [familyId, unguarded.subjectId]);
  const withdrawn = await addChildMember(familyId, owner.session.subjectId, { consentWithdrawn: true, device: false });
  const guarded = await addChildMember(familyId, owner.session.subjectId);
  const room = await openRoom(familyId, owner.session.subjectId);

  // No live guardianship, a revoked one and a withdrawn consent all refuse the child; a family role or
  // a membership alone never creates the parent mapping.
  for (const child of [unguarded, withdrawn]) {
    await assert.rejects(createInvitation(room.id, child.subjectId, owner), refuses('ROOM_INVITATION_INVITEE_NOT_GUARDED'));
    await assert.rejects(createInvitation(room.id, child.subjectId, stranger), refuses('ROOM_INVITATION_INVITEE_NOT_GUARDED'));
  }
  assert.equal(await invitationCount(), 0);
  // The recorded guardian invites and the child accepts; a different adult member cannot stand in.
  const { invitation } = await createInvitation(room.id, guarded.subjectId, owner);
  assert.equal(invitation.invitee_subject_id, guarded.subjectId);
  assert.equal((await acceptedAs(room.id, guarded)).invitation.status, 'accepted');
  await assert.rejects(createInvitation(room.id, unguarded.subjectId, stranger),
    refuses('ROOM_INVITATION_INVITEE_NOT_GUARDED'));
});

test('the inviter losing guardianship invalidates a child invitation even with another valid guardian', async () => {
  const { familyId, owner } = await familyWithOwner();
  const otherGuardian = await addAdultMember(familyId);
  const child = await addChildMember(familyId, owner.session.subjectId, { device: false });
  const consentId=randomUUID();
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-guardianship','child-guardianship-v1')`,
  [consentId,otherGuardian.session.subjectId,child.subjectId]);
  await db.app.query(`INSERT INTO siyue.guardian_relationships
    (family_id,guardian_subject_id,child_subject_id,consent_record_id)
    VALUES($1,$2,$3,$4)`,[familyId,otherGuardian.session.subjectId,child.subjectId,consentId]);
  const device=await grantedChildDevice(familyId,otherGuardian.session.subjectId,child.subjectId);
  const invitee={subjectId:child.subjectId,...device};
  const room=await openRoom(familyId,owner.session.subjectId);
  await createdAs(room.id,child.subjectId,owner);
  await acceptedAs(room.id,invitee);
  await db.app.query(`UPDATE siyue.consent_records SET withdrawn_at=now()
    WHERE actor_subject_id=$1 AND subject_id=$2`,[owner.session.subjectId,child.subjectId]);
  await assert.rejects(authorizeJoinAs(room.id,invitee),refuses('ROOM_INVITATION_INVITEE_NOT_GUARDED'));
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.room_seats WHERE room_id=$1',room.id),0);
});

test('an old accepted invitation cannot revive after its invitee membership is reactivated', async () => {
  const value=await pendingInvitation();
  await acceptedAs(value.roomId,value.peer);
  await db.app.query(`UPDATE siyue.family_memberships SET active=false,version=version+1
    WHERE family_id=$1 AND subject_id=$2`,[value.familyId,value.peer.session.subjectId]);
  await db.app.query(`UPDATE siyue.family_memberships SET active=true,version=version+1
    WHERE family_id=$1 AND subject_id=$2`,[value.familyId,value.peer.session.subjectId]);
  await assert.rejects(authorizeJoinAs(value.roomId,value.peer),refuses('ROOM_INVITATION_STALE'));
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.room_seats WHERE room_id=$1',value.roomId),0);
});

test('a stale caller clock cannot accept or join a database-expired invitation', async () => {
  const pending=await pendingInvitation();
  await db.app.query(`UPDATE siyue.room_invitations
    SET created_at=clock_timestamp()-interval '2 hours',
        expires_at=clock_timestamp()-interval '1 hour'
    WHERE room_id=$1`,[pending.roomId]);
  const staleNow=new Date(Date.now()-90*60_000);
  await assert.rejects(transaction(db.app,async client=>{
    const session=await fx.service.verifyForMutation(client,pending.peer.accessToken);
    return roomInvitationRepository.acceptInvitation(client,{roomId:pending.roomId,
      invitee:{sessionId:session.sessionId,subjectId:session.subjectId}},staleNow);
  }),refuses('ROOM_INVITATION_EXPIRED'));

  const accepted=await pendingInvitation();
  await acceptedAs(accepted.roomId,accepted.peer);
  await db.app.query(`UPDATE siyue.room_invitations
    SET created_at=clock_timestamp()-interval '2 hours',
        accepted_at=clock_timestamp()-interval '90 minutes',
        expires_at=clock_timestamp()-interval '1 hour'
    WHERE room_id=$1`,[accepted.roomId]);
  await assert.rejects(transaction(db.app,async client=>{
    const session=await fx.service.verifyForMutation(client,accepted.peer.accessToken);
    return roomInvitationRepository.authorizeJoin(client,{roomId:accepted.roomId,
      participant:{sessionId:session.sessionId,subjectId:session.subjectId}},staleNow);
  }),refuses('ROOM_INVITATION_EXPIRED'));
});

test('acceptance refuses a session that expires after its transaction begins', async () => {
  const value=await pendingInvitation();
  await assert.rejects(transaction(db.app,async client=>{
    const session=await fx.service.verifyForMutation(client,value.peer.accessToken);
    // The session was valid when verified. It expires while the caller still holds this transaction;
    // transaction_timestamp()/now() must not keep it alive at the later invitation decision.
    await client.query(`UPDATE siyue.auth_sessions
      SET idle_expires_at=transaction_timestamp()+interval '1 millisecond' WHERE id=$1`,[session.sessionId]);
    await client.query('SELECT pg_sleep(0.05)');
    return roomInvitationRepository.acceptInvitation(client,{roomId:value.roomId,
      invitee:{sessionId:session.sessionId,subjectId:session.subjectId}},fx.clock());
  }),refuses('ROOM_INVITATION_SESSION_INVALID'));
  assert.equal((await invitationRow(value.roomId,value.peer.session.subjectId)).status,'pending');
});

test('a revoked invitation is closed for good, and revoking is idempotent and inviter-scoped', async () => {
  const value = await pendingInvitation();
  const invitee = value.peer.session.subjectId;
  // Another member - including one with a role - cannot close an invitation it did not issue.
  const other = await addAdultMember(value.familyId, 'admin');
  await assert.rejects(revokeInvitation(value.roomId, invitee, other), refuses('ROOM_INVITATION_NOT_INVITER'));
  assert.equal((await invitationRow(value.roomId, invitee)).status, 'pending');

  const revoked = await revokeInvitation(value.roomId, invitee, value.guardian);
  assert.equal(revoked.invitation.status, 'revoked');
  assert.ok(revoked.invitation.revoked_at instanceof Date);
  // Revoking again returns the same closed row instead of rewriting the instant or the status.
  assert.deepEqual((await revokeInvitation(value.roomId, invitee, value.guardian)).invitation, revoked.invitation);
  assert.equal(await invitationCount(), 1);
  // The old invitation can never be accepted or re-created into a live one.
  await assert.rejects(acceptInvitation(value.roomId, value.peer), refuses('ROOM_INVITATION_REVOKED'));
  await assert.rejects(createInvitation(value.roomId, invitee, value.guardian), refuses('ROOM_INVITATION_REVOKED'));
  assert.deepEqual(await invitationRow(value.roomId, invitee), revoked.invitation);
  // An accepted invitation is not revocable here: removing a joined member is a separate owner decision.
  const joined = await pendingInvitation();
  await acceptInvitation(joined.roomId, joined.peer);
  await assert.rejects(revokeInvitation(joined.roomId, joined.peer.session.subjectId, joined.guardian),
    refuses('ROOM_INVITATION_ALREADY_ACCEPTED'));
});

test('an ended room, a frozen family, an exited member and a moved version refuse the old invitation', async () => {
  // Ending the room closes the invitation for the member who was invited before it ended.
  const ended = await pendingInvitation();
  await endRoom(ended.roomId, 1);
  await assert.rejects(acceptInvitation(ended.roomId, ended.peer), refuses('ROOM_INVITATION_ROOM_ENDED'));
  await assert.rejects(createInvitation(ended.roomId, ended.child.subjectId, ended.guardian), refuses('ROOM_INVITATION_ROOM_ENDED'));
  assert.equal((await invitationRow(ended.roomId, ended.peer.session.subjectId)).status, 'pending');

  // A frozen family (the account-deletion freeze also ends its rooms) refuses before any join.
  const frozen = await pendingInvitation();
  await db.admin.query("UPDATE siyue.families SET status='frozen',version=version+1 WHERE id=$1", [frozen.familyId]);
  await db.admin.query("UPDATE siyue.rooms SET status='ended',ended_at=GREATEST(now(),created_at),version=version+1 WHERE family_id=$1", [frozen.familyId]);
  await assert.rejects(acceptInvitation(frozen.roomId, frozen.peer), refuses('ROOM_INVITATION_FAMILY_INACTIVE'));
  await assert.rejects(createInvitation(frozen.roomId, frozen.child.subjectId, frozen.guardian), refuses('ROOM_INVITATION_FAMILY_INACTIVE'));

  // The invited member leaving or being removed ends the reach of the invitation that named them.
  const exited = await pendingInvitation();
  await db.admin.query('UPDATE siyue.family_memberships SET active=false,version=version+1 WHERE family_id=$1 AND subject_id=$2',
    [exited.familyId, exited.peer.session.subjectId]);
  await assert.rejects(acceptInvitation(exited.roomId, exited.peer), refuses('ROOM_INVITATION_INVITEE_INELIGIBLE'));
  assert.equal((await invitationRow(exited.roomId, exited.peer.session.subjectId)).status, 'pending');

  // The inviter losing the membership it issued the invitation under is refused as well.
  const gone = await pendingInvitation();
  await db.admin.query('UPDATE siyue.family_memberships SET active=false,version=version+1 WHERE family_id=$1 AND subject_id=$2',
    [gone.familyId, gone.guardian.session.subjectId]);
  await assert.rejects(acceptInvitation(gone.roomId, gone.peer), refuses('ROOM_INVITATION_INVITER_INELIGIBLE'));

  // Any later change to the family version makes the pinned invitation stale instead of silently live.
  const stale = await pendingInvitation();
  await db.admin.query('UPDATE siyue.families SET version=version+1 WHERE id=$1', [stale.familyId]);
  await assert.rejects(acceptInvitation(stale.roomId, stale.peer), refuses('ROOM_INVITATION_STALE'));
  // Re-issuing the same invitation is not a way around a moved version: the replay of the durable row
  // reports the same staleness acceptance would, without writing a second row.
  await assert.rejects(createInvitation(stale.roomId, stale.peer.session.subjectId, stale.guardian),
    refuses('ROOM_INVITATION_STALE'));
  // One row per room and member across every case above: five invitations, none rewritten by a refusal.
  assert.equal(await invitationCount(), 5);
  assert.deepEqual(await invitationRow(stale.roomId, stale.peer.session.subjectId), stale.invitation);
});

test('repeated and concurrent invitations and acceptance leave exactly one consistent row', async () => {
  const value = await scene();
  const invitee = value.peer.session.subjectId;
  const first = await createInvitation(value.roomId, invitee, value.guardian);
  const repeated = await createInvitation(value.roomId, invitee, value.guardian);
  assert.deepEqual(repeated.invitation, first.invitation);
  assert.equal(await invitationCount(), 1);
  // The same member invited by another adult is a conflict, not a second invitation and not a rewrite.
  const admin = await addAdultMember(value.familyId, 'admin');
  await assert.rejects(createInvitation(value.roomId, invitee, admin), refuses('ROOM_INVITATION_CONFLICT'));
  assert.deepEqual(await invitationRow(value.roomId, invitee), first.invitation);

  // Concurrent creates of one (room, member) serialise on the room lock: every caller sees the same row.
  const parallelRoom = await openRoom(value.familyId, value.guardian.session.subjectId);
  const settled = await Promise.allSettled([1, 2, 3, 4].map(() =>
    createInvitation(parallelRoom.id, invitee, value.guardian)));
  assert.ok(settled.every(entry => entry.status === 'fulfilled'), settled.map(entry => entry.reason?.code).join(','));
  assert.equal(new Set(settled.map(entry => entry.value.invitation.id)).size, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.room_invitations WHERE room_id=$1', parallelRoom.id), 1);

  // Accepting and revoking the same invitation in parallel: exactly one wins, and the stored row
  // matches the winner instead of both effects landing on one row.
  const race = await pendingInvitation();
  const racers = await Promise.allSettled([
    acceptInvitation(race.roomId, race.peer),
    revokeInvitation(race.roomId, race.peer.session.subjectId, race.guardian),
  ]);
  const won = racers.filter(entry => entry.status === 'fulfilled');
  assert.equal(won.length, 1, racers.map(entry => entry.reason?.code ?? 'ok').join(','));
  const stored = await invitationRow(race.roomId, race.peer.session.subjectId);
  assert.equal(stored.status, won[0].value.invitation.status);
  assert.equal(racers.filter(entry => entry.status === 'rejected').every(entry =>
    ['ROOM_INVITATION_REVOKED', 'ROOM_INVITATION_ALREADY_ACCEPTED'].includes(entry.reason?.code)), true);
});

test('an accepted invitation authorizes a join without taking a seat itself', async () => {
  const value = await scene();
  await createdAs(value.roomId, value.child.subjectId, value.guardian);
  // A pending invitation is not a join authorization: the invited member accepts it first, and nothing
  // is seated while it is still pending.
  await assert.rejects(authorizeJoinAs(value.roomId, value.child), refuses('ROOM_INVITATION_NOT_ACCEPTED'));
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.room_seats'), 0);

  const accepted = await acceptedAs(value.roomId, value.child);
  const verdict = await authorizeJoinAs(value.roomId, value.child);
  assert.deepEqual([verdict.invitation.id, verdict.invitation.status, verdict.room.id],
    [accepted.invitation.id, 'accepted', value.roomId]);
  // The verdict is read-only: repeating it writes no invitation, no acceptance and no seat.
  assert.deepEqual((await authorizeJoinAs(value.roomId, value.child)).invitation, accepted.invitation);
  assert.deepEqual([await count('SELECT count(*)::int AS n FROM siyue.room_seats'), await invitationCount()], [0, 1]);
  assert.deepEqual(await invitationRow(value.roomId, value.child.subjectId), accepted.invitation);

  // The caller chains the verdict into the seat kernel inside its own transaction; only then is a seat
  // taken, and it belongs to the same verified child session the verdict was issued for.
  const chained = await transaction(db.app, async client => {
    const session = await fx.service.verifyForMutation(client, value.child.accessToken);
    const identity = { sessionId: session.sessionId, subjectId: session.subjectId };
    const authorization = await roomInvitationRepository.authorizeJoin(client,
      { roomId: value.roomId, participant: identity }, fx.clock());
    const seated = await roomCapacityRepository.claimSeat(client, value.roomId, identity, fx.clock());
    return { authorization, seated };
  });
  assert.deepEqual([chained.authorization.invitation.status, chained.seated.seat.seat_index, chained.seated.seat.subject_id],
    ['accepted', 1, value.child.subjectId]);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.room_seats'), 1);
});

test('a join authorization refuses uninvited, revoked, expired, ended, frozen, exited and stale state', async () => {
  /** A scene whose invitation was accepted, so it is joinable until something ends its reach. */
  const joinable = async () => {
    const value = await pendingInvitation();
    await acceptedAs(value.roomId, value.peer);
    return value;
  };
  // An uninvited member of the same family, a member of another family and an unknown room hold no
  // verdict at all, and none of those reads writes anything.
  const uninvited = await scene();
  await assert.rejects(authorizeJoinAs(uninvited.roomId, uninvited.peer), refuses('ROOM_INVITATION_NOT_FOUND'));
  const other = await scene();
  await assert.rejects(authorizeJoinAs(uninvited.roomId, other.peer), refuses('ROOM_INVITATION_NOT_FOUND'));
  await assert.rejects(authorizeJoinAs(randomUUID(), uninvited.peer), refuses('ROOM_INVITATION_ROOM_NOT_FOUND'));
  assert.deepEqual([await invitationCount(), await count('SELECT count(*)::int AS n FROM siyue.room_seats')], [0, 0]);

  // A revoked pending invitation is closed, and revoking an accepted one is refused, so an accepted
  // invitation's reach ends with the room, the family, the membership or its own deadline.
  const revoked = await pendingInvitation();
  await revokeInvitation(revoked.roomId, revoked.peer.session.subjectId, revoked.guardian);
  await assert.rejects(authorizeJoinAs(revoked.roomId, revoked.peer), refuses('ROOM_INVITATION_REVOKED'));
  await assert.rejects(acceptInvitation(revoked.roomId, revoked.peer), refuses('ROOM_INVITATION_REVOKED'));

  const expiring = await scene();
  await createdAs(expiring.roomId, expiring.peer.session.subjectId, expiring.guardian,
    { expiresAt: new Date(+fx.clock() + 2_000) });
  await acceptedAs(expiring.roomId, expiring.peer);
  fx.advance(3_000);
  await assert.rejects(authorizeJoinAs(expiring.roomId, expiring.peer), refuses('ROOM_INVITATION_EXPIRED'));

  const ended = await joinable();
  await endRoom(ended.roomId, 1);
  await assert.rejects(authorizeJoinAs(ended.roomId, ended.peer), refuses('ROOM_INVITATION_ROOM_ENDED'));

  const frozen = await joinable();
  await db.admin.query("UPDATE siyue.families SET status='frozen',version=version+1 WHERE id=$1", [frozen.familyId]);
  await assert.rejects(authorizeJoinAs(frozen.roomId, frozen.peer), refuses('ROOM_INVITATION_FAMILY_INACTIVE'));

  const exited = await joinable();
  await db.admin.query('UPDATE siyue.family_memberships SET active=false,version=version+1 WHERE family_id=$1 AND subject_id=$2',
    [exited.familyId, exited.peer.session.subjectId]);
  await assert.rejects(authorizeJoinAs(exited.roomId, exited.peer), refuses('ROOM_INVITATION_INVITEE_INELIGIBLE'));

  const inviterGone = await joinable();
  await db.admin.query('UPDATE siyue.family_memberships SET active=false,version=version+1 WHERE family_id=$1 AND subject_id=$2',
    [inviterGone.familyId, inviterGone.guardian.session.subjectId]);
  await assert.rejects(authorizeJoinAs(inviterGone.roomId, inviterGone.peer), refuses('ROOM_INVITATION_INVITER_INELIGIBLE'));

  const stale = await joinable();
  await db.admin.query('UPDATE siyue.families SET version=version+1 WHERE id=$1', [stale.familyId]);
  await assert.rejects(authorizeJoinAs(stale.roomId, stale.peer), refuses('ROOM_INVITATION_STALE'));

  // A forged session pair, a smuggled role and a malformed call are refused before any verdict.
  await assert.rejects(authorizeJoin(stale.roomId,
    { session: { sessionId: randomUUID(), subjectId: stale.peer.session.subjectId } }),
    refuses('ROOM_INVITATION_SESSION_INVALID'));
  await assert.rejects(transaction(db.app, client => roomInvitationRepository.authorizeJoin(client,
    { roomId: stale.roomId, participant: identityOf(stale.peer), role: 'owner' }, fx.clock())),
    refuses('ROOM_INVITATION_INVALID_REQUEST'));
  await assert.rejects(transaction(db.app, client => roomInvitationRepository.authorizeJoin(client,
    { roomId: 'not-a-uuid', participant: identityOf(stale.peer) }, fx.clock())),
    refuses('ROOM_INVITATION_INVALID_REQUEST'));

  // Boundary of this slice: this repository proves the session row only. A child device grant revoked
  // after acceptance is refused by the session kernel inside `verifyForMutation` - the grant, guardian,
  // consent and family checks all live there - so the documented caller pattern never reaches a verdict
  // with a dead identity, and a caller that skipped that step would be passing an unverified pair.
  const child = await scene();
  await createdAs(child.roomId, child.child.subjectId, child.guardian);
  await acceptedAs(child.roomId, child.child);
  await db.admin.query('UPDATE siyue.device_grants SET revoked_at=$2,version=version+1 WHERE id=$1',
    [child.child.deviceGrantId, fx.clock()]);
  assert.equal((await authorizeJoinAs(child.roomId, child.child).then(() => null, error => error))?.code,
    'AUTH_SESSION_INVALID');
});

test('a failed transaction leaves no invitation and no acceptance behind', async () => {
  const value = await scene();
  const { roomId, peer, guardian } = value;
  await assert.rejects(transaction(db.app, async client => {
    await roomInvitationRepository.createInvitation(client, { roomId, inviteeSubjectId: peer.session.subjectId,
      inviter: identityOf(guardian), parentAuthority: 'verified', expiresAt: future() }, fx.clock());
    throw new Error('synthetic_failure_after_invite');
  }), /synthetic_failure_after_invite/);
  assert.equal(await invitationCount(), 0);
  // The same caller-scoped rollback restores a pending invitation when acceptance fails afterwards.
  await createInvitation(roomId, peer.session.subjectId, guardian);
  await assert.rejects(transaction(db.app, async client => {
    await roomInvitationRepository.acceptInvitation(client, { roomId, invitee: identityOf(peer) }, fx.clock());
    throw new Error('synthetic_failure_after_accept');
  }), /synthetic_failure_after_accept/);
  const stored = await invitationRow(roomId, peer.session.subjectId);
  assert.deepEqual([stored.status, stored.accepted_at, await invitationCount()], ['pending', null, 1]);
  await assert.rejects(revokeInvitation(randomUUID(), peer.session.subjectId, guardian), refuses('ROOM_INVITATION_ROOM_NOT_FOUND'));
  await assert.rejects(acceptInvitation(randomUUID(), peer), refuses('ROOM_INVITATION_ROOM_NOT_FOUND'));
});

test('the invitation table holds its links, its one-row bound and its runtime privileges', async () => {
  const table = 'room_invitations';
  const columnNames = rows(`SELECT column_name FROM information_schema.columns WHERE table_schema='siyue'
    AND table_name='room_invitations' ORDER BY column_name`);
  // The complete fixed column contract: no join code, token, digest, ciphertext, role, subject kind,
  // parent flag, session, device, media, board or recording column may be added to this table.
  assert.deepEqual((await columnNames).map(row => row.column_name), ['accepted_at', 'created_at', 'expires_at',
    'family_version', 'id', 'invitee_membership_version', 'invitee_subject_id',
    'inviter_membership_version', 'inviter_subject_id',
    'revoked_at', 'room_id', 'status']);
  assert.deepEqual((await rows("SELECT indexname FROM pg_indexes WHERE schemaname='siyue' AND tablename='room_invitations' ORDER BY indexname"))
    .map(row => row.indexname), ['room_invitations_invitee', 'room_invitations_pkey', 'room_invitations_room_id_invitee_subject_id_key']);
  // One link per reference, pinned by name: a room, and the inviter and invitee subjects. No link
  // points at the adult-only family invitation table.
  assert.deepEqual(Object.fromEntries((await rows(`SELECT c.conname, t.relname AS target FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.confrelid WHERE c.conrelid='siyue.room_invitations'::regclass AND c.contype='f'`))
    .map(row => [row.conname, row.target])), { room_invitations_room_id_fkey: 'rooms',
    room_invitations_inviter_subject_id_fkey: 'subjects', room_invitations_invitee_subject_id_fkey: 'subjects' });
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
    assert.equal((await rows('SELECT has_table_privilege($1,$2,$3) AS ok', ['siyue_app', `siyue.${table}`, privilege]))[0].ok, true, privilege);
  assert.equal((await rows('SELECT has_table_privilege($1,$2,$3) AS ok', ['siyue_app', `siyue.${table}`, 'TRUNCATE']))[0].ok, false);

  const family = await familyWithOwner();
  const guardian = family.owner, invitee = await addAdultMember(family.familyId);
  const room = await openRoom(family.familyId, guardian.session.subjectId);
  const insert = (overrides = {}) => {
    const row = { id: randomUUID(), room_id: room.id, inviter_subject_id: guardian.session.subjectId,
      invitee_subject_id: invitee.session.subjectId, status: 'pending', inviter_membership_version: 1,
      invitee_membership_version: 1, family_version: 1, expires_at: future(),
      accepted_at: null, revoked_at: null, created_at: fx.clock(), ...overrides };
    return db.app.query(`INSERT INTO siyue.room_invitations(id,room_id,inviter_subject_id,invitee_subject_id,status,
        inviter_membership_version,invitee_membership_version,family_version,
        expires_at,accepted_at,revoked_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [row.id, row.room_id, row.inviter_subject_id, row.invitee_subject_id, row.status, row.inviter_membership_version,
      row.invitee_membership_version, row.family_version, row.expires_at, row.accepted_at,
      row.revoked_at, row.created_at]);
  };
  assert.equal((await insert()).rows[0].status, 'pending');
  await failure(insert(), '23505', 'second invitation for one room and member');
  // The stored row is cleared again so every case below breaks exactly the constraint it names
  // instead of tripping the one-row bound first.
  await db.app.query('DELETE FROM siyue.room_invitations WHERE room_id=$1', [room.id]);
  await failure(insert({ invitee_subject_id: invitee.session.subjectId, room_id: randomUUID() }), '23503', 'unknown room');
  await failure(insert({ inviter_subject_id: randomUUID() }), '23503', 'unknown inviter');
  await failure(insert({ invitee_subject_id: randomUUID() }), '23503', 'unknown invitee');
  await failure(insert({ invitee_subject_id: guardian.session.subjectId }), '23514', 'inviter inviting itself');
  await failure(insert({ status: 'removed' }), '23514', 'unknown status');
  await failure(insert({ expires_at: new Date(+fx.clock() - 1_000) }), '23514', 'expiry before creation');
  await failure(insert({ inviter_membership_version: 0 }), '23514', 'membership version bound');
  await failure(insert({ family_version: 0 }), '23514', 'family version bound');
  await failure(insert({ status: 'accepted' }), '23514', 'accepted without an instant');
  await failure(insert({ accepted_at: fx.clock() }), '23514', 'instant without acceptance');
  await failure(insert({ revoked_at: fx.clock() }), '23514', 'instant without revocation');
  await failure(insert({ status: 'revoked' }), '23514', 'revoked without an instant');
  // A row is either waiting or closed: it never carries both instants at once.
  await failure(insert({ status: 'accepted', accepted_at: fx.clock(), revoked_at: fx.clock() }), '23514', 'both instants');
});

test('0023 upgrades a real 0022 database additively and leaves the invitation repository usable', async () => {
  const legacy = await startPostgresFixture({ migrate: false });
  const directory = mkdtempSync('/tmp/siyue-room-invitations-upgrade-');
  try {
    const migrations = await readMigrations();
    const previous = migrations.filter(migration => migration.version <= '0022_account_deletion_family_reviews.sql');
    assert.equal(previous.length, 22);
    for (const migration of previous) writeFileSync(join(directory, migration.version), migration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 22);
    assert.equal((await legacy.admin.query('SELECT to_regclass($1) AS present', ['siyue.room_invitations'])).rows[0].present, null);
    // Applying exactly 0023 adds the table and rewrites neither the earlier history nor a live session.
    const invitationMigration = migrations.find(migration => migration.version === '0023_room_invitations.sql');
    assert.ok(invitationMigration);
    writeFileSync(join(directory, invitationMigration.version), invitationMigration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 1);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity), migrations.length - 23);
    assert.equal((await legacy.admin.query('SELECT to_regclass($1) IS NOT NULL AS present', ['siyue.room_invitations'])).rows[0].present, true);
    assert.equal((await legacy.admin.query("SELECT has_table_privilege('siyue_app','siyue.room_invitations','SELECT,INSERT,UPDATE,DELETE') AS ok")).rows[0].ok, true);
    assert.equal((await legacy.admin.query("SELECT has_table_privilege('siyue_app','siyue.room_invitations','TRUNCATE') AS ok")).rows[0].ok, false);

    // A database that predates the upgrade runs the whole C11 invitation path with the runtime role.
    const legacyFx = await createAuthFixture({ app: legacy.app });
    const guardian = await legacyFx.issue();
    const familyId = randomUUID();
    await legacy.app.query('INSERT INTO siyue.families(id,owner_subject_id) VALUES($1,$2)', [familyId, guardian.session.subjectId]);
    await legacy.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,'owner',true,1)",
      [familyId, guardian.session.subjectId]);
    const invitee = await legacyFx.issue();
    await legacy.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,'member',true,1)",
      [familyId, invitee.session.subjectId]);
    const room = await transaction(legacy.app, client =>
      roomCapacityRepository.openRoom(client, familyId, guardian.session.subjectId, legacyFx.clock()));
    const created = await transaction(legacy.app, client => roomInvitationRepository.createInvitation(client,
      { roomId: room.id, inviteeSubjectId: invitee.session.subjectId, inviter: identityOf(guardian),
        parentAuthority: 'verified', expiresAt: new Date(+legacyFx.clock() + 3_600_000) }, legacyFx.clock()));
    const accepted = await transaction(legacy.app, client => roomInvitationRepository.acceptInvitation(client,
      { roomId: room.id, invitee: identityOf(invitee) }, legacyFx.clock()));
    assert.deepEqual([created.invitation.status, accepted.invitation.status], ['pending', 'accepted']);
  } finally { rmSync(directory, { recursive: true, force: true }); await legacy.stop(); }
});

test('no server module registers the invitation repository, so the formal entry stays closed', async () => {
  // The C11 parent verdict has no trusted producer yet, so the invitation repository must not be
  // reachable from an entry point: no route, index or service may import it, and no HTTP surface may
  // forward a client-supplied verdict into it. This is a source-level guard, not a runtime check.
  const source = fileURLToPath(new URL('../../src/', import.meta.url));
  const referencing = readdirSync(source, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.ts') && name !== 'modules/rooms/invitations.ts')
    .filter(name => readFileSync(join(source, name), 'utf8').includes('rooms/invitations'));
  assert.deepEqual(referencing, [], 'no module may import the invitation repository yet');
  // Nothing re-exports it either, so a future route has to add the import deliberately rather than
  // inheriting an entry from an index module.
  for (const entry of ['index.ts', 'app.ts', 'session.ts']) {
    const contents = readFileSync(join(source, entry), 'utf8');
    assert.equal(/rooms\/invitations|roomInvitationRepository|authorizeJoin/.test(contents), false, entry);
  }
});
