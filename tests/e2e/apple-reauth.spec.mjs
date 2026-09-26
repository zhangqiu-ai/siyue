import {test,expect} from 'playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createAuthFixture} from '../../apps/server/tests/integration/auth-fixture.mjs';
import {transaction} from '../../apps/server/dist/adapters/postgres/database.js';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
import {createAppleRequestGate} from '../../apps/server/dist/identities/apple/request-gate.js';
import {createAppleFlowStorage} from '../../apps/server/dist/identities/apple/flow-storage.js';
import {createAppleIdentityStorage} from '../../apps/server/dist/identities/apple/identity-storage.js';
import {createAppleLoginPreparation} from '../../apps/server/dist/identities/apple/prepare-login.js';
import {createAppleLoginService} from '../../apps/server/dist/identities/apple/login-service.js';

// Real runtime routes over real HTTP with an isolated temporary database. The Apple issuer,
// key set and code exchange are synthetic adapters; no real Apple endpoint is contacted.
let db,app,auth,base,exchanges;
let verifiedSubject='';
const clientId='app.siyue.mobile',namespace='synthetic-team';
test.beforeAll(async()=>{
 db=await startPostgresFixture();
 auth=await createAuthFixture(db);
 exchanges=0;
 const storage=createAppleFlowStorage(db.app,auth.cipher,clientId,auth.clock);
 const preparation=createAppleLoginPreparation({storage,clock:auth.clock,requestPepper:randomBytes(32),
  verify:async()=>({provider:'apple',subject:verifiedSubject,clientId}),
  exchange:async()=>{exchanges++;return {identity:{provider:'apple',subject:verifiedSubject,clientId},refreshToken:'synthetic-provider-secret'};}});
 const service=createAppleLoginService({preparation,storage,identities:createAppleIdentityStorage(auth.cipher,namespace,auth.clock),sessions:auth.service});
 app=createRuntimeApp(db.app,db.identity,{sessions:auth.service,apple:{service,gate:createAppleRequestGate(db.app,randomBytes(32),auth.clock)}});
 base=await app.listen({port:0,host:'127.0.0.1'});
});
test.afterAll(async()=>{await app?.close();await db?.stop();});
// Each test owns its flows; rolling the minute boundary keeps the shared start budget fresh.
test.beforeEach(()=>{auth.advance(60_000);});

const count=(sql,...params)=>db.app.query(sql,params).then(result=>result.rows[0].n);
async function linkedAccount(appleSubject=randomUUID()){
 const subjectId=randomUUID();
 await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'adult','Synthetic HTTP')",[subjectId]);
 const tokens=await transaction(db.app,client=>auth.service.issue(client,subjectId,randomUUID(),'email'));
 await db.app.query(`INSERT INTO siyue.external_identities(id,subject_id,provider,provider_namespace,provider_subject,client_id,issuer)
  VALUES($1,$2,'apple',$3,$4,$5,'https://appleid.apple.com')`,[randomUUID(),subjectId,namespace,appleSubject,clientId]);
 return {subjectId,appleSubject,tokens,bearer:tokens.accessToken};
}
const reauthStart={purpose:'reauth',action:'link-identity',platform:'ios',installationId:'synthetic-http-reauth',deviceLabel:'Synthetic iPhone'};
const loginStart={purpose:'login',platform:'ios',installationId:'synthetic-http-login',deviceLabel:'Synthetic iPhone'};
const post=(request,path,data,{bearer,key}={})=>request.post(`${base}${path}`,{
 ...(data===undefined?{}:{data}),...(bearer||key?{headers:{...(bearer?{authorization:`Bearer ${bearer}`}:{}),...(key?{'idempotency-key':key}:{})}}:{})});
const start=(request,data,bearer)=>post(request,'/v1/auth/apple/start',data,{bearer});
const complete=(request,data,{bearer,key}={})=>post(request,'/v1/auth/apple/complete',data,{bearer,key:key??randomUUID()});
async function body(response){return (await response.json()).data;}
const errorCode=async response=>(await response.json()).error.code;
// One request, both facts: a replayed failure must not be mistaken for a fresh decision.
const failure=async response=>({status:response.status(),code:(await response.json()).error?.code});
const startFlow=async(request,data,bearer)=>{const response=await start(request,data,bearer);expect(response.status()).toBe(200);return body(response);};
const completionBody=(flow,extra={})=>({flowId:flow.flowId,transactionSecret:flow.transactionSecret,state:flow.state,
 identityToken:'synthetic.header.payload',authorizationCode:'synthetic-authorization-code',...extra});

