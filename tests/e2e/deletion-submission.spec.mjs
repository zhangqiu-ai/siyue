import {test,expect} from 'playwright/test';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture,password} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createAccountDeletionJobStore} from '../../apps/server/dist/modules/auth/account-deletion-jobs.js';
import {createAccountDeletionImpactService} from '../../apps/server/dist/modules/auth/account-deletion-impact.js';
import {createAccountDeletionAcceptKernel} from '../../apps/server/dist/modules/auth/account-deletion-accept.js';
import {createAccountDeletionIdempotencyStore} from '../../apps/server/dist/modules/auth/account-deletion-idempotency.js';
import {createAccountDeletionSubmission} from '../../apps/server/dist/modules/auth/account-deletion-submission.js';
import {createAccountDeletionGuardedCleanupRunner} from '../../apps/server/dist/modules/auth/account-deletion-guarded-runner.js';
import {createAppleRevocationOutbox} from '../../apps/server/dist/identities/apple/revocation-outbox.js';
import {createAppleRevocationPostgresStore} from '../../apps/server/dist/identities/apple/revocation-postgres.js';
import {createDeletionLedgerStore} from '../../apps/server/dist/account-deletion-ledger/ledger-store.js';
import {runFrozenFamilyReviewCli} from '../../apps/server/dist/frozen-family-review-cli.js';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';

let db,fx,ledger,app,url,operatorUrl;
const headers=token=>({authorization:`Bearer ${token}`});
test.beforeAll(async()=>{
  db=await startPostgresFixture();fx=await createEmailFixture(db);
  const socket=(await db.admin.query("SELECT current_setting('unix_socket_directories') AS socket")).rows[0].socket;
  const bin=process.env.SIYUE_TEST_POSTGRES_BIN??'/opt/homebrew/opt/postgresql@17/bin';
  execFileSync(`${bin}/psql`,['-h',socket,'-U','siyue_test_admin','-d','postgres','-f',fileURLToPath(new URL('../../apps/server/provision/deletion-ledger.sql',import.meta.url))],{
    env:{...process.env,LC_ALL:'C',SIYUE_DELETION_LEDGER_DATABASE:'siyue_deletion_ledger',SIYUE_DELETION_LEDGER_ENVIRONMENT:'test',SIYUE_DELETION_LEDGER_APP_PASSWORD:randomBytes(32).toString('hex')},stdio:'pipe'});
  execFileSync(`${bin}/psql`,['-h',socket,'-U','siyue_test_admin','-d','siyue_test','-f',fileURLToPath(new URL('../../apps/server/provision/frozen-family-review-operator.sql',import.meta.url))],{
    env:{...process.env,LC_ALL:'C',SIYUE_FROZEN_FAMILY_REVIEW_DATABASE:'siyue_test',SIYUE_FROZEN_FAMILY_REVIEW_ENVIRONMENT:'test',SIYUE_FROZEN_FAMILY_REVIEW_OPERATOR_ROLE:'siyue_review_operator',SIYUE_FROZEN_FAMILY_REVIEW_OPERATOR_PASSWORD:randomBytes(32).toString('hex')},stdio:'pipe'});
  operatorUrl=`postgresql://siyue_review_operator@localhost/siyue_test?host=${encodeURIComponent(socket)}`;
  ledger=createDeletionLedgerStore(db.poolFor('siyue_deletion_ledger_app','siyue_deletion_ledger'),{database:'siyue_deletion_ledger',environment:'test'},fx.clock);
  const idem=createAccountDeletionIdempotencyStore(db.app,fx.cipher,randomBytes(32),fx.clock);
  const queue=createAppleRevocationOutbox({store:createAppleRevocationPostgresStore(db.app),cipher:fx.cipher,revoke:async()=>{throw Error('unexpected provider');},clock:fx.clock});
  const accept=createAccountDeletionAcceptKernel(db.app,fx.service,createAccountDeletionImpactService(db.app,fx.service,fx.clock),createAccountDeletionJobStore(db.app,fx.clock),queue,ledger,fx.clock,idem);
  app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email,deletionSubmission:createAccountDeletionSubmission(db.app,accept,idem,ledger)});
  url=await app.listen({host:'127.0.0.1',port:0});
});
test.afterAll(async()=>{await app?.close();await db?.stop();});
async function proof(request,token){const response=await request.post(url+'/v1/auth/reauth/password',{headers:headers(token),data:{password,action:'delete-account'}});expect(response.status()).toBe(200);return (await response.json()).data.reauthGrant;}

