import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createFamilyRepository } from '../../dist/modules/families/repository.js';
import { createFamilyManagementAcceptanceService,
  consumeFamilyManagementAcceptance } from '../../dist/modules/auth/family-management-acceptance.js';
import { transferOwnedFamilyForDeletion } from '../../dist/modules/auth/account-deletion-family.js';
import { inspectAccountDeletionBlockers } from '../../dist/modules/auth/account-deletion-cleanup.js';

let db,fx,service;
before(async()=>{db=await startPostgresFixture();});
beforeEach(async()=>{
  await db.admin.query('TRUNCATE siyue.subjects CASCADE');
  fx=await createEmailFixture(db);
  service=createFamilyManagementAcceptanceService(db.app,fx.service,fx.clock);
});
after(async()=>{await db?.stop();});

async function scene() {
  const owner=await fx.issue(),recipient=await fx.issue(),outsider=await fx.issue();
  const family=await transaction(db.app,client=>createFamilyRepository(db.app).create(client,
    owner.session.subjectId,'a'.repeat(64)));
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [family.familyId,recipient.session.subjectId]);
  const childId=randomUUID(),consentId=randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')",[childId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [family.familyId,childId]);
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-guardianship','1.0')`,[consentId,owner.session.subjectId,childId]);
  await db.app.query(`INSERT INTO siyue.guardian_relationships
    (family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)`,
  [family.familyId,owner.session.subjectId,childId,consentId]);
  return {owner,recipient,outsider,family,childId};
}
const request=scope=>({expectedFamilyVersion:scope.familyVersion,
  expectedMembershipVersion:scope.membershipVersion,
  expectedOwnerMembershipVersion:scope.ownerMembershipVersion,
  expectedChildScopeDigest:scope.childScopeDigest,
  acceptance:{familyManagement:true,guardianship:true}});
const consume=(family,owner,recipient)=>transaction(db.app,client=>consumeFamilyManagementAcceptance(client,
  family.familyId,owner.session.subjectId,recipient.session.subjectId,fx.clock()));

test('recipient explicitly accepts the locked family and child scope; deletion may consume it once',async()=>{
  const {owner,recipient,outsider,family}=await scene();
  const preview=await service.preview(recipient.accessToken,family.familyId);
  assert.equal(preview.childCount,1);
  assert.equal(preview.ownerSubjectId,owner.session.subjectId);
  await assert.rejects(service.preview(outsider.accessToken,family.familyId),{code:'FAMILY_NOT_FOUND'});
  const accepted=await service.accept(recipient.accessToken,family.familyId,request(preview));
  assert.equal(accepted.ownerSubjectId,owner.session.subjectId);
  assert.equal(accepted.recipientSubjectId,recipient.session.subjectId);
  assert.equal(accepted.childScopeDigest,preview.childScopeDigest);
  const stored=(await db.app.query(`SELECT owner_subject_id,recipient_subject_id,consumed_at,superseded_at
    FROM siyue.family_management_acceptances WHERE id=$1`,[accepted.acceptanceId])).rows[0];
  assert.deepEqual(stored,{owner_subject_id:owner.session.subjectId,
    recipient_subject_id:recipient.session.subjectId,consumed_at:null,superseded_at:null});
  await consume(family,owner,recipient);
  assert.ok((await db.app.query('SELECT consumed_at FROM siyue.family_management_acceptances WHERE id=$1',
    [accepted.acceptanceId])).rows[0].consumed_at);
  await assert.rejects(consume(family,owner,recipient),{code:'AUTH_DELETION_DEPENDENCIES'});
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.management.accept'"))
    .rows[0].n,1);
});

