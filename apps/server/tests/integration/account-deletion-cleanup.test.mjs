import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createFamilyRepository } from '../../dist/modules/families/repository.js';
import { createAccountDeletionJobStore } from '../../dist/modules/auth/account-deletion-jobs.js';
import { createAccountDeletionCleanupKernel } from '../../dist/modules/auth/account-deletion-cleanup.js';
import { createAccountDeletionRevocationCoordinator } from '../../dist/modules/auth/account-deletion-revocation.js';
import { createFamilyManagementAcceptanceService } from '../../dist/modules/auth/family-management-acceptance.js';

// Server-side account-deletion cleanup kernel (design chapter 13) against an isolated temporary
// PostgreSQL cluster. Every case builds its own state inside the throwaway cluster; the kernel opens no
// route and makes no provider call. Cases that destroy something re-check a second adult's rows, and
// cases that stop re-check the target's own rows, because the kernel may neither damage a bystander nor
// remove anything of its own before an uncertainty is resolved.
const day = 86_400_000;
const zero = { emails: 0, passwordCredentials: 0, challenges: 0, sessions: 0, refreshTokens: 0,
  reauthGrants: 0, appleLoginFlows: 0, roomSeats: 0, accountConsents: 0, idempotencyRecords: 0,
  familyCreateRequests: 0, familyMemberships: 0, mailJobs: 0, appleCredentials: 0,
  appleRevocationJobs: 0, appleIdentities: 0 };
// The layered historical pass is reported apart from the credential and temporary material above, so a
// run that refuses a deletion must report an empty history too -- not merely omit the key.
const historyZero = { invitationsDeleted: 0, invitationsRedacted: 0, invitationsClosed: 0,
  pairingRequests: 0, deviceGrants: 0, guardianships: 0, consents: 0, rooms: 0,
  roomInvitationsDeleted: 0, roomInvitationsRedacted: 0, reviews: 0, reviewAcceptances: 0,
  acceptances: 0, families: 0 };
const zeroRemoved = { ...zero, history: historyZero };

let db, fx, jobs, cleanup;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query('TRUNCATE siyue.subjects, siyue.rate_limit_buckets, siyue.idempotency_records, siyue.outbox_jobs CASCADE');
  fx = await createEmailFixture(db);
  jobs = createAccountDeletionJobStore(db.app, fx.clock);
  cleanup = createAccountDeletionCleanupKernel(db.app, fx.clock);
});
after(async () => { await db?.stop(); });

const query = (sql, ...args) => db.app.query(sql, args);
const rows = (sql, ...args) => query(sql, ...args).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
const keyHash = () => createHash('sha256').update(randomUUID()).digest('hex');

/** A real adult: address, password credential, session, consent and refresh token. */
async function registered() {
  const { tokens, address } = await fx.register();
  return { subjectId: tokens.session.subjectId, refreshToken: tokens.refreshToken, address };
}

/**
 * The same adult after its deletion request was accepted: pending subject plus one deletion job.
 * `prepare` runs while the account is still active, so a case can create the live state that an
 * accepted deletion has to clean up (an outstanding challenge with queued mail, a provider link).
 */
async function accepted({ providerRevocationPending = false, prepare } = {}) {
  const who = await registered();
  if (prepare) await prepare(who);
  await query('UPDATE siyue.subjects SET display_name=$2 WHERE id=$1', who.subjectId, '练习账号');
  await query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1", who.subjectId);
  const receipt = await transaction(db.app, client => jobs.insertPending(client,
    { subjectId: who.subjectId, receiptExpiresAt: new Date(+fx.clock() + day), providerRevocationPending }));
  return { ...who, receipt };
}

/**
 * Minimal Apple link plus, optionally, the durable revocation state that link should carry. `outbox`
 * is the queue status and `windowDays` moves that queue's window (and creation) so a case can sit
 * before or after the bounded revocation deadline. Every column satisfies migration 0016's CHECKs,
 * because a row an impossible state could not insert would not test the state machine.
 */