test('formal deletion accepts once, recovers the same receipt and completes guarded cleanup',async({request})=>{
  const who=await fx.register();const token=who.tokens.accessToken,key=randomUUID();
  const body={reauthGrant:await proof(request,token),confirmation:true,dependencyDisposition:{kind:'none'}};
  const send=(data=body,k=key)=>request.delete(url+'/v1/me/account',{headers:{...headers(token),'idempotency-key':k},data});
  expect((await send({...body,subjectId:randomUUID()})).status()).toBe(400);
  expect((await send(body,'invalid')).status()).toBe(400);
  const response=await send();expect(response.status()).toBe(202);const receipt=(await response.json()).data;
  expect((await ledger.lookup(who.tokens.session.subjectId)).status).toBe('accepted');
  const retry=await send();expect(retry.status()).toBe(202);expect((await retry.json()).data).toEqual(receipt);
  expect((await send({...body,reauthGrant:randomUUID()+'.'+'x'.repeat(43)})).status()).toBe(409);
  expect((await request.get(url+'/v1/account/session',{headers:headers(token)})).status()).toBe(401);
  await createAccountDeletionGuardedCleanupRunner(db.app,{ledger,clock:fx.clock}).sweep();
  const progress=await request.post(url+'/v1/account/deletion/status',{data:{deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret}});
  expect(progress.status()).toBe(200);expect((await progress.json()).data).toMatchObject({serverDataDeleted:true,providerRevocationPending:false});
  expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[who.tokens.session.subjectId])).rows[0].n).toBe(0);
});

test('owner sees only active candidates and explicit acceptance unlocks a real transfer',async({request})=>{
  const owner=await fx.register(),recipient=await fx.register(),outsider=await fx.register();
  const created=await request.post(url+'/v1/families',{headers:{...headers(owner.tokens.accessToken),'idempotency-key':randomUUID()}});
  const family=(await created.json()).data.familyId;
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",[family,recipient.tokens.session.subjectId]);
  const candidates=()=>request.get(`${url}/v1/families/${family}/deletion-recipients`,{headers:headers(owner.tokens.accessToken)});
  expect((await (await candidates()).json()).data[0]).toMatchObject({subjectId:recipient.tokens.session.subjectId,management:'pending'});
  expect((await request.get(`${url}/v1/families/${family}/deletion-recipients`,{headers:headers(outsider.tokens.accessToken)})).status()).toBe(404);
  const scope=(await (await request.get(`${url}/v1/families/${family}/management-acceptance/preview`,{headers:headers(recipient.tokens.accessToken)})).json()).data;
  const accepted=await request.post(`${url}/v1/families/${family}/management-acceptance`,{headers:headers(recipient.tokens.accessToken),data:{expectedFamilyVersion:scope.familyVersion,expectedMembershipVersion:scope.membershipVersion,expectedOwnerMembershipVersion:scope.ownerMembershipVersion,expectedChildScopeDigest:scope.childScopeDigest,acceptance:{familyManagement:true,guardianship:true}}});
  expect(accepted.status()).toBe(201);expect((await (await candidates()).json()).data[0].management).toBe('accepted');
  const response=await request.delete(url+'/v1/me/account',{headers:{...headers(owner.tokens.accessToken),'idempotency-key':randomUUID()},data:{reauthGrant:await proof(request,owner.tokens.accessToken),confirmation:true,dependencyDisposition:{kind:'per-family',families:[{familyId:family,kind:'transfer',recipientSubjectId:recipient.tokens.session.subjectId}]}}});
  expect(response.status()).toBe(202);
  expect((await db.app.query('SELECT owner_subject_id,status FROM siyue.families WHERE id=$1',[family])).rows[0]).toEqual({owner_subject_id:recipient.tokens.session.subjectId,status:'active'});
});

