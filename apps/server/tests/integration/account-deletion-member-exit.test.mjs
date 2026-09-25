import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createFamilyRepository } from '../../dist/modules/families/repository.js';
import { endOwnFamilyAccessForDeletion } from '../../dist/modules/auth/account-deletion-member-exit.js';
import { inspectAccountDeletionBlockers } from '../../dist/modules/auth/account-deletion-cleanup.js';

// Isolated temporary PostgreSQL cluster only: the fixture always builds a fresh cluster on a short Unix
// socket and never reads a database URL or the workspace .env. Every subject, family, child, grant,
// invitation, pairing, room and seat below is synthetic, and no HTTP route, mail, provider, RTC vendor or
// network call happens here.
//
// "A non-owner adult ends their own family access" is an internal step with no HTTP surface, so every
// call below runs inside a caller-owned transaction that already holds the deleting subject lock,
// exactly as the future deletion acceptance kernel must call it.
let db, fx;
const day = 86_400_000;
const refuses = (code, status) => error => error?.code === code && error?.status === status;
const rows = (sql, params) => db.app.query(sql, params).then(result => result.rows);
const row = (sql, params) => rows(sql, params).then(result => result[0]);
const count = (sql, params) => rows(sql, params).then(result => Number(result[0].n));
/** 64 hex characters unique per call, for the columns that store a keyed digest. */
const digest = () => randomUUID().replaceAll('-', '').repeat(2);

before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query('TRUNCATE siyue.subjects CASCADE');
  fx = await createEmailFixture(db);
});
after(async () => { await db?.stop(); });

/** An adult subject without a session, for scenes that only need a family role filled. */
async function adultSubject() {
  const id = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [id]);
  return id;
}

/** One active family with an owner, a second member, the member under test and an unrelated adult. */
async function scene() {
  const owner = await fx.issue(), sibling = await fx.issue(), member = await fx.issue(), stranger = await fx.issue();
  const family = await transaction(db.app, client =>
    createFamilyRepository(db.app).create(client, owner.session.subjectId, 'a'.repeat(64)));
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member'),($1,$3,'member')",
    [family.familyId, member.session.subjectId, sibling.session.subjectId]);
  return {owner, sibling, member, stranger, family};
}

/** A supervised child plus the consent each named adult recorded for it. */
async function childWithGuardians(familyId, guardians) {
  const childId = randomUUID(), consents = new Map();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'child','Synthetic Child')", [childId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [familyId, childId]);
  for (const guardian of guardians) {
    const consentId = randomUUID();
    await db.app.query("INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version) VALUES($1,$2,$3,'child-guardianship','1.0')",
      [consentId, guardian, childId]);
    await db.app.query('INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)',
      [familyId, guardian, childId, consentId]);
    consents.set(guardian, consentId);
  }
  return {childId, consents};
}

/** A child device grant approved by one adult, under the guardian relationship version it read. */
async function grantFor(childId, guardianId, familyId) {
  const grantId = randomUUID();
  await db.app.query("INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,device_label,guardian_relationship_version,guardian_credential_version,scopes,expires_at) VALUES($1,$2,$3,$4,$5,'ios','Synthetic iPad',1,1,ARRAY[]::text[],$6)",
    [grantId, childId, guardianId, familyId, randomUUID(), new Date(+fx.clock() + 30 * day - 1_000)]);
  return grantId;
}

/** A real adult session for an existing subject, issued by the session service. */
const sessionFor = subjectId => transaction(db.app, client => fx.service.issue(client, subjectId, randomUUID(), 'email'));

async function openRoom(familyId, creatorId, seats) {
  const roomId = randomUUID();
  await db.app.query('INSERT INTO siyue.rooms(id,family_id,created_by_subject_id) VALUES($1,$2,$3)',
    [roomId, familyId, creatorId]);
  for (const [index, seat] of seats.entries())
    await db.app.query('INSERT INTO siyue.room_seats(room_id,session_id,subject_id,seat_index) VALUES($1,$2,$3,$4)',
      [roomId, seat.sessionId, seat.subjectId, index + 1]);
  return roomId;
}

