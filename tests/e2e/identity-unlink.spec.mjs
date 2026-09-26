import {test,expect} from 'playwright/test';
import {randomUUID} from 'node:crypto';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture,password as fixturePassword} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
import {transaction} from '../../apps/server/dist/adapters/postgres/database.js';
import {createAppleIdentityStorage} from '../../apps/server/dist/identities/apple/identity-storage.js';

// Real runtime over a temporary PostgreSQL cluster, with the real mail outbox and the synthetic
// Apple repository. No provider, mailbox or production system is contacted.
const namespace='app.siyue.http.unlink';
const password='  http-unlink-pw7  ';
let db,fx,apples,app,mailLess,address,mailLessAddress;
test.beforeAll(async()=>{
 db=await startPostgresFixture();fx=await createEmailFixture(db);apples=createAppleIdentityStorage(fx.cipher,namespace);
 // The mail service is what carries the security notice to the removed address, so it decides
 // whether the unbind endpoint exists at all.
 app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});
 mailLess=createRuntimeApp(db.app,db.identity,{sessions:fx.service});
 address=await app.listen({host:'127.0.0.1',port:0});
 mailLessAddress=await mailLess.listen({host:'127.0.0.1',port:0});
});
test.afterAll(async()=>{await app?.close();await mailLess?.close();await db?.stop();});

/** Apple-only adult created by the real identity repository, then given an Apple session. */
async function appleAccount(){
 const identity=await transaction(db.app,client=>apples.resolve(client,{identity:{provider:'apple',subject:`synthetic-${randomUUID()}`,clientId:'app.siyue.synthetic'},refreshToken:`synthetic-refresh-${randomUUID()}`}));
 const tokens=await transaction(db.app,client=>fx.service.issue(client,identity.subjectId,randomUUID(),'apple'));
 return {...identity,tokens};
}
/** Real authenticated link flow: verified address plus the first password on the same subject. */
async function linkEmail(who,loginAddress=`${randomUUID()}@example.test`){
 const grant=await transaction(db.app,client=>fx.service.issueReauth(client,who.tokens.session.sessionId,'link-identity'));
 const proof=await fx.email.linkRequest(who.tokens.accessToken,{email:loginAddress,locale:'zh-CN',reauthGrant:grant.reauthGrant},randomUUID(),fx.context);
 const job=(await db.app.query('SELECT * FROM siyue.outbox_jobs WHERE aggregate_id=$1',[proof.challengeId])).rows[0];
 const code=fx.cipher.open(job.payload_ciphertext,`mail:${job.id}`).code;
 await fx.email.linkConfirm(who.tokens.accessToken,{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code,newPassword:password},randomUUID(),fx.context);
 return {address:loginAddress,handle:`email:${(await db.app.query('SELECT id FROM siyue.account_emails WHERE subject_id=$1',[who.subjectId])).rows[0].id}`};
}
/** Real password reauth over HTTP: the grant is issued by the same route the apps will call. */
async function reauth(request,token,action,secret=password){
 const response=await request.post(address+'/v1/auth/reauth/password',{headers:{authorization:`Bearer ${token}`},data:{password:secret,action}});
 expect(response.status()).toBe(200);
 return (await response.json()).data.reauthGrant;
}
const unlink=(request,token,identityId,grant)=>request.delete(`${address}/v1/me/identities/${identityId}`,
 {headers:token===undefined?{}:{authorization:`Bearer ${token}`},data:{reauthGrant:grant}});
const count=(sql,...params)=>db.app.query(sql,params).then(result=>Number(result.rows[0].n));

