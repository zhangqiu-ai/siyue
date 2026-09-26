import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startPostgresFixture} from './postgres-fixture.mjs';
import {createEmailFixture} from './email-fixture.mjs';
import {transaction} from '../../dist/adapters/postgres/database.js';
import {createFamilyRepository} from '../../dist/modules/families/repository.js';
import {createAccountDeletionImpactService} from '../../dist/modules/auth/account-deletion-impact.js';
import {createAccountDeletionJobStore} from '../../dist/modules/auth/account-deletion-jobs.js';
import {createAccountDeletionAcceptKernel} from '../../dist/modules/auth/account-deletion-accept.js';
import {createAccountDeletionIdempotencyStore} from '../../dist/modules/auth/account-deletion-idempotency.js';
import {createAccountDeletionSubmission} from '../../dist/modules/auth/account-deletion-submission.js';
import {createFamilyManagementAcceptanceService} from '../../dist/modules/auth/family-management-acceptance.js';
import {createAppleRevocationPostgresStore} from '../../dist/identities/apple/revocation-postgres.js';
import {createAppleRevocationOutbox} from '../../dist/identities/apple/revocation-outbox.js';
import {createDeletionLedgerStore,DELETION_LEDGER_FORMAT} from '../../dist/account-deletion-ledger/index.js';
import {createDeletionLedgerGate} from '../../dist/account-deletion-ledger/login-gate.js';
import {createSessionService} from '../../dist/modules/auth/sessions.js';
import {createPreparedReconciler} from '../../dist/account-deletion-ledger/prepared-reconciler.js';

let db,fx,accept,jobs,queue,ledger,ledgerAdmin,ledgerPool;
before(async()=>{
  db=await startPostgresFixture();
  const socket=(await db.admin.query("SELECT current_setting('unix_socket_directories') AS socket")).rows[0].socket;
  const bin=process.env.SIYUE_TEST_POSTGRES_BIN??'/opt/homebrew/opt/postgresql@17/bin';
  execFileSync(`${bin}/psql`,['-h',socket,'-U','siyue_test_admin','-d','postgres','-f',
    fileURLToPath(new URL('../../provision/deletion-ledger.sql',import.meta.url))],{
    env:{...process.env,LC_ALL:'C',SIYUE_DELETION_LEDGER_DATABASE:'siyue_deletion_ledger',
      SIYUE_DELETION_LEDGER_ENVIRONMENT:'test',SIYUE_DELETION_LEDGER_APP_PASSWORD:randomBytes(32).toString('hex')},
    stdio:['ignore','pipe','pipe'],timeout:30_000});
  ledgerAdmin=db.poolFor('siyue_test_admin','siyue_deletion_ledger');
  ledgerPool=db.poolFor('siyue_deletion_ledger_app','siyue_deletion_ledger');
});
beforeEach(async()=>{
  await db.admin.query('TRUNCATE siyue.subjects CASCADE');
  await ledgerAdmin.query('TRUNCATE ledger.entries');
  await ledgerAdmin.query(`UPDATE ledger.metadata SET format=$1,environment='test',seq=0,entry_count=0`,
    [DELETION_LEDGER_FORMAT]);
  fx=await createEmailFixture(db);
  ledger=createDeletionLedgerStore(ledgerPool,
    {database:'siyue_deletion_ledger',environment:'test'},fx.clock);
  jobs=createAccountDeletionJobStore(db.app,fx.clock);
  queue=createAppleRevocationOutbox({store:createAppleRevocationPostgresStore(db.app),
    cipher:fx.cipher,revoke:async()=>{throw new Error('provider_not_called_by_acceptance');},clock:fx.clock});
  accept=createAccountDeletionAcceptKernel(db.app,fx.service,
    createAccountDeletionImpactService(db.app,fx.service,fx.clock),jobs,queue,ledger,fx.clock);
});
after(async()=>{await db?.stop();});
const query=(sql,...args)=>db.app.query(sql,args).then(result=>result.rows);
const proof=who=>transaction(db.app,client=>fx.service.issueReauth(client,who.session.sessionId,'delete-account'));

