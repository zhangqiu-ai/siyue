import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {generateKeyPair,exportPKCS8} from 'jose';
import {RecoveryCipher} from '../../adapters/crypto/auth-crypto.js';
import {createAppleTokenRevocation,type AppleRevocationOutcome} from './revocation.js';
import {createAppleRevocationMemoryStore,createAppleRevocationOutbox} from './revocation-outbox.js';

const cipher=new RecoveryCipher('test',new Map([['test',randomBytes(32)]]));
const namespace='app.siyue.mobile',refresh='synthetic-apple-refresh-token',day=86_400_000;
const start=Date.parse('2026-09-22T00:00:00Z');
let time=start;
const clock=()=>new Date(time);
const advance=milliseconds=>{time+=milliseconds;};
beforeEach(()=>{time=start;});
/** The identity store seals a credential under this exact AAD, so a drift on either side fails here. */
const sealed=(identityId:string,providerNamespace=namespace)=>cipher.seal({refreshToken:refresh},'apple-identity:'+identityId+':'+providerNamespace);
const row=(identityId:string,refreshCiphertext:string)=>({identity_id:identityId,provider_namespace:namespace,refresh_ciphertext:refreshCiphertext});
/** Stand-in for the caller's transaction client; the boundary only reads through it. */
const transactionClient=(rows:Array<unknown>,queries:string[]=[])=>({query:async(sql:string)=>{queries.push(sql);return {rows};}}) as unknown as PoolClient;
const setup=async(options:{revoke?:(input:{refreshToken:string})=>Promise<AppleRevocationOutcome>;
 windowMs?:number;retryDelayMs?:number;maxRetryDelayMs?:number}={})=>{
 const store=createAppleRevocationMemoryStore(),calls:Array<{refreshToken:string}>=[],alerts:string[]=[];
 const revoke=options.revoke??(async(input:{refreshToken:string})=>{calls.push(input);return {outcome:'revoked'} as AppleRevocationOutcome;});
 // Only what a test actually specifies is forwarded, so the production defaults under test are the
 // module's own instead of a second copy inside this helper.
 const tuning:{windowMs?:number;retryDelayMs?:number;maxRetryDelayMs?:number}={};
 if(options.windowMs!==undefined)tuning.windowMs=options.windowMs;
 if(options.retryDelayMs!==undefined)tuning.retryDelayMs=options.retryDelayMs;
 if(options.maxRetryDelayMs!==undefined)tuning.maxRetryDelayMs=options.maxRetryDelayMs;
 const outbox=createAppleRevocationOutbox({store,cipher,revoke,clock,...tuning,alert:code=>alerts.push(code)});
 return {store,calls,alerts,outbox,job:()=>[...store.jobs.values()][0]};
};
const enqueue=(outbox:{enqueueForSubject:(client:PoolClient,input:{subjectId:string})=>Promise<{identities:number}>},
 identityId:string,ciphertext:string)=>outbox.enqueueForSubject(transactionClient([row(identityId,ciphertext)]),{subjectId:randomUUID()});

test('account deletion queues one revocation per live Apple identity and keeps only the sealed credential',async()=>{
 const {store,outbox}=await setup();
 const identityId=randomUUID(),ciphertext=sealed(identityId),queries:string[]=[];
 const result=await outbox.enqueueForSubject(transactionClient([row(identityId,ciphertext)],queries),{subjectId:randomUUID()});
 assert.deepEqual(result,{identities:1});
 // Only the subject's own live Apple identities that still carry a credential are read, and the rows
 // are locked so the accepted deletion and its queued revocation commit together.
 assert.equal(queries.length,1);
 assert.match(queries[0]!,/i\.provider='apple' AND i\.status='active'/);
 assert.match(queries[0]!,/FOR UPDATE OF i,c/);
 const queued=store.jobs.values().next().value!;
 assert.deepEqual(queued.job,{identityId,providerNamespace:namespace,refreshCiphertext:ciphertext});
 assert.deepEqual([queued.status,queued.attempts],['pending',0]);
 assert.equal(+queued.expiresAt-(+queued.availableAt),7*day);
 // The queued row keeps the sealed credential and never the plaintext provider token.
 assert.equal(JSON.stringify(queued).includes(refresh),false);
 // A repeated call for the same identity never opens a second job.
 await enqueue(outbox,identityId,ciphertext);
 assert.equal(store.jobs.size,1);
 await assert.rejects(outbox.enqueueForSubject(transactionClient([]),{subjectId:'not-a-uuid'}));
});

