import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { authClientErrorCodeSchema,authHostRequestSchema,type AuthClientErrorCode } from './auth-client.js';
import { emailLoginMethodId } from './auth-identities.js';

// The account page reads which login methods the current subject still has. It is a read on the
// same generation boundary as the other host commands, so nothing but version, request id and
// generation travels with it: no token, address, URL or file path can be attached to the call.
const loginMethodsRequest=(overrides:Record<string,unknown>={}):Record<string,unknown>=>({
  version:1,requestId:randomUUID(),generation:4,operation:'login-methods',payload:{},...overrides,
});

test('login-methods is a strict empty-payload read on the existing generation boundary', () => {
  const parsed=authHostRequestSchema.safeParse(loginMethodsRequest());
  assert.equal(parsed.success,true);
  if(!parsed.success)return;
  assert.equal(parsed.data.operation,'login-methods');
  assert.deepEqual(parsed.data.payload,{});
  // Smuggling a credential, address, URL, path, subject or idempotency key into the read fails.
  for(const payload of [{token:'synthetic'},{url:'https://evil.invalid'},{path:'/tmp/synthetic'},
    {subjectId:randomUUID()},{key:randomUUID()},{cursor:randomUUID()}]) {
    assert.equal(authHostRequestSchema.safeParse(loginMethodsRequest({payload})).success,false);
  }
  // The envelope itself stays strict and cannot drop the generation boundary.
  assert.equal(authHostRequestSchema.safeParse(loginMethodsRequest({url:'https://evil.invalid'})).success,false);
  assert.equal(authHostRequestSchema.safeParse(loginMethodsRequest({generation:-1})).success,false);
  assert.equal(authHostRequestSchema.safeParse(loginMethodsRequest({generation:'1'})).success,false);
  assert.equal(authHostRequestSchema.safeParse(loginMethodsRequest({requestId:'not-a-uuid'})).success,false);
});

// Linking a first login email to an account that already has one is its own outcome: it is not a
// wrong credential, not another subject's address, and not a transient service failure.
const linkingAlreadyDone:AuthClientErrorCode='email_already_linked';

test('a subject that already has a login email reports a distinct stable code', () => {
  assert.equal(authClientErrorCodeSchema.parse(linkingAlreadyDone), 'email_already_linked');
  assert.equal(authClientErrorCodeSchema.parse('email_exists'), 'email_exists');
  for (const near of ['email_linked', 'already_linked', 'EMAIL_ALREADY_LINKED', 'email_exists_linked']) assert.equal(authClientErrorCodeSchema.safeParse(near).success, false);
});

test('client error codes stay unique and free of server-side names', () => {
  const codes = authClientErrorCodeSchema.options;
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(codes.some((entry) => entry !== entry.toLowerCase()), false);
});

// Unbinding one login method is the write counterpart of `login-methods`: the caller hands back the
// strict handle that read returned together with its own current password. The password
// re-verification, the single-use `unlink-identity` grant and the bearer all stay inside the
// controller, so the call itself carries no grant, no token, no address, no subject and no URL.
const unlinkRequest=(overrides:Record<string,unknown>={}):Record<string,unknown>=>({
  version:1,requestId:randomUUID(),generation:7,operation:'unlink-identity',
  payload:{identityId:emailLoginMethodId('17898741-d6e6-4e64-b76b-927c2169a3e0'),currentPassword:'synthetic current password'},...overrides,
});