test('login baseline over HTTP still issues one session and refuses a session bearer',async({request})=>{
 verifiedSubject=randomUUID();
 const flow=await startFlow(request,loginStart);
 expect(flow).toMatchObject({nonce:expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),state:expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)});
 const input=completionBody(flow),key=randomUUID();
 const first=await request.post(`${base}/v1/auth/apple/complete`,{headers:{'idempotency-key':key},data:input});
 expect(first.status()).toBe(200);
 const tokens=await body(first);
 expect(tokens.tokenType).toBe('Bearer');
 expect((await auth.service.verify(tokens.accessToken)).sessionId).toBe(tokens.session.sessionId);
 // The existing login contract is unchanged: a bearer is not part of it, before or after.
 expect(await failure(await start(request,loginStart,tokens.accessToken))).toEqual({status:400,code:'AUTH_INVALID_REQUEST'});
 expect(await failure(await complete(request,input,{bearer:tokens.accessToken,key}))).toEqual({status:400,code:'AUTH_INVALID_REQUEST'});
 // Same request and key still recover the identical session without a second issuance.
 expect(await body(await request.post(`${base}/v1/auth/apple/complete`,{headers:{'idempotency-key':key},data:input}))).toEqual(tokens);
 expect(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1',tokens.session.subjectId)).toBe(1);
 expect(exchanges).toBe(1);
});

