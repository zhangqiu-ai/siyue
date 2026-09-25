import { test,expect } from 'playwright/test';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from '../../apps/server/tests/integration/postgres-fixture.mjs';
import { createEmailFixture,password } from '../../apps/server/tests/integration/email-fixture.mjs';
import { createRuntimeApp } from '../../apps/server/dist/runtime-app.js';
import { createMailWorker } from '../../apps/server/dist/adapters/mail/outbox.js';
import { transaction } from '../../apps/server/dist/adapters/postgres/database.js';

// Real runtime routes over real loopback HTTP and an isolated temporary PostgreSQL cluster. The
// "Apple" subject below is a synthetic row and the mailbox is an injected local adapter; no real
// provider, SMTP host or recipient is contacted and no delivery is claimed.
let db,fx,app,address,mailbox,worker;
const linkPassword='http link binding synthetic phrase 🌙 2026';
test.beforeAll(async()=>{
 db=await startPostgresFixture();fx=await createEmailFixture(db);mailbox=[];
 worker=createMailWorker(db.app,fx.cipher,{send:async(id,payload)=>{mailbox.push({id,...payload});return 'accepted';},close(){}},fx.clock);
 app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});address=await app.listen({host:'127.0.0.1',port:0});
});
test.afterAll(async()=>{await app?.close();await db?.stop();});
// Each test owns its addresses; moving the clock keeps the shared send windows fresh.
test.beforeEach(()=>{fx.advance(3_600_001);mailbox.length=0;});
const count=(sql,...params)=>db.app.query(sql,params.length===1&&Array.isArray(params[0])?params[0]:params).then(result=>Number(result.rows[0].n));
const post=(request,path,data,{bearer,key,headers:extra}={})=>request.post(`${address}${path}`,{
  ...(data===undefined?{}:{data}),
  ...(bearer||key||extra?{headers:{...(bearer?{authorization:`Bearer ${bearer}`}:{}),...(key?{'idempotency-key':key}:{}),...(extra??{})}}:{}),
});
const failure=async response=>({status:response.status(),code:(await response.json()).error?.code});
/** Adult subject with an Apple-issued session and no login email or password yet. */
async function appleOnly() {
  const subjectId=randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'adult','Synthetic HTTP Apple-only')",[subjectId]);
  const tokens=await transaction(db.app,client=>fx.service.issue(client,subjectId,randomUUID(),'apple'));
  return {subjectId,tokens};
}
const issueGrant=(who,action='link-identity')=>transaction(db.app,client=>fx.service.issueReauth(client,who.tokens.session.sessionId,action));
async function deliver(challengeId) {
  const job=(await db.app.query('SELECT id FROM siyue.outbox_jobs WHERE aggregate_id=$1',[challengeId])).rows[0];
  let mail;
  for(let tick=0;tick<20&&!mail;tick++){await worker.tick();mail=mailbox.find(item=>item.id===job.id);}
  expect(mail).toBeDefined();
  return mail;
}

