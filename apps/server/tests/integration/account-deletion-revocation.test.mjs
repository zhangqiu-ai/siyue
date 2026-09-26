import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {startPostgresFixture} from './postgres-fixture.mjs';
import {transaction} from '../../dist/adapters/postgres/database.js';
import {RecoveryCipher} from '../../dist/adapters/crypto/auth-crypto.js';
import {createAppleRevocationPostgresStore} from '../../dist/identities/apple/revocation-postgres.js';
import {createAccountDeletionJobStore} from '../../dist/modules/auth/account-deletion-jobs.js';
import {createAccountDeletionRevocationCoordinator,createAccountDeletionRevocationWorker}
  from '../../dist/modules/auth/account-deletion-revocation.js';

// Coordination between the durable Apple revocation queue (migration 0016) and the deletion job's
// provider dimension (migration 0015), against an isolated temporary PostgreSQL cluster only. No
// HTTP route, no Apple endpoint, no mail transport and no worker timer is reached: every provider
// answer below is an injected local stand-in, every subject, identity, credential seal and receipt is
// synthetic, and nothing here claims that a real account was revoked at Apple.
const day=86_400_000;
const namespace='app.siyue.mobile';
const refresh='synthetic-apple-refresh-token';
const start=Date.parse('2026-09-24T00:00:00Z');
const cipher=new RecoveryCipher('test',new Map([['test',randomBytes(32)]]));
let db;
before(async()=>{db=await startPostgresFixture();});
beforeEach(async()=>{await db.admin.query('TRUNCATE siyue.subjects CASCADE');});
after(async()=>{await db?.stop();});

const rows=(sql,...args)=>db.app.query(sql,args).then(result=>result.rows);
const one=async(sql,...args)=>(await rows(sql,...args))[0];
/** The credential the identity store seals: the revocation AAD is the identity id plus the provider
 * namespace, so a seal is only openable by the job that names exactly those two. */
const sealOf=(identityId,providerNamespace=namespace,token=refresh)=>
  cipher.seal({refreshToken:token},'apple-identity:'+identityId+':'+providerNamespace);
const addSubject=status=>db.app.query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'adult',$2) RETURNING id",
  [randomUUID(),status??'deletion_pending']).then(result=>result.rows[0].id);
/** One Apple identity of that subject, with or without the credential row the queue copies a seal from. */
const addIdentity=async({subjectId,status='active',credential=true,sealed}={})=>{
  const subject=subjectId??await addSubject(),identityId=randomUUID();
  await db.app.query(`INSERT INTO siyue.external_identities(id,subject_id,provider,provider_namespace,
      provider_subject,client_id,issuer,status)
    VALUES($1,$2,'apple',$3,$4,$5,'https://appleid.apple.com',$6)`,
  [identityId,subject,namespace,`synthetic-apple-subject-${identityId.slice(0,8)}`,namespace,status]);
  if(credential)await db.app.query('INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext) VALUES($1,$2)',
    [identityId,sealed??sealOf(identityId)]);
  return {subjectId:subject,identityId};
};
/** The deletion job as the acceptance kernel writes it: only the provider dimension is open here. */
const addDeletionJob=async(subjectId,{pending=true,localDataDeleted=false,errorCode=null}={})=>{
  const deletionId=randomUUID(),receiptSecret=randomBytes(32).toString('base64url');
  await db.app.query(`INSERT INTO siyue.account_deletion_jobs(id,subject_id,state,requested_at,local_data_deleted,
      provider_revocation_pending,receipt_secret_hash,receipt_expires_at,last_error_code)
    VALUES($1,$2,'accepted',$3,$4,$5,$6,$7,$8)`,
  [deletionId,subjectId,new Date(start),localDataDeleted,pending,
    createHash('sha256').update(receiptSecret).digest('hex'),new Date(start+30*day),errorCode]);
  return {deletionId,receiptSecret};
};
const deletionRow=subjectId=>one('SELECT * FROM siyue.account_deletion_jobs WHERE subject_id=$1',subjectId);
/** The whole provider dimension of one job: flag, bounded code, and the two columns this module
 * must never touch. */
