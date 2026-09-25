import test from 'node:test';
import assert from 'node:assert/strict';
import {
  childCreateRequestSchema, childListResponseSchema, childSummarySchema,
  devicePairingCreateRequestSchema, devicePairingCreateResponseSchema,
  devicePairingStatusRequestSchema, devicePairingStatusResponseSchema,
  devicePairingPreviewRequestSchema, devicePairingPreviewResponseSchema,
  devicePairingApproveRequestSchema,
  devicePairingCompleteRequestSchema, devicePairingCompleteResponseSchema,
  childDeviceSummarySchema, childDeviceListResponseSchema, childDeviceRevokeRequestSchema,
} from './index.js';

const uuid = '123e4567-e89b-42d3-a456-426614174000';
const otherUuid = '987f6543-e21b-42c3-b456-426614174999';
const secret = 'request-token-material'.padEnd(43, 'x');
const pollSecret = 'poll-secret-material'.padEnd(43, 'y');
assert.equal(secret.length, 43);
assert.equal(pollSecret.length, 43);
const refreshToken = `${uuid}.${secret}`;
const childSession = {subjectId: uuid, subjectKind: 'child', sessionId: otherUuid, expiresAt: '2026-09-24T00:00:00Z'};
const sessionTokens = {
  tokenType: 'Bearer', accessToken: 'access-token-value',
  accessExpiresAt: '2026-09-24T00:00:00Z', refreshToken, refreshExpiresAt: '2026-10-24T00:00:00Z',
  sessionAbsoluteExpiresAt: '2026-11-24T00:00:00Z', session: childSession,
};
const childDevice = {
  grantId: uuid, childSubjectId: otherUuid, installationId: 'device-1', platform: 'ios',
  deviceLabel: 'Kid iPad', status: 'active', version: 1,
  expiresAt: '2026-10-24T00:00:00Z', revokedAt: null,
};

// Authority a child device or creating client must never be able to assert about itself.
const hostileFields: Record<string, unknown> = {
  role: 'owner', subjectKind: 'adult', password: 'long-enough-password-value',
  guardianPassword: 'long-enough-password-value', guardianSubjectId: uuid,
  sessionTokens, guardianSessionTokens: sessionTokens, approvedBy: uuid, scopes: ['family.admin'],
};
const rejectsInjection = (schema: {safeParse: (value: unknown) => {success: boolean}}, base: Record<string, unknown>) => {
  for (const [field, value] of Object.entries(hostileFields))
    if (!(field in base)) assert.equal(schema.safeParse({...base, [field]: value}).success, false, `accepted injected ${field}`);
};

test('child creation requires explicit guardian consent and version checks', () => {
  const request = {displayName: '小禾', consentPolicyVersion: 'child-device-2026-09', consentConfirmed: true,
    expectedMembershipVersion: 1, expectedFamilyVersion: 3};
  assert.equal(childCreateRequestSchema.safeParse(request).success, true);
  assert.deepEqual(childCreateRequestSchema.parse({...request, displayName: '  小禾  '}).displayName, '小禾');
  // The policy version must satisfy the durable consent row's ^[a-z0-9._-]{1,40}$ constraint, and a
  // Chinese display name stays valid as written.
  assert.deepEqual(childCreateRequestSchema.parse({...request, consentPolicyVersion: ' child-device-2026-09 '}).consentPolicyVersion, 'child-device-2026-09');
  for (const consentPolicyVersion of ['Child-Device-2026-09', 'child device', 'child/device', 'child.device+1', '中文策略', '', 'a'.repeat(41)])
    assert.equal(childCreateRequestSchema.safeParse({...request, consentPolicyVersion}).success, false, String(consentPolicyVersion));
  assert.equal(childCreateRequestSchema.safeParse({...request, displayName: '小禾 · 玥玥'}).success, true);
  for (const displayName of ['小禾\u0000', '小禾\n家长'])
    assert.equal(childCreateRequestSchema.safeParse({...request, displayName}).success, false);
  for (const consentConfirmed of [false, 'true', 1, null, undefined])
    assert.equal(childCreateRequestSchema.safeParse({...request, consentConfirmed}).success, false);
  for (const field of ['consentPolicyVersion', 'consentConfirmed', 'displayName', 'expectedMembershipVersion', 'expectedFamilyVersion'])
    assert.equal(childCreateRequestSchema.safeParse({...request, [field]: undefined}).success, false, `accepted missing ${field}`);
  for (const version of [0, -1, 1.5, '1'])
    assert.equal(childCreateRequestSchema.safeParse({...request, expectedFamilyVersion: version}).success, false);
  assert.equal(childCreateRequestSchema.safeParse({...request, displayName: '   '}).success, false);
  rejectsInjection(childCreateRequestSchema, request);
});

