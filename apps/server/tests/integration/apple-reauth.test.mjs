import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {devicePairingCompleteResponseSchema,devicePairingCreateResponseSchema} from '@siyue/contracts';
import {startPostgresFixture} from './postgres-fixture.mjs';
import {createAuthFixture} from './auth-fixture.mjs';
import {transaction} from '../../dist/adapters/postgres/database.js';
import {migrateDatabase,assertDatabaseReady,readMigrations} from '../../dist/adapters/postgres/migrate.js';
import {createRuntimeApp} from '../../dist/runtime-app.js';
import {createChildDevicePairingService} from '../../dist/modules/families/device-pairings.js';
import {createAppleFlowStorage} from '../../dist/identities/apple/flow-storage.js';
import {createAppleIdentityStorage} from '../../dist/identities/apple/identity-storage.js';
import {createAppleIdentityVerifier} from '../../dist/identities/apple/identity.js';
import {createAppleLoginPreparation} from '../../dist/identities/apple/prepare-login.js';
import {createAppleLoginService} from '../../dist/identities/apple/login-service.js';

// Synthetic Apple issuer/JWKS/exchange and an isolated temporary cluster only.
let db;before(async()=>{db=await startPostgresFixture();});after(async()=>{await db?.stop();});
const clientId='app.siyue.mobile',namespace='synthetic-team';
const pair=await generateKeyPair('RS256');
const verify=createAppleIdentityVerifier(clientId,createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'test',alg:'RS256'}]}));
const rows=(sql,...params)=>db.app.query(sql,params).then(result=>result.rows);
const count=(sql,...params)=>rows(sql,...params).then(result=>result[0].n);

async function fixture(appleSubject){
 const auth=await createAuthFixture(db),pepper=randomBytes(32);let exchanges=0;
 const subject=appleSubject??`apple-${randomUUID()}`;
 const storage=createAppleFlowStorage(db.app,auth.cipher,clientId,auth.clock);
 const identities=createAppleIdentityStorage(auth.cipher,namespace,auth.clock);
 const preparation=createAppleLoginPreparation({storage,clock:auth.clock,requestPepper:pepper,verify,
  exchange:async()=>{exchanges++;return {identity:{provider:'apple',subject,clientId},refreshToken:'synthetic-provider-refresh'};}});
 const service=createAppleLoginService({preparation,storage,identities,sessions:auth.service});
 return {auth,storage,preparation,service,subject,exchanges:()=>exchanges};
}

/** Adult subject with one active, linked Apple identity and an email-issued session. */
async function account(fx,appleSubject=fx.subject){
 const subjectId=randomUUID(),identityId=randomUUID();
 await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'adult','Synthetic')",[subjectId]);
 const tokens=await transaction(db.app,client=>fx.auth.service.issue(client,subjectId,randomUUID(),'email'));
 await db.app.query(`INSERT INTO siyue.external_identities(id,subject_id,provider,provider_namespace,provider_subject,client_id,issuer)
  VALUES($1,$2,'apple',$3,$4,$5,'https://appleid.apple.com')`,[identityId,subjectId,namespace,appleSubject,clientId]);
 return {subjectId,identityId,tokens};
}

/**
 * Precondition owned by the neighbouring child-device slice: one explicit guardian relationship backed
 * by a recorded consent plus the child's family membership and subject. The rows are written directly so
 * this file only checks how an Apple-issued `approve-child-device` grant is spent by the real route.
 */