const dimensionOf=async subjectId=>{
  const row=await deletionRow(subjectId);
  return [row.provider_revocation_pending,row.last_error_code,row.local_data_deleted,row.completed_at,row.state];
};
const queueRow=identityId=>one('SELECT * FROM siyue.apple_revocation_outbox WHERE identity_id=$1',identityId);
const receipt=()=>createAccountDeletionJobStore(db.app,()=>new Date(start));
/** Synthetic clock shared by the store, the outbox and the assertions, so no case depends on wall time. */
function fixture(){
  let time=start;
  return {clock:()=>new Date(time),advance:milliseconds=>{time+=milliseconds;}};
}
/** The composed service under test, with the provider half always injected. */
const workerFor=(clock,{revoke,alert,windowMs,limit}={})=>createAccountDeletionRevocationWorker(db.app,{
  store:createAppleRevocationPostgresStore(db.app,{clock}),cipher,clock,
  revoke:revoke??(async()=>({outcome:'revoked'})),alert,windowMs,limit});
const enqueue=async(service,subjectId)=>{await transaction(db.app,client=>service.enqueueForSubject(client,{subjectId}));};
/** Queues the subject's one Apple identity and settles it as Apple having confirmed the revocation. */
const confirmRevocation=async(store,subjectId)=>{
  const identityId=(await one('SELECT id FROM siyue.external_identities WHERE subject_id=$1',subjectId)).id;
  await transaction(db.app,client=>store.enqueue(client,{availableAt:new Date(start),expiresAt:new Date(start+7*day),
    job:{identityId,providerNamespace:namespace,refreshCiphertext:sealOf(identityId)}}));
  const claim=await store.claim(new Date(start),new Date(start+60_000));
  assert.equal(claim.job.identityId,identityId);
  await store.settle(claim,{state:'revoked'},new Date(start));
  return identityId;
};

test('one attempt plus coordination clears the provider dimension only after Apple confirmed',async()=>{
  const {clock}=fixture(),calls=[];
  const worker=workerFor(clock,{revoke:async input=>{calls.push(input);return {outcome:'revoked'};}});
  const subjectId=await addSubject(),{identityId}=await addIdentity({subjectId});
  const {deletionId,receiptSecret}=await addDeletionJob(subjectId);
  await enqueue(worker,subjectId);
  // A queued revocation is a recorded request, not a confirmation: the dimension is still open.
  assert.deepEqual(await dimensionOf(subjectId),[true,null,false,null,'accepted']);
  assert.equal((await queueRow(identityId)).status,'pending');
  const tick=await worker.tick();
  assert.deepEqual([tick.attempt,tick.subjectId],['revoked',subjectId]);
  assert.deepEqual(tick.report,{checked:1,cleared:1,jobs:[
    {deletionId,subjectId,cleared:true,errorCode:null,identities:1,confirmed:1}]});
  // Exactly the credential the identity store sealed was opened under the job's own AAD, and the
  // queue destroyed it with the confirmed revocation.
  assert.deepEqual(calls,[{refreshToken:refresh}]);
  assert.deepEqual(await queueRow(identityId).then(row=>[row.status,row.refresh_ciphertext,row.attempts]),
    ['revoked',null,1]);
  // Only the provider dimension moved: the local dimension, the completion stamp and the job state
  // are exactly as the acceptance kernel left them, and no identity lifecycle flag was invented.
  assert.deepEqual(await dimensionOf(subjectId),[false,null,false,null,'accepted']);
  assert.equal((await one('SELECT status FROM siyue.external_identities WHERE id=$1',identityId)).status,'active');
  // The receipt reads the same fact through the public projection, still as a separate dimension.
  assert.deepEqual(await receipt().status({deletionId,receiptSecret}),
    {serverDataDeleted:false,providerRevocationPending:false,completedAt:null,lastErrorCode:null});
  // A terminal queue row is never claimed twice, and an already cleared job is never re-decided.
  assert.deepEqual(await worker.tick(),{attempt:undefined,subjectId:undefined,report:undefined});
  assert.deepEqual(await worker.reconcile({subjectId}),{checked:0,cleared:0,jobs:[]});
  assert.deepEqual(await dimensionOf(subjectId),[false,null,false,null,'accepted']);
});

