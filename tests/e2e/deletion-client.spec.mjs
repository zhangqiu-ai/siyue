import {test,expect} from 'playwright/test';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
import {createAccountDeletionJobStore} from '../../apps/server/dist/modules/auth/account-deletion-jobs.js';
import {createAccountDeletionCleanupRunner} from '../../apps/server/dist/modules/auth/account-deletion-cleanup-runner.js';
import {createFamilyRepository} from '../../apps/server/dist/modules/families/repository.js';
import {endOwnFamilyAccessForDeletion} from '../../apps/server/dist/modules/auth/account-deletion-member-exit.js';
import {dissolveEmptyOwnedFamilyForDeletion} from '../../apps/server/dist/modules/auth/account-deletion-empty-family.js';
import {registerAccountDeletionReadRoutes} from '../../apps/server/dist/modules/auth/account-deletion-routes.js';
import {transaction} from '../../apps/server/dist/adapters/postgres/database.js';
import {createAuthApiClient} from '../../packages/adapters/dist/index.js';
const Fastify=createRequire(new URL('../../apps/server/package.json',import.meta.url))('fastify');

// Account-deletion client slice (SA-07) against a real server rather than a stub fetcher: the
// receipt-only progress read, the deliberately unregistered submission route and the read-only
// impact payload validated against the shared contract.
let db,fx,app,address,store;
test.beforeAll(async()=>{db=await startPostgresFixture();});
test.beforeEach(async()=>{
 await db.admin.query('TRUNCATE siyue.subjects CASCADE');
 fx=await createEmailFixture(db);
 store=createAccountDeletionJobStore(db.app,fx.clock);
 app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});
 address=await app.listen({host:'127.0.0.1',port:0});
});
test.afterEach(async()=>{await app?.close();});
test.afterAll(async()=>{await db?.stop();});
const client=()=>createAuthApiClient({environment:'test',apiBaseUrl:address+'/v1',fetcher:fetch});
async function pendingReceipt(providerRevocationPending=true) {
 const tokens=await fx.issue();
 await db.app.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",[tokens.session.subjectId]);
 return transaction(db.app,connection=>store.insertPending(connection,{subjectId:tokens.session.subjectId,
  receiptExpiresAt:new Date(+fx.clock()+86_400_000),providerRevocationPending}));
}

test('the deletion client reads one job with the receipt alone and refuses any other proof',async()=>{
 const receipt=await pendingReceipt();
 const progress=await client().deletionStatus({deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret});
 expect(progress).toEqual({serverDataDeleted:false,providerRevocationPending:true,completedAt:null,lastErrorCode:null});
 // Progress stays minimal: no email, profile, login method, session or content field travels with it.
 expect(Object.keys(progress).sort()).toEqual(['completedAt','lastErrorCode','providerRevocationPending','serverDataDeleted']);
 // Unknown and mismatched receipts agree on the server; the client reports an unusable proof.
 for(const input of [{deletionId:receipt.deletionId,receiptSecret:'C'.repeat(43)},
   {deletionId:randomUUID(),receiptSecret:receipt.receiptSecret}])
  await expect(client().deletionStatus(input)).rejects.toMatchObject({name:'AuthClientError',code:'challenge_invalid'});
 // An expired receipt stops working instead of reporting the job as finished. The HTTP route
 // compares against wall-clock time rather than the fixture clock, so the job row is moved into the
 // past instead of advancing time.
 await db.app.query("UPDATE siyue.account_deletion_jobs SET requested_at=now()-interval '2 hours',receipt_expires_at=now()-interval '1 hour' WHERE id=$1",[receipt.deletionId]);
 await expect(client().deletionStatus({deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret}))
  .rejects.toMatchObject({code:'challenge_invalid'});
});

test('the receipt keeps Apple revocation pending when its credential is missing after server cleanup',async()=>{
 const tokens=await fx.issue();
 const subjectId=tokens.session.subjectId;
 await db.app.query(`INSERT INTO siyue.external_identities
   (id,subject_id,provider,provider_namespace,provider_subject,client_id,issuer)
   VALUES($1,$2,'apple','synthetic-team',$3,'app.siyue.synthetic','https://appleid.apple.com')`,
 [randomUUID(),subjectId,randomUUID()]);
 await db.app.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",[subjectId]);
 const receipt=await transaction(db.app,connection=>store.insertPending(connection,{subjectId,
  receiptExpiresAt:new Date(+fx.clock()+86_400_000),providerRevocationPending:true}));
 await db.app.query(`UPDATE siyue.account_deletion_jobs SET last_error_code='apple_credential_missing'
   WHERE id=$1`,[receipt.deletionId]);
 const scan=await createAccountDeletionCleanupRunner(db.app,{clock:fx.clock}).sweep();
 expect(scan.taken).toBe(1);
 expect(scan.cleaned).toBe(1);

 await expect(client().deletionStatus({deletionId:receipt.deletionId,
  receiptSecret:receipt.receiptSecret})).resolves.toEqual({serverDataDeleted:true,
  providerRevocationPending:true,completedAt:null,lastErrorCode:'apple_credential_missing'});
});

