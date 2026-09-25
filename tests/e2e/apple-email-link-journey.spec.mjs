import { test,expect } from 'playwright/test';
import { randomBytes,randomUUID } from 'node:crypto';
import { startPostgresFixture } from '../../apps/server/tests/integration/postgres-fixture.mjs';
import { createEmailFixture } from '../../apps/server/tests/integration/email-fixture.mjs';
import { createRuntimeApp } from '../../apps/server/dist/runtime-app.js';
import { createMailWorker } from '../../apps/server/dist/adapters/mail/outbox.js';
import { createAppleRequestGate } from '../../apps/server/dist/identities/apple/request-gate.js';
import { createAppleFlowStorage } from '../../apps/server/dist/identities/apple/flow-storage.js';
import { createAppleIdentityStorage } from '../../apps/server/dist/identities/apple/identity-storage.js';
import { createAppleLoginPreparation } from '../../apps/server/dist/identities/apple/prepare-login.js';
import { createAppleLoginService } from '../../apps/server/dist/identities/apple/login-service.js';

// Combined journey over real loopback HTTP and an isolated temporary PostgreSQL cluster: an
// Apple-only adult is created by a synthetic login, re-authenticates with the same Apple subject
// to obtain a link-identity grant, then binds a login email and password. The Apple issuer, token
// verification and code exchange are local synthetic adapters and the mailbox is an injected local
// adapter; no real Apple endpoint, SMTP host, recipient or production resource is contacted.
const clientId='app.siyue.mobile',namespace='synthetic-team';
const journeyPassword='apple email link synthetic phrase 🌙 2026';
let db,fx,app,address,mailbox,worker,exchanges,verifiedSubject;

test.beforeAll(async()=>{
 db=await startPostgresFixture();
 fx=await createEmailFixture(db);
 mailbox=[];exchanges=0;
 worker=createMailWorker(db.app,fx.cipher,{send:async(id,payload)=>{mailbox.push({id,...payload});return 'accepted';},close(){}},fx.clock);
 const storage=createAppleFlowStorage(db.app,fx.cipher,clientId,fx.clock);
 const preparation=createAppleLoginPreparation({storage,requestPepper:randomBytes(32),clock:fx.clock,
  verify:async()=>({provider:'apple',subject:verifiedSubject,clientId}),
  exchange:async()=>{exchanges++;return {identity:{provider:'apple',subject:verifiedSubject,clientId},refreshToken:'synthetic-provider-secret'};}});
 const service=createAppleLoginService({preparation,storage,identities:createAppleIdentityStorage(fx.cipher,namespace,fx.clock),sessions:fx.service});
 app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email,apple:{service,gate:createAppleRequestGate(db.app,randomBytes(32),fx.clock)}});
 address=await app.listen({host:'127.0.0.1',port:0});
});
test.afterAll(async()=>{await app?.close();await db?.stop();});

const count=(sql,...params)=>db.app.query(sql,params.length===1&&Array.isArray(params[0])?params[0]:params).then(result=>Number(result.rows[0].n));
const post=(request,path,data,{bearer,key}={})=>request.post(`${address}${path}`,{
 ...(data===undefined?{}:{data}),
 ...(bearer||key?{headers:{...(bearer?{authorization:`Bearer ${bearer}`}:{}),...(key?{'idempotency-key':key}:{})}}:{}),
});
const failure=async response=>({status:response.status(),code:(await response.json()).error?.code});
const completion=flow=>({flowId:flow.flowId,transactionSecret:flow.transactionSecret,state:flow.state,
 identityToken:'synthetic.header.payload',authorizationCode:'synthetic-authorization-code'});
const reauthStart={purpose:'reauth',action:'link-identity',platform:'ios',installationId:'synthetic-apple-email-reauth',deviceLabel:'Synthetic iPhone'};
const startFlow=async(request,data,bearer)=>{const response=await post(request,'/v1/auth/apple/start',data,bearer?{bearer}:{});expect(response.status()).toBe(200);return (await response.json()).data;};
/** Runs the injected local mail worker until the verification job leaves the outbox. */
async function deliver(challengeId){
 const job=(await db.app.query('SELECT id FROM siyue.outbox_jobs WHERE aggregate_id=$1',[challengeId])).rows[0];
 expect(job).toBeDefined();
 let mail;
 for(let tick=0;tick<20&&!mail;tick++){await worker.tick();mail=mailbox.find(item=>item.id===job.id);}
 expect(mail).toBeDefined();
 return mail;
}