async function appleIdentity(subjectId, { credential = true, outbox = null,
  namespace = 'synthetic-team', windowDays = 7 } = {}) {
  const identityId = randomUUID();
  await query(`INSERT INTO siyue.external_identities
    (id,subject_id,provider,provider_namespace,provider_subject,client_id,issuer)
    VALUES($1,$2,'apple',$3,$4,'app.siyue.synthetic','https://appleid.apple.com')`,
  identityId, subjectId, namespace, randomUUID());
  if (credential) await query(
    'INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext) VALUES($1,$2)',
    identityId, 'sealed-' + identityId);
  if (outbox) {
    const now = fx.clock();
    const expiresAt = new Date(+now + windowDays * day);
    const createdAt = new Date(+expiresAt - 7 * day);
    // Only pending and sending are non-terminal; revoked and expired drop the queue's own copy of the
    // seal, while needs_attention keeps it for an operator inside the window.
    const settled = outbox === 'pending' || outbox === 'sending' ? null : now;
    const error = outbox === 'revoked' ? null
      : outbox === 'expired' ? 'revocation_window_expired' : 'apple_provider_unavailable';
    await query(`INSERT INTO siyue.apple_revocation_outbox
      (id,identity_id,provider_namespace,refresh_ciphertext,status,attempts,available_at,expires_at,
       created_at,last_error_code,settled_at,retain_until,lease_id,lease_until)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    randomUUID(), identityId, namespace,
    outbox === 'revoked' || outbox === 'expired' ? null : 'sealed-' + identityId,
    outbox, settled ? 1 : 0, createdAt, expiresAt, createdAt, error, settled,
    settled ? new Date(+settled + 30 * day) : null,
    outbox === 'sending' ? randomUUID() : null, outbox === 'sending' ? new Date(+now + 60_000) : null);
  }
  return identityId;
}

test('only an accepted adult deletion that owns a job is a target', async () => {
  const active = await fx.issue();
  const missing = await cleanup.cleanupSubject({ subjectId: randomUUID() })
    .then(() => null, error => error.code);
  const wrongState = await cleanup.cleanupSubject({ subjectId: active.session.subjectId })
    .then(() => null, error => error.code);
  assert.equal(missing, 'cleanup_target_missing');
  assert.equal(wrongState, 'cleanup_target_not_pending');
  assert.equal(await cleanup.cleanupSubject({}).then(() => null, error => error.code),
    'cleanup_invalid_request');
  assert.equal(await cleanup.cleanupSubject({ subjectId: 'not-a-uuid' }).then(() => null, error => error.code),
    'cleanup_invalid_request');
  assert.equal(await cleanup.cleanupSubject({ subjectId: active.session.subjectId, accessToken: 'x' })
    .then(() => null, error => error.code), 'cleanup_invalid_request');

  const childId = randomUUID();
  await query(`INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')`, childId);
  assert.equal(await cleanup.cleanupSubject({ subjectId: childId }).then(() => null, error => error.code),
    'cleanup_target_not_adult');

  // A pending subject without the accepted job is not a target either: nothing may be destroyed without
  // the record that a deletion was authorized.
  const orphan = await fx.issue();
  await query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1", orphan.session.subjectId);
  assert.equal(await cleanup.cleanupSubject({ subjectId: orphan.session.subjectId })
    .then(() => null, error => error.code), 'cleanup_job_missing');

  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails'), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs'), 0);
});

test('an accepted deletion with no dependency is cleaned and completed', async () => {
  let reset;
  // Request the reset while the account is still active, then accept the deletion with it still
  // outstanding: an accepted deletion must cancel that live challenge and its queued mail.
  const who = await accepted({ prepare: async subject => {
    // One challenge request per address per minute: step past the registration's own request.
    fx.advance(61_000);
    reset = await fx.request('password-reset', subject.address);
    // Rotate once so the session owns a replaced_by chain: the delete must remove both ends of it.
    await fx.service.refresh(subject.refreshToken, randomUUID());
  }});
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.outbox_jobs WHERE aggregate_id=$1 AND status='pending'",
    reset.challengeId), 1);

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.deepEqual(result, {
    subjectId: who.subjectId,
    deletionId: who.receipt.deletionId,
    outcome: 'completed',
    serverDataDeleted: true,
    providerRevocationPending: false,
    preservedAppleRevocations: 0,
    blockers: [],
    // The registration challenge is bound to its new subject in the registration transaction;
    // the unused password-reset challenge and its queued mail are also subject-bound.
    removed: { ...zero, emails: 1, passwordCredentials: 1, accountConsents: 1, challenges: 2,
      sessions: 1, refreshTokens: 2, mailJobs: 1, history: historyZero },
  });

  const subject = (await rows('SELECT status,display_name,deleted_at FROM siyue.subjects WHERE id=$1',
    who.subjectId))[0];
  assert.equal(subject.status, 'deleted');
  assert.equal(subject.display_name, '');
  assert.ok(subject.deleted_at);
  for (const table of ['account_emails', 'password_credentials', 'account_consents', 'auth_sessions',
    'refresh_tokens', 'reauth_grants', 'idempotency_records']) {
    const remaining = table === 'refresh_tokens'
      ? await count('SELECT count(*)::int AS n FROM siyue.refresh_tokens t JOIN siyue.auth_sessions s ON s.id=t.session_id WHERE s.subject_id=$1', who.subjectId)
      : await count(`SELECT count(*)::int AS n FROM siyue.${table} WHERE subject_id=$1`, who.subjectId);
    assert.equal(remaining, 0, table);
  }
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE email_normalized=$1',
    who.address), 0);
  const mail = (await rows('SELECT status,payload_ciphertext FROM siyue.outbox_jobs WHERE aggregate_id=$1',
    reset.challengeId))[0];
  assert.equal(mail.status, 'cancelled');
  assert.equal(mail.payload_ciphertext, null);

  const job = (await rows(`SELECT state,local_data_deleted,provider_revocation_pending,completed_at
    FROM siyue.account_deletion_jobs WHERE id=$1`, who.receipt.deletionId))[0];
  assert.equal(job.state, 'completed');
  assert.equal(job.local_data_deleted, true);
  assert.equal(job.provider_revocation_pending, false);
  assert.equal(job.completed_at.toISOString(), fx.clock().toISOString());
  // The receipt still reads this one job's progress; it grants nothing else.
  assert.deepEqual(await jobs.status({ deletionId: who.receipt.deletionId, receiptSecret: who.receipt.receiptSecret }),
    { serverDataDeleted: true, providerRevocationPending: false,
      completedAt: fx.clock().toISOString(), lastErrorCode: null });
});