test('child summary carries family and guardianship scope only', () => {
  const summary = {childSubjectId: uuid, familyId: otherUuid, guardianSubjectId: '987f6543-e21b-42c3-b456-426614174998',
    relationshipVersion: 2, familyVersion: 3, displayName: '小禾'};
  assert.equal(childSummarySchema.safeParse(summary).success, true);
  for (const relationshipVersion of [0, -1, 1.5])
    assert.equal(childSummarySchema.safeParse({...summary, relationshipVersion}).success, false);
  for (const field of ['childSubjectId', 'familyId', 'guardianSubjectId', 'familyVersion', 'displayName'])
    assert.equal(childSummarySchema.safeParse({...summary, [field]: undefined}).success, false, `accepted missing ${field}`);
  rejectsInjection(childSummarySchema, summary);
});

test('the guardian child list is one strict list of the same minimal child views', () => {
  const summary = {childSubjectId: uuid, familyId: otherUuid, guardianSubjectId: '987f6543-e21b-42c3-b456-426614174998',
    relationshipVersion: 2, familyVersion: 3, displayName: '小禾'};
  assert.equal(childListResponseSchema.safeParse({items: []}).success, true);
  assert.equal(childListResponseSchema.safeParse({items: [summary]}).success, true);
  assert.equal(childListResponseSchema.safeParse({items: [summary, {...summary, childSubjectId: otherUuid}]}).success, true);
  // A list is a list: a bare child, a bare array or an extra summary field is not this contract.
  assert.equal(childListResponseSchema.safeParse(summary).success, false);
  assert.equal(childListResponseSchema.safeParse([summary]).success, false);
  assert.equal(childListResponseSchema.safeParse({items: summary}).success, false);
  assert.equal(childListResponseSchema.safeParse({items: [summary], total: 1}).success, false);
  assert.equal(childListResponseSchema.safeParse({items: [{...summary, role: 'owner'}]}).success, false);
  // Every listed child stays a full minimal view: nothing may be dropped, widened or blanked out.
  assert.equal(childListResponseSchema.safeParse({items: [{...summary, relationshipVersion: 0}]}).success, false);
  assert.equal(childListResponseSchema.safeParse({items: [{...summary, displayName: '小禾\n家长'}]}).success, false);
  for (const field of ['childSubjectId', 'familyId', 'guardianSubjectId', 'relationshipVersion', 'familyVersion', 'displayName'])
    assert.equal(childListResponseSchema.safeParse({items: [{...summary, [field]: undefined}]}).success, false, `accepted missing ${field}`);
  rejectsInjection(childListResponseSchema, {items: [summary]});
});

test('anonymous pairing creation accepts only device description', () => {
  const request = {installationId: 'device-1', platform: 'ios', deviceLabel: 'Kid iPad'};
  assert.equal(devicePairingCreateRequestSchema.safeParse(request).success, true);
  assert.equal(devicePairingCreateRequestSchema.safeParse({installationId: 'device-1', platform: 'android'}).success, true);
  for (const platform of ['web', 'windows', 'iOS', ''])
    assert.equal(devicePairingCreateRequestSchema.safeParse({...request, platform}).success, false);
  for (const value of ['', '   ', 'i'.repeat(201)])
    assert.equal(devicePairingCreateRequestSchema.safeParse({...request, installationId: value}).success, false);
  assert.equal(devicePairingCreateRequestSchema.safeParse({...request, deviceLabel: 'x'.repeat(101)}).success, false);
  // A NUL byte would reach PostgreSQL `text` and answer 5xx for an anonymous caller, and CR/LF in a
  // label would let a device name wrap lines in the guardian's preview. Neither is accepted, and both
  // Chinese device names and surrounding whitespace keep working.
  for (const value of ['device\u0000-1', 'device\n-1', 'device\r-1', 'device\t-1', 'device\u000B-1', 'device\u001F-1'])
    assert.equal(devicePairingCreateRequestSchema.safeParse({...request, installationId: value}).success, false, JSON.stringify(value));
  assert.equal(devicePairingCreateRequestSchema.safeParse({...request, installationId: '玥玥的-iPad'}).success, true);
  assert.deepEqual(devicePairingCreateRequestSchema.parse({...request, installationId: '  device-1  '}).installationId, 'device-1');
  for (const value of ['Kid\niPad', 'Kid\riPad', 'Kid\u0000iPad', 'Kid\u001FiPad'])
    assert.equal(devicePairingCreateRequestSchema.safeParse({...request, deviceLabel: value}).success, false, JSON.stringify(value));
  for (const deviceLabel of ['小禾的 iPad', '小禾iPad 🍃'])
    assert.equal(devicePairingCreateRequestSchema.safeParse({...request, deviceLabel}).success, true, deviceLabel);
  assert.equal(devicePairingCreateRequestSchema.safeParse({platform: 'ios'}).success, false);
  rejectsInjection(devicePairingCreateRequestSchema, request);
});

