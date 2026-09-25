import { test,expect } from 'playwright/test';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from '../../apps/server/tests/integration/postgres-fixture.mjs';
import { createEmailFixture,password } from '../../apps/server/tests/integration/email-fixture.mjs';
import { createRuntimeApp } from '../../apps/server/dist/runtime-app.js';
import { createMailWorker } from '../../apps/server/dist/adapters/mail/outbox.js';
let db,fx,app,address,mailbox,worker;
test.beforeAll(async()=>{
 db=await startPostgresFixture();fx=await createEmailFixture(db);mailbox=[];
 worker=createMailWorker(db.app,fx.cipher,{send:async(id,payload)=>{mailbox.push({id,...payload});return 'accepted';},close(){}},fx.clock);
 app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});address=await app.listen({host:'127.0.0.1',port:0});
});
test.afterAll(async()=>{await app?.close();await db?.stop();});
const headers=()=>({'idempotency-key':randomUUID()});
async function challenge(request,purpose,email) {
 const response=await request.post(`${address}/v1/auth/email/${purpose}/request`,{headers:headers(),data:{email,locale:'en-US'}});
 expect(response.status()).toBe(202);const proof=(await response.json()).data;
 const job=(await db.app.query('SELECT id FROM siyue.outbox_jobs WHERE aggregate_id=$1',[proof.challengeId])).rows[0];
 let mail;
 for(let i=0;i<20 && !mail;i++) {await worker.tick();mail=mailbox.find(item=>item.id===job.id);}
 expect(mail).toBeDefined();
 return {...proof,code:mail.code};
}

test('HTTP registration → mail delivery adapter → login → refresh → password reset rejects previous devices',async({request})=>{
 const email='http-flow@example.test';const proof=await challenge(request,'register',email);
 const data={challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:proof.code,password,platform:'ios',installationId:'phone',termsVersion:'0.0.1',privacyVersion:'0.0.1'};
 const key=headers();const first=await request.post(address+'/v1/auth/email/register/confirm',{headers:key,data});
 expect(first.status()).toBe(201);const tokens=(await first.json()).data;
 const retry=await request.post(address+'/v1/auth/email/register/confirm',{headers:key,data});expect((await retry.json()).data).toEqual(tokens);
 expect((await request.get(address+'/v1/account/session',{headers:{authorization:`Bearer ${tokens.accessToken}`}})).status()).toBe(200);
 const login=await request.post(address+'/v1/auth/email/login',{data:{email,password,installationId:'tablet',platform:'ios'}});expect(login.status()).toBe(200);
 const second=(await login.json()).data;
 const refreshed=await request.post(address+'/v1/auth/refresh',{data:{refreshToken:second.refreshToken,rotationId:randomUUID()}});expect(refreshed.status()).toBe(200);
 fx.advance(60_001);const resetProof=await challenge(request,'password/reset',email);const newPassword='Changed synthetic 🌙 password 24';
 const reset=await request.post(address+'/v1/auth/email/password/reset/confirm',{headers:headers(),data:{challengeId:resetProof.challengeId,requestSecret:resetProof.requestSecret,code:resetProof.code,newPassword}});
 expect(reset.status()).toBe(204);expect(await reset.text()).toBe('');
 expect((await request.get(address+'/v1/account/session',{headers:{authorization:`Bearer ${tokens.accessToken}`}})).status()).toBe(401);
 expect((await request.post(address+'/v1/auth/refresh',{data:{refreshToken:(await refreshed.json()).data.refreshToken,rotationId:randomUUID()}})).status()).toBe(401);
 expect((await request.post(address+'/v1/auth/email/login',{data:{email,password,installationId:'phone',platform:'ios'}})).status()).toBe(401);
 const fresh=await request.post(address+'/v1/auth/email/login',{data:{email,password:newPassword,installationId:'phone',platform:'ios'}});expect(fresh.status()).toBe(200);
 expect((await fresh.json()).data.session.subjectId).toBe(tokens.session.subjectId);
});