test('HTTP link request and confirm bind a new email and password to the same subject',async({request})=>{
 const subjectsBefore=await count('SELECT count(*)::int AS n FROM siyue.subjects');
 const who=await appleOnly(),email='http-link@example.test',grant=await issueGrant(who);
 const requestKey=randomUUID();
 const started=await post(request,'/v1/me/email/link/request',{email,locale:'en-US',reauthGrant:grant.reauthGrant},{bearer:who.tokens.accessToken,key:requestKey});
 expect(started.status()).toBe(202);expect(started.headers()['cache-control']).toBe('no-store');
 const proof=(await started.json()).data;
 expect(proof).toMatchObject({challengeId:expect.stringMatching(/^[0-9a-f-]{36}$/),requestSecret:expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),resendAfterSeconds:60});
 const stored=await db.app.query('SELECT * FROM siyue.email_challenges WHERE id=$1',[proof.challengeId]);
 expect(stored.rows[0]).toMatchObject({purpose:'link-email',subject_id:who.subjectId,initiating_session_id:who.tokens.session.sessionId,credential_version:1,status:'pending'});
 expect(JSON.stringify(stored.rows[0])).not.toContain(proof.requestSecret);
 const queued=await db.app.query('SELECT status,payload_ciphertext FROM siyue.outbox_jobs WHERE aggregate_id=$1',[proof.challengeId]);
 expect(queued.rows[0].status).toBe('pending');
 expect(queued.rows[0].payload_ciphertext).not.toContain(email);
 const mail=await deliver(proof.challengeId);
 expect(mail).toMatchObject({template:'verification',purpose:'link-email',to:email,locale:'en-US'});
 expect(mail.code).toMatch(/^\d{6}$/);
 const confirmKey=randomUUID();
 const confirmed=await post(request,'/v1/me/email/link/confirm',{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:mail.code,newPassword:linkPassword},{bearer:who.tokens.accessToken,key:confirmKey});
 expect(confirmed.status()).toBe(204);expect(await confirmed.text()).toBe('');
 // Same operation key recovers the same terminal result; another key cannot reuse the challenge.
 expect((await post(request,'/v1/me/email/link/confirm',{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:mail.code,newPassword:linkPassword},{bearer:who.tokens.accessToken,key:confirmKey})).status()).toBe(204);
 expect(await failure(await post(request,'/v1/me/email/link/confirm',{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:mail.code,newPassword:linkPassword},{bearer:who.tokens.accessToken,key:randomUUID()}))).toEqual({status:400,code:'AUTH_CHALLENGE_INVALID'});
 // One subject, one session chain and the new credential signs in on another platform.
 expect(await count('SELECT count(*)::int AS n FROM siyue.subjects')).toBe(subjectsBefore+1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[who.subjectId])).toBe(1);
 const linked=(await db.app.query('SELECT * FROM siyue.account_emails WHERE subject_id=$1',[who.subjectId])).rows[0];
 expect(linked).toMatchObject({email_normalized:email,login_enabled:true,is_primary:true});
 expect((await db.app.query('SELECT password_hash FROM siyue.password_credentials WHERE subject_id=$1',[who.subjectId])).rows[0].password_hash).toMatch(/^\$argon2id\$/);
 const login=await request.post(`${address}/v1/auth/email/login`,{data:{email,password:linkPassword,installationId:'android-http',platform:'android'}});
 expect(login.status()).toBe(200);
 const signedIn=(await login.json()).data;
 expect(signedIn.session.subjectId).toBe(who.subjectId);
 expect((await request.get(`${address}/v1/account/session`,{headers:{authorization:`Bearer ${signedIn.accessToken}`}})).status()).toBe(200);
 // The verification mail was delivered once and its payload is gone; no secret is retained.
 expect(await count("SELECT count(*)::int AS n FROM siyue.email_challenges WHERE id=$1 AND status='consumed'",[proof.challengeId])).toBe(1);
 expect((await db.app.query('SELECT status,payload_ciphertext FROM siyue.outbox_jobs WHERE aggregate_id=$1',[proof.challengeId])).rows[0]).toEqual({status:'sent',payload_ciphertext:null});
 expect(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='email.link-email' AND outcome='success' AND subject_id=$1",[who.subjectId])).toBe(1);
});