test('cleanup preserves an earlier account challenge after its address is reused', async () => {
  const address=`${randomUUID()}@example.test`;
  const old=await fx.register(address);
  fx.advance(61_000);
  const oldReset=await fx.request('password-reset',address);
  await query("UPDATE siyue.email_challenges SET status='consumed',consumed_at=$2 WHERE id=$1",
    oldReset.challengeId,fx.clock());
  await query('DELETE FROM siyue.account_emails WHERE subject_id=$1',old.tokens.session.subjectId);
  fx.advance(61_000);
  const newer=await fx.register(address);
  const subjectId=newer.tokens.session.subjectId;
  await query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",subjectId);
  await transaction(db.app,client=>jobs.insertPending(client,{subjectId,
    receiptExpiresAt:new Date(+fx.clock()+day),providerRevocationPending:false}));

  const result=await cleanup.cleanupSubject({subjectId});
  assert.equal(result.serverDataDeleted,true);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE id=$1',
    oldReset.challengeId),1);
  assert.equal((await rows('SELECT subject_id FROM siyue.email_challenges WHERE id=$1',
    oldReset.challengeId))[0].subject_id,old.tokens.session.subjectId);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE id=$1',
    newer.proof.challengeId),0);
});

test('cleanup removes an anonymous reset created while the account is deletion pending', async () => {
  const who=await accepted();
  fx.advance(61_000);
  const reset=await fx.request('password-reset',who.address);
  assert.equal((await rows('SELECT subject_id,status FROM siyue.email_challenges WHERE id=$1',
    reset.challengeId))[0].subject_id,null);
  const result=await cleanup.cleanupSubject({subjectId:who.subjectId});
  assert.equal(result.serverDataDeleted,true);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE id=$1',
    reset.challengeId),0);
});

test('a live family membership stops the run and destroys nothing', async () => {
  const who = await accepted();
  const owner = await fx.issue();
  const family = await transaction(db.app, client =>
    createFamilyRepository(db.app).create(client, owner.session.subjectId, keyHash()));
  await query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    family.familyId, who.subjectId);

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.deepEqual(result, {
    subjectId: who.subjectId, deletionId: who.receipt.deletionId, outcome: 'needs_attention',
    serverDataDeleted: false, providerRevocationPending: false, preservedAppleRevocations: 0,
    blockers: ['family_membership'], removed: zeroRemoved,
  });
  assert.deepEqual((await rows('SELECT status,display_name,deleted_at FROM siyue.subjects WHERE id=$1',
    who.subjectId))[0], { status: 'deletion_pending', display_name: '练习账号', deleted_at: null });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1', who.subjectId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1', who.subjectId), 1);
  const job = (await rows('SELECT state,local_data_deleted,last_error_code FROM siyue.account_deletion_jobs WHERE id=$1',
    who.receipt.deletionId))[0];
  assert.deepEqual(job, { state: 'needs_attention', local_data_deleted: false, last_error_code: 'family_membership' });
  // The family, its owner and that owner's data are untouched.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.families WHERE id=$1', family.familyId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1', family.familyId), 2);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.subjects WHERE id=$1', owner.session.subjectId), 1);
});

test('an ended room the deleting adult opened alone is their own object and goes with them', async () => {
  const who=await accepted(),owner=await fx.issue(),roomId=randomUUID();
  const family=await transaction(db.app,client=>
    createFamilyRepository(db.app).create(client,owner.session.subjectId,keyHash()));
  await query(`INSERT INTO siyue.rooms(id,family_id,created_by_subject_id,status,ended_at)
    VALUES($1,$2,$3,'ended',now())`,roomId,family.familyId,who.subjectId);
  const result=await cleanup.cleanupSubject({subjectId:who.subjectId});
  assert.equal(result.outcome,'completed');
  assert.equal(result.serverDataDeleted,true);
  assert.deepEqual(result.removed.history.rooms,1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.rooms WHERE id=$1',roomId),0);
});

test('a historical family management acceptance linked to a recipient blocks completed deletion', async () => {
  const who=await accepted(),owner=await fx.issue();
  const family=await transaction(db.app,client=>
    createFamilyRepository(db.app).create(client,owner.session.subjectId,keyHash()));
  const acceptedAt=fx.clock();
  await query(`INSERT INTO siyue.family_management_acceptances
    (id,family_id,owner_subject_id,recipient_subject_id,family_version,
      recipient_membership_version,owner_membership_version,child_scope_digest,
      accepted_at,expires_at,consumed_at,retain_until)
    VALUES($1,$2,$3,$4,1,1,1,$5,$6,$7,$6,$8)`,
  randomUUID(),family.familyId,owner.session.subjectId,who.subjectId,'0'.repeat(64),
  acceptedAt,new Date(+acceptedAt+day),new Date(+acceptedAt+31*day));

  const result=await cleanup.cleanupSubject({subjectId:who.subjectId});
  assert.equal(result.outcome,'needs_attention');
  assert.equal(result.serverDataDeleted,false);
  assert.deepEqual(result.blockers,['retained_management_acceptance']);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    who.subjectId),1);
  fx.advance(32*day);
  assert.equal(await createFamilyManagementAcceptanceService(db.app,fx.service,fx.clock).cleanupExpired(),1);
  const resumed=await cleanup.cleanupSubject({subjectId:who.subjectId});
  assert.equal(resumed.outcome,'completed');
  assert.equal(resumed.serverDataDeleted,true);
});