test('changed child scope rejects the old acceptance and preserves it as unconsumed',async()=>{
  const {owner,recipient,family,childId}=await scene();
  const preview=await service.preview(recipient.accessToken,family.familyId);
  const accepted=await service.accept(recipient.accessToken,family.familyId,request(preview));
  await db.app.query(`UPDATE siyue.guardian_relationships SET version=version+1
    WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3`,
  [family.familyId,owner.session.subjectId,childId]);
  await assert.rejects(consume(family,owner,recipient),{code:'AUTH_DELETION_DEPENDENCIES'});
  assert.equal((await db.app.query('SELECT consumed_at FROM siyue.family_management_acceptances WHERE id=$1',
    [accepted.acceptanceId])).rows[0].consumed_at,null);
  const fresh=await service.preview(recipient.accessToken,family.familyId);
  assert.notEqual(fresh.childScopeDigest,preview.childScopeDigest);
  const replacement=await service.accept(recipient.accessToken,family.familyId,request(fresh));
  assert.notEqual(replacement.acceptanceId,accepted.acceptanceId);
  assert.ok((await db.app.query('SELECT superseded_at FROM siyue.family_management_acceptances WHERE id=$1',
    [accepted.acceptanceId])).rows[0].superseded_at);
  await consume(family,owner,recipient);
});

test('confirmation, membership version and recipient eligibility are required',async()=>{
  const {recipient,outsider,family}=await scene();
  const preview=await service.preview(recipient.accessToken,family.familyId);
  await assert.rejects(service.accept(recipient.accessToken,family.familyId,
    {...request(preview),acceptance:{familyManagement:true,guardianship:false}}),
  {code:'FAMILY_INVALID_REQUEST'});
  await assert.rejects(service.accept(outsider.accessToken,family.familyId,request(preview)),
    {code:'FAMILY_NOT_FOUND'});
  await db.app.query('UPDATE siyue.family_memberships SET version=version+1 WHERE family_id=$1 AND subject_id=$2',
    [family.familyId,recipient.session.subjectId]);
  await assert.rejects(service.accept(recipient.accessToken,family.familyId,request(preview)),
    {code:'FAMILY_STALE_AUTHORIZATION'});
  assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.family_management_acceptances')).rows[0].n,0);
});

test('an expired or changed-family acceptance cannot authorize transfer',async()=>{
  const {owner,recipient,family}=await scene();
  const preview=await service.preview(recipient.accessToken,family.familyId);
  await service.accept(recipient.accessToken,family.familyId,request(preview));
  await db.app.query('UPDATE siyue.families SET version=version+1 WHERE id=$1',[family.familyId]);
  await assert.rejects(consume(family,owner,recipient),{code:'AUTH_DELETION_DEPENDENCIES'});
  const current=await service.preview(recipient.accessToken,family.familyId);
  await service.accept(recipient.accessToken,family.familyId,request(current));
  fx.advance(24*60*60*1000+1);
  await assert.rejects(consume(family,owner,recipient),{code:'AUTH_DELETION_DEPENDENCIES'});
  assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.family_management_acceptances WHERE consumed_at IS NOT NULL'))
    .rows[0].n,0);
});

test('a changed guardianship policy invalidates the recorded child responsibility',async()=>{
  const {owner,recipient,family,childId}=await scene();
  const preview=await service.preview(recipient.accessToken,family.familyId);
  const accepted=await service.accept(recipient.accessToken,family.familyId,request(preview));
  await db.app.query(`UPDATE siyue.consent_records SET policy_version='2.0'
    WHERE id=(SELECT consent_record_id FROM siyue.guardian_relationships
      WHERE family_id=$1 AND guardian_subject_id=$2 AND child_subject_id=$3)`,
  [family.familyId,owner.session.subjectId,childId]);
  await assert.rejects(consume(family,owner,recipient),{code:'AUTH_DELETION_DEPENDENCIES'});
  assert.notEqual((await service.preview(recipient.accessToken,family.familyId)).childScopeDigest,
    accepted.childScopeDigest);
});

