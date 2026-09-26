import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { familyListSchema, familySummarySchema, familyInvitationCreateRequestSchema, familyInvitationAcceptRequestSchema, familyInvitationCreatedSchema } from './family-api.js';
import { familyManagementAcceptanceRequestSchema, familyManagementAcceptanceReceiptSchema,
  familyManagementAcceptancePreviewSchema } from './family-api.js';

test('family summary contains only identity and membership version, never derived permissions', () => {
  const item = {familyId:randomUUID(),ownerSubjectId:randomUUID(),role:'member',membershipVersion:1,familyVersion:2};
  assert.deepEqual(familySummarySchema.parse(item),item);
  assert.deepEqual(familyListSchema.parse({items:[item]}),{items:[item]});
  for (const extra of [{...item,canEditWhiteboard:true},{...item,guardian:true},{...item,subjectKind:'adult'}])
    assert.equal(familySummarySchema.safeParse(extra).success,false);
  assert.equal(familySummarySchema.safeParse({...item,membershipVersion:0}).success,false);
});

test('invitation contracts carry only bounded token, target and versions',()=>{
  const token='a'.repeat(43);
  assert.equal(familyInvitationCreateRequestSchema.safeParse({expectedMembershipVersion:1,expectedFamilyVersion:1}).success,true);
  assert.equal(familyInvitationCreateRequestSchema.safeParse({intendedEmail:'parent@example.test',expectedMembershipVersion:2,expectedFamilyVersion:3}).success,true);
  assert.equal(familyInvitationAcceptRequestSchema.safeParse({token}).success,true);
  assert.equal(familyInvitationCreatedSchema.safeParse({invitationId:randomUUID(),token,expiresAt:new Date().toISOString()}).success,true);
  for(const invalid of [
    {expectedMembershipVersion:0,expectedFamilyVersion:1},
    {expectedMembershipVersion:1,expectedFamilyVersion:1,role:'admin'},
    {expectedMembershipVersion:1,expectedFamilyVersion:1,intendedEmail:'not-an-email'},
  ])assert.equal(familyInvitationCreateRequestSchema.safeParse(invalid).success,false);
  for(const invalid of [{token:'short'},{token,subjectId:randomUUID()}])assert.equal(familyInvitationAcceptRequestSchema.safeParse(invalid).success,false);
});

test('management acceptance needs both explicit duties and current-state expectations',()=>{
  const acceptance={familyManagement:true,guardianship:true} as const;
  const request={expectedFamilyVersion:2,expectedMembershipVersion:3,expectedOwnerMembershipVersion:1,expectedChildScopeDigest:'b'.repeat(64),acceptance};
  assert.deepEqual(familyManagementAcceptanceRequestSchema.parse(request),request);
  for(const invalid of [
    {...request,acceptance:{familyManagement:true}},
    {...request,acceptance:{familyManagement:true,guardianship:false}},
    {...request,acceptance:{familyManagement:true,guardianship:true,notice:'read'}},
    {...request,acceptance:undefined},
    {...request,expectedFamilyVersion:0},
    {...request,expectedMembershipVersion:1.5},
    {...request,expectedChildScopeDigest:'B'.repeat(64)},
    {...request,expectedChildScopeDigest:'b'.repeat(63)},
  ])assert.equal(familyManagementAcceptanceRequestSchema.safeParse(invalid).success,false);
});

test('management acceptance accepts no self-reported identity and no caller-supplied confirmation echo',()=>{
  const request={expectedFamilyVersion:1,expectedMembershipVersion:1,expectedOwnerMembershipVersion:1,
    expectedChildScopeDigest:'a'.repeat(64),acceptance:{familyManagement:true,guardianship:true}};
  for(const extra of [
    {recipientSubjectId:randomUUID()},{ownerSubjectId:randomUUID()},{familyId:randomUUID()},
    {subjectId:randomUUID()},{sessionId:randomUUID()},{role:'admin'},{guardian:true},{subjectKind:'adult'},
    {recordedAt:new Date().toISOString()},{eligible:true},{childScope:[]},
  ])assert.equal(familyManagementAcceptanceRequestSchema.safeParse({...request,...extra}).success,false);
  const receipt={acceptanceId:randomUUID(),familyId:randomUUID(),recipientSubjectId:randomUUID(),ownerSubjectId:randomUUID(),
    familyVersion:1,membershipVersion:2,ownerMembershipVersion:3,childScopeDigest:'a'.repeat(64),
    acceptedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString(),consumedAt:null};
  assert.deepEqual(familyManagementAcceptanceReceiptSchema.parse(receipt),receipt);
  assert.equal(familyManagementAcceptanceReceiptSchema.safeParse({...receipt,displayName:'Synthetic Parent'}).success,false);
  assert.equal(familyManagementAcceptanceReceiptSchema.safeParse({...receipt,childSubjectIds:[randomUUID()]}).success,false);
  assert.equal(familyManagementAcceptanceReceiptSchema.safeParse({...receipt,membershipVersion:0}).success,false);
});

test('management preview reports scope size without exposing child identities',()=>{
  const preview={familyId:randomUUID(),ownerSubjectId:randomUUID(),recipientSubjectId:randomUUID(),
    familyVersion:2,membershipVersion:1,ownerMembershipVersion:3,
    childScopeDigest:'c'.repeat(64),childCount:2};
  assert.deepEqual(familyManagementAcceptancePreviewSchema.parse(preview),preview);
  assert.equal(familyManagementAcceptancePreviewSchema.safeParse({...preview,childSubjectIds:[randomUUID()]}).success,false);
  assert.equal(familyManagementAcceptancePreviewSchema.safeParse({...preview,childCount:-1}).success,false);
});