test('Apple-only login, Apple reauth grant, email link and cross-platform login keep exactly one subject',async({request})=>{
 const subjectsBefore=await count('SELECT count(*)::int AS n FROM siyue.subjects');
 const identitiesBefore=await count('SELECT count(*)::int AS n FROM siyue.external_identities');
 const appleSubject=`synthetic-apple-email-journey-${randomUUID()}`,email='apple-email-journey@example.test';

 // Synthetic Apple login creates exactly one Apple-only adult subject and one Siyue session.
 verifiedSubject=appleSubject;
 const loginFlow=await startFlow(request,{purpose:'login',platform:'ios',installationId:'synthetic-apple-email',deviceLabel:'Synthetic iPhone'});
 const loginReply=await post(request,'/v1/auth/apple/complete',completion(loginFlow),{key:randomUUID()});
 expect(loginReply.status()).toBe(200);
 const login=(await loginReply.json()).data;
 const subjectId=(await fx.service.verify(login.accessToken)).subjectId;
 expect(login.session.subjectId).toBe(subjectId);
 expect(subjectsBefore+1).toBe(await count('SELECT count(*)::int AS n FROM siyue.subjects'));
 expect((await db.app.query('SELECT kind,status FROM siyue.subjects WHERE id=$1',[subjectId])).rows[0]).toEqual({kind:'adult',status:'active'});
 const identity=(await db.app.query('SELECT * FROM siyue.external_identities WHERE subject_id=$1',[subjectId])).rows;
 expect(identity).toHaveLength(1);
 expect(identity[0]).toMatchObject({provider:'apple',provider_namespace:namespace,provider_subject:appleSubject,status:'active'});
 // Apple-only: the new adult still has no login email or password and only one session.
 expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[subjectId])).toBe(0);
 expect(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',[subjectId])).toBe(0);
 expect(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1',[subjectId])).toBe(1);
 expect(exchanges).toBe(1);

 // The same session re-authenticates with the same verified Apple subject and receives one grant.
 const reauthFlow=await startFlow(request,reauthStart,login.accessToken);
 const grantReply=await post(request,'/v1/auth/apple/complete',completion(reauthFlow),{bearer:login.accessToken,key:randomUUID()});
 expect(grantReply.status()).toBe(200);
 const grant=(await grantReply.json()).data;
 expect(Object.keys(grant).sort()).toEqual(['expiresAt','reauthGrant']);
 expect(grant.reauthGrant).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
 // Reauth only issues the grant: no new identity and no new session for the same subject.
 expect(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE subject_id=$1',[subjectId])).toBe(1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1',[subjectId])).toBe(1);

 // A different verified Apple subject can never obtain the grant, and nothing is auto-merged.
 const subjectsBeforeWrong=await count('SELECT count(*)::int AS n FROM siyue.subjects');
 verifiedSubject=`synthetic-apple-email-other-${randomUUID()}`;
 const wrongFlow=await startFlow(request,reauthStart,login.accessToken);
 const wrongReply=await post(request,'/v1/auth/apple/complete',completion(wrongFlow),{bearer:login.accessToken,key:randomUUID()});
 expect(await failure(wrongReply)).toEqual({status:401,code:'AUTH_APPLE_RESTART_REQUIRED'});
 expect(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE subject_id=$1',[subjectId])).toBe(1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.subjects')).toBe(subjectsBeforeWrong);
 expect(await count('SELECT count(*)::int AS n FROM siyue.external_identities')).toBe(identitiesBefore+1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE provider_subject=$1',[verifiedSubject])).toBe(0);
 verifiedSubject=appleSubject;

 // The link request consumes the one-time grant and queues the verification code locally.
 const started=await post(request,'/v1/me/email/link/request',{email,locale:'en-US',reauthGrant:grant.reauthGrant},{bearer:login.accessToken,key:randomUUID()});
 expect(started.status()).toBe(202);
 const proof=(await started.json()).data;
 expect(proof).toMatchObject({challengeId:expect.stringMatching(/^[0-9a-f-]{36}$/),requestSecret:expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),resendAfterSeconds:60});
 expect((await db.app.query('SELECT purpose,subject_id,initiating_session_id,status FROM siyue.email_challenges WHERE id=$1',[proof.challengeId])).rows[0])
  .toEqual({purpose:'link-email',subject_id:subjectId,initiating_session_id:login.session.sessionId,status:'pending'});
 expect((await db.app.query('SELECT consumed_at FROM siyue.reauth_grants WHERE id=$1',[grant.reauthGrant.split('.')[0]])).rows[0].consumed_at).not.toBeNull();
 const mail=await deliver(proof.challengeId);
 expect(mail).toMatchObject({template:'verification',purpose:'link-email',to:email,locale:'en-US'});
 expect(mail.code).toMatch(/^\d{6}$/);

 // Confirming binds the verified address and first password to the Apple-created subject.
 const confirmed=await post(request,'/v1/me/email/link/confirm',{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:mail.code,newPassword:journeyPassword},{bearer:login.accessToken,key:randomUUID()});
 expect(confirmed.status()).toBe(204);
 expect(await confirmed.text()).toBe('');
 expect((await db.app.query('SELECT * FROM siyue.account_emails WHERE subject_id=$1',[subjectId])).rows[0])
  .toMatchObject({email_normalized:email,login_enabled:true,is_primary:true});
 expect((await db.app.query('SELECT password_hash FROM siyue.password_credentials WHERE subject_id=$1',[subjectId])).rows[0].password_hash).toMatch(/^\$argon2id\$/);

 // The new credential signs in as the same subject from another platform.
 const androidLogin=await request.post(`${address}/v1/auth/email/login`,{data:{email,password:journeyPassword,installationId:'synthetic-android',platform:'android'}});
 expect(androidLogin.status()).toBe(200);
 const signedIn=(await androidLogin.json()).data;
 expect(signedIn.session.subjectId).toBe(subjectId);
 expect((await fx.service.verify(signedIn.accessToken)).subjectId).toBe(subjectId);
 expect((await db.app.query('SELECT platform FROM siyue.auth_sessions WHERE id=$1',[signedIn.session.sessionId])).rows[0].platform).toBe('android');

 // One subject, one Apple identity, one login email and no merge of the rejected subject.
 expect(await count('SELECT count(*)::int AS n FROM siyue.subjects')).toBe(subjectsBefore+1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.external_identities')).toBe(identitiesBefore+1);
 expect(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='email.link-email' AND outcome='success' AND subject_id=$1",[subjectId])).toBe(1);
});
