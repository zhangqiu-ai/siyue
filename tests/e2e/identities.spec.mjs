import {test,expect} from 'playwright/test';
import {randomUUID} from 'node:crypto';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
import {transaction} from '../../apps/server/dist/adapters/postgres/database.js';
import {createAppleIdentityStorage} from '../../apps/server/dist/identities/apple/identity-storage.js';

// Real runtime over a temporary PostgreSQL cluster. The Apple identity comes from the real
// repository with a synthetic exchange result, and every address is a reserved example.test
// value; no provider and no mailbox is contacted.
const namespace='app.siyue.http.synthetic';
let db,fx,app,address,apples;
test.beforeAll(async()=>{
 db=await startPostgresFixture();fx=await createEmailFixture(db);apples=createAppleIdentityStorage(fx.cipher,namespace);
 app=createRuntimeApp(db.app,db.identity,{sessions:fx.service});address=await app.listen({host:'127.0.0.1',port:0});
});
test.afterAll(async()=>{await app?.close();await db?.stop();});

/** Apple-only adult created by the real identity repository, with the provider values kept for
 *  leak assertions. */
async function appleOnly(){
 const providerSubject=`synthetic-${randomUUID()}`,clientId=`synthetic-client-${randomUUID()}`,refreshToken=`synthetic-refresh-${randomUUID()}`;
 const identity=await transaction(db.app,client=>apples.resolve(client,{identity:{provider:'apple',subject:providerSubject,clientId},refreshToken}));
 const tokens=await transaction(db.app,client=>fx.service.issue(client,identity.subjectId,randomUUID(),'apple'));
 return {...identity,tokens,providerSubject,clientId,refreshToken};
}
/** Real authenticated link flow: verified address plus the first password on the same subject. */
async function linkEmail(who,loginAddress){
 const grant=await transaction(db.app,client=>fx.service.issueReauth(client,who.tokens.session.sessionId,'link-identity'));
 const proof=await fx.email.linkRequest(who.tokens.accessToken,{email:loginAddress,locale:'zh-CN',reauthGrant:grant.reauthGrant},randomUUID(),fx.context);
 const job=(await db.app.query('SELECT * FROM siyue.outbox_jobs WHERE aggregate_id=$1',[proof.challengeId])).rows[0];
 const code=fx.cipher.open(job.payload_ciphertext,`mail:${job.id}`).code;
 await fx.email.linkConfirm(who.tokens.accessToken,{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code,newPassword:'  synthetic-pass7  '},randomUUID(),fx.context);
}
async function summary(request,token){
 const response=await request.fetch(address+'/v1/me/identities',{headers:token===undefined?{}:{authorization:`Bearer ${token}`}});
 return {status:response.status(),cacheControl:response.headers()['cache-control'],body:await response.text()};
}
const row=async(sql,...params)=>(await db.app.query(sql,params.length===1&&Array.isArray(params[0])?params[0]:params)).rows[0];

test('Apple-only, email-only and both-method accounts each receive only their own minimal summary',async({request})=>{
 const apple=await appleOnly(),email=await fx.register('http.masked@example.test'),both=await appleOnly();
 await linkEmail(both,'http.both@example.test');
 const emailRow=await row('SELECT id FROM siyue.account_emails WHERE subject_id=$1',[email.tokens.session.subjectId]);
 const bothEmailRow=await row('SELECT id FROM siyue.account_emails WHERE subject_id=$1',[both.subjectId]);

 const appleResponse=await summary(request,apple.tokens.accessToken);
 expect(appleResponse.status).toBe(200);expect(appleResponse.cacheControl).toBe('no-store');
 const appleData=JSON.parse(appleResponse.body);
 expect(Object.keys(appleData)).toEqual(['data','meta']);
 expect(appleData.data.items).toEqual([{identityId:`apple:${apple.identityId}`,kind:'apple',status:'active'}]);
 expect(Object.keys(appleData.data)).toEqual(['items']);

 const emailResponse=await summary(request,email.tokens.accessToken);
 const emailData=JSON.parse(emailResponse.body).data;
 expect(emailData.items).toEqual([{identityId:`email:${emailRow.id}`,kind:'email_password',status:'active',emailMask:'h•••@example.test'}]);

 const bothResponse=await summary(request,both.tokens.accessToken);
 const bothData=JSON.parse(bothResponse.body).data;
 expect(bothData.items).toEqual([
  {identityId:`email:${bothEmailRow.id}`,kind:'email_password',status:'active',emailMask:'h•••@example.test'},
  {identityId:`apple:${both.identityId}`,kind:'apple',status:'active'},
 ]);

 // Strict shape: no document, method or provider field beyond the design's minimal summary.
 for(const item of bothData.items)
  expect(Object.keys(item).sort()).toEqual(item.kind==='apple'?['identityId','kind','status']:['emailMask','identityId','kind','status']);

 // The response text must not carry a credential, a full address, an external subject, the
 // provider namespace or the provider client id.
 const bodies=[appleResponse.body,emailResponse.body,bothResponse.body].join('\n');
 for(const sensitive of [apple.providerSubject,apple.clientId,apple.refreshToken,apple.tokens.accessToken,apple.tokens.refreshToken,
   both.providerSubject,both.clientId,both.refreshToken,both.tokens.accessToken,both.tokens.refreshToken,
   namespace,'namespace','http.masked@example.test','http.both@example.test',apple.subjectId,both.subjectId])
  expect(bodies.includes(sensitive)).toBe(false);
 expect(bodies).not.toMatch(/accessToken|refreshToken|reauthGrant|providerSubject|provider_subject/);
});

