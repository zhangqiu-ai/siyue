import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {startPostgresFixture} from './postgres-fixture.mjs';
import {createAppleFlowStorage} from '../../dist/identities/apple/flow-storage.js';
import {RecoveryCipher,digest} from '../../dist/adapters/crypto/auth-crypto.js';
let db;before(async()=>{db=await startPostgresFixture();});after(async()=>{await db?.stop();});
const cipher=new RecoveryCipher('test',new Map([['test',randomBytes(32)]]));
function fixture(){let time=Date.parse('2026-09-22T00:00:00Z');const clock=()=>new Date(time);return {store:createAppleFlowStorage(db.app,cipher,'app.siyue.mobile',clock),clock,advance:ms=>time+=ms};}
const start=store=>store.start({purpose:'login',platform:'ios',installationId:'synthetic-device'});
const proof=flow=>({flowId:flow.flowId,transactionSecret:flow.transactionSecret,state:flow.state});
const result={identity:{provider:'apple',subject:'verified-apple-sub',clientId:'app.siyue.mobile'},refreshToken:'synthetic-apple-refresh'};
const requestHash=digest('synthetic-complete-request');

test('start persists only proof hashes; wrong state/secret or client configuration cannot inspect or claim',async()=>{
 const {store}=fixture(),flow=await start(store),row=(await db.app.query('SELECT * FROM siyue.apple_login_flows WHERE id=$1',[flow.flowId])).rows[0];
 for(const secret of [flow.transactionSecret,flow.state,flow.nonce])assert.equal(JSON.stringify(row).includes(secret),false);
 assert.equal(row.nonce_hash,digest(flow.nonce));assert.equal(+row.expires_at-+row.created_at,300000);
 for(const bad of [{...proof(flow),state:'x'.repeat(43)},{...proof(flow),transactionSecret:'y'.repeat(43)}]){
  await assert.rejects(store.inspect(bad),{code:'invalid_flow'});await assert.rejects(store.claim(bad,result.identity.subject,requestHash),{code:'invalid_flow'});
 }
 const other=createAppleFlowStorage(db.app,cipher,'another.app',()=>new Date(row.created_at));await assert.rejects(other.inspect(proof(flow)),{code:'invalid_flow'});
 assert.equal((await store.inspect(proof(flow))).nonceHash,digest(flow.nonce));
});

test('concurrent completion has one exchange winner, fenced writes and encrypted durable verified recovery',async()=>{
 const {store,clock}=fixture(),flow=await start(store);
 const claims=await Promise.allSettled(Array.from({length:10},()=>store.claim(proof(flow),result.identity.subject,requestHash)));
 const won=claims.filter(x=>x.status==='fulfilled');assert.equal(won.length,1);assert.equal(claims.filter(x=>x.status==='rejected'&&x.reason.code==='in_progress').length,9);
 const lease=won[0].value;assert.equal(lease.kind,'claimed');
 await assert.rejects(store.recordVerified(flow.flowId,randomUUID(),result),{code:'stale_exchange'});
 await store.recordVerified(flow.flowId,lease.leaseId,result);
 const row=(await db.app.query('SELECT * FROM siyue.apple_login_flows WHERE id=$1',[flow.flowId])).rows[0];assert.equal(row.status,'verified');assert.equal(row.verified_ciphertext.includes(result.refreshToken),false);
 const restarted=createAppleFlowStorage(db.app,cipher,'app.siyue.mobile',clock);const recovered=await restarted.claim(proof(flow),result.identity.subject,requestHash);assert.equal(recovered.kind,'verified');assert.deepEqual(recovered.result,result);
 await assert.rejects(restarted.claim(proof(flow),result.identity.subject,digest('other-request')),{code:'request_conflict'});
 await assert.rejects(restarted.claim(proof(flow),'other-subject',requestHash),{code:'request_conflict'});
 assert.equal(await store.fail(flow.flowId,lease.leaseId),false);
});