async function guardianshipOf(fx,guardianSubjectId,familyId){
 const childSubjectId=randomUUID(),consentRecordId=randomUUID();
 await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'child','小禾')",[childSubjectId]);
 await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,'member',true,1)",[familyId,childSubjectId]);
 await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version,recorded_at)
  VALUES($1,$2,$3,'child-guardianship','child-device-pairing-v1',$4)`,[consentRecordId,guardianSubjectId,childSubjectId,fx.auth.clock()]);
 await db.app.query(`INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,active,version,
   consent_record_id,created_at) VALUES($1,$2,$3,true,1,$4,$5)`,[familyId,guardianSubjectId,childSubjectId,consentRecordId,fx.auth.clock()]);
 await db.app.query('UPDATE siyue.families SET version=version+1 WHERE id=$1',[familyId]);
 return {childSubjectId,consentRecordId};
}

const startLogin=fx=>fx.service.start({purpose:'login',platform:'ios',installationId:'synthetic-login',deviceLabel:'Synthetic iPhone'});
const reauthRequest={purpose:'reauth',action:'link-identity',platform:'ios',installationId:'synthetic-reauth',deviceLabel:'Synthetic iPhone'};
/** Stable keyed-digest pepper and synthetic addresses for the pairing service in this file. */
const pairingPepper=randomBytes(32),childAddress='198.51.100.20',guardianAddress='198.51.100.10';
async function completeInput(fx,flow,appleSubject=fx.subject,extra={}){
 const seconds=Math.floor(+fx.auth.clock()/1000);
 const identityToken=await new SignJWT({nonce:flow.nonce}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://appleid.apple.com')
  .setAudience(clientId).setSubject(appleSubject).setIssuedAt(seconds).setExpirationTime(seconds+300).sign(pair.privateKey);
 return {flowId:flow.flowId,transactionSecret:flow.transactionSecret,state:flow.state,identityToken,authorizationCode:randomUUID(),...extra};
}
const flowRow=async id=>(await rows('SELECT * FROM siyue.apple_login_flows WHERE id=$1',id))[0];
const pairingRow=async id=>(await rows('SELECT * FROM siyue.device_pairing_requests WHERE id=$1',id))[0];
const consumeReauth=(fx,sessionId,grant,action='link-identity')=>transaction(db.app,client=>fx.auth.service.consumeReauth(client,sessionId,grant,action));

test('reauth start requires the verified calling session; login stays session-free',async()=>{
 const fx=await fixture(),who=await account(fx);
 // login keeps the original contract: a session bearer is not part of a login start.
 await assert.rejects(fx.service.start({purpose:'login',platform:'ios',installationId:'synthetic'},who.tokens.accessToken),{code:'invalid_request'});
 // reauth cannot start without the caller's current session or with a login-shaped body.
 await assert.rejects(fx.service.start(reauthRequest),{code:'invalid_request'});
 await assert.rejects(fx.storage.start({purpose:'login',platform:'ios',installationId:'synthetic'},{sessionId:who.tokens.session.sessionId}),{code:'invalid_request'});
 const flow=await fx.service.start(reauthRequest,who.tokens.accessToken);
 const row=await flowRow(flow.flowId);
 assert.deepEqual([row.purpose,row.action,row.session_id],['reauth','link-identity',who.tokens.session.sessionId]);
 assert.equal(+row.expires_at-+row.created_at,300000);
 assert.equal(JSON.stringify(row).includes(flow.transactionSecret),false);
 assert.ok(flow.nonce.length===43&&flow.state.length===43);
});

test('database rejects impossible purpose bindings on the flow table',async()=>{
 const fx=await fixture(),who=await account(fx),sessionId=who.tokens.session.sessionId;
 const insert=values=>db.app.query(`INSERT INTO siyue.apple_login_flows(id,client_id,installation_id,secret_hash,state_hash,nonce_hash,expires_at,purpose,action,session_id)
  VALUES(gen_random_uuid(),'app.siyue.mobile','constraint-check',repeat('a',64),repeat('b',64),repeat('c',64),now()+interval '300 seconds',${values})`);
 for(const invalid of ["'reauth',NULL,NULL","'reauth','link-identity',NULL","'reauth',NULL,'"+sessionId+"'",
  "'reauth','unlink-identity','"+sessionId+"'","'reauth','change-password','"+sessionId+"'",
  "'reauth','revoke-session',NULL","'login','link-identity','"+sessionId+"'","'login','revoke-session','"+sessionId+"'","'login',NULL,'"+sessionId+"'"])
  await assert.rejects(insert(invalid),error=>error.code==='23514',invalid);
 // Controls: every documented binding remains insertable.
 await insert("'login',NULL,NULL");
 await insert("'reauth','link-identity','"+sessionId+"'");
 await insert("'reauth','revoke-session','"+sessionId+"'");
 await insert("'reauth','revoke-all-sessions','"+sessionId+"'");
 await insert("'reauth','delete-account','"+sessionId+"'");
 assert.equal(await count("SELECT count(*)::int AS n FROM siyue.apple_login_flows WHERE installation_id='constraint-check'"),5);
});

test('reauth completion issues exactly one session-bound grant without new identity or session',async()=>{
 const fx=await fixture(),who=await account(fx);
 const before={subjects:await count('SELECT count(*)::int AS n FROM siyue.subjects'),identities:await count('SELECT count(*)::int AS n FROM siyue.external_identities'),
  sessions:await count('SELECT count(*)::int AS n FROM siyue.auth_sessions')};
 const flow=await fx.service.start(reauthRequest,who.tokens.accessToken),input=await completeInput(fx,flow),key=randomUUID();
 const grant=await fx.service.complete(input,key,who.tokens.accessToken);
 assert.deepEqual(Object.keys(grant).sort(),['expiresAt','reauthGrant']);
 assert.equal(+new Date(grant.expiresAt)-+fx.auth.clock(),300000);
 assert.equal(fx.exchanges(),1);
 const stored=await rows('SELECT * FROM siyue.reauth_grants WHERE session_id=$1',who.tokens.session.sessionId);
 assert.equal(stored.length,1);
 assert.deepEqual([stored[0].subject_id,stored[0].session_id,stored[0].action,stored[0].credential_version,stored[0].consumed_at],
  [who.subjectId,who.tokens.session.sessionId,'link-identity',1,null]);
 assert.equal(JSON.stringify(stored[0]).includes(grant.reauthGrant.split('.')[1]),false);
 const row=await flowRow(flow.flowId);
 assert.deepEqual([row.status,row.purpose,row.action,row.completed_session_id,row.verified_ciphertext],
  ['completed','reauth','link-identity',who.tokens.session.sessionId,null]);
 assert.equal(+row.response_expires_at-+row.completed_at,60000);
 // No new subject, identity or Siyue session; the existing link keeps its provider credential.
 assert.deepEqual({subjects:await count('SELECT count(*)::int AS n FROM siyue.subjects'),identities:await count('SELECT count(*)::int AS n FROM siyue.external_identities'),
  sessions:await count('SELECT count(*)::int AS n FROM siyue.auth_sessions')},before);
 assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_provider_credentials WHERE identity_id=$1',who.identityId),1);
 // Same request and key recover the identical grant without re-exchanging or minting another.
 assert.deepEqual(await fx.service.complete(input,key,who.tokens.accessToken),grant);
 assert.equal(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE session_id=$1',who.tokens.session.sessionId),1);
 assert.equal(fx.exchanges(),1);
 await assert.rejects(fx.service.complete(input,randomUUID(),who.tokens.accessToken),{code:'request_conflict'});
});

test('the issued grant is one-time, session-bound and action-bound',async()=>{
 const fx=await fixture(),who=await account(fx);
 const flow=await fx.service.start(reauthRequest,who.tokens.accessToken),input=await completeInput(fx,flow);
 const grant=(await fx.service.complete(input,randomUUID(),who.tokens.accessToken)).reauthGrant;
 await assert.rejects(consumeReauth(fx,who.tokens.session.sessionId,grant,'change-password'),{code:'AUTH_REAUTH_REQUIRED'});
 await assert.rejects(consumeReauth(fx,randomUUID(),grant,'link-identity'),{code:'AUTH_SESSION_INVALID'});
 await consumeReauth(fx,who.tokens.session.sessionId,grant,'link-identity');
 await assert.rejects(consumeReauth(fx,who.tokens.session.sessionId,grant,'link-identity'),{code:'AUTH_REAUTH_REQUIRED'});
 // A consumed grant is never re-published and the flow cannot mint a replacement.
 await assert.rejects(fx.service.complete(input,randomUUID(),who.tokens.accessToken),{code:'request_conflict'});
 await assert.rejects(fx.service.complete({...input,authorizationCode:'other-code'},randomUUID(),who.tokens.accessToken),{code:'request_conflict'});
});

test('cross-session, unlinked-identity, revoked-session and expired reauth attempts issue no grant',async()=>{
 for(const [scenario,expected] of [['cross-session','session_mismatch'],['unlinked','identity_not_linked'],['revoked','session_invalid'],['expired','restart_required']]){
  const fx=await fixture(),who=await account(fx);
  const secondSession=await transaction(db.app,client=>fx.auth.service.issue(client,who.subjectId,randomUUID(),'email'));
  const flow=await fx.service.start(reauthRequest,who.tokens.accessToken),input=await completeInput(fx,flow);
  const bearer=scenario==='cross-session'?secondSession.accessToken:who.tokens.accessToken;
  if(scenario==='unlinked')await db.app.query("UPDATE siyue.external_identities SET status='unlinked' WHERE id=$1",[who.identityId]);
  if(scenario==='revoked')await fx.auth.service.logoutAccess(who.tokens.accessToken);
  if(scenario==='expired')fx.auth.advance(300000);
  await assert.rejects(fx.service.complete(input,randomUUID(),bearer),{code:expected},scenario);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE session_id=$1',who.tokens.session.sessionId),0,scenario);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE subject_id=$1',who.subjectId),1,scenario);
  if(scenario==='unlinked')assert.equal((await rows('SELECT status FROM siyue.external_identities WHERE id=$1',who.identityId))[0].status,'unlinked');
 }
});

test('an Apple identity bound to another subject cannot complete reauth',async()=>{
 const owner=await fixture(),intruder=await fixture();
 // who links an unrelated Apple subject; the verified identity resolves to another subject.
 const who=await account(owner,'apple-unrelated'),other=await account(intruder);
 assert.notEqual(who.subjectId,other.subjectId);
 const flow=await owner.service.start(reauthRequest,who.tokens.accessToken);
 const input=await completeInput(owner,flow),grantsBefore=await count('SELECT count(*)::int AS n FROM siyue.reauth_grants');
 await assert.rejects(owner.service.complete(input,randomUUID(),who.tokens.accessToken),{code:'identity_not_linked'});
 assert.equal(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants'),grantsBefore);
 assert.equal(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE subject_id=$1',who.subjectId),1);
});

test('login completion keeps its original contract: no bearer, session issued as before',async()=>{
 const fx=await fixture();
 const flow=await startLogin(fx),input=await completeInput(fx,flow);
 const grantsBefore=await count('SELECT count(*)::int AS n FROM siyue.reauth_grants');
 const tokens=await fx.service.complete(input,randomUUID());
 assert.equal((await fx.auth.service.verify(tokens.accessToken)).sessionId,tokens.session.sessionId);
 assert.equal(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants'),grantsBefore);
 const second=await startLogin(fx),secondInput=await completeInput(fx,second);
 await assert.rejects(fx.service.complete(secondInput,randomUUID(),tokens.accessToken),{code:'invalid_request'});
 assert.equal(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants'),grantsBefore);
});

test('only the five documented Apple reauth actions can start a flow',async()=>{
 const fx=await fixture(),who=await account(fx),installationId='synthetic-reauth-actions',sessionId=who.tokens.session.sessionId;
 for(const action of ['link-identity','revoke-session','revoke-all-sessions','approve-child-device','delete-account']){
  const flow=await fx.service.start({...reauthRequest,action,installationId},who.tokens.accessToken);
  assert.equal((await flowRow(flow.flowId)).action,action);
 }
 // Neither the service nor the flow store admits an action outside the documented whitelist.
 for(const action of ['unlink-identity','change-email','change-password','approve-child-devices','revoke','']){
  await assert.rejects(fx.service.start({...reauthRequest,action,installationId},who.tokens.accessToken),error=>error.name==='ZodError',action);
  await assert.rejects(fx.storage.start({purpose:'reauth',action,platform:'ios',installationId},{sessionId}),error=>error.name==='ZodError',action);
 }
 assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_login_flows WHERE installation_id=$1',installationId),5);
});

test('revoke reauth flows issue one grant bound to the action and session chosen at start',async()=>{
 const fx=await fixture(),who=await account(fx),sessionId=who.tokens.session.sessionId;
 const otherSession=await transaction(db.app,client=>fx.auth.service.issue(client,who.subjectId,randomUUID(),'email'));
 for(const action of ['revoke-session','revoke-all-sessions']){
  const flow=await fx.service.start({...reauthRequest,action},who.tokens.accessToken),input=await completeInput(fx,flow),key=randomUUID();
  const grant=await fx.service.complete(input,key,who.tokens.accessToken);
  assert.deepEqual(Object.keys(grant).sort(),['expiresAt','reauthGrant']);
  const stored=await rows('SELECT * FROM siyue.reauth_grants WHERE id=$1',grant.reauthGrant.split('.')[0]);
  assert.deepEqual([stored[0].subject_id,stored[0].session_id,stored[0].action,stored[0].credential_version,stored[0].consumed_at],
   [who.subjectId,sessionId,action,1,null]);
  // The same request and key recover the identical grant while it is still unconsumed.
  assert.deepEqual(await fx.service.complete(input,key,who.tokens.accessToken),grant);
  // Every other action is refused, including the ones the Apple-only path never serves.
  for(const wrong of ['link-identity','revoke-session','revoke-all-sessions','change-password'].filter(value=>value!==action))
   await assert.rejects(consumeReauth(fx,sessionId,grant.reauthGrant,wrong),{code:'AUTH_REAUTH_REQUIRED'},`${action} as ${wrong}`);
  // Refused cross-action attempts and another session of the same subject must not spend it.
  assert.equal((await rows('SELECT consumed_at FROM siyue.reauth_grants WHERE id=$1',grant.reauthGrant.split('.')[0]))[0].consumed_at,null);
  await assert.rejects(consumeReauth(fx,otherSession.session.sessionId,grant.reauthGrant,action),{code:'AUTH_REAUTH_REQUIRED'});
  await consumeReauth(fx,sessionId,grant.reauthGrant,action);
  // A consumed grant is never re-published, so recovery of the same request stops working.
  await assert.rejects(fx.service.complete(input,key,who.tokens.accessToken),{code:'recovery_expired'});
 }
});

test('Apple reauth grants revoke exactly the device scope they were issued for',async()=>{
 const fx=await fixture(),who=await account(fx);
 const second=await transaction(db.app,client=>fx.auth.service.issue(client,who.subjectId,randomUUID(),'email'));
 const third=await transaction(db.app,client=>fx.auth.service.issue(client,who.subjectId,randomUUID(),'email'));
 const grantFor=async action=>{const flow=await fx.service.start({...reauthRequest,action},who.tokens.accessToken);
  return (await fx.service.complete(await completeInput(fx,flow),randomUUID(),who.tokens.accessToken)).reauthGrant;};
 const single=await grantFor('revoke-session');
 // A revoke-session grant can never be spent on the whole subject.
 await assert.rejects(fx.auth.service.revokeAllDeviceSessions(who.tokens.accessToken,single),{code:'AUTH_REAUTH_REQUIRED'});
 await fx.auth.service.revokeDeviceSession(who.tokens.accessToken,second.session.sessionId,single);
 await assert.rejects(fx.auth.service.verify(second.accessToken));
 assert.equal((await rows('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',third.session.sessionId))[0].revoked_at,null);
 // The spent grant cannot reach a third device, and that device stays usable.
 await assert.rejects(fx.auth.service.revokeDeviceSession(who.tokens.accessToken,third.session.sessionId,single),{code:'AUTH_REAUTH_REQUIRED'});
 assert.ok(await fx.auth.service.verify(third.accessToken));
 // A revoke-all grant cannot be downgraded to one device, then revokes every session.
 const all=await grantFor('revoke-all-sessions');
 await assert.rejects(fx.auth.service.revokeDeviceSession(who.tokens.accessToken,third.session.sessionId,all),{code:'AUTH_REAUTH_REQUIRED'});
 await fx.auth.service.revokeAllDeviceSessions(who.tokens.accessToken,all);
 await assert.rejects(fx.auth.service.verify(who.tokens.accessToken));
 await assert.rejects(fx.auth.service.verify(third.accessToken));
});

test('an approve-child-device Apple grant is bound to that action and refused for every other one',async()=>{
 const fx=await fixture(),who=await account(fx),sessionId=who.tokens.session.sessionId;
 const flow=await fx.service.start({...reauthRequest,action:'approve-child-device'},who.tokens.accessToken),input=await completeInput(fx,flow);
 assert.equal((await flowRow(flow.flowId)).action,'approve-child-device');
 const key=randomUUID(),grant=(await fx.service.complete(input,key,who.tokens.accessToken)).reauthGrant;
 const stored=await rows('SELECT * FROM siyue.reauth_grants WHERE id=$1',grant.split('.')[0]);
 assert.deepEqual([stored[0].subject_id,stored[0].session_id,stored[0].action,stored[0].credential_version,stored[0].consumed_at],
  [who.subjectId,sessionId,'approve-child-device',1,null]);
 // 旧 grant 拒绝：任何更窄或不相干的动作都不能花掉这张绑定配对的授权。
 for(const wrong of ['link-identity','revoke-session','revoke-all-sessions','change-password'])
  await assert.rejects(consumeReauth(fx,sessionId,grant,wrong),{code:'AUTH_REAUTH_REQUIRED'},wrong);
 assert.equal((await rows('SELECT consumed_at FROM siyue.reauth_grants WHERE id=$1',grant.split('.')[0]))[0].consumed_at,null);
 await consumeReauth(fx,sessionId,grant,'approve-child-device');
 await assert.rejects(consumeReauth(fx,sessionId,grant,'approve-child-device'),{code:'AUTH_REAUTH_REQUIRED'});
 // 已消费的 grant 不会重新发布：同一请求键重放只得到恢复窗口已过，而不是第二张授权。
 await assert.rejects(fx.service.complete(input,key,who.tokens.accessToken),{code:'recovery_expired'});
 await assert.rejects(fx.service.complete(input,randomUUID(),who.tokens.accessToken),{code:'request_conflict'});
});

test('the Apple-issued approve-child-device grant is spent once by the real pairing approval',async()=>{
 const fx=await fixture(),who=await account(fx);
 const pairings=createChildDevicePairingService(db.app,fx.auth.service,fx.auth.cipher,pairingPepper,fx.auth.clock);
 const app=createRuntimeApp(db.app,db.identity,{sessions:fx.auth.service,devicePairings:pairings});
 try{
  const authorization={authorization:`Bearer ${who.tokens.accessToken}`};
  // 家长家庭通过真实路由创建，监护关系/同意行按相邻子切片的前置条件直接写入。
  const family=await app.inject({method:'POST',url:'/v1/families',headers:{...authorization,'idempotency-key':randomUUID()}});
  assert.equal(family.statusCode,201,family.body);
  const {childSubjectId}=await guardianshipOf(fx,who.subjectId,family.json().data.familyId);
  const created=await app.inject({method:'POST',url:'/v1/device-pairings',remoteAddress:childAddress,
   payload:{installationId:'synthetic-child-ipad',platform:'ios',deviceLabel:'Synthetic child iPad'}});
  assert.equal(created.statusCode,201,created.body);
  const pairing=devicePairingCreateResponseSchema.parse(created.json().data);
  const approve=grant=>app.inject({method:'POST',url:`/v1/device-pairings/${pairing.pairingId}/approve`,remoteAddress:guardianAddress,headers:authorization,
   payload:{requestToken:pairing.requestToken,childSubjectId,reauthGrant:grant,expectedGuardianVersion:1}});
  const grantFor=async action=>{const flow=await fx.service.start({...reauthRequest,action},who.tokens.accessToken);
   return (await fx.service.complete(await completeInput(fx,flow),randomUUID(),who.tokens.accessToken)).reauthGrant;};
  // 旧动作签发的 grant 不能批准配对，且拒绝不消费它。
  const legacy=await grantFor('revoke-all-sessions');
  const refused=await approve(legacy);
  assert.equal(refused.statusCode,401,refused.body);
  assert.equal((await pairingRow(pairing.pairingId)).status,'pending');
  await consumeReauth(fx,who.tokens.session.sessionId,legacy,'revoke-all-sessions');
  // Apple 重新验证签发的 approve-child-device grant 由真实 HTTP 端点消费。
  const accepted=await approve(await grantFor('approve-child-device'));
  assert.equal(accepted.statusCode,200,accepted.body);
  assert.equal(accepted.json().data.status,'approved');
  const row=await pairingRow(pairing.pairingId);
  assert.deepEqual([row.status,row.approved_by,row.child_subject_id,row.approved_guardian_version,row.approved_credential_version],
   ['approved',who.subjectId,childSubjectId,1,1]);
  // 发起设备用 pollSecret 一次领取，只拿到受限 child 会话和设备授权 id。
  const completed=await app.inject({method:'POST',url:`/v1/device-pairings/${pairing.pairingId}/complete`,remoteAddress:childAddress,
   payload:{pollSecret:pairing.pollSecret}});
  assert.equal(completed.statusCode,200,completed.body);
  const result=devicePairingCompleteResponseSchema.parse(completed.json().data);
  assert.equal(result.sessionTokens.session.subjectKind,'child');
  assert.equal((await pairingRow(pairing.pairingId)).status,'consumed');
 }finally{await app.close();}
});

test('0008 widens the reauth action whitelist on an existing database without rewriting history',async()=>{
 const legacy=await startPostgresFixture({migrate:false}),directory=mkdtempSync('/tmp/siyue-apple-reauth-');
 try{
  const migrations=await readMigrations();
  // Apply the pre-0008 history byte for byte, exactly as an existing deployment has it.
  const before0008=migrations.filter(migration=>migration.version<'0008_apple_reauth_actions.sql');
  const actionMigration=migrations.find(migration=>migration.version==='0008_apple_reauth_actions.sql');
  assert.ok(actionMigration);
  for(const migration of before0008)writeFileSync(join(directory,migration.version),migration.sql);
  assert.equal(await migrateDatabase(legacy.migrator,legacy.identity,pathToFileURL(directory+'/')),before0008.length);
  // This historical database predates child-device tables. Seed the adult session directly: the
  // current session service intentionally joins those newer tables and cannot run before 0011.
  const subjectId=randomUUID(),sessionId=randomUUID(),installationId=randomUUID();
  await legacy.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')",[subjectId]);
  await legacy.app.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,credential_version,
    authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
    VALUES($1,$2,$3,'email',1,now(),now(),now(),now()+interval '30 days',now()+interval '180 days')`,
  [sessionId,subjectId,installationId]);
  const insert=values=>legacy.app.query(`INSERT INTO siyue.apple_login_flows(id,client_id,installation_id,secret_hash,state_hash,nonce_hash,expires_at,purpose,action,session_id)
   VALUES(gen_random_uuid(),'app.siyue.mobile','legacy-upgrade',repeat('a',64),repeat('b',64),repeat('c',64),now()+interval '300 seconds',${values})`);
  await insert("'login',NULL,NULL");
  await insert("'reauth','link-identity','"+sessionId+"'");
  // The pre-0008 whitelist still rejects the actions this slice adds.
  await assert.rejects(insert("'reauth','revoke-session','"+sessionId+"'"),error=>error.code==='23514');
  // Apply precisely 0008 before later migrations, so adding future migrations cannot change
  // which whitelist this test treats as the old and new states.
  writeFileSync(join(directory,actionMigration.version),actionMigration.sql);
  assert.equal(await migrateDatabase(legacy.migrator,legacy.identity,pathToFileURL(directory+'/')),1);
  // Existing login and link-identity rows keep their meaning and their recorded history.
  assert.deepEqual((await legacy.app.query("SELECT action FROM siyue.apple_login_flows WHERE installation_id='legacy-upgrade' ORDER BY purpose")).rows.map(row=>row.action),[null,'link-identity']);
  await insert("'reauth','revoke-session','"+sessionId+"'");
  await insert("'reauth','revoke-all-sessions','"+sessionId+"'");
  for(const invalid of ["'reauth','delete-account','"+sessionId+"'","'reauth','revoke-session',NULL","'login','revoke-session','"+sessionId+"'"])
   await assert.rejects(insert(invalid),error=>error.code==='23514',invalid);
 assert.equal(await migrateDatabase(legacy.migrator,legacy.identity),migrations.length-before0008.length-1);
 await assertDatabaseReady(legacy.app,legacy.identity);
 }finally{rmSync(directory,{recursive:true});await legacy.stop();}
});