test('cross-subject, revoked, disabled, invalid and blocked requests never list or leak a method',async({request})=>{
 const mine=await appleOnly(),other=await appleOnly();
 await linkEmail(mine,'http.revoke@example.test');
 const mineEmailRow=await row('SELECT id FROM siyue.account_emails WHERE subject_id=$1',[mine.subjectId]);
 const emailItem={identityId:`email:${mineEmailRow.id}`,kind:'email_password',status:'active',emailMask:'h•••@example.test'};
 const ownItems=JSON.parse((await summary(request,mine.tokens.accessToken)).body).data.items;
 expect(ownItems).toEqual([emailItem,{identityId:`apple:${mine.identityId}`,kind:'apple',status:'active'}]);
 // Another subject's handle is never part of this account's summary, in either direction.
 const foreign=JSON.parse((await summary(request,other.tokens.accessToken)).body).data.items;
 expect(foreign).toEqual([{identityId:`apple:${other.identityId}`,kind:'apple',status:'active'}]);
 expect(ownItems.some(item=>item.identityId===`apple:${other.identityId}`)).toBe(false);
 expect(foreign.some(item=>item.identityId===emailItem.identityId)).toBe(false);

 // A revoked external identity and an address that is no longer login-enabled are not methods.
 await db.app.query("UPDATE siyue.external_identities SET status='revoked' WHERE id=$1",[mine.identityId]);
 expect(JSON.parse((await summary(request,mine.tokens.accessToken)).body).data.items).toEqual([emailItem]);
 await db.app.query('UPDATE siyue.account_emails SET login_enabled=false WHERE subject_id=$1',[mine.subjectId]);
 expect(JSON.parse((await summary(request,mine.tokens.accessToken)).body).data.items).toEqual([]);

 // A subject without any usable method gets an empty list, not an error or a foreign method.
 const bare=randomUUID();await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')",[bare]);
 const bareTokens=await transaction(db.app,client=>fx.service.issue(client,bare,randomUUID(),'email'));
 expect(JSON.parse((await summary(request,bareTokens.accessToken)).body).data.items).toEqual([]);

 // Blocked/deleted subjects are rejected before any read, and the decision is not cached.
 for(const status of ['blocked','deletion_pending','deleted']){
  await db.app.query('UPDATE siyue.subjects SET status=$2 WHERE id=$1',[mine.subjectId,status]);
  const denied=await request.fetch(address+'/v1/me/identities',{headers:{authorization:`Bearer ${mine.tokens.accessToken}`}});
  expect(denied.status()).toBe(401);expect((await denied.json()).error.code).toBe('AUTH_SESSION_INVALID');
 }
 await db.app.query("UPDATE siyue.subjects SET status='active' WHERE id=$1",[mine.subjectId]);
 await db.app.query('UPDATE siyue.account_emails SET login_enabled=true WHERE subject_id=$1',[mine.subjectId]);
 expect(JSON.parse((await summary(request,mine.tokens.accessToken)).body).data.items).toEqual([emailItem]);

 // No credential source other than one bearer header; unknown or malformed access is a failure.
 expect((await request.fetch(address+'/v1/me/identities')).status()).toBe(400);
 expect((await request.fetch(`${address}/v1/me/identities?subjectId=${other.subjectId}`,{headers:{authorization:`Bearer ${mine.tokens.accessToken}`}})).status()).toBe(400);
 expect((await request.fetch(address+'/v1/me/identities',{headers:{authorization:'Bearer not a token'}})).status()).toBe(400);
 expect((await request.fetch(address+'/v1/me/identities',{headers:{authorization:`Bearer ${mine.tokens.accessToken}`}})).status()).toBe(200);
 expect((await request.fetch(address+'/v1/me/identities',{headers:{authorization:`Bearer ${randomUUID()}.${'A'.repeat(43)}`}})).status()).toBe(401);
 expect((await request.post(address+'/v1/me/identities')).status()).toBe(404);
});
