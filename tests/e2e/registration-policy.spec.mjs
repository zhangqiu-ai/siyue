import { test,expect } from 'playwright/test';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from '../../apps/server/tests/integration/postgres-fixture.mjs';
import { createEmailFixture,password } from '../../apps/server/tests/integration/email-fixture.mjs';
import { createRuntimeApp } from '../../apps/server/dist/runtime-app.js';
import { createMailWorker } from '../../apps/server/dist/adapters/mail/outbox.js';
import { disabledRegistrationPolicy } from '../../apps/server/dist/registration-policy.js';
// Two real HTTP runtimes over one database: the closed policy and a published test policy. The published
// versions are the only consent values a confirm may echo, and nothing here relaxes the gate itself.
const published=Object.freeze({enabled:true,
 terms:Object.freeze({version:'2026-09-25-terms-test',url:'https://example.test/siyue/terms'}),
 privacy:Object.freeze({version:'2026-09-25-privacy-test',url:'https://example.test/siyue/privacy'})});
const unpublished='2026-01-01-unpublished';
let db,closedFixture,publishedFixture,closedAddress,publishedAddress,closedApp,publishedApp,mailbox,worker;
test.beforeAll(async()=>{
 db=await startPostgresFixture();
 closedFixture=await createEmailFixture(db,{registrationPolicy:disabledRegistrationPolicy});
 publishedFixture=await createEmailFixture(db,{registrationPolicy:published});
 mailbox=[];
 worker=createMailWorker(db.app,publishedFixture.cipher,{send:async(id,payload)=>{mailbox.push({id,...payload});return 'accepted';},close(){}},publishedFixture.clock);
 closedApp=createRuntimeApp(db.app,db.identity,{sessions:closedFixture.service,email:closedFixture.email,registrationPolicy:disabledRegistrationPolicy});
 publishedApp=createRuntimeApp(db.app,db.identity,{sessions:publishedFixture.service,email:publishedFixture.email,registrationPolicy:published});
 closedAddress=await closedApp.listen({host:'127.0.0.1',port:0});
 publishedAddress=await publishedApp.listen({host:'127.0.0.1',port:0});
});
test.afterAll(async()=>{await closedApp?.close();await publishedApp?.close();await db?.stop();});
const headers=()=>({'idempotency-key':randomUUID()});
const requestBody=(email)=>({email,locale:'en-US'});
async function readPolicy(request,base) {
 const response=await request.get(`${base}/v1/auth/registration-policy`);
 expect(response.status()).toBe(200);
 const body=await response.json();
 return {response,data:body.data,meta:body.meta};
}
async function challenge(request,base,email) {
 const response=await request.post(`${base}/v1/auth/email/register/request`,{headers:headers(),data:requestBody(email)});
 expect(response.status()).toBe(202);
 const proof=(await response.json()).data;
 const job=(await db.app.query('SELECT id FROM siyue.outbox_jobs WHERE aggregate_id=$1',[proof.challengeId])).rows[0];
 let mail;
 for(let index=0;index<20&&!mail;index++) {await worker.tick();mail=mailbox.find(item=>item.id===job.id);}
 expect(mail).toBeDefined();
 return {...proof,code:mail.code};
}

test('the public registration policy is served over real HTTP with no-store in both states',async({request})=>{
 const closed=await readPolicy(request,closedAddress);
 expect(closed.response.headers()['cache-control']).toBe('no-store');
 expect(closed.data).toEqual(disabledRegistrationPolicy);
 expect(closed.meta.requestId).toBeTruthy();
 const open=await readPolicy(request,publishedAddress);
 expect(open.response.headers()['cache-control']).toBe('no-store');
 expect(open.data).toEqual(published);
 expect(Object.keys(open.data).sort()).toEqual(['enabled','privacy','terms']);
 expect(open.data.terms.url.startsWith('https://')).toBe(true);
});

