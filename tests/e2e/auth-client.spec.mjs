import {test,expect} from 'playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture,password} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
import {createAuthApiClient,createAuthController,createAccountWorkspace} from '../../packages/adapters/dist/index.js';
import {transaction} from '../../apps/server/dist/adapters/postgres/database.js';
import {resumeAccountAuth} from '../../apps/mobile/src/account/foreground-auth.ts';
import {createAppleRequestGate} from '../../apps/server/dist/identities/apple/request-gate.js';
import {createAppleFlowStorage} from '../../apps/server/dist/identities/apple/flow-storage.js';
import {createAppleIdentityStorage} from '../../apps/server/dist/identities/apple/identity-storage.js';
import {createAppleLoginPreparation} from '../../apps/server/dist/identities/apple/prepare-login.js';
import {createAppleLoginService} from '../../apps/server/dist/identities/apple/login-service.js';
let db,fx,app,address,controllers,appleApps;
test.beforeAll(async()=>{db=await startPostgresFixture();});
test.beforeEach(async()=>{
 await db.admin.query('TRUNCATE siyue.subjects,siyue.email_challenges,siyue.idempotency_records,siyue.rate_limit_buckets,siyue.outbox_jobs,siyue.security_events CASCADE');
 fx=await createEmailFixture(db);controllers=[];appleApps=[];
 app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});address=await app.listen({host:'127.0.0.1',port:0});
});
test.afterEach(async()=>{for(const item of controllers)await item.dispose();await app?.close();
 for(const item of appleApps)await item.close();appleApps=[];});