test('internal acceptance invalidates all subject sessions and creates one pending receipt atomically',async()=>{
  const who=await fx.issue();
  const second=await transaction(db.app,client=>fx.service.issue(client,who.session.subjectId,randomUUID(),'email'));
  const grant=await proof(who);
  const receipt=await accept.acceptUnattached({accessToken:who.accessToken,reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'none'}});
  assert.equal((await query('SELECT status FROM siyue.subjects WHERE id=$1',who.session.subjectId))[0].status,'deletion_pending');
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL',who.session.subjectId))[0].n,0);
  assert.equal((await query(`SELECT count(*)::int AS n FROM siyue.refresh_tokens t JOIN siyue.auth_sessions s ON s.id=t.session_id
    WHERE s.subject_id=$1 AND (t.revoked_at IS NULL OR t.retry_ciphertext IS NOT NULL)`,who.session.subjectId))[0].n,0);
  await assert.rejects(fx.service.verify(who.accessToken));
  await assert.rejects(fx.service.verify(second.accessToken));
  assert.deepEqual(await jobs.status({deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret}),
    {serverDataDeleted:false,providerRevocationPending:false,completedAt:null,lastErrorCode:null});
  assert.deepEqual((await ledger.lookup(who.session.subjectId))?.status,'accepted');
  assert.deepEqual((await ledger.lookup(who.session.subjectId))?.intentId,receipt.deletionId);
  const audit=(await query(`SELECT event_type,subject_id,session_id,request_id,outcome,redacted_metadata
    FROM siyue.security_events WHERE event_type='account.deletion.accept'`))[0];
  assert.deepEqual(audit,{event_type:'account.deletion.accept',subject_id:who.session.subjectId,
    session_id:who.session.sessionId,request_id:receipt.deletionId,outcome:'success',redacted_metadata:null});
  await assert.rejects(accept.acceptUnattached({accessToken:who.accessToken,reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'none'}}));
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs WHERE subject_id=$1',who.session.subjectId))[0].n,1);
});

test('启用逐次账本门禁时，受理先锁定验证会话再持久化 prepared',async()=>{
  const who=await fx.issue(),grant=await proof(who);
  const gated=createSessionService(db.app,fx.signer,fx.cipher,fx.clock,
    {loginGate:createDeletionLedgerGate(ledger)});
  const accepting=createAccountDeletionAcceptKernel(db.app,gated,
    createAccountDeletionImpactService(db.app,gated,fx.clock),jobs,queue,ledger,fx.clock);
  const receipt=await accepting.acceptUnattached({accessToken:who.accessToken,
    reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'none'}});
  assert.equal((await ledger.lookup(who.session.subjectId)).status,'accepted');
  assert.equal((await query('SELECT id FROM siyue.account_deletion_jobs WHERE subject_id=$1',
    who.session.subjectId))[0].id,receipt.deletionId);
});

test('a family dependency or invalid confirmation refuses without spending the proof',async()=>{
  const who=await fx.issue();
  const grant=await proof(who);
  await assert.rejects(accept.acceptUnattached({accessToken:who.accessToken,reauthGrant:grant.reauthGrant,confirmation:false,dependencyDisposition:{kind:'none'}}),
    {code:'AUTH_INVALID_REQUEST'});
  await assert.rejects(accept.acceptUnattached({accessToken:who.accessToken,reauthGrant:grant.reauthGrant,
    confirmation:true,dependencyDisposition:{kind:'end-family-access'}}),{code:'AUTH_INVALID_REQUEST'});
  const family=await transaction(db.app,client=>createFamilyRepository(db.app).create(client,who.session.subjectId,
    createHash('sha256').update(randomUUID()).digest('hex')));
  const formerMember=await fx.issue();
  await db.app.query(`INSERT INTO siyue.family_memberships(family_id,subject_id,role,active)
    VALUES($1,$2,'member',false)`, [family.familyId,formerMember.session.subjectId]);
  await assert.rejects(accept.acceptUnattached({accessToken:who.accessToken,reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'none'}}),
    {code:'AUTH_DELETION_DEPENDENCIES'});
  await assert.rejects(accept.acceptUnattached({accessToken:who.accessToken,reauthGrant:grant.reauthGrant,
    confirmation:true,dependencyDisposition:{kind:'per-family',families:[
      {familyId:family.familyId,kind:'end-family-access'}]}}),
  {code:'AUTH_DELETION_DEPENDENCIES'});
  assert.equal((await query('SELECT status FROM siyue.subjects WHERE id=$1',who.session.subjectId))[0].status,'active');
  assert.equal((await query('SELECT consumed_at FROM siyue.reauth_grants WHERE session_id=$1',who.session.sessionId))[0].consumed_at,null);
  assert.equal(await ledger.lookup(who.session.subjectId),null);
  assert.ok(family.familyId);
});