test('expired exchange lease is terminal and commits failure before throwing; no second exchange is allowed',async()=>{
 const {store,advance}=fixture(),flow=await start(store),lease=await store.claim(proof(flow),result.identity.subject,requestHash);advance(30000);
 await assert.rejects(store.claim(proof(flow),result.identity.subject,requestHash),{code:'restart_required'});
 assert.equal((await db.app.query('SELECT status FROM siyue.apple_login_flows WHERE id=$1',[flow.flowId])).rows[0].status,'failed');
 await assert.rejects(store.recordVerified(flow.flowId,lease.leaseId,result),{code:'stale_exchange'});
 await assert.rejects(store.claim(proof(flow),result.identity.subject,requestHash),{code:'restart_required'});
});

test('flow expiry, mismatched verified identity and explicit failure preserve terminal semantics',async()=>{
 const {store,advance}=fixture(),expired=await start(store);advance(300000);
 await assert.rejects(store.claim(proof(expired),result.identity.subject,requestHash),{code:'restart_required'});
 assert.equal((await db.app.query('SELECT status FROM siyue.apple_login_flows WHERE id=$1',[expired.flowId])).rows[0].status,'expired');
 const flow=await start(store),lease=await store.claim(proof(flow),result.identity.subject,requestHash);
 await assert.rejects(store.recordVerified(flow.flowId,lease.leaseId,{...result,identity:{...result.identity,subject:'wrong'}}),{code:'stale_exchange'});
 await assert.rejects(store.claim(proof(flow),result.identity.subject,requestHash),{code:'restart_required'});
 const failed=await start(store),second=await store.claim(proof(failed),result.identity.subject,requestHash);assert.equal(await store.fail(failed.flowId,second.leaseId),true);assert.equal(await store.fail(failed.flowId,second.leaseId),false);
});

test('corrupt encrypted evidence is not returned or overwritten, and cleanup removes expired material',async()=>{
 const {store,advance}=fixture(),flow=await start(store),lease=await store.claim(proof(flow),result.identity.subject,requestHash);await store.recordVerified(flow.flowId,lease.leaseId,result);
 await db.app.query("UPDATE siyue.apple_login_flows SET verified_ciphertext='corrupt-synthetic' WHERE id=$1",[flow.flowId]);
 await assert.rejects(store.claim(proof(flow),result.identity.subject,requestHash),{code:'restart_required'});
 assert.equal((await db.app.query('SELECT verified_ciphertext FROM siyue.apple_login_flows WHERE id=$1',[flow.flowId])).rows[0].verified_ciphertext,'corrupt-synthetic');
 advance(300000);await store.cleanup();const row=(await db.app.query('SELECT * FROM siyue.apple_login_flows WHERE id=$1',[flow.flowId])).rows[0];assert.equal(row.status,'expired');assert.equal(row.verified_ciphertext,null);
 advance(86400000);await store.cleanup();assert.equal((await db.app.query('SELECT id FROM siyue.apple_login_flows WHERE id=$1',[flow.flowId])).rowCount,0);
});

test('database rejects impossible states and cleanup fences an abandoned exchange lease',async()=>{
 const {store,advance}=fixture(),flow=await start(store);
 await assert.rejects(db.app.query("UPDATE siyue.apple_login_flows SET status='verified' WHERE id=$1",[flow.flowId]),error=>error.code==='23514');
 const lease=await store.claim(proof(flow),result.identity.subject,requestHash);
 await assert.rejects(db.app.query("UPDATE siyue.apple_login_flows SET lease_expires_at=expires_at+interval '1 second' WHERE id=$1",[flow.flowId]),error=>error.code==='23514');
 advance(30000);await store.cleanup();await assert.rejects(store.recordVerified(flow.flowId,lease.leaseId,result),{code:'stale_exchange'});
 assert.equal((await db.app.query('SELECT status FROM siyue.apple_login_flows WHERE id=$1',[flow.flowId])).rows[0].status,'failed');
});