test.afterAll(async()=>{await db?.stop();});
function memoryVault() {
 let value=null;return {read:async()=>value,write:async next=>{value=next;},raw:()=>value};
}
function create(vault=memoryVault(),fetcher=fetch,extra={},base=address) {
 const api=createAuthApiClient({environment:'test',apiBaseUrl:base+'/v1',fetcher});
 const host=createAuthController({api,vault,newId:randomUUID,now:()=>+fx.clock(),...extra});controllers.push(host);return {host,vault,api};
}
test('device controller revokes another session with password grant, then clears local recovery after self revocation',async()=>{
 const {host,vault}=create();const current=await login(host);
 const other=await transaction(db.app,client=>fx.service.issue(client,current.subjectId,randomUUID(),'email'));
 const listed=await host.deviceSessions();expect(listed.items.some(item=>item.sessionId===other.session.sessionId)).toBe(true);
 await host.revokeDeviceSession(other.session.sessionId,password);
 expect((await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',[other.session.sessionId])).rows[0].revoked_at).not.toBeNull();
 expect(host.getState().status).toBe('authenticated');
 await host.revokeDeviceSession(current.sessionId);
 expect(host.getState().status).toBe('anonymous');expect(JSON.parse(vault.raw()).active).toBeNull();
 await host.dispose();const restarted=create(vault).host;await restarted.bootstrap();expect(restarted.getState().status).toBe('anonymous');
});

test('device revoke preserves recovery bytes and reports secure storage failure if local clearing fails',async()=>{
 const base=memoryVault();let failing=false;
 const vault={read:base.read,write:async value=>{if(failing&&JSON.parse(value).active===null)throw Error('synthetic disk failure');await base.write(value);}};
 const {host}=create(vault);const current=await login(host);const previous=base.raw();failing=true;
 await expect(host.revokeDeviceSession(current.sessionId)).rejects.toMatchObject({code:'storage_unavailable'});
 expect(host.getState().status).toBe('secure-storage-unavailable');expect(base.raw()).toBe(previous);
 expect((await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',[current.sessionId])).rows[0].revoked_at).not.toBeNull();
});
test('revoke-all requires the current password and removes every owned session and local recovery',async()=>{
 const {host,vault}=create();const current=await login(host);
 const other=await transaction(db.app,client=>fx.service.issue(client,current.subjectId,randomUUID(),'email'));
 await expect(host.revokeAllDeviceSessions('wrong synthetic password')).rejects.toMatchObject({code:'invalid_credentials'});
 expect(host.getState().status).toBe('authenticated');
 await host.revokeAllDeviceSessions(password);
 expect(host.getState().status).toBe('anonymous');expect(JSON.parse(vault.raw()).active).toBeNull();
 expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL',[current.subjectId])).rows[0].n).toBe(0);
 await host.dispose();const restarted=create(vault).host;await restarted.bootstrap();expect(restarted.getState().status).toBe('anonymous');
});
test('lost revoke-all response reconciles server revocation before clearing local recovery',async()=>{
 const vault=memoryVault();let lose=false;
 const fetcher=async(url,init)=>{const response=await fetch(url,init);if(lose&&url.endsWith('/me/sessions/revoke-all')&&response.status===204){lose=false;throw Error('synthetic lost response');}return response;};
 const {host}=create(vault,fetcher);const current=await login(host);lose=true;
 await expect(host.revokeAllDeviceSessions(password)).rejects.toMatchObject({code:'reauth_required'});
 expect(host.getState().status).toBe('anonymous');expect(JSON.parse(vault.raw()).active).toBeNull();
 expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL',[current.subjectId])).rows[0].n).toBe(0);
 await host.dispose();const restarted=create(vault).host;await restarted.bootstrap();expect(restarted.getState().status).toBe('anonymous');
});
test('action denial with a still-valid refresh does not erase the account recovery record',async()=>{
 const vault=memoryVault();let deny=false;
 const fetcher=(url,init)=>deny&&url.endsWith('/me/sessions/revoke-all')?Promise.resolve(new Response(JSON.stringify({error:{code:'AUTH_REAUTH_REQUIRED'}}),{status:401,headers:{'content-type':'application/json'}})):fetch(url,init);
 const {host}=create(vault,fetcher);const current=await login(host);deny=true;
 await expect(host.revokeAllDeviceSessions(password)).rejects.toMatchObject({code:'reauth_required'});
 expect(host.getState().status).toBe('authenticated');expect(JSON.parse(vault.raw()).active.sessionId).toBe(current.sessionId);
 expect((await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',[current.sessionId])).rows[0].revoked_at).toBeNull();
});
async function login(host,email='host@example.test') {
 await fx.register(email);await host.bootstrap();await host.login({email,password,platform:'ios'});return host.getState().session;
}

test('client persists only refresh material, cold start and ten consumers share one rotation',async()=>{
 const vault=memoryVault();let refreshes=0;
 const fetcher=async(url,init)=>{if(url.endsWith('/auth/refresh'))refreshes++;return fetch(url,init);};
 const {host}=create(vault,fetcher);const original=await login(host);
 expect(vault.raw()).not.toContain('accessToken');expect(vault.raw()).not.toContain(password);expect(vault.raw()).not.toContain('Bearer');
 await host.dispose();const restarted=create(vault,fetcher).host;await restarted.bootstrap();expect(refreshes).toBe(1);
 expect(restarted.getState().session.subjectId).toBe(original.subjectId);
 fx.advance(15*60_000);
 const sessions=await Promise.all(Array.from({length:10},()=>restarted.session()));
 expect(sessions.every(item=>item.sessionId===original.sessionId)).toBe(true);expect(refreshes).toBe(2);
});

test('lost refresh response survives restart with same persisted rotationId, never a second successor',async()=>{
 const vault=memoryVault();let drop=false;const ids=[];
 const fetcher=async(url,init)=>{
  const response=await fetch(url,init);
  if(url.endsWith('/auth/refresh')) {ids.push(JSON.parse(init.body).rotationId);if(drop){drop=false;throw Error('synthetic response lost');}}
  return response;
 };
 const {host}=create(vault,fetcher);const original=await login(host);fx.advance(15*60_000);drop=true;
 await expect(host.session()).rejects.toMatchObject({code:'network'});
 const pending=JSON.parse(vault.raw()).active.pendingRotationId;expect(pending).toBeTruthy();
 await host.dispose();const restarted=create(vault,fetcher).host;await restarted.bootstrap();
 expect(ids).toEqual([pending,pending]);expect(restarted.getState().status).toBe('authenticated');
 expect((await db.app.query('SELECT * FROM siyue.refresh_tokens WHERE session_id=$1',[original.sessionId])).rowCount).toBe(2);
});

test('successor storage failure does not announce login; old pending proof can recover after restart',async()=>{
 const base=memoryVault();let failing=false;
 const vault={read:base.read,write:async next=>{const record=JSON.parse(next);if(failing&&record.active?.pendingRotationId===null)throw Error('synthetic storage failure');await base.write(next);}};
 const {host}=create(vault);await login(host);fx.advance(15*60_000);failing=true;
 await expect(host.session()).rejects.toMatchObject({code:'storage_unavailable'});expect(host.getState().status).toBe('secure-storage-unavailable');
 expect(JSON.parse(base.raw()).active.pendingRotationId).toBeTruthy();failing=false;
 await host.dispose();const restarted=create(vault).host;await restarted.bootstrap();expect(restarted.getState().status).toBe('authenticated');
});

test('offline logout persists a tombstone, reboot cannot authenticate from revocation queue, reconnect revokes old session',async()=>{
 const vault=memoryVault();let offline=false;
 const fetcher=(url,init)=>{if(offline)throw Error('synthetic offline');return fetch(url,init);};
 const {host}=create(vault,fetcher);const original=await login(host);offline=true;
 expect(await host.logout()).toEqual({local:true,server:'pending'});expect(host.getState().status).toBe('anonymous');
 const saved=JSON.parse(vault.raw());expect(saved.active).toBeNull();expect(saved.revocations).toHaveLength(1);
 await host.dispose();const restarted=create(vault,fetcher).host;await restarted.bootstrap();expect(restarted.getState().status).toBe('anonymous');
 offline=false;await restarted.drainRevocations();expect(JSON.parse(vault.raw()).revocations).toHaveLength(0);
 expect((await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',[original.sessionId])).rows[0].revoked_at).not.toBeNull();
});

test('malformed vault and environment mismatch preserve original bytes without network or empty replacement',async()=>{
 for(const raw of ['{bad','{"schemaVersion":99}']) {
  let writes=0,calls=0;
  const {host}=create({read:async()=>raw,write:async()=>{writes++;}},async()=>{calls++;throw Error('should not reach network');});
  await expect(host.bootstrap()).rejects.toMatchObject({code:'storage_corrupt'});expect(host.getState().status).toBe('secure-storage-unavailable');expect(writes).toBe(0);expect(calls).toBe(0);
 }
 const base=memoryVault();const first=create(base).host;await first.bootstrap();const raw=JSON.parse(base.raw());raw.apiBaseUrl='https://evil.invalid/v1';await base.write(JSON.stringify(raw));
 const second=create(base).host;await expect(second.bootstrap()).rejects.toMatchObject({code:'storage_corrupt'});expect(JSON.parse(base.raw()).apiBaseUrl).toBe('https://evil.invalid/v1');
});

test('late old account query is discarded after switching, new identity and stored credentials remain intact',async()=>{
 await fx.register('account-b@example.test');let pause=false,release,arrived;
 const seen=new Promise(resolve=>{arrived=resolve;});
 const fetcher=async(url,init)=>{
  const response=await fetch(url,init);
  if(pause&&url.endsWith('/account/session')) {pause=false;arrived();await new Promise(resolve=>{release=resolve;});}
  return response;
 };
 const {host,vault}=create(undefined,fetcher);const a=await login(host);pause=true;
 const pending=host.session();const denied=expect(pending).rejects.toMatchObject({code:'cancelled'});await seen;
 try {
  await host.login({email:'account-b@example.test',password,platform:'android'});const b=host.getState().session;
  expect(b.subjectId).not.toBe(a.subjectId);release();await denied;
  expect(host.getState().session.subjectId).toBe(b.subjectId);expect(JSON.parse(vault.raw()).active.subjectId).toBe(b.subjectId);
 }finally{release?.();}
});

test('login does not publish authenticated until durable write; failure compensates only newly issued session',async()=>{
 const base=memoryVault();const vault={read:base.read,write:async value=>{if(JSON.parse(value).active)throw Error('synthetic full disk');await base.write(value);}};
 const {host}=create(vault);const user=await fx.register('full@example.test');await host.bootstrap();
 await expect(host.login({email:user.address,password,platform:'ios'})).rejects.toMatchObject({code:'storage_unavailable'});
 expect(host.getState().session).toBeNull();expect(host.getState().status).toBe('secure-storage-unavailable');expect(JSON.parse(base.raw()).active).toBeNull();
 const sessions=(await db.app.query('SELECT * FROM siyue.auth_sessions WHERE subject_id=$1',[user.tokens.session.subjectId])).rows;
 expect(sessions.filter(item=>item.revoked_at===null)).toHaveLength(1);expect(sessions.find(item=>item.revoked_at===null).id).toBe(user.tokens.session.sessionId);
});

test('storage deadline reports unavailable while a late native write retains exclusive ordering',async()=>{
 const base=memoryVault();let paused=false,release,arrived;
 const seen=new Promise(resolve=>{arrived=resolve;});
 const vault={read:base.read,write:async value=>{
  if(paused&&JSON.parse(value).active){paused=false;arrived();await new Promise(resolve=>{release=resolve;});}
  await base.write(value);
 }};
 const {host}=create(vault,fetch,{storageTimeoutMs:30});await fx.register('slow-vault@example.test');await host.bootstrap();paused=true;
 const loginAttempt=host.login({email:'slow-vault@example.test',password,platform:'ios'});
 const failed=expect(loginAttempt).rejects.toMatchObject({code:'storage_unavailable'});await seen;await failed;
 expect(host.getState().session).toBeNull();expect(host.getState().status).toBe('secure-storage-unavailable');
 const logoutAttempt=host.logout();release();expect((await logoutAttempt).local).toBe(true);
 expect(JSON.parse(base.raw()).active).toBeNull();expect(host.getState().status).toBe('anonymous');
});

test('logout storage failure never reports successful local sign-out or overwrites original',async()=>{
 const base=memoryVault();let failing=false;
 const vault={read:base.read,write:async value=>{if(failing)throw Error('synthetic unavailable');await base.write(value);}};
 const {host}=create(vault);await login(host);const original=base.raw();failing=true;
 await expect(host.logout()).rejects.toMatchObject({code:'storage_unavailable'});expect(host.getState().status).toBe('secure-storage-unavailable');expect(base.raw()).toBe(original);
 failing=false;expect((await host.logout()).local).toBe(true);expect(JSON.parse(base.raw()).active).toBeNull();
});

test('server outage preserves recovery and returns unavailable, explicit revocation requires new authentication',async()=>{
 const vault=memoryVault();let unavailable=false;
 const {host}=create(vault,(url,init)=>unavailable?Promise.resolve(new Response('',{status:503})):fetch(url,init));
 const session=await login(host);const original=vault.raw();unavailable=true;
 await expect(host.session()).rejects.toMatchObject({code:'unavailable'});expect(host.getState().status).toBe('service-unavailable');expect(vault.raw()).toBe(original);
 unavailable=false;await db.app.query("UPDATE siyue.auth_sessions SET revoked_at=$2 WHERE id=$1",[session.sessionId,fx.clock()]);
 await expect(host.bootstrap()).rejects.toMatchObject({code:'reauth_required'});expect(host.getState().status).toBe('reauth-required');expect(host.getState().session).toBeNull();
});

test('disposed controller cannot clear or overwrite a replacement vault from a late revocation response',async()=>{
 const vault=memoryVault();let hold=false,release,arrived;
 const seen=new Promise(resolve=>{arrived=resolve;});
 const fetcher=async(url,init)=>{
  const response=await fetch(url,init);
  if(hold&&url.endsWith('/auth/logout')) {hold=false;arrived();await new Promise(resolve=>{release=resolve;});}
  return response;
 };
 const {host}=create(vault,fetcher);await login(host,'owner-a@example.test');await fx.register('owner-b@example.test');hold=true;
 await host.login({email:'owner-b@example.test',password,platform:'ios'});await seen;
 const ownerB=host.getState().session.subjectId;
 try {
  await host.dispose();const replacement=create(vault).host;await replacement.bootstrap();const saved=vault.raw();
  release();await new Promise(resolve=>setImmediate(resolve));
  expect(replacement.getState().session.subjectId).toBe(ownerB);expect(vault.raw()).toBe(saved);
 }finally{release?.();}
});

test('late logout completion cannot report success in a newly signed-in account context',async()=>{
 let release,arrived,hold=false;
 const seen=new Promise(resolve=>{arrived=resolve;});
 const fetcher=async(url,init)=>{
  const response=await fetch(url,init);
  if(hold&&url.endsWith('/auth/logout')){hold=false;arrived();await new Promise(resolve=>{release=resolve;});}
  return response;
 };
 const {host,vault}=create(undefined,fetcher);await login(host,'logout-a@example.test');
 await fx.register('logout-b@example.test');hold=true;
 const pending=host.logout();await seen;
 try {
  await host.login({email:'logout-b@example.test',password,platform:'ios'});
  const identity=host.getState().session.subjectId;
  const cancelled=expect(pending).rejects.toMatchObject({code:'cancelled'});release();await cancelled;
  expect(host.getState().status).toBe('authenticated');
  expect(JSON.parse(vault.raw()).active.subjectId).toBe(identity);
 }finally{release?.();}
});

 test('mobile foreground revalidation retains the live account generation and detects revocation',async()=>{
 let offline=false;const {host}=create(undefined,(url,init)=>{if(offline)throw Error('synthetic offline');return fetch(url,init);});
 const original=await login(host);const generation=host.getState().generation;const observations=[];
 const workspace=createAccountWorkspace({auth:host,environment:'test',catalog:{find:async()=>null},open:async()=>({client:{},close:async()=>{}})});
 await workspace.start();const resource=workspace.client(),revision=workspace.getState().revision;
 const unsubscribe=host.subscribe(()=>observations.push(host.getState()));
 try{
  await resumeAccountAuth(host);
  expect(host.getState().generation).toBe(generation);
  expect(observations.every(state=>state.account?.subjectId===original.subjectId)).toBe(true);
  fx.advance(15*60_000);await resumeAccountAuth(host);
  expect(host.getState().generation).toBe(generation);expect(host.getState().status).toBe('authenticated');
  offline=true;await expect(resumeAccountAuth(host)).rejects.toMatchObject({code:'network'});
  expect(host.getState().status).toBe('offline-available');offline=false;await resumeAccountAuth(host);
  expect(host.getState().status).toBe('authenticated');expect(host.getState().generation).toBe(generation);
  expect(observations.every(state=>state.account?.subjectId===original.subjectId)).toBe(true);
  expect(workspace.getState().revision).toBe(revision);expect(workspace.client()).toBe(resource);
  await db.app.query('UPDATE siyue.auth_sessions SET revoked_at=now() WHERE id=$1',[original.sessionId]);
  await expect(resumeAccountAuth(host)).rejects.toMatchObject({code:'reauth_required'});
  expect(host.getState().status).toBe('reauth-required');
  await expect.poll(()=>workspace.getState().status).toBe('ready');
  expect(workspace.getState().revision).toBeGreaterThan(revision);expect(workspace.client()).not.toBe(resource);
 }finally{unsubscribe();await workspace.dispose();}
 });

test('Apple remains unavailable while its complete authorization flow is not wired',async()=>{
 const {api}=create();expect((await api.providers()).apple.enabled).toBe(false);
 for(const route of ['start','complete']){
  const reply=await fetch(address+'/v1/auth/apple/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({purpose:'login',platform:'ios',installationId:'synthetic'})});
  expect(reply.status).toBe(404);
 }
 expect((await db.app.query('SELECT count(*)::int AS count FROM siyue.subjects')).rows[0].count).toBe(0);
});

// --- Apple-only first email link: shared controller path over real HTTP and an isolated
// temporary PostgreSQL cluster. Apple verification and code exchange are synthetic local
// adapters (no real Apple endpoint), and the mailbox is read from the encrypted outbox.

const appleClientId='app.siyue.mobile',appleNamespace='synthetic-team',linkEmail='first-email@example.test';
const linkPassword='第一次绑定登录邮箱的合成密码 🌙';
let verifiedSubject;
const appleAuthorize=async input=>({state:input.state,identityToken:'synthetic.header.payload',authorizationCode:'synthetic-authorization-code'});
/** A second runtime app on the same pool that also wires the Apple reauth routes; the shared app
 *  stays email-only so the "Apple wiring absent" regression case still sees 404s. */
async function withApple() {
 const storage=createAppleFlowStorage(db.app,fx.cipher,appleClientId,fx.clock);
 const preparation=createAppleLoginPreparation({storage,clock:fx.clock,requestPepper:randomBytes(32),
  verify:async()=>({provider:'apple',subject:verifiedSubject,clientId:appleClientId}),
  exchange:async()=>({identity:{provider:'apple',subject:verifiedSubject,clientId:appleClientId},refreshToken:'synthetic-provider-secret'})});
 const service=createAppleLoginService({preparation,storage,identities:createAppleIdentityStorage(fx.cipher,appleNamespace,fx.clock),sessions:fx.service});
 const instance=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email,apple:{service,gate:createAppleRequestGate(db.app,randomBytes(32),fx.clock)}});
 appleApps.push(instance);
 return {app:instance,address:await instance.listen({host:'127.0.0.1',port:0})};
}
const rowCount=async(sql,...params)=>Number((await db.app.query(sql,params.length===1&&Array.isArray(params[0])?params[0]:params)).rows[0].n);
/** The verification code the link-email challenge produced, decrypted from the local outbox job. */
async function mailedCode(challengeId) {
 const job=(await db.app.query('SELECT * FROM siyue.outbox_jobs WHERE aggregate_id=$1',[challengeId])).rows[0];
 expect(job).toBeDefined();
 return fx.cipher.open(job.payload_ciphertext,`mail:${job.id}`).code;
}
const challengeKeys=['challengeId','expiresAt','requestSecret','resendAfterSeconds'];

test('Apple-only account links its first email through one in-call reauth grant',async()=>{
 verifiedSubject=randomUUID();const apple=await withApple();
 const {host,vault}=create(memoryVault(),fetch,{},apple.address);
 await host.bootstrap();await host.loginApple(appleAuthorize);
 const before=host.getState();
 expect(before.status).toBe('authenticated');expect(before.account.subjectKind).toBe('adult');
 const initialMethods=await host.loginMethods();
 expect(initialMethods.items).toHaveLength(1);expect(initialMethods.items[0].kind).toBe('apple');
 const challenge=await host.requestEmailLinkWithApple({email:linkEmail,locale:'zh-CN'},appleAuthorize,randomUUID());
 expect(Object.keys(challenge).sort()).toEqual(challengeKeys);
 // The grant is spent inside the call: never returned, never persisted, session untouched.
 expect(vault.raw()).not.toContain('reauthGrant');expect(vault.raw()).not.toContain('Bearer');
 expect(host.getState().generation).toBe(before.generation);
 expect(host.getState().session.sessionId).toBe(before.session.sessionId);
 expect(host.getState().account.subjectId).toBe(before.account.subjectId);
 const grants=await db.app.query('SELECT action,session_id,consumed_at FROM siyue.reauth_grants WHERE session_id=$1',[before.session.sessionId]);
 expect(grants.rows).toHaveLength(1);expect(grants.rows[0].action).toBe('link-identity');expect(grants.rows[0].consumed_at).not.toBeNull();
 const stored=await db.app.query('SELECT purpose,subject_id,status FROM siyue.email_challenges WHERE email_normalized=$1',[linkEmail]);
 expect(stored.rows).toHaveLength(1);
 expect(stored.rows[0]).toMatchObject({purpose:'link-email',status:'pending'});
 expect(stored.rows[0].subject_id).toBe(before.account.subjectId);
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.outbox_jobs WHERE aggregate_id=$1',challenge.challengeId)).toBe(1);
 await host.confirmEmailLink({challengeId:challenge.challengeId,requestSecret:challenge.requestSecret,code:await mailedCode(challenge.challengeId),newPassword:linkPassword},randomUUID());
 const linked=await db.app.query('SELECT subject_id FROM siyue.account_emails WHERE email_normalized=$1',[linkEmail]);
 expect(linked.rows).toHaveLength(1);expect(linked.rows[0].subject_id).toBe(before.account.subjectId);
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.subjects')).toBe(1);
 expect(host.getState().status).toBe('authenticated');expect(host.getState().session.sessionId).toBe(before.session.sessionId);
 const linkedMethods=await host.loginMethods();
 expect(linkedMethods.items.map(item=>item.kind)).toEqual(['email_password','apple']);
 expect(linkedMethods.items[0].emailMask).toBe('f•••@example.test');
 // The new login method resolves the same subject from another platform.
 const other=create(memoryVault(),fetch,{},apple.address);
 await other.host.bootstrap();await other.host.login({email:linkEmail,password:linkPassword,platform:'android'});
 expect(other.host.getState().session.subjectId).toBe(before.account.subjectId);
 expect((await db.app.query('SELECT subject_id FROM siyue.account_emails WHERE email_normalized=$1',[linkEmail])).rows).toHaveLength(1);
});

test('shared client unlinks the email method through real HTTP and clears the revoked local session',async()=>{
 verifiedSubject=randomUUID();const apple=await withApple();const {host,vault}=create(memoryVault(),fetch,{},apple.address);
 await host.bootstrap();await host.loginApple(appleAuthorize);
 const subjectId=host.getState().session.subjectId;
 const challenge=await host.requestEmailLinkWithApple({email:linkEmail,locale:'zh-CN'},appleAuthorize,randomUUID());
 await host.confirmEmailLink({challengeId:challenge.challengeId,requestSecret:challenge.requestSecret,code:await mailedCode(challenge.challengeId),newPassword:linkPassword},randomUUID());
 const emailMethod=(await host.loginMethods()).items.find(item=>item.kind==='email_password');expect(emailMethod).toBeDefined();
 await host.unlinkIdentity(emailMethod.identityId,linkPassword);
 expect(host.getState().status).toBe('anonymous');expect(JSON.parse(vault.raw()).active).toBeNull();
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',subjectId)).toBe(0);
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL',subjectId)).toBe(0);
 await host.loginApple(appleAuthorize);
 expect(host.getState().session.subjectId).toBe(subjectId);
 expect((await host.loginMethods()).items.map(item=>item.kind)).toEqual(['apple']);
});

test('lost shared-client unlink response never resends DELETE and reconciles the revoked session',async()=>{
 verifiedSubject=randomUUID();const apple=await withApple();let lose=false,deletes=0;
 const fetcher=async(url,init)=>{const response=await fetch(url,init);
  if(url.includes('/me/identities/')&&init.method==='DELETE'){deletes++;if(lose&&response.status===204){lose=false;throw Error('synthetic lost unlink response');}}
  return response;};
 const {host,vault}=create(memoryVault(),fetcher,{},apple.address);
 await host.bootstrap();await host.loginApple(appleAuthorize);
 const challenge=await host.requestEmailLinkWithApple({email:linkEmail,locale:'zh-CN'},appleAuthorize,randomUUID());
 await host.confirmEmailLink({challengeId:challenge.challengeId,requestSecret:challenge.requestSecret,code:await mailedCode(challenge.challengeId),newPassword:linkPassword},randomUUID());
 const emailMethod=(await host.loginMethods()).items.find(item=>item.kind==='email_password');expect(emailMethod).toBeDefined();
 lose=true;
 await expect(host.unlinkIdentity(emailMethod.identityId,linkPassword)).rejects.toMatchObject({code:'reauth_required'});
 expect(deletes).toBe(1);expect(host.getState().status).toBe('anonymous');expect(JSON.parse(vault.raw()).active).toBeNull();
 expect(await rowCount("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='identity.unlink-email' AND outcome='success'")).toBe(1);
});

test('a lost Apple reauth completion resumes the same key without repeating native authorization',async()=>{
 verifiedSubject=randomUUID();const apple=await withApple();
 let lose=false,completes=0,native=0;
 const fetcher=async(url,init)=>{const response=await fetch(url,init);
  if(url.endsWith('/auth/apple/complete')){completes++;if(lose){lose=false;throw Error('synthetic lost completion');}}
  return response;};
 const authorize=async input=>{native++;return appleAuthorize(input);};
 const {host}=create(memoryVault(),fetcher,{},apple.address);
 await host.bootstrap();await host.loginApple(appleAuthorize);
 const sessionId=host.getState().session.sessionId,key=randomUUID();
 lose=true;
 await expect(host.requestEmailLinkWithApple({email:linkEmail,locale:'zh-CN'},authorize,key)).rejects.toMatchObject({code:'network'});
 expect(native).toBe(1);expect(completes).toBe(2);
 const challenge=await host.requestEmailLinkWithApple({email:linkEmail,locale:'zh-CN'},authorize,key);
 expect(native).toBe(1);expect(completes).toBe(3);
 expect(Object.keys(challenge).sort()).toEqual(challengeKeys);
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE session_id=$1',[sessionId])).toBe(1);
 expect(await rowCount("SELECT count(*)::int AS n FROM siyue.apple_login_flows WHERE purpose='reauth' AND session_id=$1",[sessionId])).toBe(1);
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE purpose=$1',['link-email'])).toBe(1);
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.outbox_jobs WHERE aggregate_id=$1',[challenge.challengeId])).toBe(1);
 await host.confirmEmailLink({challengeId:challenge.challengeId,requestSecret:challenge.requestSecret,code:await mailedCode(challenge.challengeId),newPassword:linkPassword},randomUUID());
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.account_emails WHERE email_normalized=$1',[linkEmail])).toBe(1);
});

test('a lost email link response returns the accepted challenge without another grant',async()=>{
 verifiedSubject=randomUUID();const apple=await withApple();
 let lose=false,completes=0,native=0;
 const fetcher=async(url,init)=>{const response=await fetch(url,init);
  if(url.endsWith('/auth/apple/complete'))completes++;
  if(lose&&url.endsWith('/me/email/link/request')){lose=false;throw Error('synthetic lost link response');}
  return response;};
 const authorize=async input=>{native++;return appleAuthorize(input);};
 const {host}=create(memoryVault(),fetcher,{},apple.address);
 await host.bootstrap();await host.loginApple(appleAuthorize);
 const sessionId=host.getState().session.sessionId,key=randomUUID();
 lose=true;
 await expect(host.requestEmailLinkWithApple({email:linkEmail,locale:'zh-CN'},authorize,key)).rejects.toMatchObject({code:'network'});
 const challenge=await host.requestEmailLinkWithApple({email:linkEmail,locale:'zh-CN'},authorize,key);
 expect(native).toBe(1);expect(completes).toBe(2);
 const stored=await db.app.query('SELECT id,purpose FROM siyue.email_challenges WHERE email_normalized=$1',[linkEmail]);
 expect(stored.rows).toHaveLength(1);expect(stored.rows[0]).toMatchObject({id:challenge.challengeId,purpose:'link-email'});
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.outbox_jobs WHERE aggregate_id=$1',[challenge.challengeId])).toBe(1);
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE session_id=$1',[sessionId])).toBe(1);
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE purpose=$1',['link-email'])).toBe(1);
 await host.confirmEmailLink({challengeId:challenge.challengeId,requestSecret:challenge.requestSecret,code:await mailedCode(challenge.challengeId),newPassword:linkPassword},randomUUID());
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.account_emails WHERE email_normalized=$1',[linkEmail])).toBe(1);
});

test('logout cancels the Apple reauth link flow and the same key cannot resume it',async()=>{
 verifiedSubject=randomUUID();const apple=await withApple();
 let native=0,release,entered;
 const gate=new Promise(resolve=>{release=resolve;}),seen=new Promise(resolve=>{entered=resolve;});
 const authorize=async input=>{native++;entered();return gate.then(()=>appleAuthorize(input));};
 const {host,vault}=create(memoryVault(),fetch,{},apple.address);
 await host.bootstrap();await host.loginApple(appleAuthorize);
 const sessionId=host.getState().session.sessionId,subjectId=host.getState().account.subjectId,key=randomUUID();
 const pending=host.requestEmailLinkWithApple({email:linkEmail,locale:'zh-CN'},authorize,key);
 await seen;await host.logout();release();
 await expect(pending).rejects.toMatchObject({code:'cancelled'});
 expect(native).toBe(1);
 expect(host.getState().status).toBe('anonymous');expect(JSON.parse(vault.raw()).active).toBeNull();
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE session_id=$1',[sessionId])).toBe(0);
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE subject_id=$1',[subjectId])).toBe(0);
 // The abandoned flow stays pending and cannot complete itself; the account gains no login email.
 expect((await db.app.query("SELECT status FROM siyue.apple_login_flows WHERE purpose='reauth' AND session_id=$1",[sessionId])).rows).toEqual([{status:'pending'}]);
 await host.loginApple(appleAuthorize);
 await host.requestEmailLinkWithApple({email:linkEmail,locale:'zh-CN'},authorize,key);
 expect(native).toBe(2);
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE purpose=$1',['link-email'])).toBe(1);
 expect(host.getState().status).toBe('authenticated');expect(host.getState().account.subjectId).toBe(subjectId);
});

test('Apple-only controller revokes another device and then all sessions with distinct action grants',async()=>{
 verifiedSubject=randomUUID();const apple=await withApple();const {host,vault}=create(memoryVault(),fetch,{},apple.address);
 await host.bootstrap();await host.loginApple(appleAuthorize);
 const current=host.getState().session;
 const other=await transaction(db.app,client=>fx.service.issue(client,current.subjectId,randomUUID(),'apple'));
 await host.revokeDeviceSessionWithApple(other.session.sessionId,appleAuthorize,randomUUID());
 expect(host.getState().status).toBe('authenticated');
 expect((await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',[other.session.sessionId])).rows[0].revoked_at).not.toBeNull();
 const first=(await db.app.query('SELECT action,consumed_at FROM siyue.reauth_grants WHERE session_id=$1',[current.sessionId])).rows;
 expect(first).toHaveLength(1);expect(first[0].action).toBe('revoke-session');expect(first[0].consumed_at).not.toBeNull();
 await host.revokeAllDeviceSessionsWithApple(appleAuthorize,randomUUID());
 expect(host.getState().status).toBe('anonymous');expect(JSON.parse(vault.raw()).active).toBeNull();
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL',[current.subjectId])).toBe(0);
 const actions=(await db.app.query('SELECT action,consumed_at FROM siyue.reauth_grants WHERE session_id=$1 ORDER BY action',[current.sessionId])).rows;
 expect(actions.map(item=>item.action)).toEqual(['revoke-all-sessions','revoke-session']);
 expect(actions.every(item=>item.consumed_at!==null)).toBe(true);
 expect(vault.raw()).not.toContain('reauthGrant');
});

test('lost Apple-only revoke response is reported as unknown and the device list reconciles it',async()=>{
 verifiedSubject=randomUUID();const apple=await withApple();let lose=false,native=0;
 const fetcher=async(url,init)=>{const response=await fetch(url,init);if(lose&&url.includes('/me/sessions/')&&init?.method==='DELETE'&&response.status===204){lose=false;throw Error('synthetic lost revoke response');}return response;};
 const authorize=async input=>{native++;return appleAuthorize(input);};
 const {host,vault}=create(memoryVault(),fetcher,{},apple.address);
 await host.bootstrap();await host.loginApple(appleAuthorize);
 const current=host.getState().session;
 const other=await transaction(db.app,client=>fx.service.issue(client,current.subjectId,randomUUID(),'apple'));
 lose=true;
 await expect(host.revokeDeviceSessionWithApple(other.session.sessionId,authorize,randomUUID())).rejects.toMatchObject({code:'network'});
 expect(native).toBe(1);expect(host.getState().status).toBe('authenticated');
 expect(JSON.parse(vault.raw()).active.sessionId).toBe(current.sessionId);
 expect((await host.deviceSessions()).items.some(item=>item.sessionId===other.session.sessionId)).toBe(false);
 expect(await rowCount('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE session_id=$1',[current.sessionId])).toBe(1);
});

test('deletion controller previews the real account and preserves recovery while the formal route is closed',async()=>{
 const receipts=memoryVault();const {host,vault}=create(memoryVault(),fetch,{deletionReceiptVault:receipts});
 const account=await login(host,'deletion-controller@example.test');
 expect(await host.deletionImpact()).toEqual({subjectId:account.subjectId,families:[],guardianships:[],activeChildDeviceCount:0});
 const original=JSON.parse(vault.raw()).active;
 await expect(host.submitDeletionWithPassword(password,{kind:'none'})).rejects.toMatchObject({code:'unavailable'});
 expect(host.hasPendingDeletion()).toBe(true);
 expect(receipts.raw()).toBeNull();expect(JSON.parse(vault.raw()).active).toEqual(original);
 await expect(host.retryDeletion()).rejects.toMatchObject({code:'unavailable'});
 expect(receipts.raw()).toBeNull();expect(JSON.parse(vault.raw()).active).toEqual(original);
 expect((await host.session()).subjectId).toBe(account.subjectId);
 expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs WHERE subject_id=$1',[account.subjectId])).rows[0].n).toBe(0);
 expect(JSON.stringify(host.getState())).not.toMatch(/reauthGrant|receiptSecret|refreshToken|accessToken/);
});
