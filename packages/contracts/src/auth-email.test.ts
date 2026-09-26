import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountPasswordSchema, newAccountPasswordSchema, NEW_PASSWORD_MIN, NEW_PASSWORD_MAX, emailChallengeRequestSchema, emailRegisterConfirmSchema, emailLinkRequestSchema, emailLinkConfirmSchema, normalizeLoginEmail, registrationPolicySchema } from './auth-email.js';
const newPassword='Syn-新密码-🌙7';
test('password boundaries count Unicode code points and preserve exact spaces',()=>{
 // Two bounds on purpose: a password being chosen now is 6–20 code points, while a password that
 // only proves an existing credential is 6–128 so an account set under the earlier 15–128 rule
 // keeps signing in. Neither bound is trimmed and there is no character-class rule.
 assert.equal(NEW_PASSWORD_MIN,6);assert.equal(NEW_PASSWORD_MAX,20);
 for(const input of ['😀'.repeat(6),'😀'.repeat(20),'学'.repeat(20),'  multi word  ',newPassword])
  assert.equal(newAccountPasswordSchema.parse(input),input);
 for(const input of ['😀'.repeat(5),'😀'.repeat(21),'学'.repeat(21),'','     ','学'.repeat(10)+'\ud800'])
  assert.equal(newAccountPasswordSchema.safeParse(input).success,false);
 for(const input of ['😀'.repeat(6),'😀'.repeat(15),'学'.repeat(128),'  multi word phrase  ','a legacy 30 character password!'])
  assert.equal(accountPasswordSchema.parse(input),input);
 for(const input of ['😀'.repeat(5),'学'.repeat(129),'a'.repeat(15)+'\ud800'])
  assert.equal(accountPasswordSchema.safeParse(input).success,false);
});
test('email normalization does not merge aliases; identity claims and malformed OTP rejected',()=>{
 assert.equal(normalizeLoginEmail(' Parent.Name+tag@Example.com '),'parent.name+tag@example.com');
 assert.equal(emailChallengeRequestSchema.safeParse({email:'parent@example.com',locale:'en-US',role:'owner'}).success,false);
 const payload={challengeId:'17898741-d6e6-4e64-b76b-927c2169a3e0',requestSecret:'A'.repeat(43),code:'000012',password:newPassword,installationId:'test-device',platform:'ios',termsVersion:'v1',privacyVersion:'v1'};
 assert.equal(emailRegisterConfirmSchema.parse(payload).code,'000012');
 for(const changed of [{code:12},{code:'12'},{email:'other@example.com'},{subjectKind:'adult'}]) assert.equal(emailRegisterConfirmSchema.safeParse({...payload,...changed}).success,false);
});
test('link request binds one reauth grant and link confirm stays strict and password-only',()=>{
 const grant='17898741-d6e6-4e64-b76b-927c2169a3e0.'+'A'.repeat(43);
 const request={email:'parent@example.com',locale:'zh-CN',reauthGrant:grant};
 assert.equal(emailLinkRequestSchema.parse(request).email,'parent@example.com');
 // A missing or malformed grant, an extra self-reported identity field or a register/reset
 // proof field are rejected instead of ignored.
 for(const changed of [{reauthGrant:undefined},{reauthGrant:'A'.repeat(43)},{reauthGrant:`${grant.slice(0,36)}.${'A'.repeat(42)}`},
   {subjectId:'17898741-d6e6-4e64-b76b-927c2169a3e0'},{action:'link-identity'},{password:newPassword},
   {installationId:'test-device'},{platform:'ios'}])
  assert.equal(emailLinkRequestSchema.safeParse({...request,...changed}).success,false);
 assert.equal(emailLinkRequestSchema.safeParse({email:'parent@example.com',reauthGrant:request.reauthGrant}).success,false);
 const confirm={challengeId:'17898741-d6e6-4e64-b76b-927c2169a3e0',requestSecret:'A'.repeat(43),code:'000012',newPassword};
 assert.equal(emailLinkConfirmSchema.parse(confirm).newPassword,confirm.newPassword);
 for(const changed of [{code:'12'},{code:12},{requestSecret:'A'.repeat(42)},{newPassword:'short'},
  {email:'other@example.com'},{reauthGrant:request.reauthGrant},{installationId:'test-device'},{platform:'android'},{displayName:'Synthetic'}])
  assert.equal(emailLinkConfirmSchema.safeParse({...confirm,...changed}).success,false);
});
test('registration policy carries only released https documents and never a half published pair',()=>{
 const terms={version:'terms-2026-09-25',url:'https://siyue.app/terms'};
 const privacy={version:'privacy-2026-09-25',url:'https://siyue.app/privacy?lang=zh-CN'};
 // A deployment without a released pair says so with two absent documents, nothing else.
 assert.equal(registrationPolicySchema.parse({enabled:false,terms:null,privacy:null}).enabled,false);
 const released=registrationPolicySchema.parse({enabled:true,terms,privacy});
 assert.equal(released.terms?.version,terms.version);assert.equal(released.privacy?.url,privacy.url);
 for(const invalid of [
   {enabled:true,terms,privacy:null},{enabled:true,terms:null,privacy},{enabled:true,terms:null,privacy:null},
   {enabled:false,terms,privacy},{enabled:false,terms,privacy:null},{enabled:false,terms:null,privacy},
   {enabled:true,terms:{...terms,url:'http://siyue.app/terms'},privacy},
   {enabled:true,terms:{...terms,url:'https://parent:secret@siyue.app/terms'},privacy},
   {enabled:true,terms:{...terms,url:'https://siyue.app/terms#v2'},privacy},
   {enabled:true,terms:{...terms,url:'data:text/html,synthetic'},privacy},
   {enabled:true,terms,privacy:{...privacy,version:''}},
   {enabled:true,terms,privacy:{...privacy,version:'v'.repeat(81)}},
   {enabled:true,terms,privacy,notice:'synthetic'},{enabled:true,terms,privacy:undefined},
 ]) assert.equal(registrationPolicySchema.safeParse(invalid).success,false,JSON.stringify(invalid));
});
