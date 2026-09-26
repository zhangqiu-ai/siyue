import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appleFullNameSchema, appleLoginCompleteRequestSchema, appleLoginStartRequestSchema, appleLoginStartResponseSchema, appleReauthActionSchema, appleReauthGrantSchema } from './auth-apple.js';
const secret = 'A'.repeat(43);
const flowId = '17898741-d6e6-4e64-b76b-927c2169a3e0';
const start = {purpose: 'login', platform: 'ios', installationId: 'test-device'};
const reauth = {purpose: 'reauth', action: 'link-identity', platform: 'ios', installationId: 'test-device'};
const grant = {reauthGrant: flowId + '.' + secret, expiresAt: '2026-09-22T00:00:00.000Z'};
const complete = {flowId, transactionSecret: secret, state: secret, identityToken: 'a'.repeat(120) + '.' + 'b'.repeat(120) + '.' + 'c'.repeat(40), authorizationCode: 'c0de-opaque'};
test('login start and complete accept the documented bounded shape', () => {
 assert.deepEqual(appleLoginStartRequestSchema.parse({...start, deviceLabel: 'iPhone 17'}), {...start, deviceLabel: 'iPhone 17'});
 assert.equal(appleLoginStartResponseSchema.parse({flowId, transactionSecret: secret, nonce: secret, state: secret, expiresAt: '2026-09-22T00:00:00.000Z'}).flowId, flowId);
 assert.equal(appleLoginCompleteRequestSchema.parse({...complete, fullName: {givenName: '思玥', familyName: 'Li', nickname: 'siyue'}}).fullName?.givenName, '思玥');
 assert.equal(appleLoginCompleteRequestSchema.parse(complete).fullName, undefined);
 assert.deepEqual(appleFullNameSchema.parse({namePrefix: 'Dr.', nameSuffix: 'Jr.', middleName: 'Q'}), {namePrefix: 'Dr.', nameSuffix: 'Jr.', middleName: 'Q'});
});
test('unknown keys are rejected instead of ignored, including link and reauth fields', () => {
 for(const extra of [{action: 'link-identity'}, {reauthGrant: secret}, {sessionId: flowId}, {platform: 'ios', email: 'a@example.com'}])
  assert.equal(appleLoginStartRequestSchema.safeParse({...start, ...extra}).success, false);
 for(const extra of [{reauthGrant: secret}, {sessionId: flowId}, {subjectId: flowId}, {action: 'unlink-identity'}, {email: 'a@example.com'}])
  assert.equal(appleLoginStartRequestSchema.safeParse({...reauth, ...extra}).success, false);
 for(const extra of [{user: 'x'}, {audience: 'app.siyue.mobile'}, {clientId: 'app.siyue.mobile'}, {subjectId: flowId}, {email: 'a@example.com'}, {realUserStatus: 'verified'}])
  assert.equal(appleLoginCompleteRequestSchema.safeParse({...complete, ...extra}).success, false);
 assert.equal(appleLoginCompleteRequestSchema.safeParse({...complete, fullName: {givenName: 'Li', unknownPart: 'x'}}).success, false);
 assert.equal(appleLoginStartResponseSchema.safeParse({flowId, transactionSecret: secret, nonce: secret, state: secret, expiresAt: '2026-09-22T00:00:00.000Z', audience: 'app.siyue.mobile'}).success, false);
 assert.equal(appleReauthGrantSchema.safeParse({...grant, action: 'link-identity'}).success, false);
 assert.equal(appleLoginStartRequestSchema.safeParse({purpose: 'login', installationId: 'test-device'}).success, false);
});
test('reauth start requires the bound action and stays otherwise identical to login', () => {
 assert.deepEqual(appleLoginStartRequestSchema.parse({...reauth, deviceLabel: 'iPhone 17'}), {...reauth, deviceLabel: 'iPhone 17'});
 for(const missing of [{purpose: 'reauth', platform: 'ios', installationId: 'test-device'}, {purpose: 'reauth', action: 'link-identity', installationId: 'test-device'}])
  assert.equal(appleLoginStartRequestSchema.safeParse(missing).success, false);
 for(const action of ['unlink-identity', 'change-password', 'link', '']) assert.equal(appleLoginStartRequestSchema.safeParse({...reauth, action}).success, false);
});
test('Apple reauth admits exactly the password-free actions, including account deletion', () => {
 assert.deepEqual(appleReauthActionSchema.options, ['link-identity', 'revoke-session', 'revoke-all-sessions', 'approve-child-device', 'delete-account']);
 // 每个允许的动作都能开始一次 reauth；配对批准也在列表内，因为 Apple-only 家长没有密码可验证。
 for(const action of appleReauthActionSchema.options)
  assert.equal(appleLoginStartRequestSchema.safeParse({...reauth, action}).success, true, action);
 // 需要密码、需要邮箱验证码或根本不属于再次验证的动作仍然被拒绝。
 for(const action of ['unlink-identity', 'change-email', 'change-password', 'approve-child-devices', 'approve-child-device ', 'link', ''])
  assert.equal(appleLoginStartRequestSchema.safeParse({...reauth, action}).success, false, action);
});
test('only the ios platform and the two documented purposes are accepted', () => {
 assert.equal(appleLoginStartRequestSchema.safeParse({...start, platform: 'android'}).success, false);
 assert.equal(appleLoginStartRequestSchema.safeParse({...start, platform: 'desktop'}).success, false);
 assert.equal(appleLoginStartRequestSchema.safeParse({...reauth, platform: 'android'}).success, false);
 for(const purpose of ['link', 'register', '']) assert.equal(appleLoginStartRequestSchema.safeParse({...start, purpose}).success, false);
 for(const purpose of ['login', 'link', 'register', '']) assert.equal(appleLoginStartRequestSchema.safeParse({...reauth, purpose}).success, false);
});
test('oversize values are rejected for every bounded field', () => {
 assert.equal(appleLoginStartRequestSchema.safeParse({...start, installationId: 'x'.repeat(201)}).success, false);
 assert.equal(appleLoginStartRequestSchema.safeParse({...start, deviceLabel: 'x'.repeat(101)}).success, false);
 assert.equal(appleLoginStartRequestSchema.safeParse({...reauth, installationId: 'x'.repeat(201)}).success, false);
 assert.equal(appleLoginStartRequestSchema.safeParse({...reauth, deviceLabel: 'x'.repeat(101)}).success, false);
 assert.equal(appleLoginCompleteRequestSchema.safeParse({...complete, identityToken: 'a'.repeat(16 * 1024) + '.b.c'}).success, false);
 assert.equal(appleLoginCompleteRequestSchema.safeParse({...complete, authorizationCode: 'x'.repeat(2049)}).success, false);
 assert.equal(appleLoginCompleteRequestSchema.safeParse({...complete, state: 'A'.repeat(44)}).success, false);
 assert.equal(appleLoginCompleteRequestSchema.safeParse({...complete, fullName: {givenName: 'x'.repeat(101)}}).success, false);
 assert.equal(appleLoginStartResponseSchema.safeParse({flowId, transactionSecret: 'A'.repeat(44), nonce: secret, state: secret, expiresAt: '2026-09-22T00:00:00.000Z'}).success, false);
});
test('invalid transaction proof, identity token and authorization code are rejected', () => {
 for(const bad of ['A'.repeat(42), 'A'.repeat(44), secret.slice(0, 42) + '+', secret.slice(0, 42) + '=', ''])
  assert.equal(appleLoginCompleteRequestSchema.safeParse({...complete, transactionSecret: bad}).success, false);
 for(const badState of ['', 'A', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(20) + '+', 'A'.repeat(20) + '/'])
  assert.equal(appleLoginCompleteRequestSchema.safeParse({...complete, state: badState}).success, false);
 for(const badToken of ['', 'header.payload', 'a..b', 'a.b.', '.b.c', 'a.b.c d', 'a+b.c.d', 'not-a-jwt'])
  assert.equal(appleLoginCompleteRequestSchema.safeParse({...complete, identityToken: badToken}).success, false);
 for(const badCode of ['', 'x'.repeat(2049)]) assert.equal(appleLoginCompleteRequestSchema.safeParse({...complete, authorizationCode: badCode}).success, false);
 assert.equal(appleLoginStartResponseSchema.safeParse({flowId: 'not-a-uuid', transactionSecret: secret, nonce: secret, state: secret, expiresAt: '2026-09-22T00:00:00.000Z'}).success, false);
 assert.equal(appleLoginStartResponseSchema.safeParse({flowId, transactionSecret: secret, nonce: '', state: secret, expiresAt: '2026-09-22T00:00:00.000Z'}).success, false);
});
test('reauth grants mirror the password reauth response shape and reject malformed proof', () => {
 assert.deepEqual(appleReauthGrantSchema.parse(grant), grant);
 for(const bad of [{reauthGrant: 'not-a-grant', expiresAt: grant.expiresAt}, {reauthGrant: flowId, expiresAt: grant.expiresAt},
  {reauthGrant: secret + '.' + secret, expiresAt: grant.expiresAt}, {reauthGrant: grant.reauthGrant, expiresAt: 'not-a-date'},
  {reauthGrant: grant.reauthGrant, expiresAt: grant.expiresAt, expiresIn: 300}, {}])
  assert.equal(appleReauthGrantSchema.safeParse(bad).success, false);
});