test('the HTTP journey removes only the verified email method and signs the whole subject out',async({request})=>{
 const who=await appleAccount(),email=await linkEmail(who,'http.unlink@example.test');
 const before=await request.get(address+'/v1/me/identities',{headers:{authorization:`Bearer ${who.tokens.accessToken}`}});
 expect((await before.json()).data.items.map(item=>item.kind)).toEqual(['email_password','apple']);

 const grant=await reauth(request,who.tokens.accessToken,'unlink-identity');
 const response=await unlink(request,who.tokens.accessToken,email.handle,grant);
 expect(response.status()).toBe(204);
 expect(response.headers()['cache-control']).toBe('no-store');
 expect(await response.text()).toBe('');

 // The whole subject was signed out, so the access token used for the call is gone too, and a
 // repeat of the same request cannot change anything twice.
 const repeat=await unlink(request,who.tokens.accessToken,email.handle,grant);
 expect(repeat.status()).toBe(401);
 expect((await repeat.json()).error.code).toBe('AUTH_SESSION_INVALID');

 // A session the account can still open lists exactly one method: the Apple one it kept.
 const reopened=await transaction(db.app,client=>fx.service.issue(client,who.subjectId,randomUUID(),'apple'));
 const after=await request.get(address+'/v1/me/identities',{headers:{authorization:`Bearer ${reopened.accessToken}`}});
 expect((await after.json()).data.items).toEqual([{identityId:`apple:${who.identityId}`,kind:'apple',status:'active'}]);
 // The account no longer has a password method, so the fresh proof is issued straight to the
 // reopened session: the route must still refuse it because that handle is gone.
 const replayProof=await transaction(db.app,client=>fx.service.issueReauth(client,reopened.session.sessionId,'unlink-identity'));
 const replay=await unlink(request,reopened.accessToken,email.handle,replayProof.reauthGrant);
 expect(replay.status()).toBe(404);
 expect((await replay.json()).error.code).toBe('AUTH_IDENTITY_NOT_FOUND');

 // Database: the email method is gone, the Apple identity and its credential are untouched, the
 // credential version moved once, and the removed address got its own unlink notice.
 expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',who.subjectId)).toBe(0);
 expect(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',who.subjectId)).toBe(0);
 expect(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE subject_id=$1 AND status=$2',who.subjectId,'active')).toBe(1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.apple_provider_credentials WHERE identity_id=$1',who.identityId)).toBe(1);
 // The calling session and its refresh chain are revoked; the session opened afterwards, and
 // shown above to list only the Apple method, is the only live one.
 expect(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE id=$1 AND revoked_at IS NOT NULL',who.tokens.session.sessionId)).toBe(1);
 expect(await count("SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoke_reason='identity_unlinked'",who.subjectId)).toBe(1);
 expect(await count("SELECT count(*)::int AS n FROM siyue.refresh_tokens t JOIN siyue.auth_sessions s ON s.id=t.session_id WHERE s.subject_id=$1 AND t.revoked_at IS NULL",who.subjectId)).toBe(1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.subjects WHERE id=$1 AND status=$2',who.subjectId,'active')).toBe(1);
 const notice=(await db.app.query("SELECT * FROM siyue.outbox_jobs WHERE kind='security-notice' AND aggregate_id=$1",[who.subjectId])).rows;
 expect(notice.length).toBe(1);
 expect(fx.cipher.open(notice[0].payload_ciphertext,`mail:${notice[0].id}`))
  .toEqual({template:'email-unlinked',to:'http.unlink@example.test',locale:'zh-CN'});

 // No response of this journey carries the proof, the address or a provider detail.
 const bodies=[await before.text(),await after.text().catch(()=>''),JSON.stringify(await repeat.json()),JSON.stringify(await replay.json())].join('\n');
 for(const sensitive of [grant,password,'http.unlink@example.test',who.tokens.accessToken,who.tokens.refreshToken,namespace])
  expect(bodies.includes(sensitive)).toBe(false);
});

test('HTTP refusals keep the last method, foreign handles and wrong proofs safe',async({request})=>{
 // An email-only account cannot lose its only way to sign in.
 const registered=await fx.register('http.unlink.email-only@example.test');
 const subjectId=registered.tokens.session.subjectId;
 const handle=`email:${(await db.app.query('SELECT id FROM siyue.account_emails WHERE subject_id=$1',[subjectId])).rows[0].id}`;
 const grant=await reauth(request,registered.tokens.accessToken,'unlink-identity',fixturePassword);
 const last=await unlink(request,registered.tokens.accessToken,handle,grant);
 expect(last.status()).toBe(409);
 const lastError=(await last.json());
 expect(lastError.error).toEqual({code:'AUTH_LAST_METHOD_REQUIRED',messageKey:'auth.errors.AUTH_LAST_METHOD_REQUIRED',retryable:false});
 expect(typeof lastError.meta.requestId).toBe('string');
 expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',subjectId)).toBe(1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',subjectId)).toBe(1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL',subjectId)).toBe(1);

 const mine=await appleAccount(),mineEmail=await linkEmail(mine,'http.unlink.mine@example.test');
 const other=await appleAccount(),otherEmail=await linkEmail(other,'http.unlink.other@example.test');
 const proof=await reauth(request,mine.tokens.accessToken,'unlink-identity');
 const foreign=await unlink(request,mine.tokens.accessToken,otherEmail.handle,proof);
 expect(foreign.status()).toBe(404);
 expect((await foreign.json()).error.code).toBe('AUTH_IDENTITY_NOT_FOUND');
 // Apple unbind is not implemented, so an Apple handle is refused before any database work.
 const apple=await unlink(request,mine.tokens.accessToken,`apple:${mine.identityId}`,proof);
 expect(apple.status()).toBe(400);
 expect((await apple.json()).error.code).toBe('AUTH_INVALID_REQUEST');
 // A wrong action, a malformed handle and a request without a body are refused as well.
 const wrongAction=await reauth(request,mine.tokens.accessToken,'change-password');
 const wrong=await unlink(request,mine.tokens.accessToken,mineEmail.handle,wrongAction);
 expect(wrong.status()).toBe(401);
 expect((await wrong.json()).error.code).toBe('AUTH_REAUTH_REQUIRED');
 expect((await unlink(request,mine.tokens.accessToken,'email:not-a-uuid',proof)).status()).toBe(400);
 expect((await request.delete(`${address}/v1/me/identities/${mineEmail.handle}`,{headers:{authorization:`Bearer ${mine.tokens.accessToken}`}})).status()).toBe(400);
 expect((await request.delete(`${address}/v1/me/identities/${mineEmail.handle}?force=1`,{headers:{authorization:`Bearer ${mine.tokens.accessToken}`},data:{reauthGrant:proof}})).status()).toBe(400);
 expect((await request.delete(`${address}/v1/me/identities/${mineEmail.handle}`,{data:{reauthGrant:proof}})).status()).toBe(400);
 // Nothing changed for either subject, and the still-unspent proof removes the real method.
 expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',mine.subjectId)).toBe(1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',other.subjectId)).toBe(1);
 expect((await unlink(request,mine.tokens.accessToken,mineEmail.handle,proof)).status()).toBe(204);
 expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',mine.subjectId)).toBe(0);
});