test('HTTP link request rejects missing proof, wrong action, foreign grant and revoked session without side effects',async({request})=>{
 const baseline={challenges:await count('SELECT count(*)::int AS n FROM siyue.email_challenges'),jobs:await count('SELECT count(*)::int AS n FROM siyue.outbox_jobs')};
 const who=await appleOnly(),other=await appleOnly(),email='http-link-errors@example.test';
 const body={email,locale:'zh-CN',reauthGrant:(await issueGrant(who)).reauthGrant},key=randomUUID();
 expect((await post(request,'/v1/me/email/link/request',body,{key})).status()).toBe(400);
 expect((await post(request,'/v1/me/email/link/request',body,{bearer:who.tokens.accessToken})).status()).toBe(400);
 expect((await post(request,'/v1/me/email/link/request',{...body,subjectId:who.subjectId},{bearer:who.tokens.accessToken,key})).status()).toBe(400);
 expect((await post(request,'/v1/me/email/link/request',{email,locale:'zh-CN'},{bearer:who.tokens.accessToken,key})).status()).toBe(400);
 expect((await post(request,'/v1/me/email/link/request?code=do-not-reflect',body,{bearer:who.tokens.accessToken,key})).status()).toBe(400);
 expect((await post(request,'/v1/me/email/link/request',body,{bearer:who.tokens.accessToken,key,headers:{origin:'https://evil.invalid'}})).status()).toBe(403);
 const changeGrant=await issueGrant(who,'change-password');
 expect(await failure(await post(request,'/v1/me/email/link/request',{...body,reauthGrant:changeGrant.reauthGrant},{bearer:who.tokens.accessToken,key:randomUUID()}))).toEqual({status:401,code:'AUTH_REAUTH_REQUIRED'});
 expect(await failure(await post(request,'/v1/me/email/link/request',{...body,reauthGrant:(await issueGrant(other)).reauthGrant},{bearer:who.tokens.accessToken,key:randomUUID()}))).toEqual({status:401,code:'AUTH_REAUTH_REQUIRED'});
 const revoked=await appleOnly(),revokedGrant=await issueGrant(revoked);
 await fx.service.logoutAccess(revoked.tokens.accessToken);
 expect(await failure(await post(request,'/v1/me/email/link/request',{email:'http-revoked@example.test',locale:'zh-CN',reauthGrant:revokedGrant.reauthGrant},{bearer:revoked.tokens.accessToken,key:randomUUID()}))).toEqual({status:401,code:'AUTH_SESSION_INVALID'});
 expect((await post(request,'/v1/me/email/link/request',{email:'http-none@example.test',locale:'zh-CN',reauthGrant:'A'.repeat(43)},{bearer:who.tokens.accessToken,key:randomUUID()})).status()).toBe(400);
 // No challenge, mail or consumed grant survives any rejected request.
 expect(await count('SELECT count(*)::int AS n FROM siyue.email_challenges')).toBe(baseline.challenges);
 expect(await count('SELECT count(*)::int AS n FROM siyue.outbox_jobs')).toBe(baseline.jobs);
 expect((await db.app.query('SELECT consumed_at FROM siyue.reauth_grants WHERE id=$1',[changeGrant.reauthGrant.split('.')[0]])).rows[0].consumed_at).toBeNull();
 // A repeat inside the 60 second window is refused, keeps the retry hint and never consumes its grant.
 const latest=await appleOnly(),resent='http-link-resend@example.test';
 const first=await issueGrant(latest),second=await issueGrant(latest);
 expect((await post(request,'/v1/me/email/link/request',{email:resent,locale:'zh-CN',reauthGrant:first.reauthGrant},{bearer:latest.tokens.accessToken,key:randomUUID()})).status()).toBe(202);
 const limited=await post(request,'/v1/me/email/link/request',{email:resent,locale:'zh-CN',reauthGrant:second.reauthGrant},{bearer:latest.tokens.accessToken,key:randomUUID()});
 expect(limited.status()).toBe(429);expect(limited.headers()['retry-after']).toBe('60');
 expect(await limited.text()).not.toContain(resent);
 expect((await db.app.query('SELECT consumed_at FROM siyue.reauth_grants WHERE id=$1',[second.reauthGrant.split('.')[0]])).rows[0].consumed_at).toBeNull();
});