async function pendingRoomInvitation(roomId, inviterId, inviteeId) {
  const id = randomUUID();
  await db.app.query(`INSERT INTO siyue.room_invitations
    (id,room_id,inviter_subject_id,invitee_subject_id,inviter_membership_version,
      invitee_membership_version,family_version,expires_at)
    VALUES($1,$2,$3,$4,1,1,1,$5)`,
  [id,roomId,inviterId,inviteeId,new Date(+fx.clock()+day)]);
  return id;
}

async function pendingInvitation(familyId, inviterId) {
  const invitationId = randomUUID(), at = fx.clock();
  await db.app.query("INSERT INTO siyue.family_invitations(id,family_id,inviter_id,token_hash,policy_version,inviter_membership_version,family_version,expires_at,token_ciphertext,token_ciphertext_expires_at) VALUES($1,$2,$3,$4,'1.0',1,1,$5,'synthetic-sealed-token',$6)",
    [invitationId, familyId, inviterId, digest(), new Date(+at + day), new Date(+at + 60_000)]);
  return invitationId;
}

async function approvedPairing(familyId, approverId, childId) {
  const pairingId = randomUUID(), at = fx.clock();
  await db.app.query("INSERT INTO siyue.device_pairing_requests(id,request_token_hash,poll_secret_hash,installation_id,platform,status,approved_by,child_subject_id,family_id,approved_guardian_version,approved_credential_version,created_at,expires_at,approved_at) VALUES($1,$2,$3,$4,'ios','approved',$5,$6,$7,1,1,$8,$9,$8)",
    [pairingId, digest(), digest(), randomUUID(), approverId, childId, familyId, at, new Date(+at + 300_000)]);
  return pairingId;
}

/** Everything one member owns in one family: guardianship, child device, invitation, pairing, rooms. */
async function fullScene() {
  const base = await scene();
  const ownerId = base.owner.session.subjectId, memberId = base.member.session.subjectId;
  const child = await childWithGuardians(base.family.familyId, [ownerId, memberId]);
  const memberGrant = await grantFor(child.childId, memberId, base.family.familyId);
  const ownerGrant = await grantFor(child.childId, ownerId, base.family.familyId);
  const childTokens = await transaction(db.app, client => fx.service.issueChild(client, memberGrant));
  const memberSession = await sessionFor(memberId);
  const memberInvitation = await pendingInvitation(base.family.familyId, memberId);
  const ownerInvitation = await pendingInvitation(base.family.familyId, ownerId);
  const memberPairing = await approvedPairing(base.family.familyId, memberId, child.childId);
  const ownerPairing = await approvedPairing(base.family.familyId, ownerId, child.childId);
  const memberRoom = await openRoom(base.family.familyId, memberId,
    [{sessionId: memberSession.session.sessionId, subjectId: memberId},
      {sessionId: base.sibling.session.sessionId, subjectId: base.sibling.session.subjectId}]);
  const ownerRoom = await openRoom(base.family.familyId, ownerId,
    [{sessionId: base.owner.session.sessionId, subjectId: ownerId},
      {sessionId: memberSession.session.sessionId, subjectId: memberId}]);
  return {...base, child, memberGrant, ownerGrant, childTokens, memberSession, memberInvitation, ownerInvitation,
    memberPairing, ownerPairing, memberRoom, ownerRoom};
}