test('HTTP schema/permissions reject forged identity, missing idempotency, origin and premature resend; no secret reflection',async({request})=>{
 const endpoint=address+'/v1/auth/email/register/request';const data={email:'strict@example.test',locale:'zh-CN'};
 expect((await request.post(endpoint,{data})).status()).toBe(400);
 expect((await request.post(endpoint,{headers:headers(),data:{...data,role:'owner'}})).status()).toBe(400);
 expect((await request.post(endpoint+'?code=do-not-reflect',{headers:headers(),data})).status()).toBe(400);
 expect((await request.post(endpoint,{headers:{...headers(),origin:'https://evil.invalid'},data})).status()).toBe(403);
 const response=await request.post(endpoint,{headers:headers(),data});expect(response.status()).toBe(202);expect(response.headers()['cache-control']).toBe('no-store');
 const rate=await request.post(endpoint,{headers:headers(),data});expect(rate.status()).toBe(429);expect(rate.headers()['retry-after']).toBe('60');
 expect(await rate.text()).not.toContain(data.email);
 const providers=(await (await request.get(address+'/v1/auth/providers?platform=android')).json()).data;
 expect(providers.emailPassword.enabled).toBe(true);expect(providers.apple.enabled).toBe(false);
});

test('HTTP wrong OTP retry is deterministic and does not create empty account; service errors preserve retryable distinction',async({request})=>{
 const proof=await challenge(request,'register','bad-code@example.test');
 const data={challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:proof.code==='000000'?'000001':'000000',password,platform:'android',installationId:'test',termsVersion:'0.0.1',privacyVersion:'0.0.1'};
 const key=headers();
 for(let n=0;n<2;n++) {
  const reply=await request.post(address+'/v1/auth/email/register/confirm',{headers:key,data});expect(reply.status()).toBe(400);
  const body=await reply.json();expect(body.error.code).toBe('AUTH_CHALLENGE_INVALID');expect(body.error.retryable).toBe(false);expect(JSON.stringify(body)).not.toContain(proof.requestSecret);
 }
 expect((await db.app.query('SELECT attempts FROM siyue.email_challenges WHERE id=$1',[proof.challengeId])).rows[0].attempts).toBe(1);
 await db.admin.query('REVOKE INSERT ON siyue.outbox_jobs FROM siyue_app');
 try {
  const failed=await request.post(address+'/v1/auth/email/register/request',{headers:headers(),data:{email:'storage-failure@example.test',locale:'en-US'}});
  expect(failed.status()).toBe(503);expect((await failed.json()).error.retryable).toBe(true);
  expect((await db.app.query("SELECT * FROM siyue.email_challenges WHERE email_normalized='storage-failure@example.test'")).rowCount).toBe(0);
 } finally {await db.admin.query('GRANT INSERT ON siyue.outbox_jobs TO siyue_app');}
});

test('HTTP change password requires matching reauth and revokes the current device',async({request})=>{
 const {address:email,tokens}=await fx.register('change-http@example.test');
 const authorization=`Bearer ${tokens.accessToken}`;
 const grantReply=await request.post(address+'/v1/auth/reauth/password',{headers:{authorization},data:{password,action:'change-password'}});
 expect(grantReply.status()).toBe(200);const grant=(await grantReply.json()).data;
 const changeHeaders={...headers(),authorization},changeBody={newPassword:password+'changed',reauthGrant:grant.reauthGrant};
 const changed=await request.post(address+'/v1/me/password/change',{headers:changeHeaders,data:changeBody});
 expect(changed.status()).toBe(204);
 const retry=await request.post(address+'/v1/me/password/change',{headers:changeHeaders,data:changeBody});
 expect(retry.status()).toBe(204);expect(await retry.text()).toBe('');
 const conflicting=await request.post(address+'/v1/me/password/change',{headers:changeHeaders,data:{...changeBody,newPassword:password+'other'}});
 expect(conflicting.status()).toBe(409);expect((await conflicting.json()).error.code).toBe('AUTH_IDEMPOTENCY_CONFLICT');
 expect((await db.app.query('SELECT credential_version FROM siyue.subjects WHERE id=$1',[tokens.session.subjectId])).rows[0].credential_version).toBe(2);
 expect((await db.app.query("SELECT count(*) FROM siyue.outbox_jobs WHERE kind='security-notice' AND aggregate_id=$1",[tokens.session.subjectId])).rows[0].count).toBe('1');
 expect((await db.app.query("SELECT count(*) FROM siyue.security_events WHERE event_type='password.change' AND subject_id=$1",[tokens.session.subjectId])).rows[0].count).toBe('1');
 expect((await request.get(address+'/v1/account/session',{headers:{authorization}})).status()).toBe(401);
 expect((await request.post(address+'/v1/auth/email/login',{data:{email,password:password+'changed',installationId:'test',platform:'desktop'}})).status()).toBe(200);
});