test('a still-pending room invitation is temporary material and goes with the departing member', async () => {
  const who=await accepted(),owner=await fx.issue(),roomId=randomUUID();
  const family=await transaction(db.app,client=>
    createFamilyRepository(db.app).create(client,owner.session.subjectId,keyHash()));
  await query(`INSERT INTO siyue.rooms(id,family_id,created_by_subject_id)
    VALUES($1,$2,$3)`,roomId,family.familyId,owner.session.subjectId);
  await query(`INSERT INTO siyue.room_invitations
    (id,room_id,inviter_subject_id,invitee_subject_id,
      inviter_membership_version,invitee_membership_version,
      family_version,expires_at)
    VALUES($1,$2,$3,$4,1,1,1,$5)`,randomUUID(),roomId,owner.session.subjectId,
    who.subjectId,new Date(+fx.clock()+day));
  const result=await cleanup.cleanupSubject({subjectId:who.subjectId});
  // The invitation can never be accepted once the invited account is gone, so it is destroyed instead
  // of blocking; the other member's room and its own authority are untouched.
  assert.equal(result.outcome,'completed');
  assert.equal(result.serverDataDeleted,true);
  assert.equal(result.removed.history.roomInvitationsDeleted,1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.room_invitations WHERE invitee_subject_id=$1',
    who.subjectId),0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.rooms WHERE id=$1',roomId),1);
});

test('a frozen family awaiting review still blocks personal-data cleanup', async () => {
  let family;
  const who = await accepted({prepare: async subject => {
    family = await transaction(db.app, client =>
      createFamilyRepository(db.app).create(client, subject.subjectId, keyHash()));
  }});
  const other = await fx.issue();
  await query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    family.familyId, other.session.subjectId);
  await query("UPDATE siyue.families SET status='frozen',version=version+1 WHERE id=$1", family.familyId);

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });
  assert.equal(result.outcome, 'needs_attention');
  assert.equal(result.serverDataDeleted, false);
  assert.deepEqual(result.blockers, ['family_membership', 'family_owned']);
  assert.deepEqual(result.removed, zeroRemoved);
  assert.deepEqual((await rows(`SELECT status,owner_subject_id FROM siyue.families WHERE id=$1`,
    family.familyId))[0], { status: 'frozen', owner_subject_id: who.subjectId });
  assert.deepEqual(await createFamilyRepository(db.app).list(other.session.subjectId), []);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1',
    family.familyId), 2);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    who.subjectId), 1);
  assert.equal((await rows('SELECT local_data_deleted FROM siyue.account_deletion_jobs WHERE id=$1',
    who.receipt.deletionId))[0].local_data_deleted, false);
});

test('a guardianship or a live child device grant stops the run', async () => {
  const who = await accepted();
  const owner = await fx.issue();
  const family = await transaction(db.app, client =>
    createFamilyRepository(db.app).create(client, owner.session.subjectId, keyHash()));
  const childId = randomUUID();
  await query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')", childId);
  const consentId = randomUUID();
  await query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-guardianship','1.0')`, consentId, who.subjectId, childId);
  await query(`INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,consent_record_id)
    VALUES($1,$2,$3,$4)`, family.familyId, who.subjectId, childId, consentId);
  await query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,
    guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios',1,1,'{}',$6)`,
  randomUUID(), childId, who.subjectId, family.familyId, randomUUID(), new Date(+fx.clock() + day));

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'needs_attention');
  assert.deepEqual(result.blockers, ['guardianship', 'guardianship_consent', 'child_device_grant']);
  assert.deepEqual(result.removed, zeroRemoved);
  assert.equal(result.serverDataDeleted, false);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1', who.subjectId), 1);
  assert.equal((await rows('SELECT last_error_code FROM siyue.account_deletion_jobs WHERE id=$1',
    who.receipt.deletionId))[0].last_error_code, 'guardianship');
});