test('a non-owner adult ends only their own access to one active family', async () => {
  const value = await fullScene();
  const ownerId = value.owner.session.subjectId, memberId = value.member.session.subjectId;
  await transaction(db.app, client =>
    endOwnFamilyAccessForDeletion(client, memberId, value.family.familyId, fx.clock()));

  // The membership ends and the family stays active and visible for everyone else.
  assert.deepEqual(await row('SELECT role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, memberId]), {role:'member',active:false,version:2});
  assert.deepEqual(await row('SELECT role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, ownerId]), {role:'owner',active:true,version:1});
  assert.deepEqual(await row('SELECT role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, value.sibling.session.subjectId]), {role:'member',active:true,version:1});
  assert.deepEqual(await row('SELECT status,version FROM siyue.families WHERE id=$1', [value.family.familyId]),
    {status:'active',version:1});
  assert.deepEqual(await createFamilyRepository(db.app).list(memberId), []);
  assert.equal((await createFamilyRepository(db.app).list(ownerId)).length, 1);

  // The member's guardianship and consent are withdrawn; the owner keeps co-guardianship of the child.
  assert.deepEqual(await row('SELECT active,version FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3',
    [value.family.familyId, memberId, value.child.childId]), {active:false,version:2});
  assert.deepEqual(await row('SELECT active,version FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3',
    [value.family.familyId, ownerId, value.child.childId]), {active:true,version:1});
  assert.ok((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1',
    [value.child.consents.get(memberId)])).withdrawn_at);
  assert.equal((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1',
    [value.child.consents.get(ownerId)])).withdrawn_at, null);

  // The member's own child device and its restricted session end; the owner's grant and the member's own
  // adult session are not this step's to revoke.
  assert.deepEqual(await row('SELECT version,revoked_at IS NOT NULL AS revoked FROM siyue.device_grants WHERE id=$1',
    [value.memberGrant]), {version:2,revoked:true});
  assert.deepEqual(await row('SELECT version,revoked_at FROM siyue.device_grants WHERE id=$1',
    [value.ownerGrant]), {version:1,revoked_at:null});
  assert.equal((await row('SELECT revoke_reason FROM siyue.auth_sessions WHERE device_grant_id=$1',
    [value.memberGrant])).revoke_reason, 'family_member_exited');
  await assert.rejects(fx.service.verify(value.childTokens.accessToken), refuses('AUTH_SESSION_INVALID', 401));
  await assert.rejects(fx.service.refresh(value.childTokens.refreshToken, randomUUID()), refuses('AUTH_SESSION_INVALID', 401));
  assert.equal((await fx.service.verify(value.memberSession.accessToken)).subjectId, memberId);

  // The member's pending invitation and approved pairing stop being usable; the sibling's stay.
  assert.deepEqual(await row('SELECT status,token_ciphertext FROM siyue.family_invitations WHERE id=$1',
    [value.memberInvitation]), {status:'revoked',token_ciphertext:null});
  assert.deepEqual(await row('SELECT status,token_ciphertext FROM siyue.family_invitations WHERE id=$1',
    [value.ownerInvitation]), {status:'pending',token_ciphertext:'synthetic-sealed-token'});
  assert.equal((await row('SELECT status FROM siyue.device_pairing_requests WHERE id=$1',
    [value.memberPairing])).status, 'expired');
  assert.equal((await row('SELECT status FROM siyue.device_pairing_requests WHERE id=$1',
    [value.ownerPairing])).status, 'approved');

  // The member's own room ends with its seats, and the member's seat in someone else's live room frees
  // while that room and its owner's seat stay exactly as they were.
  assert.deepEqual(await row('SELECT status,version FROM siyue.rooms WHERE id=$1', [value.memberRoom]),
    {status:'ended',version:2});
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.room_seats WHERE room_id=$1 AND released_at IS NULL',
    [value.memberRoom]), 0);
  assert.deepEqual(await row('SELECT status,version FROM siyue.rooms WHERE id=$1', [value.ownerRoom]),
    {status:'open',version:1});
  assert.ok((await row('SELECT released_at FROM siyue.room_seats WHERE room_id=$1 AND session_id=$2',
    [value.ownerRoom, value.memberSession.session.sessionId])).released_at);
  assert.equal((await row('SELECT released_at FROM siyue.room_seats WHERE room_id=$1 AND session_id=$2',
    [value.ownerRoom, value.owner.session.sessionId])).released_at, null);

  // The whole family dependency of this member is closed for a later cleanup pass.
  assert.deepEqual(await transaction(db.app, client =>
    inspectAccountDeletionBlockers(client, memberId, fx.clock())), []);
});

test('member exit closes only room invitations made stale by that member or an ended room', async () => {
  const value=await fullScene();
  const ownerId=value.owner.session.subjectId, memberId=value.member.session.subjectId;
  const siblingId=value.sibling.session.subjectId, childId=value.child.childId;
  const issuedByMember=await pendingRoomInvitation(value.ownerRoom,memberId,siblingId);
  const sentToMember=await pendingRoomInvitation(value.ownerRoom,ownerId,memberId);
  const inEndedRoom=await pendingRoomInvitation(value.memberRoom,ownerId,childId);
  const unaffected=await pendingRoomInvitation(value.ownerRoom,ownerId,childId);

  await transaction(db.app,client=>endOwnFamilyAccessForDeletion(client,memberId,value.family.familyId,fx.clock()));
  for(const id of [issuedByMember,sentToMember,inEndedRoom]) {
    const stored=await row('SELECT status,revoked_at FROM siyue.room_invitations WHERE id=$1',[id]);
    assert.equal(stored.status,'revoked');
    assert.ok(stored.revoked_at);
  }
  assert.deepEqual(await row('SELECT status,revoked_at FROM siyue.room_invitations WHERE id=$1',[unaffected]),
    {status:'pending',revoked_at:null});
});

test('a second family the member supervises is left to its own disposition', async () => {
  const value = await fullScene();
  const memberId = value.member.session.subjectId;
  const otherOwnerId = await adultSubject();
  const otherFamily = await transaction(db.app, client =>
    createFamilyRepository(db.app).create(client, otherOwnerId, '1'.repeat(64)));
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [otherFamily.familyId, memberId]);
  const otherChild = await childWithGuardians(otherFamily.familyId, [otherOwnerId, memberId]);
  const otherGrant = await grantFor(otherChild.childId, memberId, otherFamily.familyId);

  await transaction(db.app, client =>
    endOwnFamilyAccessForDeletion(client, memberId, value.family.familyId, fx.clock()));

  assert.deepEqual(await row('SELECT active,version FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3',
    [otherFamily.familyId, memberId, otherChild.childId]), {active:true,version:1});
  assert.equal((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1',
    [otherChild.consents.get(memberId)])).withdrawn_at, null);
  assert.deepEqual(await row('SELECT active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [otherFamily.familyId, memberId]), {active:true,version:1});
  assert.deepEqual(await row('SELECT version,revoked_at FROM siyue.device_grants WHERE id=$1',
    [otherGrant]), {version:1,revoked_at:null});
  assert.equal((await createFamilyRepository(db.app).list(memberId)).length, 1);
  // Only the second family is still an open dependency of this member; cleanup runs without exemptions,
  // so that family's live guardianship consent counts as its own pending case.
  assert.deepEqual(await transaction(db.app, client =>
    inspectAccountDeletionBlockers(client, memberId, fx.clock())),
  ['family_membership','guardianship','guardianship_consent','child_device_grant']);
});

test('refuses an owner, a non-member and a family that is not active', async () => {
  const value = await fullScene();
  const memberId = value.member.session.subjectId;
  const exit = subjectId => transaction(db.app, client =>
    endOwnFamilyAccessForDeletion(client, subjectId, value.family.familyId, fx.clock()));

  await assert.rejects(exit(value.owner.session.subjectId), refuses('AUTH_DELETION_DEPENDENCIES', 409));
  await assert.rejects(exit(value.stranger.session.subjectId), refuses('AUTH_DELETION_DEPENDENCIES', 409));
  for (const status of ['frozen', 'dissolved']) {
    await db.app.query('UPDATE siyue.families SET status=$2 WHERE id=$1', [value.family.familyId, status]);
    await assert.rejects(exit(memberId), refuses('AUTH_DELETION_DEPENDENCIES', 409));
    await db.app.query("UPDATE siyue.families SET status='active' WHERE id=$1", [value.family.familyId]);
  }

  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1 AND active',
    [value.family.familyId]), 4);
  assert.equal((await row('SELECT active FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2',
    [value.family.familyId, memberId])).active, true);
  assert.equal((await row('SELECT revoked_at FROM siyue.device_grants WHERE id=$1', [value.memberGrant])).revoked_at, null);
  assert.equal((await row('SELECT status FROM siyue.rooms WHERE id=$1', [value.memberRoom])).status, 'open');
  assert.equal((await row('SELECT status FROM siyue.family_invitations WHERE id=$1', [value.memberInvitation])).status, 'pending');
});