test('a frozen family review keeps deletion progress unfinished and family access closed',async()=>{
 const owner=await fx.issue(),member=await fx.issue();
 const family=await transaction(db.app,connection=>createFamilyRepository(db.app).create(connection,
  owner.session.subjectId,'f'.repeat(64)));
 await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
  [family.familyId,member.session.subjectId]);
 await transaction(db.app,async connection=>{
  await connection.query("UPDATE siyue.families SET status='frozen',version=version+1 WHERE id=$1",[family.familyId]);
  await connection.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",[owner.session.subjectId]);
 });
 const receipt=await transaction(db.app,async connection=>{
  const result=await store.insertPending(connection,{subjectId:owner.session.subjectId,
   receiptExpiresAt:new Date(+fx.clock()+86_400_000),providerRevocationPending:false});
  await connection.query(`INSERT INTO siyue.account_deletion_family_reviews
    (id,deletion_id,family_id,deleting_subject_id,state,opened_at)
    VALUES($1,$2,$3,$4,'pending',$5)`,
   [randomUUID(),result.deletionId,family.familyId,owner.session.subjectId,fx.clock()]);
  return result;
 });
 const scan=await createAccountDeletionCleanupRunner(db.app,{clock:fx.clock}).sweep();
 expect(scan.needsAttention).toBe(1);
 expect(await client().deletionStatus({deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret}))
  .toEqual({serverDataDeleted:false,providerRevocationPending:false,completedAt:null,lastErrorCode:'family_membership'});
 const listed=await fetch(address+'/v1/families',{headers:{authorization:`Bearer ${member.accessToken}`}});
 expect(listed.status).toBe(200);
 expect(JSON.stringify(await listed.json())).not.toContain(family.familyId);
 expect((await fetch(address+'/v1/account/session',
  {headers:{authorization:`Bearer ${owner.accessToken}`}})).status).toBe(401);
});

test('a departing adult member loses family access while the owner keeps the active family',async()=>{
 const owner=await fx.issue(),member=await fx.issue();
 const family=await transaction(db.app,connection=>createFamilyRepository(db.app).create(connection,
  owner.session.subjectId,'e'.repeat(64)));
 await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
  [family.familyId,member.session.subjectId]);
 await transaction(db.app,async connection=>{
  await endOwnFamilyAccessForDeletion(connection,member.session.subjectId,family.familyId,fx.clock());
  await connection.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",
   [member.session.subjectId]);
 });
 const receipt=await transaction(db.app,connection=>store.insertPending(connection,{
  subjectId:member.session.subjectId,receiptExpiresAt:new Date(+fx.clock()+86_400_000),
  providerRevocationPending:false}));
 const ownerFamilies=await fetch(address+'/v1/families',
  {headers:{authorization:`Bearer ${owner.accessToken}`}});
 expect(ownerFamilies.status).toBe(200);
 expect(JSON.stringify(await ownerFamilies.json())).toContain(family.familyId);
 expect((await fetch(address+'/v1/account/session',
  {headers:{authorization:`Bearer ${member.accessToken}`}})).status).toBe(401);
 const scan=await createAccountDeletionCleanupRunner(db.app,{clock:fx.clock}).sweep();
 expect(scan.completed).toBe(1);
 expect(await client().deletionStatus({deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret}))
  .toMatchObject({serverDataDeleted:true,providerRevocationPending:false});
 expect((await db.app.query('SELECT status FROM siyue.families WHERE id=$1',[family.familyId])).rows[0].status)
  .toBe('active');
 expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE subject_id=$1',
  [member.session.subjectId])).rows[0].n).toBe(0);
});