test('an over-limit identity set cannot be silently truncated before deletion acceptance',async()=>{
 const {store,outbox}=await setup();
 const rows=Array.from({length:33},()=>{const id=randomUUID();return row(id,sealed(id));});
 await assert.rejects(outbox.enqueueForSubject(transactionClient(rows),{subjectId:randomUUID()}),
  /apple_revocation_identity_limit/);
 assert.equal(store.jobs.size,0);
});

test('a confirmed revocation is terminal, sends the decrypted token once and destroys the seal',async()=>{
 const {store,calls,alerts,outbox,job}=await setup();
 const identityId=randomUUID();
 await enqueue(outbox,identityId,sealed(identityId));
 assert.equal(await outbox.tick(),'revoked');
 assert.deepEqual(calls,[{refreshToken:refresh}]);
 assert.deepEqual([job()!.status,job()!.attempts,job()!.job,job()!.lastErrorCode],['revoked',1,null,null]);
 assert.deepEqual(alerts,[]);
 // A terminal job is never claimed again, so one 200 cannot produce a second revoke.
 assert.equal(await outbox.tick(),undefined);
 assert.equal(calls.length,1);
});

test('a credential sealed for another identity, namespace or shape is never sent to Apple',async()=>{
 const identityId=randomUUID();
 const cases:Array<[string,string]>=[
  ['another identity',sealed(randomUUID())],
  ['another namespace',sealed(identityId,'app.siyue.desktop')],
  ['wrong credential shape',cipher.seal({token:refresh},'apple-identity:'+identityId+':'+namespace)],
 ];
 for(const [label,ciphertext] of cases){
  const {store,calls,alerts,outbox,job}=await setup();
  await enqueue(outbox,identityId,ciphertext);
  assert.equal(await outbox.tick(),'needs_attention',label);
  assert.deepEqual(calls,[],label);
  assert.deepEqual(alerts,['apple_revocation_needs_attention'],label);
  assert.deepEqual([job()!.status,job()!.lastErrorCode],['needs_attention','credential_unreadable'],label);
  assert.equal(await outbox.tick(),undefined,label);
  assert.equal(store.jobs.size,1,label);
 }
});

test('a provider outage backs off exponentially and never runs a second attempt in flight',async()=>{
 const calls:Array<{refreshToken:string}>=[];
 let outcome:AppleRevocationOutcome={outcome:'unavailable'};
 const {store,outbox,job}=await setup({retryDelayMs:1000,maxRetryDelayMs:8000,revoke:async input=>{calls.push(input);return outcome;}});
 const identityId=randomUUID();
 await enqueue(outbox,identityId,sealed(identityId));
 assert.equal(await outbox.tick(),'retry');
 assert.deepEqual([job()!.status,job()!.attempts,job()!.lastErrorCode],['pending',1,'apple_provider_unavailable']);
 assert.equal(+job()!.availableAt-(+clock()),1000);
 // Before the delay elapses the job is not claimable, so one provider attempt stays in flight.
 assert.equal(await outbox.tick(),undefined);
 assert.equal(calls.length,1);
 advance(1000);
 assert.equal(await outbox.tick(),'retry');
 assert.equal(calls.length,2);
 assert.equal(+job()!.availableAt-(+clock()),2000);
 outcome={outcome:'revoked'};
 advance(2000);
 assert.equal(await outbox.tick(),'revoked');
 assert.equal(calls.length,3);
 assert.deepEqual([job()!.status,job()!.job],['revoked',null]);
});