test('refuses while a guarded child would be left without a live guardian', async () => {
  const variants = [
    ['the other guardian relationship is revoked', value =>
      db.app.query('UPDATE siyue.guardian_relationships SET active=false WHERE family_id=$1 AND guardian_subject_id=$2',
        [value.family.familyId, value.owner.session.subjectId])],
    ['the other consent is withdrawn', value =>
      db.app.query('UPDATE siyue.consent_records SET withdrawn_at=now() WHERE id=$1',
        [value.child.consents.get(value.owner.session.subjectId)])],
    ['the other guardian is blocked', value =>
      db.app.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1", [value.owner.session.subjectId])],
    ['the other guardian membership is revoked', value =>
      db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2',
        [value.family.familyId, value.owner.session.subjectId])],
  ];
  for (const [label, mutate] of variants) {
    const value = await fullScene();
    const memberId = value.member.session.subjectId;
    await mutate(value);
    await assert.rejects(transaction(db.app, client =>
      endOwnFamilyAccessForDeletion(client, memberId, value.family.familyId, fx.clock())),
    refuses('AUTH_DELETION_DEPENDENCIES', 409), label);
    assert.equal((await row('SELECT active FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2',
      [value.family.familyId, memberId])).active, true, label);
    assert.deepEqual(await row('SELECT active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
      [value.family.familyId, memberId]), {active:true,version:1}, label);
    assert.equal((await row('SELECT revoked_at FROM siyue.device_grants WHERE id=$1', [value.memberGrant])).revoked_at, null, label);
    assert.equal((await row('SELECT status FROM siyue.rooms WHERE id=$1', [value.memberRoom])).status, 'open', label);
    assert.equal((await row('SELECT status FROM siyue.family_invitations WHERE id=$1', [value.memberInvitation])).status, 'pending', label);
    assert.equal((await row('SELECT status FROM siyue.device_pairing_requests WHERE id=$1', [value.memberPairing])).status, 'approved', label);
  }

  // A child whose only guardian is this member keeps that guardianship and every other dependency.
  const solo = await scene();
  const soloChild = await childWithGuardians(solo.family.familyId, [solo.member.session.subjectId]);
  const soloGrant = await grantFor(soloChild.childId, solo.member.session.subjectId, solo.family.familyId);
  await assert.rejects(transaction(db.app, client =>
    endOwnFamilyAccessForDeletion(client, solo.member.session.subjectId, solo.family.familyId, fx.clock())),
  refuses('AUTH_DELETION_DEPENDENCIES', 409));
  assert.equal((await row('SELECT active FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2',
    [solo.family.familyId, solo.member.session.subjectId])).active, true);
  assert.equal((await row('SELECT revoked_at FROM siyue.device_grants WHERE id=$1', [soloGrant])).revoked_at, null);
  assert.deepEqual(await transaction(db.app, client =>
    inspectAccountDeletionBlockers(client, solo.member.session.subjectId, fx.clock())),
  ['family_membership','guardianship','guardianship_consent','child_device_grant']);
});