test('unlink-identity accepts exactly one email handle and one password on the generation boundary', () => {
  const parsed=authHostRequestSchema.safeParse(unlinkRequest());
  assert.equal(parsed.success,true);
  if(!parsed.success)return;
  assert.equal(parsed.data.operation,'unlink-identity');
  assert.deepEqual(parsed.data.payload,{identityId:emailLoginMethodId('17898741-d6e6-4e64-b76b-927c2169a3e0'),currentPassword:'synthetic current password'});
  // The delivery route is not the caller's to choose: an Apple handle, a bare row id, a differently
  // cased handle, an address, a token, a grant, a path or a subject can never travel with this write.
  for(const payload of [undefined,null,{}, {identityId:unlinkRequest().payload.identityId},
    {currentPassword:'synthetic current password'}, {identityId:`apple:17898741-d6e6-4e64-b76b-927c2169a3e0`,currentPassword:'synthetic current password'},
    {identityId:'17898741-d6e6-4e64-b76b-927c2169a3e0',currentPassword:'synthetic current password'},
    {identityId:emailLoginMethodId('17898741-d6e6-4e64-b76b-927c2169a3e0').toUpperCase(),currentPassword:'synthetic current password'},
    {identityId:'email:not-a-uuid',currentPassword:'synthetic current password'},
    {identityId:unlinkRequest().payload.identityId,currentPassword:'synthetic current password',reauthGrant:`${randomUUID()}.${'A'.repeat(43)}`},
    {identityId:unlinkRequest().payload.identityId,currentPassword:'synthetic current password',accessToken:'synthetic'},
    {identityId:unlinkRequest().payload.identityId,currentPassword:'synthetic current password',subjectId:randomUUID()},
    {identityId:unlinkRequest().payload.identityId,currentPassword:'synthetic current password',url:'https://evil.invalid'},
    {identityId:unlinkRequest().payload.identityId,currentPassword:'synthetic current password',path:'/tmp/synthetic'},
    {identityId:unlinkRequest().payload.identityId,currentPassword:'synthetic current password',key:randomUUID()},
    {identityId:unlinkRequest().payload.identityId,currentPassword:''},
    {identityId:unlinkRequest().payload.identityId,currentPassword:'x'.repeat(14)},
    {identityId:unlinkRequest().payload.identityId,currentPassword:'x'.repeat(129)},
    {identityId:unlinkRequest().payload.identityId,currentPassword:'x'.repeat(257)},
    {identityId:unlinkRequest().payload.identityId,currentPassword:`${'x'.repeat(20)}\ud800`},
    {identityId:unlinkRequest().payload.identityId,currentPassword:12345678}]) {
    assert.equal(authHostRequestSchema.safeParse(unlinkRequest({payload})).success,false,JSON.stringify(payload));
  }
  // The envelope stays strict: no extra field, no dropped generation and no second spelling of the op.
  for(const envelope of [{url:'https://evil.invalid'},{grant:`${randomUUID()}.${'A'.repeat(43)}`},{operation:'unlink-identity-extra'},
    {operation:'unlink'},{generation:-1},{generation:'7'},{requestId:'not-a-uuid'}]) {
    assert.equal(authHostRequestSchema.safeParse(unlinkRequest(envelope)).success,false,JSON.stringify(envelope));
  }
});

// The account page distinguishes "you would lose your last way to sign in" from "that handle is not
// one of your methods": both are stable codes, and neither is a wrong credential or a transport fault.
test('unlink outcomes keep their own stable client codes', () => {
  for (const code of ['last_method_required','identity_not_found','deletion_dependencies','deletion_receipt_unrecoverable',
    'deletion_outcome_unknown','deletion_request_conflict','adult_required'] as const)
    assert.equal(authClientErrorCodeSchema.parse(code), code);
  for (const near of ['last_method','method_required','LAST_METHOD_REQUIRED','identity_missing','not_found']) assert.equal(authClientErrorCodeSchema.safeParse(near).success, false);
});
// Sign-up bound to released documents reports a decided refusal: the screen re-reads the public pair
// and asks for consent again, and a closed deployment answers without a second write.
test('registration policy outcomes keep their own stable client codes', () => {
  for (const code of ['policy_changed','registration_closed'] as const)
    assert.equal(authClientErrorCodeSchema.parse(code), code);
  for (const near of ['policyChange','policy_changed_extra','REGISTRATION_CLOSED','registration_closed_','unavailable_']) {
    assert.equal(authClientErrorCodeSchema.safeParse(near).success, false);
  }
});
// The released registration policy is the same anonymous read on the same generation boundary: the
// host command carries nothing but version, request id and generation, so a version, URL or
// credential can never be supplied by the renderer.
const registrationPolicyRequest=(overrides:Record<string,unknown>={}):Record<string,unknown>=>({
  version:1,requestId:randomUUID(),generation:2,operation:'registration-policy',payload:{},...overrides,
});
test('registration-policy is a strict empty-payload read', () => {
  const parsed=authHostRequestSchema.safeParse(registrationPolicyRequest());
  assert.equal(parsed.success,true);
  if(!parsed.success)return;
  assert.equal(parsed.data.operation,'registration-policy');
  assert.deepEqual(parsed.data.payload,{});
  for (const payload of [{version:'terms-2026-09-25'},{url:'https://siyue.app/terms'},{termsVersion:'synthetic'},
    {privacyVersion:'synthetic'},{accepted:true},{key:randomUUID()},{token:'synthetic'}]) {
    assert.equal(authHostRequestSchema.safeParse(registrationPolicyRequest({payload})).success,false,JSON.stringify(payload));
  }
  assert.equal(authHostRequestSchema.safeParse(registrationPolicyRequest({payload:null})).success,false);
});
