import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createFamilyRepository } from '../../dist/modules/families/repository.js';
import { createAccountDeletionJobStore } from '../../dist/modules/auth/account-deletion-jobs.js';
import { createAccountDeletionCleanupKernel } from '../../dist/modules/auth/account-deletion-cleanup.js';

// The layered historical pass of the cleanup kernel (design chapter 13.1/13.2/13.3 and the layered rule
// confirmed on 2026-09-24), against an isolated temporary PostgreSQL cluster. These cases cover the two
// questions the layer-1/layer-2 line turns on and the records migration 0024 and 0025 added:
//
//   * a room, a family or a review record this adult opened alone is theirs and goes with them, while the
//     same object with another member's or another subject's trace in it is reported and kept whole;
//   * an ended row that must outlive the adult keeps its place with the adult's link cleared, and the
//     schema refuses the partial states that clearing would otherwise allow.
const day = 86_400_000;
// The operator login the closure runs as, created by the deployment's own provisioning script: migration
// 0025 revokes INSERT/UPDATE/DELETE on `family_review_resolutions` from the API login, so a resolution row
// is written -- in the product and in these cases -- by the designated operator role and by nobody else.
const OPERATOR_ROLE = 'siyue_review_operator';
const provisionScript = fileURLToPath(new URL('../../provision/frozen-family-review-operator.sql',
  import.meta.url));

let db, fx, jobs, cleanup, operator;
before(async () => {
  db = await startPostgresFixture();
  const bin = process.env.SIYUE_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
  const socket = (await db.admin.query("SELECT setting FROM pg_settings WHERE name='unix_socket_directories'"))
    .rows[0].setting.split(',')[0];
  const adminUser = (await db.admin.query('SELECT current_user AS u')).rows[0].u;
  execFileSync(join(bin, 'psql'), ['-h', socket, '-U', adminUser, '-d', db.identity.database,
    '-f', provisionScript], { env: { ...process.env,
    SIYUE_FROZEN_FAMILY_REVIEW_DATABASE: db.identity.database,
    SIYUE_FROZEN_FAMILY_REVIEW_ENVIRONMENT: db.identity.environment,
    SIYUE_FROZEN_FAMILY_REVIEW_OPERATOR_ROLE: OPERATOR_ROLE,
    SIYUE_FROZEN_FAMILY_REVIEW_OPERATOR_PASSWORD: 'synthetic-operator-password-0000000000' },
  stdio: ['ignore', 'pipe', 'pipe'] });
  operator = db.poolFor(OPERATOR_ROLE);
});
beforeEach(async () => {
  await db.admin.query('TRUNCATE siyue.subjects, siyue.rate_limit_buckets, siyue.idempotency_records, siyue.outbox_jobs CASCADE');
  fx = await createEmailFixture(db);
  jobs = createAccountDeletionJobStore(db.app, fx.clock);
  cleanup = createAccountDeletionCleanupKernel(db.app, fx.clock);
});
after(async () => { await db?.stop(); });

const query = (sql, ...args) => db.app.query(sql, args);
// The operator connection takes the same positional form as the helpers above.
const operatorQuery = (sql, ...args) => operator.query(sql, args);
const rows = (sql, ...args) => query(sql, ...args).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
const keyHash = () => createHash('sha256').update(randomUUID()).digest('hex');
const familyOf = ownerId => transaction(db.app, client =>
  createFamilyRepository(db.app).create(client, ownerId, keyHash()));