test('one identity still waiting keeps the whole dimension pending until every identity is confirmed',
  async()=>{
    const {clock}=fixture();
    const worker=workerFor(clock,{revoke:async()=>({outcome:'revoked'})});
    const subjectId=await addSubject();
    const first=await addIdentity({subjectId}),second=await addIdentity({subjectId});
    await addDeletionJob(subjectId);
    await enqueue(worker,subjectId);
    const tick=await worker.tick();
    assert.deepEqual([tick.attempt,tick.report.cleared,tick.report.jobs[0].errorCode],
      ['revoked',0,'apple_revocation_pending']);
    assert.deepEqual(await dimensionOf(subjectId),[true,'apple_revocation_pending',false,null,'accepted']);
    // The confirmed half is reported as evidence, so an operator sees why the job is still open.
    assert.deepEqual([tick.report.jobs[0].identities,tick.report.jobs[0].confirmed],[2,1]);
    // Either identity may be claimed first (the queue orders by availability, then id), so only the
    // split itself is asserted: one confirmed, one still waiting.
    assert.deepEqual((await Promise.all([first,second].map(async identity=>
      (await queueRow(identity.identityId)).status))).sort(),['pending','revoked']);
    // The second identity is attempted next, and only then is the dimension finished.
    const secondTick=await worker.tick();
    assert.deepEqual([secondTick.report.cleared,secondTick.report.jobs[0].confirmed],[1,2]);
    assert.deepEqual(await dimensionOf(subjectId),[false,null,false,null,'accepted']);
  });

test('a failed, refused, unreadable or expired attempt keeps the job pending with a bounded code',
  async()=>{
    // 1. The provider is temporarily unavailable: the outbox retries inside its window, so the
    // receipt keeps a bounded code instead of a false success.
    {
      const {clock,advance}=fixture();
      let outcome={outcome:'unavailable'};
      const worker=workerFor(clock,{revoke:async()=>outcome});
      const subjectId=await addSubject(),{identityId}=await addIdentity({subjectId});
      await addDeletionJob(subjectId);
      await enqueue(worker,subjectId);
      const tick=await worker.tick();
      assert.deepEqual([tick.attempt,tick.report.cleared,tick.report.jobs[0].errorCode],
        ['retry',0,'apple_revocation_pending']);
      assert.deepEqual(await queueRow(identityId).then(row=>[row.status,row.last_error_code]),
        ['pending','apple_provider_unavailable']);
      assert.deepEqual(await dimensionOf(subjectId),[true,'apple_revocation_pending',false,null,'accepted']);
      // The bounded backoff is honoured, so coordination cannot clear the dimension by retrying early.
      assert.deepEqual(await worker.tick(),{attempt:undefined,subjectId:undefined,report:undefined});
      outcome={outcome:'revoked'};
      advance(30_000);
      const retried=await worker.tick();
      assert.deepEqual([retried.attempt,retried.report.cleared],['revoked',1]);
      assert.deepEqual(await dimensionOf(subjectId),[false,null,false,null,'accepted']);
    }
    // 2. The sealed credential cannot be opened under this job's own AAD, so nothing is sent: the
    // queue stops for an operator and the deletion stays open.
    {
      const {clock}=fixture(),calls=[];
      const worker=workerFor(clock,{revoke:async input=>{calls.push(input);return {outcome:'revoked'};}});
      const subjectId=await addSubject();
      await addIdentity({subjectId,sealed:sealOf(randomUUID())});
      await addDeletionJob(subjectId);
      await enqueue(worker,subjectId);
      const tick=await worker.tick();
      assert.deepEqual([tick.attempt,tick.report.cleared,tick.report.jobs[0].errorCode],
        ['needs_attention',0,'apple_revocation_needs_attention']);
      assert.deepEqual(calls,[]);
      assert.deepEqual(await dimensionOf(subjectId),
        [true,'apple_revocation_needs_attention',false,null,'accepted']);
    }
    // 3. Our own client authentication was refused: repeating the identical call cannot help, so the
    // job is not reported as revoked either.
    {
      const {clock}=fixture();
      const worker=workerFor(clock,{revoke:async()=>({outcome:'rejected',error:'invalid_client'})});
      const subjectId=await addSubject();
      await addIdentity({subjectId});
      await addDeletionJob(subjectId);
      await enqueue(worker,subjectId);
      const tick=await worker.tick();
      assert.deepEqual([tick.attempt,tick.report.jobs[0].errorCode],
        ['needs_attention','apple_revocation_needs_attention']);
      assert.deepEqual(await dimensionOf(subjectId),
        [true,'apple_revocation_needs_attention',false,null,'accepted']);
    }
    // 4. The window closed before the first attempt: the outbox destroys the seal without calling the
    // provider, and the dimension stays open for the manual path design 13.3 describes.
    {
      const {clock,advance}=fixture(),calls=[];
      const worker=workerFor(clock,{windowMs:60_000,revoke:async input=>{calls.push(input);return {outcome:'revoked'};}});
      const subjectId=await addSubject(),{identityId}=await addIdentity({subjectId});
      await addDeletionJob(subjectId);
      await enqueue(worker,subjectId);
      advance(60_000);
      const tick=await worker.tick();
      assert.deepEqual([tick.attempt,tick.report.cleared,tick.report.jobs[0].errorCode],
        ['expired',0,'apple_revocation_expired']);
      assert.deepEqual(calls,[]);
      assert.deepEqual(await queueRow(identityId).then(row=>[row.status,row.refresh_ciphertext]),
        ['expired',null]);
      assert.deepEqual(await dimensionOf(subjectId),[true,'apple_revocation_expired',false,null,'accepted']);
    }
  });

