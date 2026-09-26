import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {startPostgresFixture} from './postgres-fixture.mjs';
import {RecoveryCipher} from '../../dist/adapters/crypto/auth-crypto.js';
import {createAppleFlowStorage} from '../../dist/identities/apple/flow-storage.js';
import {AppleIdentityError,createAppleIdentityVerifier} from '../../dist/identities/apple/identity.js';
import {AppleExchangeError} from '../../dist/identities/apple/exchange.js';
import {createAppleLoginPreparation} from '../../dist/identities/apple/prepare-login.js';
let db;before(async()=>{db=await startPostgresFixture();});after(async()=>{await db?.stop();});
const key=await generateKeyPair('RS256'),clientId='app.siyue.mobile',subject='synthetic-apple-sub';
const verify=createAppleIdentityVerifier(clientId,createLocalJWKSet({keys:[{...await exportJWK(key.publicKey),kid:'synthetic',alg:'RS256'}]}));
const requestPepper=randomBytes(32);
const cipher=new RecoveryCipher('test',new Map([['test',randomBytes(32)]]));
const result={identity:{provider:'apple',subject,clientId},refreshToken:'synthetic-refresh'};
async function fixture(exchange=async()=>result,alterStorage=x=>x,afterVerify=async()=>{}){
 let time=Date.parse('2026-09-22T00:00:00Z'),calls=0,verifies=0;const clock=()=>new Date(time),storage=createAppleFlowStorage(db.app,cipher,clientId,clock);
 const make=()=>createAppleLoginPreparation({requestPepper,storage:alterStorage(storage),clock,verify:async(...args)=>{verifies++;const identity=await verify(...args);await afterVerify();return identity;},exchange:async input=>{calls++;return exchange(input);}});
 const service=make(),flow=await service.start({purpose:'login',platform:'ios',installationId:'synthetic'}),seconds=time/1000;
 const token=await new SignJWT({nonce:flow.nonce}).setProtectedHeader({alg:'RS256',kid:'synthetic'}).setIssuer('https://appleid.apple.com').setAudience(clientId).setSubject(subject).setIssuedAt(seconds).setExpirationTime(seconds+300).sign(key.privateKey);
 const input={flowId:flow.flowId,transactionSecret:flow.transactionSecret,state:flow.state,identityToken:token,authorizationCode:'synthetic-code',fullName:{givenName:'Synthetic'}},requestId=randomUUID();
 return {service,storage,make,input,requestId,advance:ms=>time+=ms,calls:()=>calls,verifies:()=>verifies};
}
test('proof and identity checks precede exchange and invalid inputs cannot consume a flow',async()=>{
 const fx=await fixture();
 for(const change of [{state:'x'.repeat(43)},{transactionSecret:'y'.repeat(43)}])await assert.rejects(fx.service.prepare({...fx.input,...change},fx.requestId),{code:'invalid_flow'});
 assert.equal(fx.verifies(),0);assert.equal(fx.calls(),0);
 await assert.rejects(fx.service.prepare({...fx.input,user:'forged'},fx.requestId),{code:'invalid_request'});
 await assert.rejects(fx.service.prepare({...fx.input,identityToken:'x.y.z'},fx.requestId),{code:'invalid_identity'});assert.equal(fx.calls(),0);
 const prepared=await fx.service.prepare(fx.input,fx.requestId);assert.equal(prepared.kind,'verified');assert.equal(fx.calls(),1);assert.deepEqual(prepared.result,result);
 const stored=(await db.app.query('SELECT request_hash FROM siyue.apple_login_flows WHERE id=$1',[fx.input.flowId])).rows[0].request_hash;
 assert.equal(stored,createHmac('sha256',requestPepper).update(JSON.stringify({purpose:'apple-login',idempotencyKey:fx.requestId,request:fx.input})).digest('hex'));
 assert.equal((await db.app.query('SELECT count(*)::int AS total FROM siyue.subjects')).rows[0].total,0);
});
test('concurrent preparations exchange once; retry restores durable result and binds all completion parameters',async()=>{
 let entered,release;const seen=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
 const fx=await fixture(async()=>{entered();await hold;return result;});const first=fx.service.prepare(fx.input,fx.requestId);await seen;
 try{
  const rest=await Promise.allSettled(Array.from({length:8},()=>fx.service.prepare(fx.input,fx.requestId)));
  assert.ok(rest.every(x=>x.status==='rejected'&&x.reason.code==='in_progress'));assert.equal(fx.calls(),1);
 }finally{release();}
 const prepared=await first;assert.deepEqual((await fx.make().prepare(fx.input,fx.requestId)).result,prepared.result);assert.equal(fx.calls(),1);
 for(const changed of [{...fx.input,authorizationCode:'other-code'},{...fx.input,fullName:{givenName:'Changed'}}])await assert.rejects(fx.service.prepare(changed,fx.requestId),{code:'request_conflict'});
 await assert.rejects(fx.service.prepare(fx.input,randomUUID()),{code:'request_conflict'});assert.equal(fx.calls(),1);
});
test('ambiguous exchange is terminal and a lost failure write cannot permit another exchange',async()=>{
 for(const unavailable of [false,true]){
  const fx=await fixture(async()=>{throw new AppleExchangeError('unknown');},storage=>unavailable?{...storage,fail:async()=>{throw Error('synthetic database outage');}}:storage);
  await assert.rejects(fx.service.prepare(fx.input,fx.requestId),{reason:'unknown'});
  await assert.rejects(fx.service.prepare(fx.input,fx.requestId),{code:unavailable?'in_progress':'restart_required'});
  fx.advance(30000);await assert.rejects(fx.service.prepare(fx.input,fx.requestId),{code:'restart_required'});assert.equal(fx.calls(),1);
 }
});
test('lost verified-write acknowledgement can recover without re-exchanging the authorization code',async()=>{
 let lost=true;const fx=await fixture(undefined,storage=>({...storage,recordVerified:async(...args)=>{await storage.recordVerified(...args);if(lost){lost=false;throw Error('synthetic lost DB acknowledgement');}}}));
 await assert.rejects(fx.service.prepare(fx.input,fx.requestId),{code:'unavailable'});
 const next=await fx.make().prepare(fx.input,fx.requestId);assert.deepEqual(next.result,result);assert.equal(fx.calls(),1);
});
test('flow expiring during identity verification never reaches the exchange',async()=>{
 let fx;fx=await fixture(undefined,x=>x,async()=>fx.advance(300000));await assert.rejects(fx.service.prepare(fx.input,fx.requestId),{code:'restart_required'});assert.equal(fx.calls(),0);
});