test('an address only this adult owned is cleared from every unaccepted invitation that names it', async () => {
  const inviter = await fx.issue();
  const { tokens, address } = await fx.register();
  const subjectId = tokens.session.subjectId;
  const family = await familyOf(inviter.session.subjectId);
  const otherAddress = `${randomUUID()}@example.test`;
  const staleId = randomUUID(), otherId = randomUUID();
  // The address was written onto a row the inviter already closed: expired, with its sealed response
  // destroyed and its deadline already past. It is exactly the state a narrower condition would miss,
  // and the deleted adult's address would stay in the table while the run reported the addresses gone.
  await query(`INSERT INTO siyue.family_invitations(id,family_id,inviter_id,intended_email,token_hash,
      status,policy_version,inviter_membership_version,family_version,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,'expired','v1',1,1,now()-interval '2 hour',now()-interval '1 hour')`,
  staleId, family.familyId, inviter.session.subjectId, address, keyHash());
  // A second row for a different address is another person's record and must not be touched.
  await query(`INSERT INTO siyue.family_invitations(id,family_id,inviter_id,intended_email,token_hash,
      status,policy_version,inviter_membership_version,family_version,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,'expired','v1',1,1,now()-interval '2 hour',now()-interval '1 hour')`,
  otherId, family.familyId, inviter.session.subjectId, otherAddress, keyHash());
  await query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1", subjectId);
  await transaction(db.app, client => jobs.insertPending(client, { subjectId,
    receiptExpiresAt: new Date(+fx.clock() + day), providerRevocationPending: false }));

  const result = await cleanup.cleanupSubject({ subjectId });

  assert.equal(result.outcome, 'completed');
  assert.equal(result.removed.history.invitationsClosed, 1);
  assert.deepEqual(await rows('SELECT intended_email,token_ciphertext FROM siyue.family_invitations WHERE id=$1',
    staleId), [{ intended_email: null, token_ciphertext: null }]);
  assert.deepEqual(await rows('SELECT intended_email FROM siyue.family_invitations WHERE id=$1', otherId),
    [{ intended_email: otherAddress }]);
});

/**
 * An adult whose deletion was accepted: `setup` runs while the account is still active, so a case can
 * build the ended history the pass has to decide on before the subject is moved to `deletion_pending`.
 */
async function accepted(setup) {
  const { tokens, address } = await fx.register();
  const subjectId = tokens.session.subjectId;
  if (setup) await setup(subjectId);
  await query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1", subjectId);
  const receipt = await transaction(db.app, client => jobs.insertPending(client, {
    subjectId, receiptExpiresAt: new Date(+fx.clock() + day), providerRevocationPending: false }));
  return { subjectId, address, receipt };
}

const endedRoom = async (familyId, creatorId) => {
  const roomId = randomUUID();
  await query(`INSERT INTO siyue.rooms(id,family_id,created_by_subject_id,status,ended_at)
    VALUES($1,$2,$3,'ended',now())`, roomId, familyId, creatorId);
  return roomId;
};

// `released_at` is stamped by the database clock, which is what the row's own check compares it with.
const seat = (roomId, tokens, released) => query(`INSERT INTO siyue.room_seats
  (room_id,session_id,subject_id,seat_index,released_at)
  VALUES($1,$2,$3,1,CASE WHEN $4 THEN now() ELSE NULL END)`,
roomId, tokens.session.sessionId, tokens.session.subjectId, released);

test('an ended room the deleting adult opened with nobody else in it goes whole', async () => {
  const owner = await fx.issue();
  let roomId;
  const who = await accepted(async subjectId => {
    const family = await familyOf(owner.session.subjectId);
    roomId = await endedRoom(family.familyId, subjectId);
    // A still-pending invitation to another member is temporary material this pass destroys anyway, so
    // it never makes the room another member's; both rows go together, and the room is not reported.
    await query(`INSERT INTO siyue.room_invitations
      (id,room_id,inviter_subject_id,invitee_subject_id,inviter_membership_version,
       invitee_membership_version,family_version,expires_at)
      VALUES($1,$2,$3,$4,1,1,1,$5)`,
    randomUUID(), roomId, subjectId, owner.session.subjectId, new Date(+fx.clock() + day));
  });

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.blockers, []);
  assert.equal(result.removed.history.rooms, 1);
  assert.equal(result.removed.history.roomInvitationsDeleted, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.rooms WHERE id=$1', roomId), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.room_invitations WHERE room_id=$1', roomId), 0);
});

test('another member seated in the room the adult opened keeps the room and is reported', async () => {
  const owner = await fx.issue();
  let roomId;
  const who = await accepted(async subjectId => {
    const family = await familyOf(owner.session.subjectId);
    roomId = await endedRoom(family.familyId, subjectId);
    // The seat is released, so the room is over and nobody is live in it, but the room still holds
    // another member's own record of having been in it. The whole room stays and waits for a person.
    await seat(roomId, owner, true);
  });

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'needs_attention');
  assert.equal(result.serverDataDeleted, false);
  assert.deepEqual(result.blockers, ['inseparable_shared_work']);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.rooms WHERE id=$1', roomId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.room_seats WHERE room_id=$1', roomId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    who.subjectId), 1);
});