test('a missing identity or a credential that never queued is never read as a confirmed revocation',
  async()=>{
    // 1. A linked Apple identity without its provider credential never enters the queue, so it can
    // never produce a claim. The dimension must stay open instead of reading that silence as success.
    const unqueuedSubject=await addSubject();
    const {identityId:unqueued}=await addIdentity({subjectId:unqueuedSubject,credential:false});
    await addDeletionJob(unqueuedSubject);
    assert.equal(await queueRow(unqueued),undefined);
    // 2. The same for an identity the user already unlinked on this device: it is not a revocation.
    const unlinkedSubject=await addSubject();
    await addIdentity({subjectId:unlinkedSubject,status:'unlinked',credential:false});
    await addDeletionJob(unlinkedSubject);
    // 3. Every Apple identity row is gone (a cleanup removed them before anything was queued). No
    // evidence is not the same fact as a confirmation, so this must not clear the dimension either.
    const goneSubject=await addSubject();
    const {identityId:removed}=await addIdentity({subjectId:goneSubject,credential:false});
    const goneJob=await addDeletionJob(goneSubject);
    await db.app.query('DELETE FROM siyue.external_identities WHERE id=$1',[removed]);
    const report=await createAccountDeletionRevocationCoordinator(db.app).reconcile();
    assert.deepEqual([report.checked,report.cleared],[3,0]);
    const bySubject=new Map(report.jobs.map(job=>[job.subjectId,job]));
    for(const [subjectId,identities] of [[unqueuedSubject,1],[unlinkedSubject,1],[goneSubject,0]])
      assert.deepEqual([bySubject.get(subjectId).cleared,bySubject.get(subjectId).errorCode,
        bySubject.get(subjectId).identities,bySubject.get(subjectId).confirmed],
      [false,'apple_credential_missing',identities,0]);
    for(const subjectId of [unqueuedSubject,unlinkedSubject,goneSubject])
      assert.deepEqual(await dimensionOf(subjectId),[true,'apple_credential_missing',false,null,'accepted']);
    // Nothing was queued, so the queue is empty and the receipt keeps the open dimension with its
    // bounded code instead of an "all done" answer.
    assert.equal((await rows('SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox'))[0].n,0);
    assert.deepEqual(await receipt().status({deletionId:goneJob.deletionId,receiptSecret:goneJob.receiptSecret}),
      {serverDataDeleted:false,providerRevocationPending:true,completedAt:null,lastErrorCode:'apple_credential_missing'});
    // A job that is still waiting is re-reported with the same bounded code on every sweep, is never
    // cleared by repetition, and is never stamped complete or locally deleted.
    const again=await createAccountDeletionRevocationCoordinator(db.app).reconcile({limit:2});
    assert.deepEqual([again.checked,again.cleared,new Set(again.jobs.map(job=>job.errorCode)).size],[2,0,1]);
    assert.deepEqual(await dimensionOf(goneSubject),[true,'apple_credential_missing',false,null,'accepted']);
  });

test('an expired revocation keeps its failure reason after privacy cleanup removes the Apple identity',async()=>{
  const subjectId=await addSubject(),{identityId}=await addIdentity({subjectId,credential:false});
  await addDeletionJob(subjectId,{errorCode:'apple_revocation_expired'});
  await db.app.query('DELETE FROM siyue.external_identities WHERE id=$1',[identityId]);
  const report=await createAccountDeletionRevocationCoordinator(db.app).reconcile({subjectId});
  assert.equal(report.checked,1);
  assert.deepEqual(report.jobs[0],{deletionId:(await deletionRow(subjectId)).id,subjectId,
    cleared:false,errorCode:'apple_revocation_expired',identities:0,confirmed:0});
  assert.deepEqual(await dimensionOf(subjectId),[true,'apple_revocation_expired',false,null,'accepted']);
});