test('provider verification failure before claim leaves a pending flow retryable',async()=>{
 let fail=true;const fx=await fixture(undefined,x=>x,async()=>{if(fail)throw new AppleIdentityError('provider_unavailable');});
 await assert.rejects(fx.service.prepare(fx.input,fx.requestId),{code:'provider_unavailable'});assert.equal(fx.calls(),0);
 assert.equal((await db.app.query('SELECT status FROM siyue.apple_login_flows WHERE id=$1',[fx.input.flowId])).rows[0].status,'pending');
 fail=false;await fx.service.prepare(fx.input,fx.requestId);assert.equal(fx.calls(),1);
});
test('a result arriving after the flow deadline is rejected and cannot start another exchange',async()=>{
 let fx;fx=await fixture(async()=>{fx.advance(300000);return result;});
 await assert.rejects(fx.service.prepare(fx.input,fx.requestId),{code:'restart_required'});
 await assert.rejects(fx.service.prepare(fx.input,fx.requestId),{code:'restart_required'});assert.equal(fx.calls(),1);
 assert.equal((await db.app.query('SELECT status FROM siyue.apple_login_flows WHERE id=$1',[fx.input.flowId])).rows[0].status,'expired');
});

test('failure before verified commit never exposes an unpersisted provider result or repeats exchange',async()=>{
 const fx=await fixture(undefined,storage=>({...storage,recordVerified:async()=>{throw Error('synthetic storage full');}}));
 await assert.rejects(fx.service.prepare(fx.input,fx.requestId),{code:'unavailable'});
 const row=(await db.app.query('SELECT status,verified_ciphertext FROM siyue.apple_login_flows WHERE id=$1',[fx.input.flowId])).rows[0];
 assert.equal(row.status,'failed');assert.equal(row.verified_ciphertext,null);
 await assert.rejects(fx.make().prepare(fx.input,fx.requestId),{code:'restart_required'});
 assert.equal(fx.calls(),1);
});