test('an owner may delete a truly empty family in the same accepted transaction',async()=>{
  const owner=await fx.issue();
  const family=await transaction(db.app,client=>createFamilyRepository(db.app).create(client,
    owner.session.subjectId,createHash('sha256').update(randomUUID()).digest('hex')));
  const grant=await proof(owner);
  const receipt=await accept.acceptUnattached({accessToken:owner.accessToken,
    reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'per-family',families:[
      {familyId:family.familyId,kind:'end-family-access'}]}});
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.families WHERE id=$1',family.familyId))[0].n,0);
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1',
    family.familyId))[0].n,0);
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.account_deletion_family_reviews'))[0].n,0);
  assert.equal((await query('SELECT status FROM siyue.subjects WHERE id=$1',owner.session.subjectId))[0]
    .status,'deletion_pending');
  assert.equal((await ledger.lookup(owner.session.subjectId)).intentId,receipt.deletionId);
});

test('recipient acceptance lets deletion transfer one family in the same accepted transaction',async()=>{
  const owner=await fx.issue(),recipient=await fx.issue();
  const family=await transaction(db.app,client=>createFamilyRepository(db.app).create(client,
    owner.session.subjectId,createHash('sha256').update(randomUUID()).digest('hex')));
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [family.familyId,recipient.session.subjectId]);
  const manager=createFamilyManagementAcceptanceService(db.app,fx.service,fx.clock);
  const preview=await manager.preview(recipient.accessToken,family.familyId);
  const accepted=await manager.accept(recipient.accessToken,family.familyId,{
    expectedFamilyVersion:preview.familyVersion,
    expectedMembershipVersion:preview.membershipVersion,
    expectedOwnerMembershipVersion:preview.ownerMembershipVersion,
    expectedChildScopeDigest:preview.childScopeDigest,
    acceptance:{familyManagement:true,guardianship:true},
  });
  const grant=await proof(owner);
  const receipt=await accept.acceptUnattached({accessToken:owner.accessToken,
    reauthGrant:grant.reauthGrant,confirmation:true,
    dependencyDisposition:{kind:'per-family',families:[
      {familyId:family.familyId,kind:'transfer',recipientSubjectId:recipient.session.subjectId}]}});
  assert.equal((await query('SELECT status FROM siyue.subjects WHERE id=$1',owner.session.subjectId))[0].status,
    'deletion_pending');
  assert.equal((await query('SELECT owner_subject_id FROM siyue.families WHERE id=$1',family.familyId))[0]
    .owner_subject_id,recipient.session.subjectId);
  assert.ok((await query('SELECT consumed_at FROM siyue.family_management_acceptances WHERE id=$1',
    accepted.acceptanceId))[0].consumed_at);
  assert.equal((await ledger.lookup(owner.session.subjectId)).intentId,receipt.deletionId);
});

