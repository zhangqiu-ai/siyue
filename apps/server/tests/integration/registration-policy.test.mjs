import { test,before,beforeEach,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createAuthFixture } from './auth-fixture.mjs';
import { createEmailService } from '../../dist/modules/auth/email.js';
import { createPasswordService } from '../../dist/modules/auth/passwords.js';
import { createRuntimeApp } from '../../dist/runtime-app.js';
import { disabledRegistrationPolicy } from '../../dist/registration-policy.js';

const password='  练习账号-🌙-siyue-23-private  ';
const publishedV1={enabled:true,terms:{version:'terms-2026-09-25',url:'https://siyue.app/terms'},
  privacy:{version:'privacy-2026-09-25',url:'https://siyue.app/privacy'}};
const publishedV2={enabled:true,terms:{version:'terms-2026-10-02',url:'https://siyue.app/terms'},
  privacy:{version:'privacy-2026-10-02',url:'https://siyue.app/privacy'}};
const codeIs=code=>error=>error.code===code;
const context=()=>({ip:'192.0.2.10',requestId:randomUUID()});
const address=()=>`${randomUUID()}@example.test`;
let db,auth,passwords,pepper,apps=[];
before(async()=>{
  db=await startPostgresFixture();auth=await createAuthFixture(db);passwords=await createPasswordService();
  // One stable pepper for every instance in this file: the challenge MAC, the idempotency key hash
  // and the recovery context are all keyed by it, so a restart under a new policy still replays the
  // operation the earlier instance accepted. A second pepper would be a different deployment.
  pepper=randomBytes(32);
});
beforeEach(async()=>{
  await db.admin.query('TRUNCATE siyue.subjects,siyue.email_challenges,siyue.idempotency_records,siyue.rate_limit_buckets,siyue.outbox_jobs,siyue.security_events CASCADE');
});
after(async()=>{for(const app of apps)await app.close();apps=[];await db?.stop();});
const service=policy=>createEmailService(db.app,auth.service,passwords,auth.cipher,pepper,auth.clock,
  policy===undefined?{}:{registrationPolicy:policy});
async function requestCode(instance,{to=address(),locale='zh-CN'}={}) {
  const key=randomUUID();
  const response=await instance.request('register',{email:to,locale},key,context());
  const job=(await db.app.query('SELECT * FROM siyue.outbox_jobs WHERE aggregate_id=$1',[response.challengeId])).rows[0];
  const payload=job?auth.cipher.open(job.payload_ciphertext,`mail:${job.id}`):undefined;
  return {...response,code:payload?.code,to,key};
}
const confirm=(proof,policy,overrides={})=>({challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:proof.code,password,
  installationId:randomUUID(),platform:'ios',termsVersion:policy.terms.version,privacyVersion:policy.privacy.version,...overrides});
const challengeRow=async id=>(await db.app.query('SELECT status,subject_id FROM siyue.email_challenges WHERE id=$1',[id])).rows[0];
const outboxRow=async id=>(await db.app.query('SELECT status,payload_ciphertext FROM siyue.outbox_jobs WHERE aggregate_id=$1',[id])).rows[0];
const rows=async table=>Number((await db.app.query(`SELECT count(*)::int AS count FROM siyue.${table}`)).rows[0].count);