test('HTTP link confirm refuses an address another subject owns and a subject that already has a login method',async({request})=>{
 const subjectsBefore=await count('SELECT count(*)::int AS n FROM siyue.subjects');
 const occupied='http-link-occupied@example.test';
 const registered=await (async()=>{
   const started=await request.post(`${address}/v1/auth/email/register/request`,{headers:{'idempotency-key':randomUUID()},data:{email:occupied,locale:'en-US'}});
   expect(started.status()).toBe(202);
   const proof=(await started.json()).data,code=(await deliver(proof.challengeId)).code;
   const confirmed=await request.post(`${address}/v1/auth/email/register/confirm`,{headers:{'idempotency-key':randomUUID()},data:{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code,password,platform:'ios',installationId:'http-register',termsVersion:'0.0.1',privacyVersion:'0.0.1'}});
   expect(confirmed.status()).toBe(201);return (await confirmed.json()).data;
 })();
 const who=await appleOnly();
 fx.advance(60_001);
 // The request does not disclose that the address is taken; only proof of control reveals it.
 const started=await post(request,'/v1/me/email/link/request',{email:occupied,locale:'en-US',reauthGrant:(await issueGrant(who)).reauthGrant},{bearer:who.tokens.accessToken,key:randomUUID()});
 expect(started.status()).toBe(202);
 const proof=(await started.json()).data,code=(await deliver(proof.challengeId)).code;
 const conflict=await post(request,'/v1/me/email/link/confirm',{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code,newPassword:linkPassword},{bearer:who.tokens.accessToken,key:randomUUID()});
 expect(await failure(conflict)).toEqual({status:409,code:'AUTH_EMAIL_ALREADY_EXISTS'});
 expect(await conflict.text()).not.toContain(occupied);
 // No merge: the original account keeps its credential and the caller gains no login method.
 expect(await count('SELECT count(*)::int AS n FROM siyue.subjects')).toBe(subjectsBefore+2);
 expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE email_normalized=$1',[occupied])).toBe(1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[who.subjectId])).toBe(0);
 expect(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',[who.subjectId])).toBe(0);
 expect((await db.app.query('SELECT subject_id FROM siyue.account_emails WHERE email_normalized=$1',[occupied])).rows[0].subject_id).toBe(registered.session.subjectId);
 expect((await request.post(`${address}/v1/auth/email/login`,{data:{email:occupied,password,installationId:'http-register',platform:'ios'}})).status()).toBe(200);
 // The same caller can still bind a free address, and then a further link is refused by design.
 const free='http-link-free@example.test';
 const freeStarted=await post(request,'/v1/me/email/link/request',{email:free,locale:'en-US',reauthGrant:(await issueGrant(who)).reauthGrant},{bearer:who.tokens.accessToken,key:randomUUID()});
 expect(freeStarted.status()).toBe(202);
 const freeProof=(await freeStarted.json()).data,freeCode=(await deliver(freeProof.challengeId)).code;
 expect((await post(request,'/v1/me/email/link/confirm',{challengeId:freeProof.challengeId,requestSecret:freeProof.requestSecret,code:freeCode,newPassword:linkPassword},{bearer:who.tokens.accessToken,key:randomUUID()})).status()).toBe(204);
 const spare=await issueGrant(who);
 const second=await post(request,'/v1/me/email/link/request',{email:'http-link-later@example.test',locale:'en-US',reauthGrant:spare.reauthGrant},{bearer:who.tokens.accessToken,key:randomUUID()});
 expect(await failure(second)).toEqual({status:409,code:'AUTH_EMAIL_ALREADY_LINKED'});
 expect(await count('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE email_normalized=$1',['http-link-later@example.test'])).toBe(0);
 expect((await db.app.query('SELECT consumed_at FROM siyue.reauth_grants WHERE id=$1',[spare.reauthGrant.split('.')[0]])).rows[0].consumed_at).toBeNull();
});

test('HTTP link retry after refreshing the same session recovers the challenge without a second mail',async({request})=>{
 const who=await appleOnly(),email='http-link-refresh@example.test',key=randomUUID();
 const first=await post(request,'/v1/me/email/link/request',{email,locale:'en-US',reauthGrant:(await issueGrant(who)).reauthGrant},{bearer:who.tokens.accessToken,key});
 expect(first.status()).toBe(202);
 const proof=(await first.json()).data,queued=(await db.app.query('SELECT id FROM siyue.outbox_jobs WHERE aggregate_id=$1',[proof.challengeId])).rows[0].id;
 // The client lost the response and refreshed the same session before repeating the same operation.
 const refreshed=await request.post(`${address}/v1/auth/refresh`,{data:{refreshToken:who.tokens.refreshToken,rotationId:randomUUID()}});
 expect(refreshed.status()).toBe(200);
 const tokens=(await refreshed.json()).data;
 expect(tokens.session.sessionId).toBe(who.tokens.session.sessionId);
 const spare=await issueGrant(who);
 const retry=await post(request,'/v1/me/email/link/request',{email,locale:'en-US',reauthGrant:spare.reauthGrant},{bearer:tokens.accessToken,key});
 expect(retry.status()).toBe(202);
 expect((await retry.json()).data).toEqual(proof);
 // One challenge, one queued mail, no second grant spent, and the recovered proof still completes.
 expect(await count('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE email_normalized=$1',[email])).toBe(1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.outbox_jobs WHERE aggregate_id=$1',[proof.challengeId])).toBe(1);
 expect((await db.app.query('SELECT id FROM siyue.outbox_jobs WHERE aggregate_id=$1',[proof.challengeId])).rows[0].id).toBe(queued);
 expect((await db.app.query('SELECT consumed_at FROM siyue.reauth_grants WHERE id=$1',[spare.reauthGrant.split('.')[0]])).rows[0].consumed_at).toBeNull();
 const confirmed=await post(request,'/v1/me/email/link/confirm',{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:(await deliver(proof.challengeId)).code,newPassword:linkPassword},{bearer:tokens.accessToken,key:randomUUID()});
 expect(confirmed.status()).toBe(204);
 expect((await request.post(`${address}/v1/auth/email/login`,{data:{email,password:linkPassword,installationId:'android-http',platform:'android'}})).status()).toBe(200);
});