test('two families transfer independently',async()=>{
  const owner=await fx.issue(),recipients=[await fx.issue(),await fx.issue()];
  const manager=createFamilyManagementAcceptanceService(db.app,fx.service,fx.clock);
  const families=[];
  for(const recipient of recipients){
    const family=await transaction(db.app,client=>createFamilyRepository(db.app).create(client,
      owner.session.subjectId,createHash('sha256').update(randomUUID()).digest('hex')));
    await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
      [family.familyId,recipient.session.subjectId]);
    const preview=await manager.preview(recipient.accessToken,family.familyId);
    const acceptance=await manager.accept(recipient.accessToken,family.familyId,{
      expectedFamilyVersion:preview.familyVersion,
      expectedMembershipVersion:preview.membershipVersion,
      expectedOwnerMembershipVersion:preview.ownerMembershipVersion,
      expectedChildScopeDigest:preview.childScopeDigest,
      acceptance:{familyManagement:true,guardianship:true},
    });
    families.push({family,recipient,acceptance});
  }
  const proofGrant=await proof(owner);
  const both={kind:'per-family',families:families.slice().reverse().map(item=>({
    familyId:item.family.familyId,kind:'transfer',recipientSubjectId:item.recipient.session.subjectId}))};
  const receipt=await accept.acceptUnattached({accessToken:owner.accessToken,
    reauthGrant:proofGrant.reauthGrant,confirmation:true,dependencyDisposition:both});
  for(const item of families)assert.equal((await query('SELECT owner_subject_id FROM siyue.families WHERE id=$1',
    item.family.familyId))[0].owner_subject_id,item.recipient.session.subjectId);
  assert.equal((await ledger.lookup(owner.session.subjectId)).intentId,receipt.deletionId);
});

test('mixed transfer and end-management freezes only the selected family and records review atomically',async()=>{
  const owner=await fx.issue(),recipient=await fx.issue(),remaining=await fx.issue();
  const familyRepository=createFamilyRepository(db.app);
  const transferred=await transaction(db.app,client=>familyRepository.create(client,owner.session.subjectId,
    createHash('sha256').update(randomUUID()).digest('hex')));
  const frozen=await transaction(db.app,client=>familyRepository.create(client,owner.session.subjectId,
    createHash('sha256').update(randomUUID()).digest('hex')));
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member'),($3,$4,'member')",
    [transferred.familyId,recipient.session.subjectId,frozen.familyId,remaining.session.subjectId]);
  const childId=randomUUID(),consentId=randomUUID(),grantId=randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')",[childId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [frozen.familyId,childId]);
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-guardianship','1.0')`,[consentId,owner.session.subjectId,childId]);
  await db.app.query(`INSERT INTO siyue.guardian_relationships
    (family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)`,
  [frozen.familyId,owner.session.subjectId,childId,consentId]);
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,
    installation_id,platform,guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios',1,1,ARRAY[]::text[],$6)`,
  [grantId,childId,owner.session.subjectId,frozen.familyId,randomUUID(),new Date(+fx.clock()+86_400_000)]);
  const childTokens=await transaction(db.app,client=>fx.service.issueChild(client,grantId));
  const manager=createFamilyManagementAcceptanceService(db.app,fx.service,fx.clock);
  const preview=await manager.preview(recipient.accessToken,transferred.familyId);
  await manager.accept(recipient.accessToken,transferred.familyId,{
    expectedFamilyVersion:preview.familyVersion,expectedMembershipVersion:preview.membershipVersion,
    expectedOwnerMembershipVersion:preview.ownerMembershipVersion,
    expectedChildScopeDigest:preview.childScopeDigest,
    acceptance:{familyManagement:true,guardianship:true},
  });
  const grant=await proof(owner);
  const receipt=await accept.acceptUnattached({accessToken:owner.accessToken,reauthGrant:grant.reauthGrant,
    confirmation:true,dependencyDisposition:{kind:'per-family',families:[
      {familyId:transferred.familyId,kind:'transfer',recipientSubjectId:recipient.session.subjectId},
      {familyId:frozen.familyId,kind:'end-family-access'}]}});
  assert.deepEqual((await query('SELECT owner_subject_id,status FROM siyue.families WHERE id=$1',
    transferred.familyId))[0],{owner_subject_id:recipient.session.subjectId,status:'active'});
  assert.deepEqual((await query('SELECT owner_subject_id,status FROM siyue.families WHERE id=$1',
    frozen.familyId))[0],{owner_subject_id:owner.session.subjectId,status:'frozen'});
  const review=(await query(`SELECT deletion_id,family_id,deleting_subject_id,state,resolved_at
    FROM siyue.account_deletion_family_reviews`))[0];
  assert.deepEqual(review,{deletion_id:receipt.deletionId,family_id:frozen.familyId,
    deleting_subject_id:owner.session.subjectId,state:'pending',resolved_at:null});
  assert.ok((await query('SELECT revoked_at FROM siyue.device_grants WHERE id=$1',grantId))[0].revoked_at);
  await assert.rejects(fx.service.verify(childTokens.accessToken));
  assert.equal((await query('SELECT status FROM siyue.subjects WHERE id=$1',owner.session.subjectId))[0].status,
    'deletion_pending');
  assert.equal((await ledger.lookup(owner.session.subjectId)).intentId,receipt.deletionId);
});

