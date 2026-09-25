import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createFamilyRepository } from '../../dist/modules/families/repository.js';
import { transferOwnedFamilyForDeletion } from '../../dist/modules/auth/account-deletion-family.js';
import { createFamilyManagementAcceptanceService } from '../../dist/modules/auth/family-management-acceptance.js';

// Isolated temporary PostgreSQL cluster only: the fixture always builds a fresh cluster on a short Unix
// socket and never reads a database URL or the workspace .env. Every subject, family, child, consent,
// grant, invitation and room below is synthetic, and no HTTP route, mail, provider or network call
// happens here.
//
// "The owner of a family hands it to an accepting recipient and then deletes their account" is an
// internal step with no HTTP surface, so every call below runs inside a caller-owned transaction that
// already holds the deleting owner's subject lock, exactly as the future deletion acceptance kernel must
// call it.
//
// The defect these tests pin down: closing the outgoing owner's guardianship in family A withdraws the
// consent rows cited by any of their relationships in family A. A consent record is keyed by
// actor/child/purpose rather than by family, so one row can legitimately back the same guardian's
// relationships in several families; withdrawing it for family A silently invalidates family B's
// guardianship and the child session that family B's device grant authorizes.
let db, fx, service;
const day = 86_400_000;
const refuses = (code, status) => error => error?.code === code && error?.status === status;
const rows = (sql, params) => db.app.query(sql, params).then(result => result.rows);
const row = (sql, params) => rows(sql, params).then(result => result[0]);
/** 64 hex characters unique per call, for the columns that store a keyed digest. */
const digest = () => randomUUID().replaceAll('-', '').repeat(2);

before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query('TRUNCATE siyue.subjects CASCADE');
  fx = await createEmailFixture(db);
  service = createFamilyManagementAcceptanceService(db.app, fx.service, fx.clock);
});
after(async () => { await db?.stop(); });

/** An adult subject without a session, for scenes that only need a family role filled. */
async function adultSubject() {
  const id = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [id]);
  return id;
}

const createFamily = ownerId => transaction(db.app, client =>
  createFamilyRepository(db.app).create(client, ownerId, digest()));
const addMember = (familyId, subjectId, role = 'member') => db.app.query(
  'INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,$3)', [familyId, subjectId, role]);

/** A supervised child, its membership in the family, and the consent each named guardian recorded. */
async function childWithGuardians(familyId, guardians) {
  const childId = randomUUID(), consents = new Map();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'child','Synthetic Child')", [childId]);
  await addMember(familyId, childId);
  for (const guardianId of guardians) {
    const consentId = randomUUID();
    await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
      VALUES($1,$2,$3,'child-guardianship','1.0')`, [consentId, guardianId, childId]);
    await db.app.query('INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)',
      [familyId, guardianId, childId, consentId]);
    consents.set(guardianId, consentId);
  }
  return {childId, consents};
}

/** A child device grant approved under the relationship version it read, so a live child session cites it. */
async function grantFor(childId, guardianId, familyId) {
  const grantId = randomUUID();
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,
    device_label,guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios','Synthetic iPad',1,1,ARRAY[]::text[],$6)`,
  [grantId, childId, guardianId, familyId, randomUUID(), new Date(+fx.clock() + 30 * day - 1_000)]);
  return grantId;
}

async function openRoom(familyId, creatorId) {
  const roomId = randomUUID();
  await db.app.query('INSERT INTO siyue.rooms(id,family_id,created_by_subject_id) VALUES($1,$2,$3)',
    [roomId, familyId, creatorId]);
  return roomId;
}

async function pendingRoomInvitation(roomId, inviterId, inviteeId) {
  const id=randomUUID();
  await db.app.query(`INSERT INTO siyue.room_invitations
    (id,room_id,inviter_subject_id,invitee_subject_id,inviter_membership_version,
      invitee_membership_version,family_version,expires_at)
    VALUES($1,$2,$3,$4,1,1,1,$5)`,
  [id,roomId,inviterId,inviteeId,new Date(+fx.clock()+day)]);
  return id;
}

async function pendingInvitation(familyId, inviterId) {
  const invitationId = randomUUID(), at = fx.clock();
  await db.app.query(`INSERT INTO siyue.family_invitations(id,family_id,inviter_id,token_hash,policy_version,
    inviter_membership_version,family_version,expires_at,token_ciphertext,token_ciphertext_expires_at)
    VALUES($1,$2,$3,$4,'1.0',1,1,$5,'synthetic-sealed-token',$6)`,
  [invitationId, familyId, inviterId, digest(), new Date(+at + day), new Date(+at + 60_000)]);
  return invitationId;
}

/**
 * Family A whose owner recorded the guardianship consent for one child, while the outgoing owner's own
 * relationship in a second family B guards the same child and cites that very same consent record. The
 * second family is owned by an unrelated adult and both the owner and the child are live members there,
 * so family B's guardianship and its device grant depend on the shared consent staying un-withdrawn.
 */
