import { test, expect } from 'playwright/test';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from '../../apps/server/tests/integration/postgres-fixture.mjs';
import { createEmailFixture } from '../../apps/server/tests/integration/email-fixture.mjs';
import { transaction } from '../../apps/server/dist/adapters/postgres/database.js';
import { createFamilyRepository } from '../../apps/server/dist/modules/families/repository.js';
import { createChildDeviceService } from '../../apps/server/dist/modules/families/child-devices.js';
import { freezeOwnedFamilyForDeletion, transferOwnedFamilyForDeletion } from '../../apps/server/dist/modules/auth/account-deletion-family.js';
import { endOwnFamilyAccessForDeletion } from '../../apps/server/dist/modules/auth/account-deletion-member-exit.js';
import { createFamilyManagementAcceptanceService } from '../../apps/server/dist/modules/auth/family-management-acceptance.js';
import { createRuntimeApp } from '../../apps/server/dist/runtime-app.js';

let db, fx, app, address;
const header = token => ({authorization: `Bearer ${token}`});
test.beforeAll(async () => {
  db = await startPostgresFixture();
  fx = await createEmailFixture(db);
  app = createRuntimeApp(db.app, db.identity, {sessions: fx.service, childDevices: createChildDeviceService(db.app, fx.service, fx.clock)});
  address = await app.listen({host: '127.0.0.1', port: 0});
});
test.afterAll(async () => { await app?.close(); await db?.stop(); });

async function scene() {
  const guardian = await fx.issue(), stranger = await fx.issue();
  const guardianId = guardian.session.subjectId;
  const family = await transaction(db.app, client => createFamilyRepository(db.app).create(client, guardianId, 'b'.repeat(64)));
  const childId = randomUUID(), consentId = randomUUID(), grantId = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'child','Synthetic Child')", [childId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')", [family.familyId, childId]);
  await db.app.query("INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version) VALUES($1,$2,$3,'child-guardianship','0.0.1')",
    [consentId, guardianId, childId]);
  await db.app.query('INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)',
    [family.familyId, guardianId, childId, consentId]);
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,device_label,
    guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios','Child iPad',1,1,ARRAY[]::text[],$6)`,
  [grantId, childId, guardianId, family.familyId, randomUUID(), new Date(+fx.clock() + 30 * 86_400_000 - 1_000)]);
  const child = await transaction(db.app, client => fx.service.issueChild(client, grantId));
  return {guardian, stranger, child, childId, grantId, familyId: family.familyId};
}

test('freezing a family closes child sessions and device management over HTTP', async ({request}) => {
  const value = await scene();
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [value.familyId,value.stranger.session.subjectId]);
  const roomId=randomUUID(),invitationId=randomUUID();
  await db.app.query('INSERT INTO siyue.rooms(id,family_id,created_by_subject_id) VALUES($1,$2,$3)',
    [roomId,value.familyId,value.guardian.session.subjectId]);
  await db.app.query(`INSERT INTO siyue.room_invitations
    (id,room_id,inviter_subject_id,invitee_subject_id,inviter_membership_version,
      invitee_membership_version,family_version,expires_at)
    VALUES($1,$2,$3,$4,1,1,1,$5)`,
  [invitationId,roomId,value.guardian.session.subjectId,value.stranger.session.subjectId,
   new Date(+fx.clock()+86_400_000)]);
  expect((await request.get(address + '/v1/account/session', {headers: header(value.child.accessToken)})).status()).toBe(200);
  await transaction(db.app, client => freezeOwnedFamilyForDeletion(client,
    value.guardian.session.subjectId,value.familyId,fx.clock()));
  expect((await request.get(address + '/v1/account/session', {headers: header(value.child.accessToken)})).status()).toBe(401);
  expect((await request.get(address + `/v1/children/${value.childId}/devices`,
    {headers: header(value.guardian.accessToken)})).status()).toBe(404);
  const grant = (await db.app.query('SELECT revoked_at FROM siyue.device_grants WHERE id=$1', [value.grantId])).rows[0];
  expect(grant.revoked_at).not.toBeNull();
  const invitation=(await db.app.query('SELECT status,revoked_at FROM siyue.room_invitations WHERE id=$1',
    [invitationId])).rows[0];
  expect(invitation.status).toBe('revoked');
  expect(invitation.revoked_at).not.toBeNull();
});