test('reauth over HTTP binds the calling session and issues one link-identity grant',async({request})=>{
 const who=await linkedAccount();
 verifiedSubject=who.appleSubject;
 const other=await linkedAccount();
 expect(await failure(await start(request,reauthStart))).toEqual({status:400,code:'AUTH_INVALID_REQUEST'});
 expect((await start(request,{...reauthStart,action:'unlink-identity'},who.bearer)).status()).toBe(400);
 expect((await start(request,{...reauthStart,reauthGrant:'x'.repeat(43)},who.bearer)).status()).toBe(400);
 const flow=await startFlow(request,reauthStart,who.bearer);
 const input=completionBody(flow);
 expect(await failure(await complete(request,input))).toEqual({status:400,code:'AUTH_INVALID_REQUEST'});
 expect(await failure(await complete(request,input,{bearer:other.bearer}))).toEqual({status:401,code:'AUTH_SESSION_INVALID'});
 const key=randomUUID();
 const grantResponse=await complete(request,input,{bearer:who.bearer,key});
 expect(grantResponse.status()).toBe(200);
 const grant=await body(grantResponse);
 expect(Object.keys(grant).sort()).toEqual(['expiresAt','reauthGrant']);
 expect(grant.reauthGrant).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
 expect(+new Date(grant.expiresAt)).toBeGreaterThan(+auth.clock());
 const stored=await db.app.query('SELECT * FROM siyue.reauth_grants WHERE session_id=$1',[who.tokens.session.sessionId]);
 expect(stored.rows).toHaveLength(1);
 expect(stored.rows[0]).toMatchObject({subject_id:who.subjectId,session_id:who.tokens.session.sessionId,action:'link-identity',consumed_at:null});
 const flowRow=(await db.app.query('SELECT status,purpose,completed_session_id FROM siyue.apple_login_flows WHERE id=$1',[flow.flowId])).rows[0];
 expect(flowRow).toMatchObject({status:'completed',purpose:'reauth',completed_session_id:who.tokens.session.sessionId});
 // No new identity or Siyue session is created for the reauth subject.
 expect(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1',who.subjectId)).toBe(1);
 expect(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE subject_id=$1',who.subjectId)).toBe(1);
 // Same request and key recover the identical grant; a new key conflicts with the flow.
 expect(await body(await complete(request,input,{bearer:who.bearer,key}))).toEqual(grant);
 expect(await failure(await complete(request,input,{bearer:who.bearer}))).toEqual({status:409,code:'AUTH_IDEMPOTENCY_CONFLICT'});
 // The grant is one-time and action-bound, and cannot be re-obtained after consumption.
 expect(await db.app.query('SELECT * FROM siyue.reauth_grants WHERE session_id=$1',[who.tokens.session.sessionId]).then(result=>result.rows)).toHaveLength(1);
 await transaction(db.app,client=>auth.service.consumeReauth(client,who.tokens.session.sessionId,grant.reauthGrant,'link-identity'));
 await assertRejects(transaction(db.app,client=>auth.service.consumeReauth(client,who.tokens.session.sessionId,grant.reauthGrant,'link-identity')),'AUTH_REAUTH_REQUIRED');
 await assertRejects(transaction(db.app,client=>auth.service.consumeReauth(client,who.tokens.session.sessionId,grant.reauthGrant,'change-password')),'AUTH_REAUTH_REQUIRED');
 const consumed=await db.app.query('SELECT consumed_at FROM siyue.reauth_grants WHERE session_id=$1',[who.tokens.session.sessionId]);
 expect(consumed.rows[0].consumed_at).not.toBeNull();
 expect(await errorCode(await complete(request,input,{bearer:who.bearer,key}))).toBe('AUTH_OPERATION_COMPLETED_LOGIN_REQUIRED');
});

test('reauth refuses unlinked Apple identities, revoked sessions and expired flows',async({request})=>{
 const who=await linkedAccount();
 verifiedSubject=randomUUID();
 const subjectsBefore=await count('SELECT count(*)::int AS n FROM siyue.subjects');
 const unlinked=await startFlow(request,reauthStart,who.bearer);
 const unlinkedInput=completionBody(unlinked);
 expect(await failure(await complete(request,unlinkedInput,{bearer:who.bearer}))).toEqual({status:401,code:'AUTH_APPLE_RESTART_REQUIRED'});
 expect(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE session_id=$1',who.tokens.session.sessionId)).toBe(0);
 expect(await count('SELECT count(*)::int AS n FROM siyue.subjects')).toBe(subjectsBefore);
 expect(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE subject_id=$1',who.subjectId)).toBe(1);
 verifiedSubject=who.appleSubject;
 const expired=await startFlow(request,reauthStart,who.bearer);
 auth.advance(300_000);
 expect(await failure(await complete(request,completionBody(expired),{bearer:who.bearer}))).toEqual({status:401,code:'AUTH_APPLE_RESTART_REQUIRED'});
 const revoked=await startFlow(request,reauthStart,who.bearer);
 await auth.service.logoutAccess(who.bearer);
 expect(await failure(await complete(request,completionBody(revoked),{bearer:who.bearer}))).toEqual({status:401,code:'AUTH_SESSION_INVALID'});
 expect(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE session_id=$1',who.tokens.session.sessionId)).toBe(0);
});

async function assertRejects(promise,code){
 let error;
 try{await promise;}catch(caught){error=caught;}
 expect(error?.code).toBe(code);
}

test('Apple-only reauth grants revoke another device or every session, and nothing wider',async({request})=>{
 const who=await linkedAccount();
 verifiedSubject=who.appleSubject;
 const other=await transaction(db.app,client=>auth.service.issue(client,who.subjectId,randomUUID(),'email'));
 // Apple-only: this adult owns no password credential, so no password reauth exists for it.
 expect(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',who.subjectId)).toBe(0);
 const grantFor=async action=>{
  const flow=await startFlow(request,{...reauthStart,action},who.bearer);
  const response=await complete(request,completionBody(flow),{bearer:who.bearer});
  expect(response.status()).toBe(200);
  return (await response.json()).data.reauthGrant;
 };
 // The strict whitelist refuses every action an Apple-only credential must not obtain.
 for(const action of ['delete-account','unlink-identity','change-password','approve-child-device'])
  expect(await failure(await start(request,{...reauthStart,action},who.bearer))).toEqual({status:400,code:'AUTH_INVALID_REQUEST'});
 // A revoke-session grant is bound to the initiating session and to that one action.
 const single=await grantFor('revoke-session');
 expect((await db.app.query('SELECT subject_id,session_id,action,consumed_at FROM siyue.reauth_grants WHERE id=$1',[single.split('.')[0]])).rows[0])
  .toEqual({subject_id:who.subjectId,session_id:who.tokens.session.sessionId,action:'revoke-session',consumed_at:null});
 expect(await failure(await request.post(`${base}/v1/me/sessions/revoke-all`,{headers:{authorization:`Bearer ${who.bearer}`},data:{reauthGrant:single}})))
  .toEqual({status:401,code:'AUTH_REAUTH_REQUIRED'});
 expect((await request.delete(`${base}/v1/me/sessions/${other.session.sessionId}`,{headers:{authorization:`Bearer ${who.bearer}`},data:{reauthGrant:single}})).status()).toBe(204);
 await expect(auth.service.verify(other.accessToken)).rejects.toThrow();
 // Replaying the spent grant against a fresh device is refused, and that device stays valid.
 const third=await transaction(db.app,client=>auth.service.issue(client,who.subjectId,randomUUID(),'email'));
 expect(await failure(await request.delete(`${base}/v1/me/sessions/${third.session.sessionId}`,{headers:{authorization:`Bearer ${who.bearer}`},data:{reauthGrant:single}})))
  .toEqual({status:401,code:'AUTH_REAUTH_REQUIRED'});
 expect((await auth.service.verify(third.accessToken)).sessionId).toBe(third.session.sessionId);
 // A revoke-all grant cannot be downgraded to one device, and still revokes the subject.
 const all=await grantFor('revoke-all-sessions');
 expect(await failure(await request.delete(`${base}/v1/me/sessions/${third.session.sessionId}`,{headers:{authorization:`Bearer ${who.bearer}`},data:{reauthGrant:all}})))
  .toEqual({status:401,code:'AUTH_REAUTH_REQUIRED'});
 expect((await request.post(`${base}/v1/me/sessions/revoke-all`,{headers:{authorization:`Bearer ${who.bearer}`},data:{reauthGrant:all}})).status()).toBe(204);
 await expect(auth.service.verify(who.bearer)).rejects.toThrow();
 await expect(auth.service.verify(third.accessToken)).rejects.toThrow();
});