test('a non-owner adult can end only their own access while the family stays active',async()=>{
  const owner=await fx.issue(),member=await fx.issue();
  const family=await transaction(db.app,client=>createFamilyRepository(db.app).create(client,
    owner.session.subjectId,createHash('sha256').update(randomUUID()).digest('hex')));
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [family.familyId,member.session.subjectId]);
  const grant=await proof(member);
  const receipt=await accept.acceptUnattached({accessToken:member.accessToken,
    reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'per-family',families:[
      {familyId:family.familyId,kind:'end-family-access'}]}});
  assert.equal((await query('SELECT owner_subject_id,status FROM siyue.families WHERE id=$1',family.familyId))[0]
    .owner_subject_id,owner.session.subjectId);
  assert.equal((await query('SELECT status FROM siyue.families WHERE id=$1',family.familyId))[0].status,'active');
  assert.equal((await query('SELECT active FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    family.familyId,member.session.subjectId))[0].active,false);
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.account_deletion_family_reviews'))[0].n,0);
  assert.equal((await query('SELECT status FROM siyue.subjects WHERE id=$1',member.session.subjectId))[0]
    .status,'deletion_pending');
  assert.equal((await ledger.lookup(member.session.subjectId)).intentId,receipt.deletionId);
});

test('freezing a family never exempts an orphaned guardianship consent',async()=>{
  const owner=await fx.issue(),remaining=await fx.issue(),childId=randomUUID();
  const family=await transaction(db.app,client=>createFamilyRepository(db.app).create(client,
    owner.session.subjectId,createHash('sha256').update(randomUUID()).digest('hex')));
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [family.familyId,remaining.session.subjectId]);
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')",[childId]);
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-guardianship','1.0')`,[randomUUID(),owner.session.subjectId,childId]);
  const grant=await proof(owner);
  await assert.rejects(accept.acceptUnattached({accessToken:owner.accessToken,
    reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'per-family',families:[
      {familyId:family.familyId,kind:'end-family-access'}]}}),{code:'AUTH_DELETION_DEPENDENCIES'});
  assert.equal((await query('SELECT status FROM siyue.families WHERE id=$1',family.familyId))[0].status,'active');
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.account_deletion_family_reviews'))[0].n,0);
  assert.equal((await query('SELECT consumed_at FROM siyue.reauth_grants WHERE session_id=$1',
    owner.session.sessionId))[0].consumed_at,null);
  assert.equal(await ledger.lookup(owner.session.subjectId),null);
});

test('an orphaned guardianship consent is rejected before acceptance even when impact preview is empty',async()=>{
  const who=await fx.issue(),grant=await proof(who),childId=randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')",[childId]);
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-guardianship','1.0')`,[randomUUID(),who.session.subjectId,childId]);
  await assert.rejects(accept.acceptUnattached({accessToken:who.accessToken,
    reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'none'}}),
    {code:'AUTH_DELETION_DEPENDENCIES'});
  assert.equal((await query('SELECT status FROM siyue.subjects WHERE id=$1',who.session.subjectId))[0].status,'active');
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs'))[0].n,0);
  assert.equal(await ledger.lookup(who.session.subjectId),null);
  assert.equal((await query("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='account.deletion.accept'"))[0].n,0);
});