test('a failed deletion transaction rolls the whole member exit back', async () => {
  const value = await fullScene();
  const memberId = value.member.session.subjectId;
  const roomInvitation=await pendingRoomInvitation(value.memberRoom,memberId,value.sibling.session.subjectId);
  await assert.rejects(transaction(db.app, async client => {
    await endOwnFamilyAccessForDeletion(client, memberId, value.family.familyId, fx.clock());
    throw new Error('synthetic_abort');
  }), /synthetic_abort/);

  assert.deepEqual(await row('SELECT active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, memberId]), {active:true,version:1});
  assert.deepEqual(await row('SELECT active,version FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3',
    [value.family.familyId, memberId, value.child.childId]), {active:true,version:1});
  assert.equal((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1',
    [value.child.consents.get(memberId)])).withdrawn_at, null);
  assert.deepEqual(await row('SELECT version,revoked_at FROM siyue.device_grants WHERE id=$1',
    [value.memberGrant]), {version:1,revoked_at:null});
  assert.equal((await fx.service.verify(value.childTokens.accessToken)).subjectId, value.child.childId);
  assert.deepEqual(await row('SELECT status,token_ciphertext FROM siyue.family_invitations WHERE id=$1',
    [value.memberInvitation]), {status:'pending',token_ciphertext:'synthetic-sealed-token'});
  assert.equal((await row('SELECT status FROM siyue.device_pairing_requests WHERE id=$1',
    [value.memberPairing])).status, 'approved');
  assert.deepEqual(await row('SELECT status,version FROM siyue.rooms WHERE id=$1', [value.memberRoom]),
    {status:'open',version:1});
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.room_seats WHERE room_id=$1 AND released_at IS NULL',
    [value.memberRoom]), 2);
  assert.equal((await createFamilyRepository(db.app).list(memberId)).length, 1);
  assert.deepEqual(await row('SELECT status,revoked_at FROM siyue.room_invitations WHERE id=$1',[roomInvitation]),
    {status:'pending',revoked_at:null});
});