test('concurrent HTTP attempts remove the method once and leave a usable Apple method',async({request})=>{
 const who=await appleAccount(),email=await linkEmail(who,'http.unlink.race@example.test');
 const second=await transaction(db.app,client=>fx.service.issue(client,who.subjectId,randomUUID(),'apple'));
 const [firstProof,secondProof]=await Promise.all([
  reauth(request,who.tokens.accessToken,'unlink-identity'),
  reauth(request,second.accessToken,'unlink-identity'),
 ]);
 const results=await Promise.all([
  unlink(request,who.tokens.accessToken,email.handle,firstProof),
  unlink(request,second.accessToken,email.handle,secondProof),
 ]);
 expect(results.map(entry=>entry.status()).filter(status=>status===204).length).toBe(1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',who.subjectId)).toBe(0);
 expect(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',who.subjectId)).toBe(0);
 expect(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE subject_id=$1 AND status=$2',who.subjectId,'active')).toBe(1);
 expect(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE subject_id=$1 AND event_type='identity.unlink-email' AND outcome='success'",who.subjectId)).toBe(1);
});

test('a runtime without the mail service does not expose the unbind route at all',async({request})=>{
 // Without a mail path the design's unbind transaction could not tell the removed address what
 // happened, so the endpoint stays closed instead of removing the method silently.
 const who=await appleAccount(),email=await linkEmail(who,'http.unlink.gate@example.test');
 const grant=await reauth(request,who.tokens.accessToken,'unlink-identity');
 const response=await request.delete(`${mailLessAddress}/v1/me/identities/${email.handle}`,
  {headers:{authorization:`Bearer ${who.tokens.accessToken}`},data:{reauthGrant:grant}});
 expect(response.status()).toBe(404);
 // The read-only summary of the same runtime is still available; only the unbind route is absent.
 expect((await request.get(mailLessAddress+'/v1/me/identities',{headers:{authorization:`Bearer ${who.tokens.accessToken}`}})).status()).toBe(200);
 expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',who.subjectId)).toBe(1);
 expect(await count("SELECT count(*)::int AS n FROM siyue.outbox_jobs WHERE kind='security-notice' AND aggregate_id=$1",who.subjectId)).toBe(0);
});