test('only the explicit guardian sees a child device, and revocation immediately invalidates its session', async ({request}) => {
  const value = await scene();
  const path = `/v1/children/${value.childId}/devices`;
  expect((await request.get(address + '/v1/account/session', {headers: header(value.child.accessToken)})).status()).toBe(200);
  const listed = await request.get(address + path, {headers: header(value.guardian.accessToken)});
  expect(listed.status()).toBe(200);
  expect((await listed.json()).data.items).toEqual([expect.objectContaining({grantId: value.grantId, status: 'active', version: 1})]);
  expect((await request.get(address + path, {headers: header(value.stranger.accessToken)})).status()).toBe(404);
  const stale = await request.delete(address + `${path}/${value.grantId}`, {headers: header(value.guardian.accessToken), data: {expectedVersion: 2}});
  expect(stale.status()).toBe(409);
  const revoked = await request.delete(address + `${path}/${value.grantId}`, {headers: header(value.guardian.accessToken), data: {expectedVersion: 1}});
  expect(revoked.status()).toBe(200);
  expect((await revoked.json()).data).toEqual(expect.objectContaining({grantId: value.grantId, status: 'revoked', version: 2}));
  expect((await request.get(address + '/v1/account/session', {headers: header(value.child.accessToken)})).status()).toBe(401);
  expect((await request.get(address + path, {headers: header(value.guardian.accessToken)})).status()).toBe(200);
});

test('a family admin without a guardian relationship cannot list or revoke the child device', async ({request}) => {
  const value = await scene();
  const familyId = (await db.app.query('SELECT family_id FROM siyue.device_grants WHERE id=$1', [value.grantId])).rows[0].family_id;
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'admin')",
    [familyId, value.stranger.session.subjectId]);
  const path = `/v1/children/${value.childId}/devices`;
  expect((await request.get(address + path, {headers: header(value.stranger.accessToken)})).status()).toBe(404);
  expect((await request.delete(address + `${path}/${value.grantId}`, {headers: header(value.stranger.accessToken), data: {expectedVersion: 1}})).status()).toBe(404);
  expect((await request.get(address + '/v1/account/session', {headers: header(value.child.accessToken)})).status()).toBe(200);
});

test('transferring one family preserves a child session guarded through another family', async ({request}) => {
  const owner=await fx.issue(),recipient=await fx.issue(),otherOwner=await fx.issue();
  const ownerId=owner.session.subjectId,childId=randomUUID(),consentId=randomUUID(),grantId=randomUUID();
  const families=createFamilyRepository(db.app);
  const familyA=await transaction(db.app,client=>families.create(client,ownerId,'a'.repeat(64)));
  const familyB=await transaction(db.app,client=>families.create(client,otherOwner.session.subjectId,'c'.repeat(64)));
  await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'child','Synthetic Child')",[childId]);
  for(const [familyId,subjectId] of [[familyA.familyId,recipient.session.subjectId],
    [familyA.familyId,childId],[familyB.familyId,ownerId],[familyB.familyId,childId]])
    await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
      [familyId,subjectId]);
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-guardianship','0.0.1')`,[consentId,ownerId,childId]);
  for(const familyId of [familyA.familyId,familyB.familyId])
    await db.app.query(`INSERT INTO siyue.guardian_relationships
      (family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)`,
    [familyId,ownerId,childId,consentId]);
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,
      installation_id,platform,device_label,guardian_relationship_version,guardian_credential_version,
      scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios','Other-family iPad',1,1,ARRAY[]::text[],$6)`,
  [grantId,childId,ownerId,familyB.familyId,randomUUID(),new Date(+fx.clock()+86_400_000)]);
  const child=await transaction(db.app,client=>fx.service.issueChild(client,grantId));
  const roomA=randomUUID(),roomB=randomUUID(),inviteA=randomUUID(),inviteB=randomUUID();
  for(const [roomId,familyId,creator] of [[roomA,familyA.familyId,ownerId],
    [roomB,familyB.familyId,otherOwner.session.subjectId]])
    await db.app.query('INSERT INTO siyue.rooms(id,family_id,created_by_subject_id) VALUES($1,$2,$3)',
      [roomId,familyId,creator]);
  for(const [invitationId,roomId] of [[inviteA,roomA],[inviteB,roomB]])
    await db.app.query(`INSERT INTO siyue.room_invitations
      (id,room_id,inviter_subject_id,invitee_subject_id,inviter_membership_version,
        invitee_membership_version,family_version,expires_at)
      VALUES($1,$2,$3,$4,1,1,1,$5)`,
    [invitationId,roomId,ownerId,childId,new Date(+fx.clock()+86_400_000)]);
  expect((await request.get(address+'/v1/account/session',{headers:header(child.accessToken)})).status()).toBe(200);

  const acceptance=createFamilyManagementAcceptanceService(db.app,fx.service,fx.clock);
  const preview=await acceptance.preview(recipient.accessToken,familyA.familyId);
  await acceptance.accept(recipient.accessToken,familyA.familyId,{
    expectedFamilyVersion:preview.familyVersion,expectedMembershipVersion:preview.membershipVersion,
    expectedOwnerMembershipVersion:preview.ownerMembershipVersion,
    expectedChildScopeDigest:preview.childScopeDigest,
    acceptance:{familyManagement:true,guardianship:true}});
  await transaction(db.app,client=>transferOwnedFamilyForDeletion(client,ownerId,familyA.familyId,
    recipient.session.subjectId,fx.clock()));

  expect((await request.get(address+'/v1/account/session',{headers:header(child.accessToken)})).status()).toBe(200);
  expect((await db.app.query('SELECT revoked_at FROM siyue.device_grants WHERE id=$1',[grantId])).rows[0].revoked_at)
    .toBeNull();
  expect((await db.app.query('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1',[consentId])).rows[0].withdrawn_at)
    .toBeNull();
  expect((await db.app.query('SELECT status FROM siyue.room_invitations WHERE id=$1',[inviteA])).rows[0].status)
    .toBe('revoked');
  expect((await db.app.query('SELECT status FROM siyue.room_invitations WHERE id=$1',[inviteB])).rows[0].status)
    .toBe('pending');
});