test('many instances clear one job once and work on a disjoint slice of the queue',async()=>{
  const {clock}=fixture();
  const store=createAppleRevocationPostgresStore(db.app,{clock});
  const subjects=[];
  for(let index=0;index<3;index+=1){
    const subjectId=await addSubject();
    await addIdentity({subjectId});
    await addDeletionJob(subjectId);
    await confirmRevocation(store,subjectId);
    subjects.push(subjectId);
  }
  // Two pools stand for two instances, each with its own coordinator over the same database.
  const others=db.poolFor('siyue_app');
  const coordinators=[createAccountDeletionRevocationCoordinator(db.app),
    createAccountDeletionRevocationCoordinator(others)];
  const reports=await Promise.all(Array.from({length:8},(_,index)=>coordinators[index%2].reconcile()));
  const seen=reports.flatMap(report=>report.jobs.map(job=>job.deletionId));
  assert.equal(seen.length,3,'each waiting job is taken by exactly one instance');
  assert.equal(new Set(seen).size,3,'no instance decides the same job twice');
  assert.equal(reports.reduce((total,report)=>total+report.cleared,0),3);
  for(const subjectId of subjects)
    assert.deepEqual(await dimensionOf(subjectId),[false,null,false,null,'accepted']);
  // The same property for one subject: concurrent callers cannot clear it twice or re-open it.
  const single=await addSubject();
  await addIdentity({subjectId:single});
  await addDeletionJob(single);
  await confirmRevocation(store,single);
  const racing=await Promise.all(Array.from({length:8},(_,index)=>
    coordinators[index%2].reconcile({subjectId:single})));
  assert.equal(racing.reduce((total,report)=>total+report.cleared,0),1);
  assert.deepEqual(await dimensionOf(single),[false,null,false,null,'accepted']);
  // The bound is enforced on both sides of the call, and nothing is left to re-evaluate.
  const bounded=createAccountDeletionRevocationCoordinator(db.app);
  assert.deepEqual(await bounded.reconcile({limit:1}),{checked:0,cleared:0,jobs:[]});
  await assert.rejects(bounded.reconcile({limit:0}),error=>error.name==='ZodError');
  await assert.rejects(bounded.reconcile({limit:201}),error=>error.name==='ZodError');
  await assert.rejects(bounded.reconcile({subjectId:'not-a-uuid'}),error=>error.name==='ZodError');
  assert.throws(()=>createAccountDeletionRevocationCoordinator(db.app,{limit:0}),error=>error.name==='ZodError');
});

test('a refused or rolled back reconciliation changes nothing and can be retried safely',async()=>{
  const {clock}=fixture();
  const store=createAppleRevocationPostgresStore(db.app,{clock});
  const subjectId=await addSubject(),{identityId}=await addIdentity({subjectId});
  // A stale bounded code from an earlier sweep, so a rollback is visible in the row it must restore.
  await addDeletionJob(subjectId,{errorCode:'apple_revocation_pending'});
  await transaction(db.app,client=>store.enqueue(client,{availableAt:new Date(start),
    expiresAt:new Date(start+7*day),job:{identityId,providerNamespace:namespace,refreshCiphertext:sealOf(identityId)}}));
  await store.settle(await store.claim(new Date(start),new Date(start+60_000)),{state:'revoked'},new Date(start));
  // 1. A database that refuses the statement writes nothing at all.
  const failing=createAccountDeletionRevocationCoordinator({query:async()=>{throw new Error('synthetic_reconcile_failure');}});
  await assert.rejects(failing.reconcile({subjectId}),/synthetic_reconcile_failure/);
  assert.deepEqual(await dimensionOf(subjectId),[true,'apple_revocation_pending',false,null,'accepted']);
  // 2. The same decision inside a caller transaction that rolls back is undone with it.
  await assert.rejects(transaction(db.app,async client=>{
    const decision=await createAccountDeletionRevocationCoordinator(client).reconcile({subjectId});
    assert.equal(decision.cleared,1);
    throw new Error('synthetic_rollback');
  }),/synthetic_rollback/);
  assert.deepEqual(await dimensionOf(subjectId),[true,'apple_revocation_pending',false,null,'accepted']);
  // 3. Nothing was consumed or half-written, so the next attempt finishes the dimension normally.
  const recovered=await createAccountDeletionRevocationCoordinator(db.app).reconcile({subjectId});
  assert.equal(recovered.cleared,1);
  assert.deepEqual(await dimensionOf(subjectId),[false,null,false,null,'accepted']);
});