test('job insertion failure rolls back status and revocation',async()=>{
  const who=await fx.issue(),grant=await proof(who);
  const failing=createAccountDeletionAcceptKernel(db.app,fx.service,
    createAccountDeletionImpactService(db.app,fx.service,fx.clock),
    {insertPending:async()=>{throw new Error('synthetic_job_failure');}},queue,ledger,fx.clock);
  await assert.rejects(failing.acceptUnattached({accessToken:who.accessToken,reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'none'}}),
    /synthetic_job_failure/);
  assert.equal((await query('SELECT status FROM siyue.subjects WHERE id=$1',who.session.subjectId))[0].status,'active');
  assert.equal((await query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',who.session.sessionId))[0].revoked_at,null);
  assert.equal((await query('SELECT consumed_at FROM siyue.reauth_grants WHERE session_id=$1',who.session.sessionId))[0].consumed_at,null);
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs'))[0].n,0);
  assert.equal((await query("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='account.deletion.accept'"))[0].n,0);
  assert.equal((await ledger.lookup(who.session.subjectId))?.status,'cancelled');
});

test('job insertion failure rolls back a frozen family and its child device revocation',async()=>{
  const owner=await fx.issue(),remaining=await fx.issue(),grant=await proof(owner);
  const family=await transaction(db.app,client=>createFamilyRepository(db.app).create(client,
    owner.session.subjectId,createHash('sha256').update(randomUUID()).digest('hex')));
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [family.familyId,remaining.session.subjectId]);
  const childId=randomUUID(),consentId=randomUUID(),deviceGrantId=randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')",[childId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [family.familyId,childId]);
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-guardianship','1.0')`,[consentId,owner.session.subjectId,childId]);
  await db.app.query(`INSERT INTO siyue.guardian_relationships
    (family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)`,
  [family.familyId,owner.session.subjectId,childId,consentId]);
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,
    installation_id,platform,guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios',1,1,ARRAY[]::text[],$6)`,
  [deviceGrantId,childId,owner.session.subjectId,family.familyId,randomUUID(),
    new Date(+fx.clock()+86_400_000)]);
  const childTokens=await transaction(db.app,client=>fx.service.issueChild(client,deviceGrantId));
  const failing=createAccountDeletionAcceptKernel(db.app,fx.service,
    createAccountDeletionImpactService(db.app,fx.service,fx.clock),
    {insertPending:async()=>{throw new Error('synthetic_job_failure');}},queue,ledger,fx.clock);
  await assert.rejects(failing.acceptUnattached({accessToken:owner.accessToken,
    reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'per-family',families:[
      {familyId:family.familyId,kind:'end-family-access'}]}}),/synthetic_job_failure/);
  assert.equal((await query('SELECT status FROM siyue.families WHERE id=$1',family.familyId))[0].status,'active');
  assert.equal((await query('SELECT revoked_at FROM siyue.device_grants WHERE id=$1',deviceGrantId))[0].revoked_at,null);
  assert.equal((await query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',childTokens.session.sessionId))[0].revoked_at,null);
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.account_deletion_family_reviews'))[0].n,0);
  assert.equal((await query('SELECT status FROM siyue.subjects WHERE id=$1',owner.session.subjectId))[0].status,'active');
  assert.equal((await ledger.lookup(owner.session.subjectId))?.status,'cancelled');
  assert.equal((await fx.service.verify(childTokens.accessToken)).subjectId,childId);
});