async function sharedConsentScene() {
  const owner = await fx.issue(), recipient = await fx.issue();
  const family = await createFamily(owner.session.subjectId);
  await addMember(family.familyId, recipient.session.subjectId);
  const child = await childWithGuardians(family.familyId, [owner.session.subjectId]);
  const otherOwnerId = await adultSubject();
  const otherFamily = await createFamily(otherOwnerId);
  await addMember(otherFamily.familyId, owner.session.subjectId);
  await addMember(otherFamily.familyId, child.childId);
  await db.app.query('INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)',
    [otherFamily.familyId, owner.session.subjectId, child.childId, child.consents.get(owner.session.subjectId)]);
  return {owner, recipient, family, child, otherOwnerId, otherFamily};
}

/** The recipient's own preview then accepted declaration, exactly as the acceptance route records it. */
async function acceptManagement(familyId, recipient) {
  const preview = await service.preview(recipient.accessToken, familyId);
  await service.accept(recipient.accessToken, familyId, {expectedFamilyVersion: preview.familyVersion,
    expectedMembershipVersion: preview.membershipVersion,
    expectedOwnerMembershipVersion: preview.ownerMembershipVersion,
    expectedChildScopeDigest: preview.childScopeDigest,
    acceptance: {familyManagement: true, guardianship: true}});
  return preview;
}

const transfer = (ownerId, familyId, recipientId) => transaction(db.app, client =>
  transferOwnedFamilyForDeletion(client, ownerId, familyId, recipientId, fx.clock()));