/** A child supervised by the member in this family and by a second adult in another family. */
async function crossFamilyScene() {
  const base = await scene();
  const guardianId = await adultSubject();
  const otherFamily = await transaction(db.app, client =>
    createFamilyRepository(db.app).create(client, guardianId, digest()));
  const child = await childWithGuardians(base.family.familyId, [base.member.session.subjectId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [otherFamily.familyId, child.childId]);
  const consentId = randomUUID();
  await db.app.query("INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version) VALUES($1,$2,$3,'child-guardianship','1.0')",
    [consentId, guardianId, child.childId]);
  await db.app.query('INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)',
    [otherFamily.familyId, guardianId, child.childId, consentId]);
  const memberGrant = await grantFor(child.childId, base.member.session.subjectId, base.family.familyId);
  return {...base, guardianId, otherFamily, child, consentId, memberGrant};
}

/**
 * Runs the exit concurrently with an uncommitted change that another connection holds open. The exit must
 * wait for that change to commit and decide on the committed state: a check that only read those rows
 * without locking them would commit a decision from a snapshot the other transaction has already
 * invalidated. Returns the exit promise after committing the other transaction.
 */
async function exitWhileHolding(mutate, memberId, familyId) {
  const holder = await db.app.connect();
  await holder.query('BEGIN');
  let exit;
  try {
    await mutate(holder);
    exit = transaction(db.app, client => endOwnFamilyAccessForDeletion(client, memberId, familyId, fx.clock()));
    let settled = false;
    exit.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(settled, false, 'the exit must wait for the concurrent change to finish');
    assert.ok(await count('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted') > 0,
      'the exit must be blocked on the concurrent row lock');
    await holder.query('COMMIT');
    return exit;
  } catch (error) {
    await holder.query('ROLLBACK');
    throw error;
  } finally { holder.release(); }
}

test('a concurrent change to the other supervisor family refuses the exit instead of a stale success', async () => {
  const variants = [
    ['the other family is frozen', (holder, value) =>
      holder.query("UPDATE siyue.families SET status='frozen' WHERE id=$1", [value.otherFamily.familyId])],
    ['the other guardian membership is revoked', (holder, value) =>
      holder.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2',
        [value.otherFamily.familyId, value.guardianId])],
    ['the other guardian is blocked', (holder, value) =>
      holder.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1", [value.guardianId])],
    ['the other consent is withdrawn', (holder, value) =>
      holder.query('UPDATE siyue.consent_records SET withdrawn_at=now() WHERE id=$1', [value.consentId])],
    ['the child membership in the other family is revoked', (holder, value) =>
      holder.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2',
        [value.otherFamily.familyId, value.child.childId])],
  ];
  for (const [label, mutate] of variants) {
    const value = await crossFamilyScene();
    const memberId = value.member.session.subjectId;
    await assert.rejects(exitWhileHolding(holder => mutate(holder, value), memberId, value.family.familyId),
      refuses('AUTH_DELETION_DEPENDENCIES', 409), label);
    assert.deepEqual(await row('SELECT active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
      [value.family.familyId, memberId]), {active:true,version:1}, label);
    assert.equal((await row('SELECT active FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2',
      [value.family.familyId, memberId])).active, true, label);
    assert.equal((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1',
      [value.child.consents.get(memberId)])).withdrawn_at, null, label);
    assert.equal((await row('SELECT revoked_at FROM siyue.device_grants WHERE id=$1', [value.memberGrant])).revoked_at, null, label);
  }

  // Negative control: an unrelated concurrent commit on that same family row serializes too, and the exit
  // still succeeds on the committed state instead of refusing everything it happened to wait for.
  const value = await crossFamilyScene();
  const memberId = value.member.session.subjectId;
  const exited = await exitWhileHolding(holder =>
    holder.query('UPDATE siyue.families SET version=version+1 WHERE id=$1', [value.otherFamily.familyId]),
  memberId, value.family.familyId);
  assert.equal(exited, undefined);
  assert.deepEqual(await row('SELECT active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, memberId]), {active:false,version:2});
  assert.deepEqual(await row('SELECT active,version FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2',
    [value.family.familyId, memberId]), {active:false,version:2});
  assert.ok((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1',
    [value.child.consents.get(memberId)])).withdrawn_at);
  assert.ok((await row('SELECT revoked_at FROM siyue.device_grants WHERE id=$1', [value.memberGrant])).revoked_at);
});