test('ending a truly empty family leaves no owner link before deletion completes',async()=>{
 const owner=await fx.issue();
 const family=await transaction(db.app,connection=>createFamilyRepository(db.app).create(connection,
  owner.session.subjectId,'d'.repeat(64)));
 const receipt=await transaction(db.app,async connection=>{
  await dissolveEmptyOwnedFamilyForDeletion(connection,owner.session.subjectId,family.familyId);
  await connection.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",
   [owner.session.subjectId]);
  return store.insertPending(connection,{subjectId:owner.session.subjectId,
   receiptExpiresAt:new Date(+fx.clock()+86_400_000),providerRevocationPending:false});
 });
 expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.families WHERE id=$1',
  [family.familyId])).rows[0].n).toBe(0);
 const scan=await createAccountDeletionCleanupRunner(db.app,{clock:fx.clock}).sweep();
 expect(scan.completed).toBe(1);
 expect(await client().deletionStatus({deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret}))
  .toMatchObject({serverDataDeleted:true,providerRevocationPending:false});
 expect((await fetch(address+'/v1/account/session',
  {headers:{authorization:`Bearer ${owner.accessToken}`}})).status).toBe(401);
});

test('an ended shared room keeps deletion progress pending until its history is settled',async()=>{
 const departing=await fx.issue(),owner=await fx.issue(),roomId=randomUUID();
 const family=await transaction(db.app,connection=>createFamilyRepository(db.app).create(connection,
  owner.session.subjectId,'c'.repeat(64)));
 await db.app.query(`INSERT INTO siyue.rooms(id,family_id,created_by_subject_id,status,ended_at)
  VALUES($1,$2,$3,'ended',now())`,[roomId,family.familyId,departing.session.subjectId]);
 await db.app.query(`INSERT INTO siyue.room_seats(room_id,session_id,subject_id,seat_index,released_at) VALUES($1,$2,$3,1,now())`,[roomId,owner.session.sessionId,owner.session.subjectId]);
 await db.app.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",
  [departing.session.subjectId]);
 const receipt=await transaction(db.app,connection=>store.insertPending(connection,{
  subjectId:departing.session.subjectId,receiptExpiresAt:new Date(+fx.clock()+86_400_000),
  providerRevocationPending:false}));
 const scan=await createAccountDeletionCleanupRunner(db.app,{clock:fx.clock}).sweep();
 expect(scan.needsAttention).toBe(1);
 expect(await client().deletionStatus({deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret}))
  .toEqual({serverDataDeleted:false,providerRevocationPending:false,completedAt:null,
   lastErrorCode:'inseparable_shared_work'});
 expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.rooms WHERE id=$1',[roomId])).rows[0].n)
  .toBe(1);
});

test('a retained family management acceptance keeps deletion progress pending',async()=>{
 const recipient=await fx.issue(),owner=await fx.issue();
 const family=await transaction(db.app,connection=>createFamilyRepository(db.app).create(connection,
  owner.session.subjectId,'b'.repeat(64)));
 const acceptedAt=fx.clock();
 await db.app.query(`INSERT INTO siyue.family_management_acceptances
  (id,family_id,owner_subject_id,recipient_subject_id,family_version,
   recipient_membership_version,owner_membership_version,child_scope_digest,
   accepted_at,expires_at,consumed_at,retain_until)
  VALUES($1,$2,$3,$4,1,1,1,$5,$6,$7,$6,$8)`,
  [randomUUID(),family.familyId,owner.session.subjectId,recipient.session.subjectId,
   '0'.repeat(64),acceptedAt,new Date(+acceptedAt+86_400_000),
   new Date(+acceptedAt+31*86_400_000)]);
 await db.app.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",
  [recipient.session.subjectId]);
 const receipt=await transaction(db.app,connection=>store.insertPending(connection,{
  subjectId:recipient.session.subjectId,receiptExpiresAt:new Date(+fx.clock()+86_400_000),
  providerRevocationPending:false}));

 const scan=await createAccountDeletionCleanupRunner(db.app,{clock:fx.clock}).sweep();
 expect(scan.needsAttention).toBe(1);
 expect(await client().deletionStatus({deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret}))
  .toEqual({serverDataDeleted:false,providerRevocationPending:false,completedAt:null,
   lastErrorCode:'retained_management_acceptance'});
 expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.family_management_acceptances WHERE recipient_subject_id=$1',
  [recipient.session.subjectId])).rows[0].n).toBe(1);
});