test('a cleanup destroys only the target rows', async () => {
  const target = await accepted();
  const bystander = await registered();
  const bystanderIdentity = await appleIdentity(bystander.subjectId, { outbox: 'pending' });
  fx.advance(61_000);
  const bystanderReset = await fx.request('password-reset', bystander.address);
  const snapshot = {
    emails: await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1', bystander.subjectId),
    passwords: await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1', bystander.subjectId),
    consents: await count('SELECT count(*)::int AS n FROM siyue.account_consents WHERE subject_id=$1', bystander.subjectId),
    sessions: await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1', bystander.subjectId),
    challenges: await count('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE subject_id=$1', bystander.subjectId),
    identities: await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE subject_id=$1', bystander.subjectId),
    credentials: await count('SELECT count(*)::int AS n FROM siyue.apple_provider_credentials WHERE identity_id=$1', bystanderIdentity),
    revocations: await count('SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox WHERE identity_id=$1', bystanderIdentity),
    mail: await count("SELECT count(*)::int AS n FROM siyue.outbox_jobs WHERE aggregate_id=$1 AND status='pending'", bystanderReset.challengeId),
  };

  const result = await cleanup.cleanupSubject({ subjectId: target.subjectId });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.removed.emails, 1);
  assert.equal(result.removed.sessions, 1);

  assert.deepEqual({
    emails: await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1', bystander.subjectId),
    passwords: await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1', bystander.subjectId),
    consents: await count('SELECT count(*)::int AS n FROM siyue.account_consents WHERE subject_id=$1', bystander.subjectId),
    sessions: await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1', bystander.subjectId),
    challenges: await count('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE subject_id=$1', bystander.subjectId),
    identities: await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE subject_id=$1', bystander.subjectId),
    credentials: await count('SELECT count(*)::int AS n FROM siyue.apple_provider_credentials WHERE identity_id=$1', bystanderIdentity),
    revocations: await count('SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox WHERE identity_id=$1', bystanderIdentity),
    mail: await count("SELECT count(*)::int AS n FROM siyue.outbox_jobs WHERE aggregate_id=$1 AND status='pending'", bystanderReset.challengeId),
  }, snapshot);
  const bystanderSubject = (await rows('SELECT status,display_name,deleted_at FROM siyue.subjects WHERE id=$1',
    bystander.subjectId))[0];
  assert.deepEqual(bystanderSubject, { status: 'active', display_name: '', deleted_at: null });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs WHERE subject_id=$1',
    bystander.subjectId), 0);
});

test('a repeated run removes nothing and changes no row', async () => {
  let reset;
  const who = await accepted({ prepare: async subject => {
    fx.advance(61_000);
    reset = await fx.request('password-reset', subject.address);
  }});
  const first = await cleanup.cleanupSubject({ subjectId: who.subjectId });
  assert.equal(first.outcome, 'completed');

  const subjectSql = 'SELECT status,display_name,deleted_at,credential_version,updated_at FROM siyue.subjects WHERE id=$1';
  const jobSql = `SELECT state,local_data_deleted,provider_revocation_pending,completed_at,last_error_code
    FROM siyue.account_deletion_jobs WHERE id=$1`;
  const mailSql = 'SELECT status,payload_ciphertext,completed_at FROM siyue.outbox_jobs WHERE aggregate_id=$1';
  const before = {
    subject: await rows(subjectSql, who.subjectId),
    job: await rows(jobSql, who.receipt.deletionId),
    mail: await rows(mailSql, reset.challengeId),
  };

  const second = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(second.outcome, 'completed');
  assert.equal(second.serverDataDeleted, true);
  assert.deepEqual(second.removed, zeroRemoved);
  assert.deepEqual(await rows(subjectSql, who.subjectId), before.subject);
  assert.deepEqual(await rows(jobSql, who.receipt.deletionId), before.job);
  assert.deepEqual(await rows(mailSql, reset.challengeId), before.mail);
});

test('an unresolved Apple revocation keeps one seal, never two, and the provider dimension open', async () => {
  const who = await accepted();
  const identityId = await appleIdentity(who.subjectId, { outbox: 'pending' });

  const first = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(first.outcome, 'cleaned');
  assert.equal(first.serverDataDeleted, true);
  assert.equal(first.providerRevocationPending, true);
  assert.equal(first.preservedAppleRevocations, 1);
  assert.equal(first.removed.emails, 1);
  // The link and its queue row stay -- the window is still open and the queue is what can still reach
  // Apple -- but the identity's own second copy of the same seal is destroyed, so exactly one copy of
  // the credential survives an unresolved revocation.
  assert.equal(first.removed.appleCredentials, 1);
  assert.equal(first.removed.appleIdentities, 0);
  assert.equal(first.removed.appleRevocationJobs, 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE id=$1', identityId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_provider_credentials WHERE identity_id=$1', identityId), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox WHERE identity_id=$1 AND status='pending' AND refresh_ciphertext IS NOT NULL", identityId), 1);

  const job = (await rows(`SELECT state,local_data_deleted,provider_revocation_pending,completed_at,last_error_code
    FROM siyue.account_deletion_jobs WHERE id=$1`, who.receipt.deletionId))[0];
  assert.deepEqual(job, { state: 'processing', local_data_deleted: true,
    provider_revocation_pending: true, completed_at: null, last_error_code: null });
  assert.deepEqual(await jobs.status({ deletionId: who.receipt.deletionId, receiptSecret: who.receipt.receiptSecret }),
    { serverDataDeleted: true, providerRevocationPending: true, completedAt: null, lastErrorCode: null });

  // A replay of the same unresolved state is a no-op: the duplicate it already destroyed is not counted
  // twice, and both guarded writes change no column.
  const subjectSql = 'SELECT status,display_name,deleted_at,credential_version,updated_at FROM siyue.subjects WHERE id=$1';
  const jobSql = `SELECT state,local_data_deleted,provider_revocation_pending,completed_at,last_error_code
    FROM siyue.account_deletion_jobs WHERE id=$1`;
  const subjectBefore = await rows(subjectSql, who.subjectId);
  const second = await cleanup.cleanupSubject({ subjectId: who.subjectId });
  assert.equal(second.outcome, 'cleaned');
  assert.equal(second.providerRevocationPending, true);
  assert.deepEqual(second.removed, zeroRemoved);
  assert.deepEqual(await rows(subjectSql, who.subjectId), subjectBefore);
  assert.deepEqual(await rows(jobSql, who.receipt.deletionId), [job]);
});