test('0014 adds child-device approval to the reauth whitelist on an applied database only',async()=>{
 const legacy=await startPostgresFixture({migrate:false}),directory=mkdtempSync('/tmp/siyue-apple-child-approval-');
 try{
  const migrations=await readMigrations();
  // Apply the 0001..0013 history byte for byte, exactly as an existing deployment has it.
  const before=migrations.filter(migration=>migration.version<'0014_apple_child_approval_reauth.sql');
  const approvalMigration=migrations.find(migration=>migration.version==='0014_apple_child_approval_reauth.sql');
  assert.ok(approvalMigration);
  assert.equal(before.length,13);
  for(const migration of before)writeFileSync(join(directory,migration.version),migration.sql);
  assert.equal(await migrateDatabase(legacy.migrator,legacy.identity,pathToFileURL(directory+'/')),before.length);
  // Seed the adult session directly: the current session service joins the 0011 tables and cannot run
  // against a database that predates this migration's rollout in the test.
  const subjectId=randomUUID(),sessionId=randomUUID(),installationId=randomUUID();
  await legacy.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')",[subjectId]);
  await legacy.app.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,credential_version,
    authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
    VALUES($1,$2,$3,'email',1,now(),now(),now(),now()+interval '30 days',now()+interval '180 days')`,
  [sessionId,subjectId,installationId]);
  const insert=values=>legacy.app.query(`INSERT INTO siyue.apple_login_flows(id,client_id,installation_id,secret_hash,state_hash,nonce_hash,expires_at,purpose,action,session_id)
   VALUES(gen_random_uuid(),'app.siyue.mobile','legacy-child-approval',repeat('a',64),repeat('b',64),repeat('c',64),now()+interval '300 seconds',${values})`);
  await insert("'login',NULL,NULL");
  await insert("'reauth','link-identity','"+sessionId+"'");
  await insert("'reauth','revoke-all-sessions','"+sessionId+"'");
  // The pre-0014 whitelist still rejects the action this slice adds, so the widening is the migration's.
  await assert.rejects(insert("'reauth','approve-child-device','"+sessionId+"'"),error=>error.code==='23514');
  // Apply precisely 0014 and nothing else.
  writeFileSync(join(directory,approvalMigration.version),approvalMigration.sql);
  assert.equal(await migrateDatabase(legacy.migrator,legacy.identity,pathToFileURL(directory+'/')),1);
  await insert("'reauth','approve-child-device','"+sessionId+"'");
  // Existing rows keep their recorded action; only the allowed set grew.
  assert.deepEqual((await legacy.app.query("SELECT action FROM siyue.apple_login_flows WHERE installation_id='legacy-child-approval' ORDER BY action NULLS FIRST")).rows.map(row=>row.action),
   [null,'approve-child-device','link-identity','revoke-all-sessions']);
  // Impossible bindings stay impossible: approval still needs a reauth purpose and a bound session.
  for(const invalid of ["'reauth','approve-child-device',NULL","'reauth','delete-account','"+sessionId+"'","'login','approve-child-device','"+sessionId+"'","'reauth',NULL,'"+sessionId+"'"])
   await assert.rejects(insert(invalid),error=>error.code==='23514',invalid);
  // Running the real directory again re-checks every applied checksum, so any rewrite of 0001..0013 fails here.
  assert.equal(await migrateDatabase(legacy.migrator,legacy.identity),migrations.length-before.length-1);
  await assertDatabaseReady(legacy.app,legacy.identity);
 }finally{rmSync(directory,{recursive:true});await legacy.stop();}
});

test('0017 adds delete-account reauth for Apple-only adults without rewriting prior migrations',async()=>{
 const legacy=await startPostgresFixture({migrate:false}),directory=mkdtempSync('/tmp/siyue-apple-deletion-');
 try{
  const migrations=await readMigrations(),before=migrations.filter(m=>m.version<'0017_apple_account_deletion_reauth.sql');
  const deletion=migrations.find(m=>m.version==='0017_apple_account_deletion_reauth.sql');
  assert.ok(deletion);
  for(const migration of before)writeFileSync(join(directory,migration.version),migration.sql);
  assert.equal(await migrateDatabase(legacy.migrator,legacy.identity,pathToFileURL(directory+'/')),before.length);
  const subjectId=randomUUID(),sessionId=randomUUID();
  await legacy.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')",[subjectId]);
  await legacy.app.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,credential_version,
    authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
    VALUES($1,$2,$3,'apple',1,now(),now(),now(),now()+interval '30 days',now()+interval '180 days')`,
   [sessionId,subjectId,randomUUID()]);
  const insert=(purpose,action,binding)=>legacy.app.query(`INSERT INTO siyue.apple_login_flows
    (id,client_id,installation_id,secret_hash,state_hash,nonce_hash,expires_at,purpose,action,session_id)
    VALUES(gen_random_uuid(),'app.siyue.mobile','deletion-upgrade',repeat('a',64),repeat('b',64),repeat('c',64),now()+interval '300 seconds',$1,$2,$3)`,
   [purpose,action,binding]);
  await assert.rejects(insert('reauth','delete-account',sessionId),error=>error.code==='23514');
  writeFileSync(join(directory,deletion.version),deletion.sql);
  assert.equal(await migrateDatabase(legacy.migrator,legacy.identity,pathToFileURL(directory+'/')),1);
  await insert('reauth','delete-account',sessionId);
  await assert.rejects(insert('reauth','delete-account',null),error=>error.code==='23514');
  await assert.rejects(insert('login','delete-account',sessionId),error=>error.code==='23514');
  assert.equal(await migrateDatabase(legacy.migrator,legacy.identity),migrations.length-before.length-1);
  await assertDatabaseReady(legacy.app,legacy.identity);
 }finally{rmSync(directory,{recursive:true});await legacy.stop();}
});