test('frozen family stays locked until an accepted scope is closed by the designated operator',async({request})=>{
  const owner=await fx.register(),recipient=await fx.register();
  const created=await request.post(url+'/v1/families',{headers:{...headers(owner.tokens.accessToken),'idempotency-key':randomUUID()}});
  const family=(await created.json()).data.familyId;
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",[family,recipient.tokens.session.subjectId]);
  const response=await request.delete(url+'/v1/me/account',{headers:{...headers(owner.tokens.accessToken),'idempotency-key':randomUUID()},data:{reauthGrant:await proof(request,owner.tokens.accessToken),confirmation:true,dependencyDisposition:{kind:'per-family',families:[{familyId:family,kind:'end-family-access'}]}}});expect(response.status()).toBe(202);
  const pending=(await (await request.get(url+'/v1/me/family-responsibilities',{headers:headers(recipient.tokens.accessToken)})).json()).data;
  expect(pending).toContainEqual({familyId:family,status:'frozen'});
  const scope=(await (await request.get(`${url}/v1/families/${family}/frozen-review/preview`,{headers:headers(recipient.tokens.accessToken)})).json()).data;
  const accepted=await request.post(`${url}/v1/families/${family}/frozen-review/acceptance`,{headers:headers(recipient.tokens.accessToken),data:{expectedFamilyVersion:scope.familyVersion,expectedMembershipVersion:scope.membershipVersion,expectedOwnerMembershipVersion:scope.ownerMembershipVersion,expectedChildScopeDigest:scope.childScopeDigest,acceptance:{familyManagement:true,guardianship:true}}});expect(accepted.status()).toBe(201);
  expect((await db.app.query('SELECT status FROM siyue.families WHERE id=$1',[family])).rows[0].status).toBe('frozen');
  const receipt=(await response.json()).data;
  const acceptance=(await accepted.json()).data;
  const review=(await db.app.query('SELECT id FROM siyue.account_deletion_family_reviews WHERE family_id=$1',[family])).rows[0];
  const args=['resolve','--review',review.id,'--recipient',recipient.tokens.session.subjectId,
    '--acceptance',acceptance.acceptanceId,'--family-version',String(scope.familyVersion),
    '--recipient-membership-version',String(scope.membershipVersion),'--owner-membership-version',String(scope.ownerMembershipVersion),
    '--child-scope-digest',scope.childScopeDigest,'--shared-work','no_shared_work','--reason','QA-FROZEN-REVIEW',
    '--idempotency-key',randomUUID(),'--shared-work-checked-at',fx.clock().toISOString()];
  const resolve=()=>runFrozenFamilyReviewCli({argv:args,clock:fx.clock,env:{
    SIYUE_FROZEN_FAMILY_REVIEW_DATABASE_URL:operatorUrl,SIYUE_DATABASE_NAME:'siyue_test',
    SIYUE_ENVIRONMENT:'test',SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS:'siyue_review_operator'}});
  const closed=await resolve();expect(closed).toMatchObject({exitCode:0,output:{ok:true,resolution:{replayed:false}}});
  expect((await resolve()).output.resolution.replayed).toBe(true);
  expect((await db.app.query('SELECT status,owner_subject_id FROM siyue.families WHERE id=$1',[family])).rows[0])
    .toEqual({status:'active',owner_subject_id:recipient.tokens.session.subjectId});
  await createAccountDeletionGuardedCleanupRunner(db.app,{ledger,clock:fx.clock}).sweep();
  const progress=await request.post(url+'/v1/account/deletion/status',{data:{deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret}});
  expect((await progress.json()).data.serverDataDeleted).toBe(true);
  // Cleanup must preserve the other adult's acceptance and the operator's immutable closure proof.
  expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.family_review_resolutions WHERE review_id=$1',[review.id])).rows[0].n).toBe(1);
  expect((await db.app.query('SELECT recipient_subject_id,deleting_subject_id FROM siyue.family_review_acceptances WHERE id=$1',[acceptance.acceptanceId])).rows[0])
    .toEqual({recipient_subject_id:recipient.tokens.session.subjectId,deleting_subject_id:null});
  expect((await resolve()).output.resolution.replayed).toBe(true);
});