test('a needs_attention attempt inside its window keeps only the queue seal', async () => {
  const who = await accepted({ providerRevocationPending: true });
  const identityId = await appleIdentity(who.subjectId, { outbox: 'needs_attention' });

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'cleaned');
  assert.equal(result.providerRevocationPending, true);
  assert.equal(result.preservedAppleRevocations, 1);
  assert.equal(result.removed.appleCredentials, 1);
  assert.equal(result.removed.appleRevocationJobs, 0);
  assert.equal(result.removed.appleIdentities, 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE id=$1', identityId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_provider_credentials WHERE identity_id=$1', identityId), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox WHERE identity_id=$1 AND status='needs_attention' AND refresh_ciphertext IS NOT NULL", identityId), 1);
  // This pass closed no window, so it writes no code of its own: naming an in-window blocker is the
  // coordinator's job, and an unresolved revocation must not look resolved here either.
  assert.equal((await rows('SELECT last_error_code FROM siyue.account_deletion_jobs WHERE id=$1',
    who.receipt.deletionId))[0].last_error_code, null);
});

test('a sending attempt inside its window is left leased and keeps only the queue seal', async () => {
  const who = await accepted({ providerRevocationPending: true });
  const identityId = await appleIdentity(who.subjectId, { outbox: 'sending' });

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'cleaned');
  assert.equal(result.providerRevocationPending, true);
  assert.equal(result.preservedAppleRevocations, 1);
  assert.equal(result.removed.appleCredentials, 1);
  assert.equal(result.removed.appleRevocationJobs, 0);
  assert.equal(result.removed.appleIdentities, 0);
  // The in-flight attempt is not disturbed: its lease and its seal are exactly what its settle needs.
  assert.deepEqual((await rows(`SELECT status,refresh_ciphertext IS NOT NULL AS sealed,
    lease_id IS NOT NULL AS leased FROM siyue.apple_revocation_outbox WHERE identity_id=$1`, identityId))[0],
  { status: 'sending', sealed: true, leased: true });
});

test('an expired revocation destroys the orphaned seal, the link and the queue and keeps the job open', async () => {
  const who = await accepted({ providerRevocationPending: true });
  const identityId = await appleIdentity(who.subjectId, { outbox: 'expired', windowDays: -1 });
  // The outbox already dropped its own copy when it settled; the identity's copy is the orphan the
  // unbounded retention left behind, and it is the one this pass has to destroy.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox WHERE identity_id=$1 AND refresh_ciphertext IS NOT NULL', identityId), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_provider_credentials WHERE identity_id=$1', identityId), 1);

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'cleaned');
  assert.equal(result.serverDataDeleted, true);
  // A closed window is not a confirmation: the local dimension finishes while the provider dimension
  // stays open with its bounded reason, and no copy of the credential survives.
  assert.equal(result.providerRevocationPending, true);
  assert.equal(result.preservedAppleRevocations, 0);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual({ emails: result.removed.emails, appleCredentials: result.removed.appleCredentials,
    appleRevocationJobs: result.removed.appleRevocationJobs, appleIdentities: result.removed.appleIdentities },
  { emails: 1, appleCredentials: 1, appleRevocationJobs: 1, appleIdentities: 1 });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE id=$1', identityId), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_provider_credentials WHERE identity_id=$1', identityId), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox WHERE identity_id=$1', identityId), 0);
  assert.deepEqual((await rows(`SELECT state,local_data_deleted,provider_revocation_pending,completed_at,last_error_code
    FROM siyue.account_deletion_jobs WHERE id=$1`, who.receipt.deletionId))[0],
  { state: 'processing', local_data_deleted: true, provider_revocation_pending: true, completed_at: null,
    last_error_code: 'apple_revocation_expired' });
  assert.deepEqual(await jobs.status({ deletionId: who.receipt.deletionId, receiptSecret: who.receipt.receiptSecret }),
    { serverDataDeleted: true, providerRevocationPending: true, completedAt: null,
      lastErrorCode: 'apple_revocation_expired' });

  // Replay: the destroyed link cannot be destroyed twice, and this kernel can never close the job.
  const replay = await cleanup.cleanupSubject({ subjectId: who.subjectId });
  assert.equal(replay.outcome, 'cleaned');
  assert.equal(replay.providerRevocationPending, true);
  assert.deepEqual(replay.removed, zeroRemoved);
});