for(const status of ['pending','accepted']) test(`a ${status} room invitation is handled without deleting another member's room`,async()=>{
 const invitee=await fx.issue(),owner=await fx.issue(),roomId=randomUUID();
 const family=await transaction(db.app,connection=>createFamilyRepository(db.app).create(connection,
  owner.session.subjectId,'a'.repeat(64)));
 await db.app.query('INSERT INTO siyue.rooms(id,family_id,created_by_subject_id) VALUES($1,$2,$3)',
  [roomId,family.familyId,owner.session.subjectId]);
 await db.app.query(`INSERT INTO siyue.room_invitations
  (id,room_id,inviter_subject_id,invitee_subject_id,
   inviter_membership_version,invitee_membership_version,family_version,expires_at,status,accepted_at)
  VALUES($1,$2,$3,$4,1,1,1,$5,$6,CASE WHEN $6='accepted' THEN now() ELSE NULL END)`,[randomUUID(),roomId,owner.session.subjectId,
   invitee.session.subjectId,new Date(+fx.clock()+86_400_000),status]);
 await db.app.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",
  [invitee.session.subjectId]);
 const receipt=await transaction(db.app,connection=>store.insertPending(connection,{
  subjectId:invitee.session.subjectId,receiptExpiresAt:new Date(+fx.clock()+86_400_000),
  providerRevocationPending:false}));
 const scan=await createAccountDeletionCleanupRunner(db.app,{clock:fx.clock}).sweep();
 expect(scan.needsAttention).toBe(status==='accepted'?1:0);
 const progress=await client().deletionStatus({deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret});
 if(status==='accepted')expect(progress).toEqual({serverDataDeleted:false,providerRevocationPending:false,completedAt:null,
   lastErrorCode:'inseparable_shared_work'});
 else {
  expect(progress.serverDataDeleted).toBe(true);
  expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.room_invitations WHERE room_id=$1',[roomId])).rows[0].n).toBe(0);
 }
 expect((await db.app.query('SELECT status FROM siyue.rooms WHERE id=$1',[roomId])).rows[0].status).toBe('open');
});

test('an unconfigured deletion submission demands the caller key and accepts nothing',async()=>{
 const tokens=await fx.issue();
 const submission={reauthGrant:`${randomUUID()}.${'g'.repeat(43)}`,confirmation:true,dependencyDisposition:{kind:'none'}};
 // The submission now carries a caller-held UUID idempotency key, and this fixture omits the independent ledger and submission service, so the route is
 // unregistered: even a well-formed keyed request is answered as an unavailable service.
 await expect(client().submitDeletion(tokens.accessToken,submission,randomUUID())).rejects.toMatchObject({code:'unavailable'});
 // A key that is not an explicit UUID is refused inside the client, so no such request can reach
 // the server: the rejected code is the local refusal, not a response the route produced.
 await expect(client().submitDeletion(tokens.accessToken,submission,'not-a-uuid')).rejects.toMatchObject({code:'invalid_request'});
 // No accepted deletion and no revocation happened: the subject is still active and holds no job.
 expect((await db.app.query('SELECT status FROM siyue.subjects WHERE id=$1',[tokens.session.subjectId])).rows[0].status).toBe('active');
 expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs')).rows[0].n).toBe(0);
});

test('the read-only impact client validates the current subject and rejects a lost session',async()=>{
 const tokens=await fx.issue();
 const impact=await client().deletionImpact(tokens.accessToken);
 expect(Object.keys(impact).sort()).toEqual(['activeChildDeviceCount','families','guardianships','subjectId']);
 expect(impact).toEqual({subjectId:tokens.session.subjectId,families:[],guardianships:[],activeChildDeviceCount:0});
 await fx.service.logoutAccess(tokens.accessToken);
 await expect(client().deletionImpact(tokens.accessToken)).rejects.toMatchObject({code:'reauth_required'});
});

test('deletion reads cap concurrent work and return a retryable busy response',async()=>{
 let release,started,active=0;
 const work=new Promise(resolve=>{release=resolve;});
 const allStarted=new Promise(resolve=>{started=resolve;});
 const bounded=Fastify();
 registerAccountDeletionReadRoutes(bounded,{inspect:async()=>{
  active++;
  if(active===4)started();
  await work;
  return {subjectId:randomUUID(),families:[],guardianships:[],activeChildDeviceCount:0};
 }},{status:async()=>{throw new Error('unexpected_status_read');}});
 try {
  const request=()=>bounded.inject({method:'GET',url:'/v1/me/account/deletion/impact',
   headers:{authorization:'Bearer synthetic-token'}});
  const pending=Array.from({length:4},request);
  await allStarted;
  const busy=await request();
  expect(busy.statusCode).toBe(429);
  expect(busy.headers['retry-after']).toBe('1');
  expect(busy.json().error).toMatchObject({code:'AUTH_BUSY',retryable:true});
  release();
  expect((await Promise.all(pending)).every(response=>response.statusCode===200)).toBe(true);
 } finally {release?.();await bounded.close();}
});