test('the bounded window ends retrying, destroys the seal and alerts exactly once',async()=>{
 const calls:Array<{refreshToken:string}>=[];
 const {store,alerts,outbox,job}=await setup({windowMs:60_000,retryDelayMs:60_000,maxRetryDelayMs:60_000,
  revoke:async input=>{calls.push(input);return {outcome:'unavailable'};}});
 const identityId=randomUUID();
 await enqueue(outbox,identityId,sealed(identityId));
 // The first retry would already fall outside the window, so the job ends instead of retrying again.
 assert.equal(await outbox.tick(),'expired');
 assert.deepEqual(alerts,['apple_revocation_expired']);
 assert.deepEqual([job()!.status,job()!.job,job()!.lastErrorCode],['expired',null,'revocation_window_expired']);
 assert.equal(calls.length,1);
 assert.equal(await outbox.tick(),undefined);
 assert.equal(store.jobs.size,1);
});

test('a window that closed before the first attempt never sends the credential at all',async()=>{
 const {alerts,outbox,job,calls}=await setup({windowMs:60_000});
 const identityId=randomUUID();
 await enqueue(outbox,identityId,sealed(identityId));
 advance(60_000);
 assert.equal(await outbox.tick(),'expired');
 assert.deepEqual(calls,[]);
 assert.deepEqual(alerts,['apple_revocation_expired']);
 assert.deepEqual([job()!.status,job()!.job,job()!.lastErrorCode],['expired',null,'revocation_not_attempted']);
});

test('a documented rejection separates a dead credential from our own client failure',async()=>{
 for(const error of ['invalid_request','invalid_client','unauthorized_client','unsupported_grant_type','invalid_scope']){
  const calls:Array<{refreshToken:string}>=[];
  const {store,alerts,outbox,job}=await setup({revoke:async input=>{calls.push(input);return {outcome:'rejected',error};}});
  const identityId=randomUUID();
  await enqueue(outbox,identityId,sealed(identityId));
  assert.equal(await outbox.tick(),'needs_attention',error);
  assert.deepEqual([job()!.status,job()!.lastErrorCode],['needs_attention','apple_'+error],error);
  // The bounded seal survives so an operator fix can still revoke it, and the queue stops by itself.
  assert.notEqual(job()!.job,null,error);
  assert.deepEqual(alerts,['apple_revocation_needs_attention'],error);
  assert.equal(await outbox.tick(),undefined,error);
  assert.equal(calls.length,1,error);
  assert.equal(store.jobs.size,1,error);
 }
 // invalid_grant is Apple saying this refresh token cannot be used: nothing is left to revoke.
 const {alerts,outbox,job}=await setup({revoke:async()=>({outcome:'rejected',error:'invalid_grant'})});
 const identityId=randomUUID();
 await enqueue(outbox,identityId,sealed(identityId));
 assert.equal(await outbox.tick(),'revoked');
 assert.deepEqual([job()!.status,job()!.job,job()!.lastErrorCode],['revoked',null,null]);
 assert.deepEqual(alerts,[]);
});

test('the real adapter and the outbox revoke end to end against a simulated Apple endpoint',async()=>{
 const signing=await generateKeyPair('ES256',{extractable:true}),forms:Array<URLSearchParams>=[];
 const revoke=await createAppleTokenRevocation({teamId:'TEAM123456',keyId:'KEY1234567',clientId:namespace,
  privateKey:await exportPKCS8(signing.privateKey)},{now:clock,fetcher:async(url,init)=>{
  assert.equal(url,'https://appleid.apple.com/auth/revoke');
  forms.push(new URLSearchParams(String(init?.body)));
  // Apple's documented answer for a revoked token: 200 with no body. No real Apple request is made.
  return new Response(null,{status:200});
 }});
 const {outbox,job}=await setup({revoke});
 const identityId=randomUUID();
 await enqueue(outbox,identityId,sealed(identityId));
 assert.equal(await outbox.tick(),'revoked');
 assert.deepEqual([forms.length,forms[0]!.get('token'),forms[0]!.get('client_id'),forms[0]!.get('token_type_hint')],
  [1,refresh,namespace,'refresh_token']);
 assert.deepEqual([job()!.status,job()!.job],['revoked',null]);
});