test('pairing creation response returns two bounded secrets and an expiry', () => {
  const response = {pairingId: uuid, requestToken: secret, pollSecret, expiresAt: '2026-09-24T00:05:00Z'};
  assert.equal(devicePairingCreateResponseSchema.safeParse(response).success, true);
  for (const requestToken of ['short', secret.slice(0, 42), `${secret}=`, `${secret}.extra`, `${secret.slice(0, 42)}+`, ''])
    assert.equal(devicePairingCreateResponseSchema.safeParse({...response, requestToken}).success, false, requestToken);
  assert.equal(devicePairingCreateResponseSchema.safeParse({...response, pollSecret: undefined}).success, false);
  assert.equal(devicePairingCreateResponseSchema.safeParse({...response, pairingId: 'device-pairing-1'}).success, false);
  assert.equal(devicePairingCreateResponseSchema.safeParse({...response, expiresAt: 'in five minutes'}).success, false);
  rejectsInjection(devicePairingCreateResponseSchema, response);
});

test('pairing status is polled with one secret and never returns adult data', () => {
  assert.equal(devicePairingStatusRequestSchema.safeParse({pollSecret: secret}).success, true);
  for (const request of [{requestToken: secret}, {pollSecret: secret, requestToken: secret}, {pollSecret: 'short'}, {}])
    assert.equal(devicePairingStatusRequestSchema.safeParse(request).success, false, JSON.stringify(request));

  for (const status of ['pending', 'approved', 'consumed', 'expired'])
    assert.equal(devicePairingStatusResponseSchema.safeParse({status, expiresAt: '2026-09-24T00:05:00Z'}).success, true, status);
  for (const status of ['active', 'revoked', 'denied', 'approved_by_guardian', 'PENDING', ''])
    assert.equal(devicePairingStatusResponseSchema.safeParse({status, expiresAt: '2026-09-24T00:05:00Z'}).success, false, status);
  assert.equal(devicePairingStatusResponseSchema.safeParse({status: 'approved'}).success, false);
  rejectsInjection(devicePairingStatusResponseSchema, {status: 'approved', expiresAt: '2026-09-24T00:05:00Z'});
});

test('adult approval binds the request token, child and reauth grant', () => {
  const request = {requestToken: secret, childSubjectId: uuid, reauthGrant: refreshToken, expectedGuardianVersion: 4};
  assert.equal(devicePairingApproveRequestSchema.safeParse(request).success, true);
  for (const expectedGuardianVersion of [0, -1, 1.5, '4'])
    assert.equal(devicePairingApproveRequestSchema.safeParse({...request, expectedGuardianVersion}).success, false);
  for (const reauthGrant of [uuid, secret, `${uuid.toUpperCase()}.${secret}`, `${uuid}.${secret.slice(0, 42)}`, undefined])
    assert.equal(devicePairingApproveRequestSchema.safeParse({...request, reauthGrant}).success, false, String(reauthGrant));
  for (const field of ['requestToken', 'childSubjectId', 'expectedGuardianVersion'])
    assert.equal(devicePairingApproveRequestSchema.safeParse({...request, [field]: undefined}).success, false, field);
  rejectsInjection(devicePairingApproveRequestSchema, request);
});