test('a shared guardianship consent is left un-withdrawn while the outgoing owner still cites it in another family', async () => {
  const value = await sharedConsentScene();
  const ownerId = value.owner.session.subjectId;
  const shared = value.child.consents.get(ownerId);
  assert.equal((await acceptManagement(value.family.familyId, value.recipient)).childCount, 1);

  await transfer(ownerId, value.family.familyId, value.recipient.session.subjectId);

  // Family A's guardianship ends for the outgoing owner. Family B's relationship is not this transfer's
  // to change, and both relationships cite one consent row: withdrawing it here would invalidate family
  // B's guardianship, so it must stay un-withdrawn.
  assert.deepEqual(await row(`SELECT active,version FROM siyue.guardian_relationships
    WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3`,
  [value.family.familyId, ownerId, value.child.childId]), {active:false,version:2});
  assert.deepEqual(await row(`SELECT active,version FROM siyue.guardian_relationships
    WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3`,
  [value.otherFamily.familyId, ownerId, value.child.childId]), {active:true,version:1});
  assert.equal((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1', [shared])).withdrawn_at, null);
});

test('a consent only the transferred family depends on is still withdrawn', async () => {
  const owner = await fx.issue(), recipient = await fx.issue();
  const family = await createFamily(owner.session.subjectId);
  await addMember(family.familyId, recipient.session.subjectId);
  const child = await childWithGuardians(family.familyId, [owner.session.subjectId]);
  await acceptManagement(family.familyId, recipient);

  await transfer(owner.session.subjectId, family.familyId, recipient.session.subjectId);

  // Positive control for the shared-consent guard: the transfer must still withdraw a consent nothing
  // outside the transferred family cites, so the fix narrows withdrawal instead of disabling it.
  assert.ok((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1',
    [child.consents.get(owner.session.subjectId)])).withdrawn_at);
  assert.deepEqual(await row(`SELECT active,version FROM siyue.guardian_relationships
    WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3`,
  [family.familyId, owner.session.subjectId, child.childId]), {active:false,version:2});
});

test('the transfer moves only the transferred family and leaves the second family guarding the child', async () => {
  const value = await sharedConsentScene();
  const ownerId = value.owner.session.subjectId, recipientId = value.recipient.session.subjectId;
  const otherFamilyId = value.otherFamily.familyId, shared = value.child.consents.get(ownerId);
  // The outgoing owner holds the same kinds of row in both families: a child device, an open room and a
  // pending invitation. Only the family A copies are this transfer's to touch.
  const ownerGrantA = await grantFor(value.child.childId, ownerId, value.family.familyId);
  const ownerGrantB = await grantFor(value.child.childId, ownerId, otherFamilyId);
  const childTokensB = await transaction(db.app, client => fx.service.issueChild(client, ownerGrantB));
  const ownerRoomA = await openRoom(value.family.familyId, ownerId);
  const ownerRoomB = await openRoom(otherFamilyId, ownerId);
  const ownerInvitationA = await pendingInvitation(value.family.familyId, ownerId);
  const ownerInvitationB = await pendingInvitation(otherFamilyId, ownerId);
  await acceptManagement(value.family.familyId, value.recipient);

  await transfer(ownerId, value.family.familyId, recipientId);

  // Family A moved to the recipient: the owner is demoted, the recipient promoted, and the recipient now
  // holds an active consent-backed guardianship of the child.
  assert.deepEqual(await row('SELECT owner_subject_id,version FROM siyue.families WHERE id=$1',
    [value.family.familyId]), {owner_subject_id:recipientId,version:2});
  assert.deepEqual(await row('SELECT role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, ownerId]), {role:'member',active:false,version:2});
  assert.deepEqual(await row('SELECT role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, recipientId]), {role:'owner',active:true,version:2});
  assert.deepEqual(await row(`SELECT r.active,r.version,c.actor_subject_id,c.withdrawn_at
    FROM siyue.guardian_relationships r JOIN siyue.consent_records c ON c.id=r.consent_record_id
    WHERE r.family_id=$1 AND r.guardian_subject_id=$2 AND r.child_subject_id=$3`,
  [value.family.familyId, recipientId, value.child.childId]),
  {active:true,version:1,actor_subject_id:recipientId,withdrawn_at:null});
  assert.ok((await row('SELECT revoked_at FROM siyue.device_grants WHERE id=$1', [ownerGrantA])).revoked_at);
  assert.deepEqual(await row('SELECT status,version FROM siyue.rooms WHERE id=$1', [ownerRoomA]),
    {status:'ended',version:2});
  assert.deepEqual(await row('SELECT status,token_ciphertext FROM siyue.family_invitations WHERE id=$1',
    [ownerInvitationA]), {status:'revoked',token_ciphertext:null});

  // Family B keeps its own owner, both memberships, the guardianship version, the shared consent, the
  // device, the open room, the pending invitation and the live child session that device authorizes:
  // none of them belong to family A.
  assert.deepEqual(await row('SELECT owner_subject_id,version FROM siyue.families WHERE id=$1',
    [otherFamilyId]), {owner_subject_id:value.otherOwnerId,version:1});
  assert.deepEqual(await row('SELECT role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [otherFamilyId, ownerId]), {role:'member',active:true,version:1});
  assert.deepEqual(await row('SELECT role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [otherFamilyId, value.child.childId]), {role:'member',active:true,version:1});
  assert.deepEqual(await row(`SELECT active,version,consent_record_id FROM siyue.guardian_relationships
    WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3`,
  [otherFamilyId, ownerId, value.child.childId]), {active:true,version:1,consent_record_id:shared});
  assert.equal((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1', [shared])).withdrawn_at, null);
  assert.deepEqual(await row('SELECT version,revoked_at FROM siyue.device_grants WHERE id=$1', [ownerGrantB]),
    {version:1,revoked_at:null});
  assert.equal((await fx.service.verify(childTokensB.accessToken)).subjectId, value.child.childId);
  assert.deepEqual(await row('SELECT status,version FROM siyue.rooms WHERE id=$1', [ownerRoomB]),
    {status:'open',version:1});
  assert.deepEqual(await row('SELECT status,token_ciphertext FROM siyue.family_invitations WHERE id=$1',
    [ownerInvitationB]), {status:'pending',token_ciphertext:'synthetic-sealed-token'});
});

test('transfer closes pending room invitations pinned to the old family version only', async () => {
  const value=await sharedConsentScene();
  const familyA=value.family.familyId, familyB=value.otherFamily.familyId;
  const ownerId=value.owner.session.subjectId, recipientId=value.recipient.session.subjectId;
  const roomA=await openRoom(familyA,ownerId), roomB=await openRoom(familyB,ownerId);
  const invitationA=await pendingRoomInvitation(roomA,recipientId,value.child.childId);
  const invitationB=await pendingRoomInvitation(roomB,ownerId,value.child.childId);
  await acceptManagement(familyA,value.recipient);

  await assert.rejects(transaction(db.app,async client=>{
    await transferOwnedFamilyForDeletion(client,ownerId,familyA,recipientId,fx.clock());
    throw new Error('synthetic_abort');
  }),/synthetic_abort/);
  assert.deepEqual(await row('SELECT status,revoked_at FROM siyue.room_invitations WHERE id=$1',[invitationA]),
    {status:'pending',revoked_at:null});
  await transfer(ownerId,familyA,recipientId);

  const closed=await row('SELECT status,revoked_at FROM siyue.room_invitations WHERE id=$1',[invitationA]);
  assert.equal(closed.status,'revoked');
  assert.ok(closed.revoked_at);
  assert.deepEqual(await row('SELECT status,revoked_at FROM siyue.room_invitations WHERE id=$1',[invitationB]),
    {status:'pending',revoked_at:null});
});

test('a transfer without the recipients stored acceptance refuses and changes nothing', async () => {
  const value = await sharedConsentScene();
  const ownerId = value.owner.session.subjectId;

  await assert.rejects(transfer(ownerId, value.family.familyId, value.recipient.session.subjectId),
    refuses('AUTH_DELETION_DEPENDENCIES', 409));

  // The refusal rolls the whole step back, so no family, membership, guardianship or consent row moved.
  assert.equal((await row('SELECT owner_subject_id FROM siyue.families WHERE id=$1',
    [value.family.familyId])).owner_subject_id, ownerId);
  assert.deepEqual(await row(`SELECT active,version FROM siyue.guardian_relationships
    WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3`,
  [value.family.familyId, ownerId, value.child.childId]), {active:true,version:1});
  assert.equal((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1',
    [value.child.consents.get(ownerId)])).withdrawn_at, null);
});