test('a consent the members other family still depends on is left un-withdrawn', async () => {
  const base = await scene();
  const memberId = base.member.session.subjectId;
  // The child is guarded by this member and by the owner in this family, while the member's own
  // guardianship of the same child in a second family cites the very same consent record.
  const child = await childWithGuardians(base.family.familyId, [base.owner.session.subjectId, memberId]);
  const otherOwnerId = await adultSubject();
  const otherFamily = await transaction(db.app, client =>
    createFamilyRepository(db.app).create(client, otherOwnerId, digest()));
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [otherFamily.familyId, child.childId]);
  await db.app.query('INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)',
    [otherFamily.familyId, memberId, child.childId, child.consents.get(memberId)]);

  await transaction(db.app, client =>
    endOwnFamilyAccessForDeletion(client, memberId, base.family.familyId, fx.clock()));

  assert.equal((await row('SELECT active FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3',
    [base.family.familyId, memberId, child.childId])).active, false);
  assert.deepEqual(await row('SELECT active,version FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3',
    [otherFamily.familyId, memberId, child.childId]), {active:true,version:1});
  assert.equal((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1',
    [child.consents.get(memberId)])).withdrawn_at, null);
  assert.equal((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1',
    [child.consents.get(base.owner.session.subjectId)])).withdrawn_at, null);
});