test('a closed invitation another member used in that room also keeps it and is reported', async () => {
  const owner = await fx.issue();
  let roomId, invitationId;
  const who = await accepted(async subjectId => {
    const family = await familyOf(owner.session.subjectId);
    roomId = await endedRoom(family.familyId, subjectId);
    invitationId = randomUUID();
    // A revoked authorization is a durable record between the two members, not temporary material, so
    // it survives even though nobody was ever seated on it.
    await query(`INSERT INTO siyue.room_invitations
      (id,room_id,inviter_subject_id,invitee_subject_id,status,inviter_membership_version,
       invitee_membership_version,family_version,expires_at,revoked_at)
      VALUES($1,$2,$3,$4,'revoked',1,1,1,$5,now())`,
    invitationId, roomId, subjectId, owner.session.subjectId, new Date(+fx.clock() + day));
  });

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'needs_attention');
  assert.deepEqual(result.blockers, ['inseparable_shared_work']);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.rooms WHERE id=$1', roomId), 1);
  // Nothing was redacted either: a room this adult created is never partially cleared, because its own
  // NOT NULL creator link would stay behind.
  assert.equal((await rows('SELECT inviter_subject_id FROM siyue.room_invitations WHERE id=$1',
    invitationId))[0].inviter_subject_id, who.subjectId);
});

test('a closed invitation into another member\'s ended room keeps its row and loses the adult\'s side', async () => {
  const owner = await fx.issue();
  let roomId, invitationId;
  const who = await accepted(async subjectId => {
    const family = await familyOf(owner.session.subjectId);
    roomId = await endedRoom(family.familyId, owner.session.subjectId);
    invitationId = randomUUID();
    await query(`INSERT INTO siyue.room_invitations
      (id,room_id,inviter_subject_id,invitee_subject_id,status,inviter_membership_version,
       invitee_membership_version,family_version,expires_at,accepted_at)
      VALUES($1,$2,$3,$4,'accepted',1,1,1,$5,now())`,
    invitationId, roomId, owner.session.subjectId, subjectId, new Date(+fx.clock() + day));
  });

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'completed');
  assert.equal(result.removed.history.roomInvitationsRedacted, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.rooms WHERE id=$1', roomId), 1);
  assert.deepEqual((await rows(`SELECT inviter_subject_id,invitee_subject_id FROM siyue.room_invitations
    WHERE id=$1`, invitationId))[0].invitee_subject_id, null);
  assert.equal((await rows('SELECT inviter_subject_id FROM siyue.room_invitations WHERE id=$1',
    invitationId))[0].inviter_subject_id, owner.session.subjectId);
});

