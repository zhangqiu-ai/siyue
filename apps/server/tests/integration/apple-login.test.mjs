import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {startPostgresFixture} from './postgres-fixture.mjs';
import {createAuthFixture} from './auth-fixture.mjs';
import {createAppleFlowStorage} from '../../dist/identities/apple/flow-storage.js';
import {createAppleIdentityStorage} from '../../dist/identities/apple/identity-storage.js';
import {createAppleIdentityVerifier} from '../../dist/identities/apple/identity.js';
import {createAppleLoginPreparation} from '../../dist/identities/apple/prepare-login.js';
import {createAppleLoginService} from '../../dist/identities/apple/login-service.js';
let db;before(async()=>{db=await startPostgresFixture();});after(async()=>{await db?.stop();});
const pair=await generateKeyPair('RS256'),clientId='app.siyue.mobile';
const verify=createAppleIdentityVerifier(clientId,createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'test',alg:'RS256'}]}));
async function fixture(){
 const auth=await createAuthFixture(db),subject=randomUUID(),pepper=randomBytes(32);let exchanges=0;
 const storage=createAppleFlowStorage(db.app,auth.cipher,clientId,auth.clock),identities=createAppleIdentityStorage(auth.cipher,'synthetic-team',auth.clock);
 const preparation=createAppleLoginPreparation({storage,clock:auth.clock,requestPepper:pepper,verify,exchange:async()=>{exchanges++;return {identity:{provider:'apple',subject,clientId},refreshToken:'synthetic-provider-refresh'};}});
 const make=(sessions=auth.service,store=storage)=>createAppleLoginService({preparation,storage:store,identities,sessions});
 async function request(){
  const flow=await storage.start({purpose:'login',platform:'ios',installationId:'test-install',deviceLabel:'Synthetic iPhone'}),seconds=Math.floor(+auth.clock()/1000);
  const identityToken=await new SignJWT({nonce:flow.nonce}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://appleid.apple.com').setAudience(clientId).setSubject(subject).setIssuedAt(seconds).setExpirationTime(seconds+300).sign(pair.privateKey);
  return {input:{flowId:flow.flowId,transactionSecret:flow.transactionSecret,state:flow.state,identityToken,authorizationCode:randomUUID(),fullName:{givenName:'Synthetic'}},key:randomUUID()};
 }
 return {auth,storage,preparation,make,request,exchanges:()=>exchanges,subject};
}
const flowRow=async id=>(await db.app.query('SELECT * FROM siyue.apple_login_flows WHERE id=$1',[id])).rows[0];
const countSessions=async subject=>(await db.app.query('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1',[subject])).rows[0].n;

test('atomic completion returns one valid Siyue session, clears provider material and recovers identical tokens',async()=>{
 const f=await fixture(),r=await f.request(),tokens=await f.make().complete(r.input,r.key);
 assert.deepEqual(await f.auth.service.verify(tokens.accessToken),tokens.session);
 const session=(await db.app.query('SELECT platform,device_label,auth_method FROM siyue.auth_sessions WHERE id=$1',[tokens.session.sessionId])).rows[0];
 assert.deepEqual(session,{platform:'ios',device_label:'Synthetic iPhone',auth_method:'apple'});
 const row=await flowRow(r.input.flowId);assert.equal(row.status,'completed');assert.equal(row.verified_ciphertext,null);
 assert.equal(+row.response_expires_at-+row.completed_at,60000);
 assert.equal(JSON.stringify(row).includes(tokens.refreshToken),false);
 assert.equal(JSON.stringify(tokens).includes('synthetic-provider-refresh'),false);
 assert.deepEqual(await f.make().complete(r.input,r.key),tokens);assert.equal(f.exchanges(),1);
 assert.equal(await countSessions(tokens.session.subjectId),1);
 await assert.rejects(f.make().complete({...r.input,state:'x'.repeat(43)},r.key),{code:'invalid_flow'});
 await assert.rejects(f.make().complete({...r.input,authorizationCode:'changed'},r.key),{code:'request_conflict'});
});

test('concurrent completion of a prepared flow issues only one session',async()=>{
 const f=await fixture(),r=await f.request();await f.preparation.prepare(r.input,r.key);
 const tokens=await Promise.all(Array.from({length:10},()=>f.make().complete(r.input,r.key)));
 for(const result of tokens)assert.deepEqual(result,tokens[0]);
 assert.equal(await countSessions(tokens[0].session.subjectId),1);assert.equal(f.exchanges(),1);
});

test('session write failure rolls back identity and session; retry uses persisted provider exchange',async()=>{
 const f=await fixture(),r=await f.request();
 const failing={...f.auth.service,issue:async(...args)=>{await f.auth.service.issue(...args);throw Error('synthetic session failure');}};
 await assert.rejects(f.make(failing).complete(r.input,r.key),/synthetic session failure/);
 assert.equal((await flowRow(r.input.flowId)).status,'verified');
 assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.external_identities WHERE provider_subject=$1',[f.subject])).rows[0].n,0);
 const tokens=await f.make().complete(r.input,r.key);assert.equal(f.exchanges(),1);assert.equal(await countSessions(tokens.session.subjectId),1);
});

test('completed response acknowledgement loss recovers without another session or exchange',async()=>{
 const f=await fixture(),r=await f.request();let lost=true;
 const store={...f.storage,complete:async(...args)=>{const result=await f.storage.complete(...args);if(lost){lost=false;throw Error('synthetic commit acknowledgement lost');}return result;}};
 await assert.rejects(f.make(f.auth.service,store).complete(r.input,r.key),/acknowledgement lost/);
 const row=await flowRow(r.input.flowId),tokens=await f.make().complete(r.input,r.key);
 assert.equal(tokens.session.sessionId,row.completed_session_id);assert.equal(await countSessions(tokens.session.subjectId),1);assert.equal(f.exchanges(),1);
});

test('recovery ends exactly at 60 seconds; cleanup preserves completed identity and prevents repeat issuance',async()=>{
 const f=await fixture(),r=await f.request(),tokens=await f.make().complete(r.input,r.key);
 f.auth.advance(59999);assert.deepEqual(await f.make().complete(r.input,r.key),tokens);
 f.auth.advance(1);await assert.rejects(f.make().complete(r.input,r.key),{code:'recovery_expired'});
 await f.storage.cleanup();const row=await flowRow(r.input.flowId);assert.equal(row.status,'completed');assert.equal(row.response_ciphertext,null);
 await assert.rejects(f.make().complete(r.input,r.key),{code:'recovery_expired'});
 const next=await f.request(),second=await f.make().complete(next.input,next.key);
 assert.equal(second.session.subjectId,tokens.session.subjectId);assert.notEqual(second.session.sessionId,tokens.session.sessionId);
 assert.equal(f.exchanges(),2);
});

test('revoked session, changed credentials, blocked subject and consumed refresh prevent credential recovery',async()=>{
 for(const action of ['revoke','version','block','refresh']){
  const f=await fixture(),r=await f.request(),tokens=await f.make().complete(r.input,r.key);
  if(action==='revoke')await f.auth.service.logoutAccess(tokens.accessToken);
  if(action==='version')await db.app.query('UPDATE siyue.subjects SET credential_version=credential_version+1 WHERE id=$1',[tokens.session.subjectId]);
  if(action==='block')await db.app.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1",[tokens.session.subjectId]);
  if(action==='refresh')await f.auth.service.refresh(tokens.refreshToken,randomUUID());
  await assert.rejects(f.make().complete(r.input,r.key),{code:'recovery_expired'});
  assert.equal(await countSessions(tokens.session.subjectId),1);
 }
});

test('corrupt response remains intact and cannot create a replacement session',async()=>{
 const f=await fixture(),r=await f.request(),tokens=await f.make().complete(r.input,r.key);
 await db.app.query("UPDATE siyue.apple_login_flows SET response_ciphertext='corrupt' WHERE id=$1",[r.input.flowId]);
 await assert.rejects(f.make().complete(r.input,r.key),{code:'recovery_expired'});
 assert.equal((await flowRow(r.input.flowId)).response_ciphertext,'corrupt');assert.equal(await countSessions(tokens.session.subjectId),1);
});

test('flow expiry during session completion rolls back all account writes',async()=>{
 const f=await fixture(),r=await f.request();
 const slow={...f.auth.service,issue:async(...args)=>{const tokens=await f.auth.service.issue(...args);f.auth.advance(300000);return tokens;}};
 await assert.rejects(f.make(slow).complete(r.input,r.key),{code:'restart_required'});
 assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.external_identities WHERE provider_subject=$1',[f.subject])).rows[0].n,0);
 assert.equal((await flowRow(r.input.flowId)).completed_session_id,null);assert.equal(f.exchanges(),1);
});


test('two distinct flows for the same Apple identity create one subject and two deliberate sessions',async()=>{
 const f=await fixture(),a=await f.request(),b=await f.request();
 await Promise.all([f.preparation.prepare(a.input,a.key),f.preparation.prepare(b.input,b.key)]);
 const [first,second]=await Promise.all([f.make().complete(a.input,a.key),f.make().complete(b.input,b.key)]);
 assert.equal(first.session.subjectId,second.session.subjectId);assert.notEqual(first.session.sessionId,second.session.sessionId);
 assert.equal(await countSessions(first.session.subjectId),2);
});

test('completion just before authorization expiry still has its own bounded response recovery window',async()=>{
 const f=await fixture(),r=await f.request();await f.preparation.prepare(r.input,r.key);
 f.auth.advance(299000);const tokens=await f.make().complete(r.input,r.key);
 f.auth.advance(2000);await f.storage.cleanup();assert.deepEqual(await f.make().complete(r.input,r.key),tokens);
 f.auth.advance(58000);await assert.rejects(f.make().complete(r.input,r.key),{code:'recovery_expired'});
});

test('response-cache encryption failure rolls back the issued session and identity',async()=>{
 const f=await fixture(),r=await f.request();
 const cipher={open:f.auth.cipher.open.bind(f.auth.cipher),seal(value,context){if(context.startsWith('apple-response:'))throw Error('synthetic cache encryption failure');return f.auth.cipher.seal(value,context);}};
 const storage=createAppleFlowStorage(db.app,cipher,clientId,f.auth.clock);
 await assert.rejects(f.make(f.auth.service,storage).complete(r.input,r.key),/cache encryption failure/);
 assert.equal((await flowRow(r.input.flowId)).status,'verified');
 assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.external_identities WHERE provider_subject=$1',[f.subject])).rows[0].n,0);
 const tokens=await f.make().complete(r.input,r.key);assert.equal(await countSessions(tokens.session.subjectId),1);assert.equal(f.exchanges(),1);
});

test('success-audit failure rolls back account and session before response recovery is published',async()=>{
 const f=await fixture(),r=await f.request();
 await assert.rejects(f.make().complete(r.input,r.key,undefined,async()=>{throw Error('synthetic audit unavailable');}),/audit unavailable/);
 assert.equal((await flowRow(r.input.flowId)).status,'verified');
 assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.external_identities WHERE provider_subject=$1',[f.subject])).rows[0].n,0);
 const tokens=await f.make().complete(r.input,r.key);assert.equal(await countSessions(tokens.session.subjectId),1);assert.equal(f.exchanges(),1);
});