test('commit 后账本暂不可写时保留 prepared 和已提交作业，供恢复对账',async()=>{
  const who=await fx.issue(),grant=await proof(who);
  const failing=createAccountDeletionAcceptKernel(db.app,fx.service,
    createAccountDeletionImpactService(db.app,fx.service,fx.clock),jobs,queue,
    {...ledger,markAccepted:async()=>{throw new Error('synthetic_marker_failure');}},fx.clock);
  await assert.rejects(failing.acceptUnattached({accessToken:who.accessToken,
    reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'none'}}),
  /synthetic_marker_failure/);
  const marker=await ledger.lookup(who.session.subjectId);
  const job=(await query('SELECT id,state FROM siyue.account_deletion_jobs WHERE subject_id=$1',
    who.session.subjectId))[0];
  assert.equal(marker?.status,'prepared');
  assert.equal(marker?.intentId,job.id);
  assert.equal(job.state,'accepted');
  assert.equal((await query('SELECT status FROM siyue.subjects WHERE id=$1',who.session.subjectId))[0].status,
    'deletion_pending');
  const resolved=await createPreparedReconciler(db.app,ledger).reconcile();
  assert.deepEqual(resolved.unresolved,[]);
  assert.equal(resolved.reconciled.length,1);
  assert.equal((await ledger.lookup(who.session.subjectId))?.status,'accepted');
});

test('a malformed accepted marker cannot release a successful receipt',async()=>{
  const who=await fx.issue(),grant=await proof(who);
  const accepting=createAccountDeletionAcceptKernel(db.app,fx.service,
    createAccountDeletionImpactService(db.app,fx.service,fx.clock),jobs,queue,
    {...ledger,markAccepted:async()=>({status:'prepared',intentId:randomUUID(),subjectId:who.session.subjectId})},fx.clock);
  await assert.rejects(accepting.acceptUnattached({accessToken:who.accessToken,
    reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'none'}}),
  {code:'AUTH_TEMPORARILY_UNAVAILABLE',status:503});
  assert.equal((await ledger.lookup(who.session.subjectId)).status,'prepared');
});

test('lost deletion response recovers only after the independent ledger accepts the committed job',async()=>{
  const who=await fx.issue(),grant=await proof(who),key=randomUUID();
  const idempotency=createAccountDeletionIdempotencyStore(db.app,fx.cipher,randomBytes(32),fx.clock);
  const failing=createAccountDeletionAcceptKernel(db.app,fx.service,
    createAccountDeletionImpactService(db.app,fx.service,fx.clock),jobs,queue,
    {...ledger,markAccepted:async()=>{throw new Error('synthetic_marker_failure');}},fx.clock,idempotency);
  const submit=createAccountDeletionSubmission(db.app,failing,idempotency,ledger);
  const request={key,accessToken:who.accessToken,reauthGrant:grant.reauthGrant,
    confirmation:true,dependencyDisposition:{kind:'none'}};
  await assert.rejects(submit.submit(request),{code:'AUTH_TEMPORARILY_UNAVAILABLE',status:503});
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs'))[0].n,1);
  assert.equal((await ledger.lookup(who.session.subjectId)).status,'prepared');
  assert.equal((await query('SELECT subject_id FROM siyue.idempotency_records WHERE scope=$1',
    'account-deletion'))[0].subject_id,null);
  const reconciled=await createPreparedReconciler(db.app,ledger).reconcile();
  assert.deepEqual(reconciled.unresolved,[]);
  const receipt=await submit.submit(request);
  assert.equal(receipt.deletionId,(await query('SELECT id FROM siyue.account_deletion_jobs'))[0].id);
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs'))[0].n,1);
  await assert.rejects(submit.submit({...request,reauthGrant:`${randomUUID()}.${'a'.repeat(43)}`}),
    {code:'AUTH_IDEMPOTENCY_CONFLICT',status:409});
  fx.advance(61_000);
  await assert.rejects(submit.submit(request),{code:'AUTH_DELETION_RECEIPT_UNRECOVERABLE',status:409});
  fx.advance(86_400_000);
  await db.app.query('DELETE FROM siyue.idempotency_records WHERE expires_at<=$1',[fx.clock()]);
  await assert.rejects(submit.submit(request),{code:'AUTH_DELETION_OUTCOME_UNKNOWN',status:409});
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs'))[0].n,1);
});