test('a closed freeze review keeps its rows and loses only the deleted owner, never the other adult', async () => {
  const recipient = await fx.issue();
  let familyId;
  const who = await accepted(async subjectId => {
    const family = await familyOf(subjectId);
    familyId = family.familyId;
    await query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
      familyId, recipient.session.subjectId);
  });
  // The operator's closure: the family is handed to the recipient, the acceptance is consumed and the
  // marker is closed. The subject stays deletable because it holds no live family authority any more.
  await query(`UPDATE siyue.families SET owner_subject_id=$2,status='active',version=version+1 WHERE id=$1`,
    familyId, recipient.session.subjectId);
  await query(`UPDATE siyue.family_memberships SET active=false,role='member',version=version+1
    WHERE family_id=$1 AND subject_id=$2`, familyId, who.subjectId);
  await query(`UPDATE siyue.family_memberships SET role='owner',version=version+1
    WHERE family_id=$1 AND subject_id=$2`, familyId, recipient.session.subjectId);
  const now = fx.clock(), acceptanceId = randomUUID(), reviewId = randomUUID(), resolutionId = randomUUID();
  const proofHash = keyHash();
  await query(`INSERT INTO siyue.family_review_acceptances(id,family_id,deleting_subject_id,
      recipient_subject_id,family_version,recipient_membership_version,owner_membership_version,
      child_scope_digest,accepted_at,consumed_at) VALUES($1,$2,$3,$4,2,2,2,$5,$6,$6)`,
  acceptanceId, familyId, who.subjectId, recipient.session.subjectId, '0'.repeat(64), now);
  await query(`INSERT INTO siyue.account_deletion_family_reviews(id,deletion_id,family_id,
      deleting_subject_id,state,opened_at,resolved_at) VALUES($1,$2,$3,$4,'resolved',$5,$5)`,
  reviewId, who.receipt.deletionId, familyId, who.subjectId, now);
  await operatorQuery(`INSERT INTO siyue.family_review_resolutions(id,review_id,acceptance_id,family_id,
      recipient_subject_id,operator_role,shared_work_result,shared_work_checked_at,reason,
      idempotency_key_hash,family_version,recipient_membership_version,owner_membership_version,
      child_scope_digest,child_count,closed_at)
      VALUES($1,$2,$3,$4,$5,'siyue_ops','separated',$6,'ops-case-1',$7,2,2,2,$8,0,$6)`,
  resolutionId, reviewId, acceptanceId, familyId, recipient.session.subjectId, now, proofHash,
  '0'.repeat(64));
  await query(`INSERT INTO siyue.security_events(id,event_type,subject_id,session_id,request_id,
      outcome,redacted_metadata,occurred_at,expires_at)
      VALUES($1,'family.review.resolve',$2,NULL,$3,'success',$4,$5,$6)`,
  randomUUID(), who.subjectId, resolutionId, JSON.stringify({ familyId }), now,
  new Date(+now + 30 * day));

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'completed');
  assert.deepEqual({ reviews: result.removed.history.reviews,
    reviewAcceptances: result.removed.history.reviewAcceptances },
  { reviews: 1, reviewAcceptances: 1 });
  // No row of the closure is removed: the marker, the acceptance another adult signed and the operator's
  // resolution all stay, with everything that made them evidence.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_deletion_family_reviews'), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_review_acceptances'), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_review_resolutions'), 1);
  assert.deepEqual(await rows(`SELECT state,resolved_at IS NOT NULL AS resolved,
    deleting_subject_id,deleting_redacted_at IS NOT NULL AS redacted
    FROM siyue.account_deletion_family_reviews WHERE id=$1`, reviewId),
  [{ state: 'resolved', resolved: true, deleting_subject_id: null, redacted: true }]);
  // The accepting adult's own evidence is untouched: their id, the versions and the digest they accepted
  // under, the instant they accepted and the consumption stamp all stay NOT NULL values.
  assert.deepEqual(await rows(`SELECT recipient_subject_id,deleting_subject_id,family_version,
    recipient_membership_version,owner_membership_version,child_scope_digest,accepted_at IS NOT NULL AS accepted,
    consumed_at IS NOT NULL AS consumed,superseded_at IS NULL AS not_superseded,
    deleting_redacted_at IS NOT NULL AS redacted FROM siyue.family_review_acceptances WHERE id=$1`,
  acceptanceId),
  [{ recipient_subject_id: recipient.session.subjectId, deleting_subject_id: null, family_version: 2,
    recipient_membership_version: 2, owner_membership_version: 2, child_scope_digest: '0'.repeat(64),
    accepted: true, consumed: true, not_superseded: true, redacted: true }]);
  // The operator's closure record is complete and unwritten: same reason, scope, result and proof.
  assert.deepEqual(await rows(`SELECT recipient_subject_id,operator_role,shared_work_result,reason,
    idempotency_key_hash,child_count,closed_at IS NOT NULL AS closed
    FROM siyue.family_review_resolutions WHERE id=$1`, resolutionId),
  [{ recipient_subject_id: recipient.session.subjectId, operator_role: 'siyue_ops',
    shared_work_result: 'separated', reason: 'ops-case-1', idempotency_key_hash: proofHash,
    child_count: 0, closed: true }]);
  // What the closure actually settled is untouched: the recipient keeps the family and the membership it
  // was handed with, and the bounded audit record of the closure is still there.
  assert.deepEqual(await rows('SELECT status,owner_subject_id FROM siyue.families WHERE id=$1', familyId),
    [{ status: 'active', owner_subject_id: recipient.session.subjectId }]);
  assert.deepEqual(await rows(`SELECT role,active FROM siyue.family_memberships
    WHERE family_id=$1 AND subject_id=$2`, familyId, recipient.session.subjectId),
  [{ role: 'owner', active: true }]);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.review.resolve'"), 1);
});

