import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountDeletionImpactSchema, accountDeletionRequestSchema, deletionReceiptSchema, deletionStatusRequestSchema, deletionStatusSchema } from './auth-deletion.js';

const deletionId = '2f1a4c0e-8b1d-4f2a-9c3e-5d6b7a8f9012';
const otherFamilyId = '7c9d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const recipientSubjectId = '5b8f3a21-9c7d-4e6f-8a1b-2c3d4e5f6a7b';
const grant = '17898741-d6e6-4e64-b76b-927c2169a3e0.' + 'A'.repeat(43);
const receiptSecret = 'B'.repeat(43);
const requested = {
  reauthGrant: grant,
  confirmation: true,
  dependencyDisposition: { kind: 'none' },
};
const receipt = { deletionId, receiptSecret, expiresAt: '2026-10-24T09:00:00.000Z' };
const status = { serverDataDeleted: true, providerRevocationPending: false, completedAt: null, lastErrorCode: null };

test('deletion impact carries only the caller and bounded dependency facts', () => {
  const impact={subjectId:deletionId,families:[{familyId:deletionId,role:'owner',soleActiveOwner:true,
    otherActiveAdultCount:0,otherActiveChildCount:1}],guardianships:[{familyId:deletionId,
    childSubjectId:deletionId,soleGuardian:true,otherGuardianCount:0,activeChildDeviceCount:1}],activeChildDeviceCount:1};
  assert.deepEqual(accountDeletionImpactSchema.parse(impact),impact);
  for(const extra of [{...impact,email:'parent@example.test'},
    {...impact,families:[{...impact.families[0],otherAdultId:deletionId}]},
    {...impact,guardianships:[{...impact.guardianships[0],activeChildDeviceCount:-1}]},
    {...impact,activeChildDeviceCount:'1'}])
    assert.equal(accountDeletionImpactSchema.safeParse(extra).success,false);
});

test('a deletion request carries one action grant, an explicit confirmation and a disposition', () => {
  assert.deepEqual(accountDeletionRequestSchema.parse(requested), requested);
  const perFamily = { kind: 'per-family', families: [
    { familyId: deletionId, kind: 'transfer', recipientSubjectId },
    { familyId: otherFamilyId, kind: 'end-family-access' }] };
  const soleFamily = { ...requested, dependencyDisposition: { kind: 'per-family',
    families: [{ familyId: deletionId, kind: 'end-family-access' }] } };
  assert.deepEqual(accountDeletionRequestSchema.parse(soleFamily), soleFamily);
  // One request settles every impacted family, and the families may be settled differently: the two
  // choices are per family, so a mixed list is the valid shape for an account that owns one family
  // and only guards a child in another.
  assert.deepEqual(accountDeletionRequestSchema.parse({ ...requested, dependencyDisposition: perFamily }),
    { ...requested, dependencyDisposition: perFamily });
});

test('family dispositions are settled one family at a time and carry only the chosen handling', () => {
  for (const invalid of [
    // `families` is required nonempty: "no dependencies" has its own variant and cannot be sent as
    // an empty list, a missing list or a non-list.
    { kind: 'per-family' },
    { kind: 'per-family', families: [] },
    { kind: 'per-family', families: 'family-a' },
    { kind: 'per-family', families: { [deletionId]: 'transfer' } },
    // Each entry names exactly one family and only the fields its own handling needs.
    { kind: 'per-family', families: [{ kind: 'end-family-access' }] },
    { kind: 'per-family', families: [{ familyId: 'not-a-uuid', kind: 'end-family-access' }] },
    { kind: 'per-family', families: [{ familyId: deletionId, kind: 'end-family-access', recipientSubjectId }] },
    { kind: 'per-family', families: [{ familyId: deletionId, kind: 'transfer' }] },
    { kind: 'per-family', families: [{ familyId: deletionId, kind: 'transfer', recipientSubjectId: 'not-a-uuid' }] },
    { kind: 'per-family', families: [{ familyId: deletionId, kind: 'transfer', recipientSubjectId, eligible: true }] },
    { kind: 'per-family', families: [{ familyId: deletionId, kind: 'end-family-access', revokeChildDevices: true }] },
    { kind: 'per-family', families: [{ familyId: deletionId, kind: 'delete-everything' }] },
    // A family settled twice is ambiguous even when the separate entries would each be valid.
    { kind: 'per-family', families: [{ familyId: deletionId, kind: 'end-family-access' }, { familyId: deletionId, kind: 'end-family-access' }] },
    { kind: 'per-family', families: [{ familyId: deletionId, kind: 'transfer', recipientSubjectId }, { familyId: deletionId, kind: 'end-family-access' }] },
    // The disposition carries the families and nothing else.
    { kind: 'per-family', families: [{ familyId: deletionId, kind: 'end-family-access' }], confirmed: true },
    { kind: 'none', families: [{ familyId: deletionId, kind: 'end-family-access' }] },
    // The replaced whole-request variants name no family at all, so they are no longer part of the
    // contract and cannot be interpreted as "apply this handling everywhere".
    { kind: 'transfer', recipientSubjectId },
    { kind: 'transfer' },
    { kind: 'transfer', recipientSubjectId: 'not-a-uuid' },
    { kind: 'transfer', recipientSubjectId, eligible: true },
    { kind: 'end-family-access' },
    { kind: 'end-family-access', revokeChildDevices: true },
  ])
    assert.equal(accountDeletionRequestSchema.safeParse({ ...requested, dependencyDisposition: invalid }).success, false, JSON.stringify(invalid));
});