test('Apple revocation enqueue failure rolls back acceptance instead of misreporting a missing credential',async()=>{
  const who=await fx.issue(),grant=await proof(who);
  await db.app.query(`INSERT INTO siyue.external_identities
    (id,subject_id,provider,provider_namespace,provider_subject,client_id,issuer)
    VALUES($1,$2,'apple','synthetic-team',$3,'app.siyue.synthetic','https://appleid.apple.com')`,
    [randomUUID(),who.session.subjectId,randomUUID()]);
  const failing=createAccountDeletionAcceptKernel(db.app,fx.service,
    createAccountDeletionImpactService(db.app,fx.service,fx.clock),jobs,
    {enqueueForSubject:async()=>{throw new Error('synthetic_queue_failure');}},ledger,fx.clock);
  await assert.rejects(failing.acceptUnattached({accessToken:who.accessToken,
    reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'none'}}),/synthetic_queue_failure/);
  assert.equal((await query('SELECT status FROM siyue.subjects WHERE id=$1',who.session.subjectId))[0].status,'active');
  assert.equal((await query('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs'))[0].n,0);
});

test('an Apple identity without a usable provider token does not trap the user in an active account',async()=>{
  const who=await fx.issue(),grant=await proof(who);
  await db.app.query(`INSERT INTO siyue.external_identities
    (id,subject_id,provider,provider_namespace,provider_subject,client_id,issuer)
    VALUES($1,$2,'apple','synthetic-team',$3,'app.siyue.synthetic','https://appleid.apple.com')`,
    [randomUUID(),who.session.subjectId,randomUUID()]);
  const receipt=await accept.acceptUnattached({accessToken:who.accessToken,reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'none'}});
  assert.deepEqual(await jobs.status({deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret}),
    {serverDataDeleted:false,providerRevocationPending:true,completedAt:null,lastErrorCode:'apple_credential_missing'});
  assert.equal((await query('SELECT status FROM siyue.subjects WHERE id=$1',who.session.subjectId))[0].status,'deletion_pending');
});

test('Apple revocation is durably queued in the same transaction as internal acceptance',async()=>{
  const who=await fx.issue(),grant=await proof(who),identityId=randomUUID(),namespace='synthetic-team';
  await db.app.query(`INSERT INTO siyue.external_identities
    (id,subject_id,provider,provider_namespace,provider_subject,client_id,issuer)
    VALUES($1,$2,'apple',$3,$4,'app.siyue.synthetic','https://appleid.apple.com')`,
    [identityId,who.session.subjectId,namespace,randomUUID()]);
  const ciphertext=fx.cipher.seal({refreshToken:'synthetic-apple-token'},`apple-identity:${identityId}:${namespace}`);
  await db.app.query('INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext) VALUES($1,$2)',
    [identityId,ciphertext]);
  const accepting=createAccountDeletionAcceptKernel(db.app,fx.service,
    createAccountDeletionImpactService(db.app,fx.service,fx.clock),jobs,queue,ledger,fx.clock);
  const receipt=await accepting.acceptUnattached({accessToken:who.accessToken,reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'none'}});
  const queued=await query('SELECT identity_id,refresh_ciphertext,status FROM siyue.apple_revocation_outbox WHERE identity_id=$1',identityId);
  assert.deepEqual(queued,[{identity_id:identityId,refresh_ciphertext:ciphertext,status:'pending'}]);
  assert.equal(JSON.stringify(queued).includes('synthetic-apple-token'),false);
  assert.deepEqual(await jobs.status({deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret}),
    {serverDataDeleted:false,providerRevocationPending:true,completedAt:null,lastErrorCode:null});
});

test('acceptance cancels queued verification mail for the deleting account',async()=>{
  const {tokens,address}=await fx.register();
  fx.advance(61_000);
  const reset=await fx.request('password-reset',address);
  const grant=await proof(tokens);
  await accept.acceptUnattached({accessToken:tokens.accessToken,reauthGrant:grant.reauthGrant,confirmation:true,dependencyDisposition:{kind:'none'}});
  const challenge=(await query('SELECT status FROM siyue.email_challenges WHERE id=$1',reset.challengeId))[0];
  const mail=(await query('SELECT status,payload_ciphertext FROM siyue.outbox_jobs WHERE aggregate_id=$1',reset.challengeId))[0];
  assert.equal(challenge.status,'superseded');
  assert.deepEqual(mail,{status:'cancelled',payload_ciphertext:null});
});