test('accepted transfer changes owner and guardian atomically, and frees the old owner for cleanup',async()=>{
  const {owner,recipient,family,childId}=await scene();
  const grantId=randomUUID();
  await db.app.query(`INSERT INTO siyue.device_grants
    (id,child_subject_id,guardian_id,family_id,installation_id,platform,
     guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios',1,1,ARRAY[]::text[],$6)`,
  [grantId,childId,owner.session.subjectId,family.familyId,randomUUID(),
    new Date(+fx.clock()+86_400_000)]);
  const childTokens=await transaction(db.app,client=>fx.service.issueChild(client,grantId));
  const preview=await service.preview(recipient.accessToken,family.familyId);
  const accepted=await service.accept(recipient.accessToken,family.familyId,request(preview));
  await transaction(db.app,client=>transferOwnedFamilyForDeletion(client,
    owner.session.subjectId,family.familyId,recipient.session.subjectId,fx.clock()));
  assert.equal((await db.app.query('SELECT owner_subject_id,status FROM siyue.families WHERE id=$1',
    [family.familyId])).rows[0].owner_subject_id,recipient.session.subjectId);
  const members=(await db.app.query('SELECT subject_id,role,active FROM siyue.family_memberships WHERE family_id=$1',
    [family.familyId])).rows;
  assert.deepEqual(members.find(row=>row.subject_id===owner.session.subjectId),
    {subject_id:owner.session.subjectId,role:'member',active:false});
  assert.deepEqual(members.find(row=>row.subject_id===recipient.session.subjectId),
    {subject_id:recipient.session.subjectId,role:'owner',active:true});
  const guardians=(await db.app.query(`SELECT guardian_subject_id,active FROM siyue.guardian_relationships
    WHERE family_id=$1 AND child_subject_id=$2`,[family.familyId,childId])).rows;
  assert.deepEqual(guardians.find(row=>row.guardian_subject_id===owner.session.subjectId),
    {guardian_subject_id:owner.session.subjectId,active:false});
  assert.deepEqual(guardians.find(row=>row.guardian_subject_id===recipient.session.subjectId),
    {guardian_subject_id:recipient.session.subjectId,active:true});
  assert.ok((await db.app.query('SELECT revoked_at FROM siyue.device_grants WHERE id=$1',
    [grantId])).rows[0].revoked_at);
  await assert.rejects(fx.service.verify(childTokens.accessToken),{code:'AUTH_SESSION_INVALID'});
  assert.ok((await db.app.query('SELECT consumed_at FROM siyue.family_management_acceptances WHERE id=$1',
    [accepted.acceptanceId])).rows[0].consumed_at);
  const blockers=await transaction(db.app,client=>inspectAccountDeletionBlockers(client,
    owner.session.subjectId,fx.clock()));
  assert.deepEqual(blockers,[]);
});

test('failed transfer rolls back consumed acceptance and leaves family intact',async()=>{
  const {owner,recipient,family}=await scene();
  const preview=await service.preview(recipient.accessToken,family.familyId);
  const accepted=await service.accept(recipient.accessToken,family.familyId,request(preview));
  await assert.rejects(transaction(db.app,async client=>{
    await transferOwnedFamilyForDeletion(client,owner.session.subjectId,family.familyId,
      recipient.session.subjectId,fx.clock());
    throw new Error('synthetic_abort');
  }),/synthetic_abort/);
  assert.equal((await db.app.query('SELECT owner_subject_id FROM siyue.families WHERE id=$1',
    [family.familyId])).rows[0].owner_subject_id,owner.session.subjectId);
  assert.equal((await db.app.query('SELECT consumed_at FROM siyue.family_management_acceptances WHERE id=$1',
    [accepted.acceptanceId])).rows[0].consumed_at,null);
});

test('management acceptance history is removed after its bounded retention window',async()=>{
  const {recipient,family}=await scene();
  const preview=await service.preview(recipient.accessToken,family.familyId);
  const accepted=await service.accept(recipient.accessToken,family.familyId,request(preview));
  fx.advance(29*86_400_000);
  assert.equal(await service.cleanupExpired(),0);
  fx.advance(86_400_001);
  assert.equal(await service.cleanupExpired(),1);
  assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.family_management_acceptances WHERE id=$1',
    [accepted.acceptanceId])).rows[0].n,0);
});