test('a deletion request cannot self-report the subject, session or a login identity', () => {
  for (const invalid of [
    { reauthGrant: grant, dependencyDisposition: { kind: 'none' } },
    { ...requested, confirmation: false },
    { ...requested, confirmation: 'true' },
    { ...requested, reauthGrant: 'not-a-grant' },
    { ...requested, reauthGrant: receiptSecret },
    { ...requested, dependencyDisposition: undefined },
    { ...requested, dependencyDisposition: { kind: 'none' } , subjectId: deletionId },
    { ...requested, sessionId: deletionId },
    { ...requested, email: 'parent@example.com' },
    { ...requested, currentPassword: 'x' },
    { ...requested, dependencyDisposition: { kind: 'delete-everything' } },
    { ...requested, dependencyDisposition: null },
    null, [], undefined,
  ])
    assert.equal(accountDeletionRequestSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
});

test('the deletion receipt is a job id, one opaque secret and an expiry, and nothing else', () => {
  assert.deepEqual(deletionReceiptSchema.parse(receipt), receipt);
  for (const invalid of [
    { deletionId, receiptSecret },
    { deletionId: 'not-a-uuid', receiptSecret, expiresAt: receipt.expiresAt },
    { deletionId, receiptSecret: 'short', expiresAt: receipt.expiresAt },
    { deletionId, receiptSecret: 'B'.repeat(44), expiresAt: receipt.expiresAt },
    { deletionId, receiptSecret, expiresAt: '2026-10-24' },
    { ...receipt, subjectId: deletionId },
    { ...receipt, accessToken: grant },
    null, undefined,
  ])
    assert.equal(deletionReceiptSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
});

test('the progress query takes the receipt in the body and nothing else', () => {
  assert.deepEqual(deletionStatusRequestSchema.parse({ deletionId, receiptSecret }), { deletionId, receiptSecret });
  for (const invalid of [
    { deletionId },
    { receiptSecret },
    { deletionId, receiptSecret, url: '/account/deletion/status' },
    { deletionId, receiptSecret, token: grant },
    { deletionId, receiptSecret: 'not a secret', },
    { deletionId: deletionId.replace(/-/g, ''), receiptSecret },
    { deletionId: 'deletion-' + deletionId, receiptSecret },
    null, undefined,
  ])
    assert.equal(deletionStatusRequestSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
});

test('progress reports the two cleanup dimensions separately and leaks no account data', () => {
  assert.deepEqual(deletionStatusSchema.parse(status), status);
  assert.deepEqual(deletionStatusSchema.parse({ ...status, completedAt: receipt.expiresAt, lastErrorCode: 'provider_unavailable' }),
    { ...status, completedAt: receipt.expiresAt, lastErrorCode: 'provider_unavailable' });
  for (const invalid of [
    { providerRevocationPending: false, completedAt: null, lastErrorCode: null },
    { serverDataDeleted: true, completedAt: null, lastErrorCode: null },
    { ...status, completedAt: undefined },
    { ...status, completedAt: '2026-10-24' },
    { ...status, lastErrorCode: 'Provider Unavailable' },
    { ...status, lastErrorCode: null, error: { code: 'provider_unavailable' } },
    { ...status, email: 'parent@example.com' },
    { ...status, displayName: 'Parent' },
    { ...status, subjectId: deletionId },
    { ...status, loginMethods: [] },
    { ...status, accessToken: grant },
    { ...status, refreshToken: grant },
    { ...status, receiptSecret },
    { ...status, state: 'deleted' },
    null, undefined,
  ])
    assert.equal(deletionStatusSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
});