test('a closure that handed a family to this adult cannot be separated and is reported', async () => {
  const deleter = await fx.issue(), newOwner = await fx.issue();
  const family = await familyOf(deleter.session.subjectId);
  let acceptanceId, resolutionId, reviewId;
  const who = await accepted(async subjectId => {
    await query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
      family.familyId, subjectId);
  });
  // The family was handed to this adult by another subject's closure and then handed on again, so this
  // adult neither owns it nor belongs to it any more while the closure that names them as recipient is
  // still stored.
  await query(`UPDATE siyue.families SET owner_subject_id=$2,version=version+1 WHERE id=$1`,
    family.familyId, newOwner.session.subjectId);
  await query(`UPDATE siyue.family_memberships SET active=false,role='member' WHERE family_id=$1 AND subject_id=$2`,
    family.familyId, deleter.session.subjectId);
  await query(`UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2`,
    family.familyId, who.subjectId);
  await query(`INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'owner')`,
    family.familyId, newOwner.session.subjectId);
  const now = fx.clock();
  acceptanceId = randomUUID(); resolutionId = randomUUID(); reviewId = randomUUID();
  await query(`INSERT INTO siyue.family_review_acceptances(id,family_id,deleting_subject_id,
      recipient_subject_id,family_version,recipient_membership_version,owner_membership_version,
      child_scope_digest,accepted_at,consumed_at) VALUES($1,$2,$3,$4,1,1,1,$5,$6,$6)`,
  acceptanceId, family.familyId, deleter.session.subjectId, who.subjectId, '0'.repeat(64), now);
  // The other subject's own deletion is accepted too, so their marker can reference a real job; it is
  // never cleaned in this case, which is what the assertions below keep checking.
  await query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",
    deleter.session.subjectId);
  const deleterJob = await transaction(db.app, client => jobs.insertPending(client, {
    subjectId: deleter.session.subjectId, receiptExpiresAt: new Date(+now + day),
    providerRevocationPending: false }));
  await query(`INSERT INTO siyue.account_deletion_family_reviews(id,deletion_id,family_id,
      deleting_subject_id,state,opened_at,resolved_at) VALUES($1,$2,$3,$4,'resolved',$5,$5)`,
  reviewId, deleterJob.deletionId, family.familyId, deleter.session.subjectId, now);
  await operatorQuery(`INSERT INTO siyue.family_review_resolutions(id,review_id,acceptance_id,family_id,
      recipient_subject_id,operator_role,shared_work_result,shared_work_checked_at,reason,
      idempotency_key_hash,family_version,recipient_membership_version,owner_membership_version,
      child_scope_digest,child_count,closed_at)
      VALUES($1,$2,$3,$4,$5,'siyue_ops','separated',$6,'ops-case-2',$7,1,1,1,$8,0,$6)`,
  resolutionId, reviewId, acceptanceId, family.familyId, who.subjectId, now, keyHash(), '0'.repeat(64));

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  // The operator's record is immutable for this login and keeps the recipient NOT NULL, so this adult's
  // id cannot be cleared out of it: the run reports the case instead of calling the account deleted.
  assert.equal(result.outcome, 'needs_attention');
  assert.equal(result.serverDataDeleted, false);
  assert.deepEqual(result.blockers, ['retained_review_closure']);
  assert.deepEqual(result.removed.history.reviews, 0);
  assert.deepEqual(result.removed.history.reviewAcceptances, 0);
  // Nothing of the closure was rewritten or removed, including the other subject's marker.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_deletion_family_reviews WHERE id=$1',
    reviewId), 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.family_review_resolutions
    WHERE recipient_subject_id=$1 AND acceptance_id=$2`, who.subjectId, acceptanceId), 1);
  assert.deepEqual(await rows(`SELECT recipient_subject_id,deleting_subject_id,consumed_at IS NOT NULL AS consumed
    FROM siyue.family_review_acceptances WHERE id=$1`, acceptanceId),
  [{ recipient_subject_id: who.subjectId, deleting_subject_id: deleter.session.subjectId, consumed: true }]);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.families WHERE id=$1', family.familyId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    who.subjectId), 1);
});

test('a redaction is only possible on a closed record, and always carries its own stamp', async () => {
  const owner = await fx.issue();
  let liveAcceptanceId, settledAcceptanceId, pendingReviewId;
  const who = await accepted(async subjectId => {
    const family = await familyOf(owner.session.subjectId);
    liveAcceptanceId = randomUUID();
    // A live declaration: the review it was made for has not been closed, so nothing may clear the id.
    await query(`INSERT INTO siyue.family_review_acceptances(id,family_id,deleting_subject_id,
        recipient_subject_id,family_version,recipient_membership_version,owner_membership_version,
        child_scope_digest,accepted_at) VALUES($1,$2,$3,$4,1,1,1,$5,$6)`,
    liveAcceptanceId, family.familyId, subjectId, owner.session.subjectId, '0'.repeat(64), fx.clock());
    // A settled declaration: superseded by a later one, so it is history and may lose the owner link.
    settledAcceptanceId = randomUUID();
    await query(`INSERT INTO siyue.family_review_acceptances(id,family_id,deleting_subject_id,
        recipient_subject_id,family_version,recipient_membership_version,owner_membership_version,
        child_scope_digest,accepted_at,superseded_at) VALUES($1,$2,$3,$4,1,1,1,$5,$6,$6)`,
    settledAcceptanceId, family.familyId, subjectId, owner.session.subjectId, '0'.repeat(64), fx.clock());
    pendingReviewId = randomUUID();
    // The marker is written after the job; see below, where the deletion job id is available.
  });
  await query(`INSERT INTO siyue.account_deletion_family_reviews(id,deletion_id,family_id,
      deleting_subject_id,state,opened_at) VALUES($1,$2,$3,$4,'pending',$5)`,
  pendingReviewId, who.receipt.deletionId, (await rows(`SELECT family_id FROM siyue.family_review_acceptances
    WHERE id=$1`, liveAcceptanceId))[0].family_id, who.subjectId, fx.clock());
  // A live acceptance cannot lose its link, and a link is never cleared without its stamp.
  await assert.rejects(query(`UPDATE siyue.family_review_acceptances SET deleting_subject_id=NULL
    WHERE id=$1`, liveAcceptanceId), { code: '23514' });
  await assert.rejects(query(`UPDATE siyue.family_review_acceptances SET deleting_redacted_at=now()
    WHERE id=$1`, liveAcceptanceId), { code: '23514' });
  // A pending marker is what an operator still has to read, so its owner link cannot be cleared either.
  await assert.rejects(query(`UPDATE siyue.account_deletion_family_reviews
    SET deleting_subject_id=NULL,deleting_redacted_at=now() WHERE id=$1`, pendingReviewId),
  { code: '23514' });
  // A settled acceptance may lose the link, and the stamp records that it did.
  await query(`UPDATE siyue.family_review_acceptances
    SET deleting_subject_id=NULL,deleting_redacted_at=now() WHERE id=$1`, settledAcceptanceId);
  assert.deepEqual(await rows(`SELECT deleting_subject_id,deleting_redacted_at FROM siyue.family_review_acceptances
    WHERE id=$1`, liveAcceptanceId), [{ deleting_subject_id: who.subjectId, deleting_redacted_at: null }]);
  assert.deepEqual(await rows(`SELECT deleting_subject_id,deleting_redacted_at FROM siyue.account_deletion_family_reviews
    WHERE id=$1`, pendingReviewId), [{ deleting_subject_id: who.subjectId, deleting_redacted_at: null }]);
  assert.deepEqual(await rows(`SELECT deleting_subject_id,deleting_redacted_at IS NOT NULL AS redacted
    FROM siyue.family_review_acceptances WHERE id=$1`, settledAcceptanceId),
  [{ deleting_subject_id: null, redacted: true }]);
});

test('a pending review marker stops the run before anything of the adult\'s is removed', async () => {
  const owner = await fx.issue();
  let reviewId;
  const who = await accepted(async () => undefined);
  const family = await familyOf(owner.session.subjectId);
  await query(`INSERT INTO siyue.family_memberships(family_id,subject_id,role,active)
    VALUES($1,$2,'member',false)`, family.familyId, who.subjectId);
  reviewId = randomUUID();
  await query(`INSERT INTO siyue.account_deletion_family_reviews(id,deletion_id,family_id,
      deleting_subject_id,state,opened_at) VALUES($1,$2,$3,$4,'pending',$5)`,
  reviewId, who.receipt.deletionId, family.familyId, who.subjectId, fx.clock());

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'needs_attention');
  assert.deepEqual(result.blockers, ['pending_family_review']);
  assert.equal(result.serverDataDeleted, false);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_deletion_family_reviews WHERE id=$1',
    reviewId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',
    who.subjectId), 1);
});

test('a dissolved family only this adult is attached to is deleted with them', async () => {
  let familyId;
  const who = await accepted(async subjectId => {
    familyId = (await familyOf(subjectId)).familyId;
    await query("UPDATE siyue.families SET status='dissolved' WHERE id=$1", familyId);
  });

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.blockers, []);
  assert.equal(result.removed.history.families, 1);
  assert.equal(result.removed.familyMemberships, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.families WHERE id=$1', familyId), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1',
    familyId), 0);
});

test('a dissolved family another member is still attached to is reported and kept', async () => {
  const other = await fx.issue();
  let familyId;
  const who = await accepted(async subjectId => {
    familyId = (await familyOf(subjectId)).familyId;
    await query("UPDATE siyue.families SET status='dissolved' WHERE id=$1", familyId);
    await query(`INSERT INTO siyue.family_memberships(family_id,subject_id,role,active)
      VALUES($1,$2,'member',false)`, familyId, other.session.subjectId);
  });

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'needs_attention');
  assert.deepEqual(result.blockers, ['shared_family_history']);
  assert.equal(result.serverDataDeleted, false);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.families WHERE id=$1', familyId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1',
    familyId), 2);
});

test('an expired device grant is revoked as its guardian link is cleared and can never be revived', async () => {
  const owner = await fx.issue();
  let grantId;
  const who = await accepted(async subjectId => {
    const family = await familyOf(owner.session.subjectId);
    const childId = randomUUID();
    await query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')", childId);
    grantId = randomUUID();
    // Expired but never revoked: the kernel does not treat it as a live dependency, and the redaction
    // must not leave an anonymous row that a later `expires_at` write could turn back into an authority.
    await query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,
      platform,guardian_relationship_version,guardian_credential_version,scopes,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5,'ios',1,1,'{}',now()+interval '1 hour',now()-interval '2 day')`,
    grantId, childId, subjectId, family.familyId, randomUUID());
  });
  fx.advance(3 * day);

  const result = await cleanup.cleanupSubject({ subjectId: who.subjectId });

  assert.equal(result.outcome, 'completed');
  assert.equal(result.removed.history.deviceGrants, 1);
  assert.deepEqual(await rows(`SELECT guardian_id,guardian_redacted_at IS NOT NULL AS redacted,
    revoked_at IS NOT NULL AS revoked FROM siyue.device_grants WHERE id=$1`, grantId),
  [{ guardian_id: null, redacted: true, revoked: true }]);
  // Even a later writer that pushes the deadline forward cannot make the row authorize a device again.
  await query("UPDATE siyue.device_grants SET expires_at=now()+interval '10 day' WHERE id=$1", grantId);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.device_grants
    WHERE id=$1 AND revoked_at IS NULL AND expires_at > now()`, grantId), 0);
  // And the schema refuses a fresh anonymous grant that was never revoked at all.
  await assert.rejects(query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,
      installation_id,platform,guardian_relationship_version,guardian_credential_version,scopes,expires_at,
      guardian_redacted_at) VALUES($1,$2,NULL,$3,$4,'ios',1,1,'{}',now()+interval '1 day',now())`,
  randomUUID(), randomUUID(), randomUUID(), randomUUID()), { code: '23514' });
});