test('member exit closes only its stale room invitations while the other guardian keeps the child online', async ({request}) => {
  const value=await scene();
  const memberId=value.stranger.session.subjectId,ownerId=value.guardian.session.subjectId;
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [value.familyId,memberId]);
  const memberConsent=randomUUID();
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-guardianship','0.0.1')`,[memberConsent,memberId,value.childId]);
  await db.app.query(`INSERT INTO siyue.guardian_relationships
    (family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)`,
  [value.familyId,memberId,value.childId,memberConsent]);
  const ownerRoom=randomUUID(),memberRoom=randomUUID();
  for(const [roomId,creator] of [[ownerRoom,ownerId],[memberRoom,memberId]])
    await db.app.query('INSERT INTO siyue.rooms(id,family_id,created_by_subject_id) VALUES($1,$2,$3)',
      [roomId,value.familyId,creator]);
  const invite=async(roomId,inviter,invitee)=>{
    const id=randomUUID();
    await db.app.query(`INSERT INTO siyue.room_invitations
      (id,room_id,inviter_subject_id,invitee_subject_id,inviter_membership_version,
        invitee_membership_version,family_version,expires_at)
      VALUES($1,$2,$3,$4,1,1,1,$5)`,
    [id,roomId,inviter,invitee,new Date(+fx.clock()+86_400_000)]);
    return id;
  };
  const memberIssued=await invite(ownerRoom,memberId,ownerId);
  const memberInvited=await invite(ownerRoom,ownerId,memberId);
  const endedRoomInvite=await invite(memberRoom,ownerId,value.childId);
  const ownerInvite=await invite(ownerRoom,ownerId,value.childId);
  expect((await request.get(address+'/v1/account/session',
    {headers:header(value.child.accessToken)})).status()).toBe(200);

  await transaction(db.app,client=>endOwnFamilyAccessForDeletion(client,memberId,value.familyId,fx.clock()));

  expect((await request.get(address+'/v1/account/session',
    {headers:header(value.child.accessToken)})).status()).toBe(200);
  for(const id of [memberIssued,memberInvited,endedRoomInvite])
    expect((await db.app.query('SELECT status FROM siyue.room_invitations WHERE id=$1',[id])).rows[0].status)
      .toBe('revoked');
  expect((await db.app.query('SELECT status FROM siyue.room_invitations WHERE id=$1',[ownerInvite])).rows[0].status)
    .toBe('pending');
});