test('a needs_attention revocation past its window destroys the live seal and keeps its own reason', async () => {
  const who = await accepted({ providerRevocationPending: true });
  const identityId = await appleIdentity(who.subjectId, { outbox: 'needs_attention', windowDays: -1 });
  // Unlike an expired attempt, this row still holds a bounded seal of its own, so this pass destroys a
  // live copy as well as the identity's duplicate.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox WHERE identity_id=$1 AND refresh_ciphertext IS NOT NULL', identityId), 1);

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'cleaned');
  assert.equal(result.providerRevocationPending, true);
  assert.equal(result.preservedAppleRevocations, 0);
  assert.deepEqual({ emails: result.removed.emails, appleCredentials: result.removed.appleCredentials,
    appleRevocationJobs: result.removed.appleRevocationJobs, appleIdentities: result.removed.appleIdentities },
  { emails: 1, appleCredentials: 1, appleRevocationJobs: 1, appleIdentities: 1 });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE id=$1', identityId), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox WHERE identity_id=$1', identityId), 0);
  assert.deepEqual(await jobs.status({ deletionId: who.receipt.deletionId, receiptSecret: who.receipt.receiptSecret }),
    { serverDataDeleted: true, providerRevocationPending: true, completedAt: null,
      lastErrorCode: 'apple_revocation_needs_attention' });

  // Cross-module contract, asserted without modifying the coordinator: with the identities gone it keeps
  // the dimension open and preserves the bounded reason instead of reading "no identities" as a
  // provider success.
  assert.deepEqual((await createAccountDeletionRevocationCoordinator(db.app)
    .reconcile({ subjectId: who.subjectId })).jobs,
  [{ deletionId: who.receipt.deletionId, subjectId: who.subjectId, cleared: false,
    errorCode: 'apple_revocation_needs_attention', identities: 0, confirmed: 0 }]);
  assert.deepEqual(await jobs.status({ deletionId: who.receipt.deletionId, receiptSecret: who.receipt.receiptSecret }),
    { serverDataDeleted: true, providerRevocationPending: true, completedAt: null,
      lastErrorCode: 'apple_revocation_needs_attention' });
});

test('a destroyed expired revocation is never re-read as a provider success', async () => {
  const who = await accepted({ providerRevocationPending: true });
  await appleIdentity(who.subjectId, { outbox: 'expired', windowDays: -1 });
  assert.equal((await cleanup.cleanupSubject({ subjectId: who.subjectId })).providerRevocationPending, true);

  // The coordinator sees zero identities: it keeps the dimension open with the preserved bounded code
  // rather than clearing it, which is exactly why the destroying pass has to leave that code behind.
  const report = await createAccountDeletionRevocationCoordinator(db.app).reconcile({ subjectId: who.subjectId });
  assert.deepEqual(report.jobs, [{ deletionId: who.receipt.deletionId, subjectId: who.subjectId, cleared: false,
    errorCode: 'apple_revocation_expired', identities: 0, confirmed: 0 }]);
  assert.deepEqual((await rows(`SELECT provider_revocation_pending,local_data_deleted,completed_at,state
    FROM siyue.account_deletion_jobs WHERE id=$1`, who.receipt.deletionId))[0],
  { provider_revocation_pending: true, local_data_deleted: true, completed_at: null, state: 'processing' });
  // Re-running the kernel changes nothing: the flag cannot be cleared from a state whose identities are
  // gone, so the destroyed seal is never re-read as a confirmed revocation.
  const replay = await cleanup.cleanupSubject({ subjectId: who.subjectId });
  assert.equal(replay.providerRevocationPending, true);
  assert.deepEqual(replay.removed, zeroRemoved);
});

test('a stored credential with no queued revocation fails closed and keeps its seal', async () => {
  const who = await accepted();
  const identityId = await appleIdentity(who.subjectId, { credential: true, outbox: null });

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'needs_attention');
  assert.deepEqual(result.blockers, ['apple_revocation_not_queued']);
  assert.equal(result.serverDataDeleted, false);
  assert.equal(result.preservedAppleRevocations, 1);
  assert.deepEqual(result.removed, zeroRemoved);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_provider_credentials WHERE identity_id=$1', identityId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1', who.subjectId), 1);
  const job = (await rows('SELECT state,local_data_deleted,last_error_code FROM siyue.account_deletion_jobs WHERE id=$1',
    who.receipt.deletionId))[0];
  assert.deepEqual(job, { state: 'needs_attention', local_data_deleted: false,
    last_error_code: 'apple_revocation_not_queued' });
});