test('a closed registration policy refuses the code request and sends no mail',async()=>{
  const closed=service(disabledRegistrationPolicy);
  await assert.rejects(closed.request('register',{email:address(),locale:'zh-CN'},randomUUID(),context()),
    error=>codeIs('AUTH_REGISTRATION_UNAVAILABLE')(error)&&error.status===503);
  assert.equal(await rows('email_challenges'),0);
  assert.equal(await rows('outbox_jobs'),0);
  assert.equal(await rows('idempotency_records'),0);
  // Only sign-up is closed: recovery still answers for any address, and an unknown one still gets no
  // mail, so the public response cannot enumerate accounts.
  const recovery=await closed.request('password-reset',{email:address(),locale:'en-US'},randomUUID(),context());
  assert.match(recovery.challengeId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(await rows('outbox_jobs'),0);
});

test('a stale document version fails without consuming the challenge or cancelling its mail',async()=>{
  const live=service(publishedV1),proof=await requestCode(live);
  for(const changes of [{termsVersion:'terms-2025-01-01'},{privacyVersion:'privacy-2025-01-01'},
    {termsVersion:publishedV2.terms.version},{privacyVersion:publishedV2.privacy.version}]) {
    await assert.rejects(live.register({...confirm(proof,publishedV1),...changes},randomUUID(),context()),
      error=>codeIs('AUTH_POLICY_CHANGED')(error)&&error.status===409);
    const row=await challengeRow(proof.challengeId);
    assert.equal(row.status,'pending');assert.equal(row.subject_id,null);
    const job=await outboxRow(proof.challengeId);
    assert.equal(job.status,'pending');assert.notEqual(job.payload_ciphertext,null);
  }
  assert.equal(await rows('subjects'),0);assert.equal(await rows('auth_sessions'),0);
});

test('the released pair creates the account with its session and consent record',async()=>{
  const live=service(publishedV1),proof=await requestCode(live);
  const tokens=await live.register(confirm(proof,publishedV1),randomUUID(),context());
  assert.deepEqual(await auth.service.verify(tokens.accessToken),tokens.session);
  assert.equal((await challengeRow(proof.challengeId)).status,'consumed');
  const account=(await db.app.query(`SELECT e.subject_id,p.kind,p.status FROM siyue.account_emails e
    JOIN siyue.subjects p ON p.id=e.subject_id WHERE e.email_normalized=$1`,[proof.to])).rows[0];
  assert.equal(account.subject_id,tokens.session.subjectId);assert.equal(account.kind,'adult');assert.equal(account.status,'active');
  assert.deepEqual((await db.app.query('SELECT terms_version,privacy_version FROM siyue.account_consents WHERE subject_id=$1',
    [tokens.session.subjectId])).rows[0],{terms_version:publishedV1.terms.version,privacy_version:publishedV1.privacy.version});
  assert.equal((await db.app.query('SELECT platform FROM siyue.auth_sessions WHERE id=$1',[tokens.session.sessionId])).rows[0].platform,'ios');
});

test('an accepted registration is recovered under its own key after the policy rolls over',async()=>{
  const before=service(publishedV1),proof=await requestCode(before),key=randomUUID(),input=confirm(proof,publishedV1);
  const first=await before.register(input,key,context());
  const rolled=service(publishedV2);
  // The stored outcome is read before the newer policy, so the accepted key and body reconstruct that
  // session instead of a second account or a policy refusal.
  const replayed=await rolled.register(input,key,context());
  assert.deepEqual(replayed,first);assert.equal(await rows('subjects'),1);
  assert.deepEqual(await auth.service.verify(replayed.accessToken),first.session);
  const stale=await requestCode(before);
  await assert.rejects(rolled.register(confirm(stale,publishedV1),randomUUID(),context()),codeIs('AUTH_POLICY_CHANGED'));
  assert.equal((await challengeRow(stale.challengeId)).status,'pending');
  assert.equal((await outboxRow(stale.challengeId)).status,'pending');
  // The rolled pair itself registers, while a closed deployment refuses a fresh request outright.
  const fresh=await rolled.register(confirm(await requestCode(rolled),publishedV2),randomUUID(),context());
  assert.deepEqual(await auth.service.verify(fresh.accessToken),fresh.session);
  await assert.rejects(service(disabledRegistrationPolicy).request('register',{email:address(),locale:'zh-CN'},randomUUID(),context()),
    codeIs('AUTH_REGISTRATION_UNAVAILABLE'));
  // Replay never resurrects a credential that was rotated in the meantime.
  await auth.service.refresh(replayed.refreshToken,randomUUID());
  await assert.rejects(rolled.register(input,key,context()),codeIs('AUTH_OPERATION_COMPLETED_LOGIN_REQUIRED'));
  assert.equal(await rows('subjects'),2);
});

test('the public policy read answers without a credential and is never cached',async()=>{
  const app=createRuntimeApp(db.app,db.identity,{sessions:auth.service,email:service(publishedV1),registrationPolicy:publishedV1});
  apps.push(app);
  const response=await app.inject({method:'GET',url:'/v1/auth/registration-policy'});
  assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');
  const body=response.json();
  assert.deepEqual(body.data,publishedV1);assert.equal(typeof body.meta.requestId,'string');
  for(const [name,options,status] of [
    ['credential',{method:'GET',url:'/v1/auth/registration-policy',headers:{authorization:'Bearer synthetic'}},400],
    ['empty-credential',{method:'GET',url:'/v1/auth/registration-policy',headers:{authorization:''}},400],
    ['query',{method:'GET',url:'/v1/auth/registration-policy?version=stale'},400],
    ['origin',{method:'GET',url:'/v1/auth/registration-policy',headers:{origin:'https://siyue.app'}},403],
  ]) {
    const refused=await app.inject(options);
    assert.equal(refused.statusCode,status,name);assert.equal(refused.headers['cache-control'],'no-store',name);
  }
});

test('a deployment without a released pair or without a mail path reports sign-up closed',async()=>{
  const closed=createRuntimeApp(db.app,db.identity,{sessions:auth.service,email:service(disabledRegistrationPolicy),registrationPolicy:disabledRegistrationPolicy});
  // Without a mail service this deployment cannot deliver a code at all, so the public read stays
  // closed even when a released pair is configured.
  const noMail=createRuntimeApp(db.app,db.identity,{sessions:auth.service,registrationPolicy:publishedV1});
  apps.push(closed,noMail);
  for(const app of [closed,noMail]) {
    const response=await app.inject({method:'GET',url:'/v1/auth/registration-policy'});
    assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');
    assert.deepEqual(response.json().data,{enabled:false,terms:null,privacy:null});
  }
});
