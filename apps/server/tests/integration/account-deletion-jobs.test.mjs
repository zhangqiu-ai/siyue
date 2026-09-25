import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startPostgresFixture} from './postgres-fixture.mjs';
import {createEmailFixture} from './email-fixture.mjs';
import {transaction} from '../../dist/adapters/postgres/database.js';
import {createAccountDeletionJobStore} from '../../dist/modules/auth/account-deletion-jobs.js';

let db,fx,store;
before(async()=>{db=await startPostgresFixture();});
beforeEach(async()=>{
  await db.admin.query('TRUNCATE siyue.subjects CASCADE');
  fx=await createEmailFixture(db);
  store=createAccountDeletionJobStore(db.app,fx.clock);
});
after(async()=>{await db?.stop();});
const expires=()=>new Date(+fx.clock()+86_400_000);
const pending=async()=>{
  const tokens=await fx.issue();
  await db.app.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",[tokens.session.subjectId]);
  return tokens.session.subjectId;
};
const insert=(subjectId,providerRevocationPending=false)=>transaction(db.app,client=>
  store.insertPending(client,{subjectId,receiptExpiresAt:expires(),providerRevocationPending}));
const receiptInput=receipt=>({deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret});

test('a pending subject gets one receipt; database retains only its digest',async()=>{
  const subjectId=await pending();
  const receipt=await insert(subjectId,true);
  assert.match(receipt.receiptSecret,/^[A-Za-z0-9_-]{43}$/);
  const row=(await db.app.query('SELECT * FROM siyue.account_deletion_jobs WHERE id=$1',[receipt.deletionId])).rows[0];
  assert.equal(row.subject_id,subjectId);
  assert.equal(row.state,'accepted');
  assert.equal(row.local_data_deleted,false);
  assert.equal(row.provider_revocation_pending,true);
  assert.match(row.receipt_secret_hash,/^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(row).includes(receipt.receiptSecret),false);
  assert.deepEqual(await store.status(receiptInput(receipt)),{
    serverDataDeleted:false,providerRevocationPending:true,completedAt:null,lastErrorCode:null});
});

test('active subjects, bad receipt windows and failed transactions create no job',async()=>{
  const active=await fx.issue();
  await assert.rejects(insert(active.session.subjectId),{code:'AUTH_DELETION_NOT_PENDING'});
  const subjectId=await pending();
  for(const receiptExpiresAt of [new Date(+fx.clock()-1),new Date(+fx.clock()+91*86_400_000),new Date('invalid')])
    await assert.rejects(transaction(db.app,client=>store.insertPending(client,
      {subjectId,receiptExpiresAt,providerRevocationPending:false})),{code:'AUTH_INVALID_REQUEST'});
  await assert.rejects(transaction(db.app,async client=>{
    await store.insertPending(client,{subjectId,receiptExpiresAt:expires(),providerRevocationPending:false});
    throw new Error('synthetic_rollback');
  }),/synthetic_rollback/);
  assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs')).rows[0].n,0);
});

test('unknown, wrong, expired and malformed receipts cannot inspect another job',async()=>{
  const first=await insert(await pending()),second=await insert(await pending());
  for(const input of [
    {deletionId:first.deletionId,receiptSecret:second.receiptSecret},
    {deletionId:randomUUID(),receiptSecret:first.receiptSecret},
  ])await assert.rejects(store.status(input),{code:'AUTH_DELETION_RECEIPT_INVALID',status:404});
  for(const input of [
    {...receiptInput(first),subjectId:randomUUID()},
    {deletionId:first.deletionId,receiptSecret:'short'},
    {deletionId:'not-a-uuid',receiptSecret:first.receiptSecret},
  ])await assert.rejects(store.status(input),{code:'AUTH_INVALID_REQUEST',status:400});
  fx.advance(86_400_001);
  await assert.rejects(store.status(receiptInput(first)),{code:'AUTH_DELETION_RECEIPT_INVALID',status:404});
  await assert.rejects(store.status(receiptInput(second)),{code:'AUTH_DELETION_RECEIPT_INVALID',status:404});
});

test('status separates Siyue cleanup from provider revocation and returns no account data',async()=>{
  const receipt=await insert(await pending(),true);
  await db.app.query(`UPDATE siyue.account_deletion_jobs SET state='processing',local_data_deleted=true,
    last_error_code='provider_unavailable' WHERE id=$1`,[receipt.deletionId]);
  const intermediate=await store.status(receiptInput(receipt));
  assert.deepEqual(intermediate,{serverDataDeleted:true,providerRevocationPending:true,
    completedAt:null,lastErrorCode:'provider_unavailable'});
  await db.app.query(`UPDATE siyue.account_deletion_jobs SET state='completed',
    provider_revocation_pending=false,completed_at=$2,last_error_code=NULL WHERE id=$1`,
  [receipt.deletionId,fx.clock()]);
  const finished=await store.status(receiptInput(receipt));
  assert.equal(finished.serverDataDeleted,true);
  assert.equal(finished.providerRevocationPending,false);
  assert.equal(finished.completedAt,fx.clock().toISOString());
  assert.equal(finished.lastErrorCode,null);
  const serialized=JSON.stringify([intermediate,finished]);
  assert.equal(serialized.includes(receipt.receiptSecret),false);
  assert.equal(serialized.includes(receipt.deletionId),false);
});

test('concurrent attempts cannot create two jobs for one subject',async()=>{
  const subjectId=await pending();
  const attempts=await Promise.allSettled([insert(subjectId),insert(subjectId)]);
  assert.equal(attempts.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(attempts.filter(item=>item.status==='rejected').length,1);
  const rows=(await db.app.query('SELECT id FROM siyue.account_deletion_jobs WHERE subject_id=$1',[subjectId])).rows;
  assert.equal(rows.length,1);
  assert.equal(rows[0].id,attempts.find(item=>item.status==='fulfilled').value.deletionId);
});