test('a confirmed revocation drops the Apple link and completes the job', async () => {
  const who = await accepted({ providerRevocationPending: true });
  const identityId = await appleIdentity(who.subjectId, { outbox: 'revoked' });
  const identity=(await rows('SELECT provider_subject,client_id FROM siyue.external_identities WHERE id=$1',
    identityId))[0];
  const targetFlow=randomUUID(),otherFlow=randomUUID(),now=fx.clock();
  for(const [id,expectedSubject] of [[targetFlow,identity.provider_subject],[otherFlow,randomUUID()]])
    await query(`INSERT INTO siyue.apple_login_flows
      (id,client_id,installation_id,secret_hash,state_hash,nonce_hash,status,created_at,expires_at,
       request_hash,expected_subject,verified_ciphertext)
      VALUES($1,$2,$3,$4,$5,$6,'verified',$7,$8,$9,$10,$11)`,id,identity.client_id,
      randomUUID(),keyHash(),keyHash(),keyHash(),new Date(+now-1000),new Date(+now+300_000),
      keyHash(),expectedSubject,'sealed-synthetic-token');
  await query("UPDATE siyue.account_deletion_jobs SET last_error_code='apple_provider_unavailable' WHERE id=$1",
    who.receipt.deletionId);

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'completed');
  assert.equal(result.providerRevocationPending, false);
  assert.equal(result.preservedAppleRevocations, 0);
  assert.equal(result.removed.appleIdentities, 1);
  assert.equal(result.removed.appleCredentials, 1);
  assert.equal(result.removed.appleRevocationJobs, 1);
  assert.equal(result.removed.appleLoginFlows, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_login_flows WHERE id=$1',targetFlow),0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_login_flows WHERE id=$1',otherFlow),1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE id=$1', identityId), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_provider_credentials WHERE identity_id=$1', identityId), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_revocation_outbox WHERE identity_id=$1', identityId), 0);
  assert.equal((await rows('SELECT last_error_code FROM siyue.account_deletion_jobs WHERE id=$1',
    who.receipt.deletionId))[0].last_error_code, null);
});

test('a missing Apple credential permits server cleanup but never reports provider revocation complete', async () => {
  const who = await accepted({ providerRevocationPending: true });
  const identityId = await appleIdentity(who.subjectId, { credential: false });
  await query(`UPDATE siyue.account_deletion_jobs SET last_error_code='apple_credential_missing'
    WHERE id=$1`, who.receipt.deletionId);

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'cleaned');
  assert.equal(result.serverDataDeleted, true);
  assert.equal(result.providerRevocationPending, true);
  assert.equal(result.removed.appleIdentities, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE id=$1', identityId), 0);
  assert.deepEqual(await jobs.status({ deletionId: who.receipt.deletionId,
    receiptSecret: who.receipt.receiptSecret }), {
    serverDataDeleted: true, providerRevocationPending: true, completedAt: null,
    lastErrorCode: 'apple_credential_missing',
  });
  const reconciled = await createAccountDeletionRevocationCoordinator(db.app)
    .reconcile({ subjectId: who.subjectId });
  assert.equal(reconciled.cleared, 0);
  assert.equal(reconciled.jobs[0].errorCode, 'apple_credential_missing');
});

test('a new dependency after partial cleanup cannot retain an old server-data-deleted claim', async () => {
  const who = await accepted({ providerRevocationPending: true });
  await appleIdentity(who.subjectId, { credential: false });
  assert.equal((await cleanup.cleanupSubject({ subjectId: who.subjectId })).serverDataDeleted, true);
  const familyId = randomUUID();
  // Simulate a damaged restore/manual write. Normal commands cannot give a deleted subject authority.
  await query("INSERT INTO siyue.families(id,owner_subject_id) VALUES($1,$2)",familyId,who.subjectId);
  await query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner')",
    familyId,who.subjectId);
  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });
  assert.equal(result.outcome,'needs_attention');
  assert.equal(result.serverDataDeleted,false);
  assert.deepEqual(result.blockers,['family_membership','family_owned']);
  assert.deepEqual(await jobs.status({deletionId:who.receipt.deletionId,
    receiptSecret:who.receipt.receiptSecret}),{
    serverDataDeleted:false,providerRevocationPending:true,completedAt:null,
    lastErrorCode:'family_membership',
  });
});

test('a revocation confirmed after the first pass lets a later pass finish the job', async () => {
  const who = await accepted({ providerRevocationPending: true });
  const identityId = await appleIdentity(who.subjectId, { outbox: 'pending' });
  assert.equal((await cleanup.cleanupSubject({ subjectId: who.subjectId })).outcome, 'cleaned');

  // The outbox worker settles the attempt as confirmed by Apple; only now may the link be removed.
  await query(`UPDATE siyue.apple_revocation_outbox SET status='revoked',refresh_ciphertext=NULL,
    last_error_code=NULL,settled_at=$2,retain_until=$3 WHERE identity_id=$1`,
  identityId, fx.clock(), new Date(+fx.clock() + 30 * day));

  const second = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(second.outcome, 'completed');
  assert.equal(second.providerRevocationPending, false);
  assert.equal(second.removed.appleIdentities, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE id=$1', identityId), 0);
  const job = (await rows(`SELECT state,local_data_deleted,provider_revocation_pending,completed_at
    FROM siyue.account_deletion_jobs WHERE id=$1`, who.receipt.deletionId))[0];
  assert.equal(job.state, 'completed');
  assert.equal(job.local_data_deleted, true);
  assert.equal(job.provider_revocation_pending, false);
  assert.equal(job.completed_at.toISOString(), fx.clock().toISOString());
});