test('guardian preview uses a request token and returns only the nominated child and device', () => {
  const request = {requestToken: secret, childSubjectId: uuid};
  const response = {deviceLabel: '小禾的 iPad', platform: 'ios', expiresAt: '2026-09-24T00:05:00Z',
    child: {childSubjectId: uuid, displayName: '小禾'}};
  assert.equal(devicePairingPreviewRequestSchema.safeParse(request).success, true);
  assert.equal(devicePairingPreviewResponseSchema.safeParse(response).success, true);
  assert.equal(devicePairingPreviewRequestSchema.safeParse({...request, pollSecret}).success, false);
  assert.equal(devicePairingPreviewResponseSchema.safeParse({...response, approvedBy: otherUuid}).success, false);
  assert.equal(devicePairingPreviewResponseSchema.safeParse({...response, child: {...response.child, displayName: '小禾\n已批准'}}).success, false);
  rejectsInjection(devicePairingPreviewRequestSchema, request);
  rejectsInjection(devicePairingPreviewResponseSchema, response);
});

test('pairing completion consumes one secret and issues only a child session', () => {
  assert.equal(devicePairingCompleteRequestSchema.safeParse({pollSecret: secret}).success, true);
  for (const request of [{requestToken: secret}, {pollSecret: secret, childSubjectId: uuid}, {pollSecret: secret, expectedGuardianVersion: 1}, {}])
    assert.equal(devicePairingCompleteRequestSchema.safeParse(request).success, false, JSON.stringify(request));

  const result = {sessionTokens, deviceGrantId: uuid};
  assert.equal(devicePairingCompleteResponseSchema.safeParse(result).success, true);
  const adultSession = {...sessionTokens, session: {...childSession, subjectKind: 'adult'}};
  assert.equal(devicePairingCompleteResponseSchema.safeParse({...result, sessionTokens: adultSession}).success, false);
  assert.equal(devicePairingCompleteResponseSchema.safeParse({...result, sessionTokens: {...sessionTokens, refreshToken: secret}}).success, false);
  assert.equal(devicePairingCompleteResponseSchema.safeParse({sessionTokens}).success, false);
  rejectsInjection(devicePairingCompleteResponseSchema, result);
});

test('device summary and revocation require an observed version', () => {
  assert.equal(childDeviceSummarySchema.safeParse(childDevice).success, true);
  for (const status of ['active', 'revoked', 'expired'])
    assert.equal(childDeviceSummarySchema.safeParse({...childDevice, status}).success, true, status);
  for (const status of ['pending', 'approved', 'consumed', 'denied'])
    assert.equal(childDeviceSummarySchema.safeParse({...childDevice, status}).success, false, status);
  for (const version of [0, -1, 1.5, undefined])
    assert.equal(childDeviceSummarySchema.safeParse({...childDevice, version}).success, false, String(version));
  assert.equal(childDeviceSummarySchema.safeParse({...childDevice, revokedAt: '2026-09-24T00:00:00Z'}).success, true);
  assert.equal(childDeviceSummarySchema.safeParse({...childDevice, deviceLabel: undefined}).success, false);
  assert.equal(childDeviceSummarySchema.safeParse({...childDevice, deviceLabel: null}).success, true);
  assert.equal(childDeviceSummarySchema.safeParse({...childDevice, installationId: '玥玥的-iPad', deviceLabel: '小禾的 iPad'}).success, true);
  for (const installationId of ['device\u0000-1', 'device\n-1'])
    assert.equal(childDeviceSummarySchema.safeParse({...childDevice, installationId}).success, false, JSON.stringify(installationId));
  for (const deviceLabel of ['Kid\niPad', 'Kid\u0000iPad'])
    assert.equal(childDeviceSummarySchema.safeParse({...childDevice, deviceLabel}).success, false, JSON.stringify(deviceLabel));
  rejectsInjection(childDeviceSummarySchema, childDevice);

  assert.equal(childDeviceListResponseSchema.safeParse({items: []}).success, true);
  assert.equal(childDeviceListResponseSchema.safeParse({items: [childDevice]}).success, true);
  assert.equal(childDeviceListResponseSchema.safeParse({items: [{...childDevice, version: 0}]}).success, false);
  assert.equal(childDeviceListResponseSchema.safeParse({items: childDevice}).success, false);

  assert.equal(childDeviceRevokeRequestSchema.safeParse({expectedVersion: 1}).success, true);
  for (const request of [{expectedVersion: 0}, {expectedVersion: -1}, {expectedVersion: 1.5}, {}, {expectedVersion: 1, grantId: uuid}, {expectedVersion: 1, childSubjectId: uuid}])
    assert.equal(childDeviceRevokeRequestSchema.safeParse(request).success, false, JSON.stringify(request));
});