// Closing the gate must refuse to issue a registration code at all: no challenge row, no queued mail,
// and a repeated attempt cannot talk the server into one. Password reset stays available because the
// gate governs sign-up, not the whole mail path.
test('a closed policy refuses to issue a registration code and queues no mail',async({request})=>{
 const address='policy-closed@example.test';const idempotencyKey=headers();
 const refused=await request.post(`${closedAddress}/v1/auth/email/register/request`,{headers:idempotencyKey,data:requestBody(address)});
 expect(refused.status()).toBe(503);
 const failure=(await refused.json()).error;
 expect(failure.code).toBe('AUTH_REGISTRATION_UNAVAILABLE');
 expect(failure.retryable).toBe(true);
 const replay=await request.post(`${closedAddress}/v1/auth/email/register/request`,{headers:idempotencyKey,data:requestBody(address)});
 expect(replay.status()).toBe(503);
 expect((await replay.json()).error.code).toBe('AUTH_REGISTRATION_UNAVAILABLE');
 expect((await db.app.query('SELECT count(*)::int AS count FROM siyue.email_challenges WHERE email_normalized=$1',[address])).rows[0].count).toBe(0);
 expect((await db.app.query(`SELECT count(*)::int AS count FROM siyue.outbox_jobs o
  JOIN siyue.email_challenges c ON c.id=o.aggregate_id WHERE c.email_normalized=$1`,[address])).rows[0].count).toBe(0);
 const resetAddress='policy-closed-reset@example.test';
 const reset=await request.post(`${closedAddress}/v1/auth/email/password/reset/request`,{headers:headers(),data:requestBody(resetAddress)});
 expect(reset.status()).toBe(202);
 expect((await db.app.query('SELECT count(*)::int AS count FROM siyue.outbox_jobs WHERE aggregate_id IN (SELECT id FROM siyue.email_challenges WHERE email_normalized=$1)',[resetAddress])).rows[0].count).toBe(0);
});

// The published versions are the contract: a stale pair is refused without creating an account or
// consuming the code, the refusal is stable for the same idempotency key, and the served versions work.
test('a published policy refuses a stale consent version and accepts the served one',async({request})=>{
 const {data:policy}=await readPolicy(request,publishedAddress);
 const address='policy-version@example.test';
 const proof=await challenge(request,publishedAddress,address);
 const confirm=(versions,key)=>request.post(`${publishedAddress}/v1/auth/email/register/confirm`,{headers:key,
  data:{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:proof.code,password,
   installationId:'policy-test',platform:'android',termsVersion:versions.termsVersion,privacyVersion:versions.privacyVersion}});
 for(const [label,versions] of [
  ['stale terms',{termsVersion:unpublished,privacyVersion:policy.privacy.version}],
  ['stale privacy',{termsVersion:policy.terms.version,privacyVersion:unpublished}],
 ]) {
  const key=headers();const refused=await confirm(versions,key);
  expect(refused.status(),label).toBe(409);
  const failure=(await refused.json()).error;
  expect(failure.code,label).toBe('AUTH_POLICY_CHANGED');
  expect(failure.retryable,label).toBe(false);
  expect((await confirm(versions,key)).status(),`${label} replay`).toBe(409);
  expect((await db.app.query('SELECT count(*)::int AS count FROM siyue.account_emails WHERE email_normalized=$1',[address])).rows[0].count,label).toBe(0);
  expect((await db.app.query('SELECT status FROM siyue.email_challenges WHERE id=$1',[proof.challengeId])).rows[0].status,label).toBe('pending');
 }
 const accepted=await confirm({termsVersion:policy.terms.version,privacyVersion:policy.privacy.version},headers());
 expect(accepted.status()).toBe(201);
 const tokens=(await accepted.json()).data;
 expect(typeof tokens.accessToken).toBe('string');
 const consent=(await db.app.query('SELECT terms_version,privacy_version FROM siyue.account_consents WHERE subject_id=$1',[tokens.session.subjectId])).rows[0];
 expect(consent).toEqual({terms_version:policy.terms.version,privacy_version:policy.privacy.version});
 expect((await db.app.query('SELECT status FROM siyue.email_challenges WHERE id=$1',[proof.challengeId])).rows[0].status).toBe('consumed');
});
