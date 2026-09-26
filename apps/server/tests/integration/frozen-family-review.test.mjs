// Frozen family review closure (design 13.2 and the 2026-09-24 confirmed rules) against an isolated
// temporary PostgreSQL cluster only: the shared fixture builds a fresh cluster on a short Unix socket and
// never reads a database URL or the workspace .env. Every identifier, instant and reason below is
// synthetic, and no mail, provider, shell or network call happens.
//
// What this file proves: a frozen family's review can be closed by a designated database login role only,
// after the recipient accepted the frozen scope in their own session; a shared-work result that keeps the
// work retained refuses the closure instead of closing it; an acceptance past its validity window is
// refused and has to be given again; the closure is idempotent by key and by every recorded parameter,
// refuses a changed scope and an already finished deletion, leaves the deleting adult with no live family
// authority, and neither revives an old child authorization nor modifies another member's work. How the
// family was frozen in the first place is covered by the acceptance and family tests; this file starts
// from the state a freeze leaves behind.
//
// The operator login is created by provision/frozen-family-review-operator.sql, the same script a
// deployment runs: least-privilege by construction, with its own self-check on the grants it issues.
// PostgreSQL requires UPDATE privilege on a table to take any row lock, so the one table the closure only
// locks -- subjects -- is granted UPDATE on a single column the closure never reads or writes, the deletion
// job is read without a lock and needs no write right at all, and the runtime role cannot create a
// resolution even though it keeps every privilege its own request path needs.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createFrozenFamilyReviewService, frozenFamilyReviewIdempotencyKeyHash,
  listPendingFrozenFamilyReviews, readFrozenFamilyReview, resolveFrozenFamilyReview,
  verifyFrozenFamilyReviewOperator } from '../../dist/modules/auth/frozen-family-review.js';
import { inspectAccountDeletionBlockers } from '../../dist/modules/auth/account-deletion-cleanup.js';
import { hasUnresolvedDeletionState } from '../../dist/account-deletion-ledger/startup-recovery.js';

const OPERATOR_ROLE = 'siyue_review_operator';
const REASON = 'OPS-CASE-2026-0912';
const day = 86_400_000;
const keyOf = () => `review-${randomUUID()}`;
const hashOf = value => createHash('sha256').update(value).digest('hex');
const provisionScript = fileURLToPath(new URL('../../provision/frozen-family-review-operator.sql',
  import.meta.url));

let db, fx, operator, service, expectation;
before(async () => {
  db = await startPostgresFixture();
  // The designated operator login is created by the deployment's own provisioning script, not by this
  // test: the grants asserted below are exactly what that script installs, so the script is executable
  // evidence rather than a description, and every test here fails if it stops being sufficient.
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
  fx = await createEmailFixture(db);
  service = createFrozenFamilyReviewService(db.app, fx.service, fx.clock);
  expectation = { operators: [OPERATOR_ROLE], database: db.identity.database,
    environment: db.identity.environment };
});
beforeEach(async () => { await db.admin.query('TRUNCATE siyue.subjects CASCADE'); });
after(async () => { await db?.stop(); });

/**
 * A frozen family exactly as an accepted sole-manager deletion leaves it: the deleting adult keeps the
 * owner membership for review, the family is frozen, the deletion job and the pending marker are bound to
 * each other, one other adult is still a member, and that adult guards one child of the family.
 */
async function frozenScene() {
  const ownerId = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'adult','deletion_pending')", [ownerId]);
  const familyId = randomUUID();
  await db.app.query("INSERT INTO siyue.families(id,status,owner_subject_id,version) VALUES($1,'frozen',$2,2)",
    [familyId, ownerId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,version) VALUES($1,$2,'owner',3)",
    [familyId, ownerId]);
  const jobId = randomUUID();
  await db.app.query(`INSERT INTO siyue.account_deletion_jobs
      (id,subject_id,requested_at,receipt_secret_hash,receipt_expires_at) VALUES($1,$2,now(),$3,$4)`,
  [jobId, ownerId, hashOf(randomUUID()), new Date(Date.now() + 30 * day)]);
  const reviewId = randomUUID();
  await db.app.query(`INSERT INTO siyue.account_deletion_family_reviews
      (id,deletion_id,family_id,deleting_subject_id,state,opened_at) VALUES($1,$2,$3,$4,'pending',now())`,
  [reviewId, jobId, familyId, ownerId]);
  const recipient = await fx.issue();
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [familyId, recipient.session.subjectId]);
  const childId = randomUUID(), consentId = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')", [childId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [familyId, childId]);
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
      VALUES($1,$2,$3,'child-guardianship','1.0')`, [consentId, ownerId, childId]);
  await db.app.query(`INSERT INTO siyue.guardian_relationships
      (family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)`,
  [familyId, ownerId, childId, consentId]);
  return { ownerId, familyId, jobId, reviewId, recipient, childId, consentId };
}

const request = scope => ({ expectedFamilyVersion: scope.familyVersion,
  expectedMembershipVersion: scope.membershipVersion,
  expectedOwnerMembershipVersion: scope.ownerMembershipVersion,
  expectedChildScopeDigest: scope.childScopeDigest,
  acceptance: { familyManagement: true, guardianship: true } });

const accept = (scene, scope) => service.accept(scene.recipient.accessToken, scene.familyId, request(scope));

/** The operator's own connection runs the identity check and the closure in one transaction. */
async function closeReview(input) {
  return transaction(operator, async client => {
    const { operatorRole } = await verifyFrozenFamilyReviewOperator(client, expectation);
    return resolveFrozenFamilyReview(client, { ...input, operatorRole }, fx.clock());
  });
}

const closureInput = (scene, scope, acceptance, overrides = {}) => ({
  reviewId: scene.reviewId, recipientSubjectId: scene.recipient.session.subjectId,
  acceptanceId: acceptance.acceptanceId, expectedFamilyVersion: scope.familyVersion,
  expectedRecipientMembershipVersion: scope.membershipVersion,
  expectedOwnerMembershipVersion: scope.ownerMembershipVersion,
  expectedChildScopeDigest: scope.childScopeDigest, sharedWorkResult: 'separated',
  sharedWorkCheckedAt: fx.clock(), reason: REASON,
  idempotencyKeyHash: frozenFamilyReviewIdempotencyKeyHash(keyOf()), ...overrides });

const count = async (sql, params = []) => Number((await db.app.query(sql, params)).rows[0].n);
const failures = async (query, code) => {
  const error = await query.then(() => null, thrown => thrown);
  assert.equal(error?.code, code, `${error?.message ?? ''} ${error?.constraint ?? ''}`.trim());
};
/** Asserts a statement was refused with one SQLSTATE, for a grant or constraint that must not be reachable. */
const refused = async (query, code, label) => {
  const error = await query.then(() => null, thrown => thrown);
  assert.equal(error?.code, code, `${label ?? ''} ${error?.constraint ?? error?.message ?? ''}`.trim());
};

test('the recipient accepts the frozen scope and a designated operator restores the family once', async () => {
  const scene = await frozenScene();
  const preview = await service.preview(scene.recipient.accessToken, scene.familyId);
  assert.deepEqual({ familyId: preview.familyId, deletingSubjectId: preview.deletingSubjectId,
    recipientSubjectId: preview.recipientSubjectId, familyVersion: preview.familyVersion,
    membershipVersion: preview.membershipVersion, ownerMembershipVersion: preview.ownerMembershipVersion,
    childCount: preview.childCount },
  { familyId: scene.familyId, deletingSubjectId: scene.ownerId,
    recipientSubjectId: scene.recipient.session.subjectId, familyVersion: 2, membershipVersion: 1,
    ownerMembershipVersion: 3, childCount: 1 });
  // The declaration covers the management duty and the applicable guardianship, and it is current for the
  // same 24-hour validity window the live management acceptance uses: repeating the same request inside
  // that window returns the same record instead of accumulating declarations.
  const accepted = await accept(scene, preview);
  assert.equal(accepted.consumedAt, null);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_review_acceptances WHERE family_id=$1',
    [scene.familyId]), 1);

  const resolution = await closeReview(closureInput(scene, preview, accepted));
  assert.equal(resolution.replayed, false);
  assert.equal(resolution.operatorRole, OPERATOR_ROLE);
  assert.equal(resolution.childCount, 1);
  assert.equal(resolution.sharedWorkResult, 'separated');
  const closed = (await db.app.query('SELECT status,owner_subject_id,version FROM siyue.families WHERE id=$1',
    [scene.familyId])).rows[0];
  assert.deepEqual(closed, { status: 'active', owner_subject_id: scene.recipient.session.subjectId, version: 3 });
  const membershipOf = async subjectId => (await db.app.query(`SELECT role,active,version
      FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2`,
  [scene.familyId, subjectId])).rows[0];
  assert.deepEqual(await membershipOf(scene.ownerId), { role: 'member', active: false, version: 4 });
  assert.deepEqual(await membershipOf(scene.recipient.session.subjectId),
    { role: 'owner', active: true, version: 2 });
  // The child membership is untouched: a role is not a guardianship, and this closure does not rewrite it.
  assert.deepEqual(await membershipOf(scene.childId), { role: 'member', active: true, version: 1 });
  const marker = (await db.app.query(`SELECT state,resolved_at FROM siyue.account_deletion_family_reviews
      WHERE id=$1`,[scene.reviewId])).rows[0];
  assert.equal(marker.state, 'resolved');
  assert.ok(marker.resolved_at);
  assert.ok((await db.app.query('SELECT consumed_at FROM siyue.family_review_acceptances WHERE id=$1',
    [accepted.acceptanceId])).rows[0].consumed_at);
  const stored = (await db.app.query('SELECT * FROM siyue.family_review_resolutions WHERE review_id=$1',
    [scene.reviewId])).rows[0];
  assert.deepEqual({ operator: stored.operator_role, result: stored.shared_work_result, reason: stored.reason,
    digest: stored.child_scope_digest, children: stored.child_count, family: stored.family_id,
    recipient: stored.recipient_subject_id, acceptance: stored.acceptance_id },
  { operator: OPERATOR_ROLE, result: 'separated', reason: REASON, digest: preview.childScopeDigest,
    children: 1, family: scene.familyId, recipient: scene.recipient.session.subjectId,
    acceptance: accepted.acceptanceId });
  // The recipient holds a new consent of their own, and the deleting adult's declaration is withdrawn.
  const guardianships = (await db.app.query(`SELECT r.guardian_subject_id,r.active,c.withdrawn_at
      FROM siyue.guardian_relationships r JOIN siyue.consent_records c ON c.id=r.consent_record_id
      WHERE r.family_id=$1 ORDER BY r.active`,[scene.familyId])).rows;
  assert.deepEqual(guardianships.map(row => ({ guardian: row.guardian_subject_id, active: row.active,
    withdrawn: row.withdrawn_at !== null })),
  [{ guardian: scene.ownerId, active: false, withdrawn: true },
    { guardian: scene.recipient.session.subjectId, active: true, withdrawn: false }]);
  assert.equal((await db.app.query(`SELECT count(*)::int AS n FROM siyue.guardian_relationships r
      JOIN siyue.consent_records c ON c.id=r.consent_record_id
      WHERE r.family_id=$1 AND r.guardian_subject_id=$2 AND c.withdrawn_at IS NULL`,
  [scene.familyId, scene.ownerId])).rows[0].n, 0);
  assert.deepEqual((await db.app.query(`SELECT event_type FROM siyue.security_events ORDER BY event_type`)).rows
    .map(row => row.event_type), ['family.review.accept', 'family.review.resolve']);
  // The review path reads the deletion job and never writes it: local data is still there, and only the
  // cleanup kernel may claim progress on it.
  assert.deepEqual((await db.app.query('SELECT local_data_deleted,state FROM siyue.account_deletion_jobs WHERE id=$1',
    [scene.jobId])).rows[0], { local_data_deleted: false, state: 'accepted' });
  // The closure is what unblocks the deletion gate: the deleting adult holds no live family authority,
  // so readiness and login are no longer refused, while the cleanup scan owns the remaining history.
  assert.deepEqual(await transaction(db.app, client =>
    inspectAccountDeletionBlockers(client, scene.ownerId, fx.clock())), []);
  assert.equal(await hasUnresolvedDeletionState(db.app), false);
});

test('a resolved review replays its own key and refuses a different key or a changed parameter', async () => {
  const scene = await frozenScene();
  const preview = await service.preview(scene.recipient.accessToken, scene.familyId);
  const accepted = await accept(scene, preview);
  const key = keyOf();
  // A live declaration cannot be blinded: the schema only lets the deleting adult's link be cleared on a
  // record that is already closed, so no redaction can turn the recipient's current consent into an
  // anonymous one, and the closure would refuse a record whose link is gone anyway.
  await refused(db.app.query(`UPDATE siyue.family_review_acceptances
      SET deleting_subject_id=NULL,deleting_redacted_at=$2 WHERE id=$1`,
    [accepted.acceptanceId, new Date()]), '23514', 'redact live acceptance');
  const input = closureInput(scene, preview, accepted,
    { idempotencyKeyHash: frozenFamilyReviewIdempotencyKeyHash(key) });
  const first = await closeReview(input);
  const replay = await closeReview(input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_review_resolutions'), 1);
  // A repeated call is a replay, not a second transfer: the family version moved exactly once.
  assert.equal((await db.app.query('SELECT version FROM siyue.families WHERE id=$1',
    [scene.familyId])).rows[0].version, 3);
  // Another idempotency key on the same closed review is a conflict, and so is the same key bound to any
  // other parameter: the stored record is only replayed for the operation it recorded.
  await failures(closeReview(closureInput(scene, preview, accepted)), 'FAMILY_REVIEW_ALREADY_RESOLVED');
  for (const overrides of [{ reason: 'OPS-CASE-OTHER' }, { sharedWorkResult: 'no_shared_work' },
      { expectedFamilyVersion: 9 }, { expectedChildScopeDigest: 'd'.repeat(64) },
      { acceptanceId: randomUUID() }, { recipientSubjectId: randomUUID() },
      // The instant of the shared-work check is part of the operation, so a retry that moves it is a
      // conflict rather than a replay of a decision recorded for another moment.
      { sharedWorkCheckedAt: new Date(+fx.clock() + 1000) }]) {
    await failures(closeReview({ ...input, ...overrides }), 'FAMILY_REVIEW_IDEMPOTENCY_CONFLICT');
  }
  // Naming a different operator on a closed review is refused by the identity check before the stored
  // record is even compared; the stored operator binding is the second layer behind it.
  await assert.rejects(transaction(operator, client => resolveFrozenFamilyReview(client,
    { ...input, operatorRole: 'siyue_review_backup' }, fx.clock())),
  { code: 'FAMILY_REVIEW_OPERATOR_REJECTED' });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_review_resolutions'), 1);
  assert.deepEqual((await db.app.query(`SELECT shared_work_result,reason,idempotency_key_hash
      FROM siyue.family_review_resolutions WHERE review_id=$1`,[scene.reviewId])).rows[0],
  { shared_work_result: 'separated', reason: REASON,
    idempotency_key_hash: frozenFamilyReviewIdempotencyKeyHash(key) });
});

test('a retry of a finished closure still returns its original proof after the owner is cleaned up', async () => {
  const scene = await frozenScene();
  const preview = await service.preview(scene.recipient.accessToken, scene.familyId);
  const accepted = await accept(scene, preview);
  const key = keyOf();
  const input = closureInput(scene, preview, accepted,
    { idempotencyKeyHash: frozenFamilyReviewIdempotencyKeyHash(key) });
  const first = await closeReview(input);
  // The deleting adult's own data is cleaned afterwards -- their session is revoked, their subject becomes
  // the tombstone the deletion job records, and the job is completed. None of that is part of the closure,
  // and none of it may take the proof of the handover with it.
  await db.app.query(`UPDATE siyue.auth_sessions SET revoked_at=COALESCE(revoked_at,$2) WHERE subject_id=$1`,
    [scene.ownerId, new Date()]);
  await db.app.query(`UPDATE siyue.subjects SET status='deleted',display_name='',deleted_at=$2 WHERE id=$1`,
    [scene.ownerId, new Date()]);
  await db.app.query(`UPDATE siyue.account_deletion_jobs
      SET state='completed',local_data_deleted=true,provider_revocation_pending=false,completed_at=$2
      WHERE id=$1`, [scene.jobId, new Date()]);
  // The cleanup's own redaction of this closed review (0026) clears the deleting adult's link on the marker
  // and on the consumed acceptance it left behind, and stamps both. The resolution, the operator's record,
  // the idempotency proof and the recipient's own acceptance columns are not part of that and stay intact.
  await db.app.query(`UPDATE siyue.account_deletion_family_reviews
      SET deleting_subject_id=NULL,deleting_redacted_at=$2 WHERE id=$1`, [scene.reviewId, new Date()]);
  await db.app.query(`UPDATE siyue.family_review_acceptances
      SET deleting_subject_id=NULL,deleting_redacted_at=$2 WHERE id=$1`, [accepted.acceptanceId, new Date()]);
  const retry = await closeReview(input);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry, { ...first, replayed: true });
  // The proof the retry returns is the recorded closure itself: who closed it, on which acceptance, with
  // which shared-work result at which instant, for which family and recipient, and when.
  assert.deepEqual({ resolutionId: retry.resolutionId, operator: retry.operatorRole,
    result: retry.sharedWorkResult, checkedAt: retry.sharedWorkCheckedAt, children: retry.childCount,
    closedAt: retry.closedAt, family: retry.familyId, recipient: retry.recipientSubjectId },
  { resolutionId: first.resolutionId, operator: OPERATOR_ROLE, result: 'separated',
    checkedAt: first.sharedWorkCheckedAt, children: 1, closedAt: first.closedAt, family: scene.familyId,
    recipient: scene.recipient.session.subjectId });
  // The handover itself is still in force, and the resolution row was not rewritten by the cleanup.
  assert.deepEqual((await db.app.query('SELECT status,owner_subject_id FROM siyue.families WHERE id=$1',
    [scene.familyId])).rows[0], { status: 'active', owner_subject_id: scene.recipient.session.subjectId });
  assert.deepEqual((await db.app.query('SELECT idempotency_key_hash,operator_role FROM siyue.family_review_resolutions WHERE review_id=$1',
    [scene.reviewId])).rows[0],
  { idempotency_key_hash: frozenFamilyReviewIdempotencyKeyHash(key), operator_role: OPERATOR_ROLE });
  // The operations view still reads the resolved review, and the redaction is visible as a cleared link
  // rather than as a missing row: the marker keeps its state, its instants and its resolution.
  const detail = await readFrozenFamilyReview(db.app, scene.reviewId);
  assert.equal(detail.review.state, 'resolved');
  assert.equal(detail.review.deletingSubjectId, null);
  assert.deepEqual(detail.acceptances, []);
});

test('a changed scope refuses the closure, writes nothing and requires a fresh acceptance', async () => {
  const scene = await frozenScene();
  const preview = await service.preview(scene.recipient.accessToken, scene.familyId);
  const accepted = await accept(scene, preview);
  await db.app.query('UPDATE siyue.families SET version=version+1 WHERE id=$1', [scene.familyId]);
  await failures(closeReview(closureInput(scene, preview, accepted)), 'FAMILY_REVIEW_STALE');
  // Even a caller that names the current version cannot consume an acceptance made for the old reason.
  await failures(closeReview(closureInput(scene, { ...preview, familyVersion: 3 }, accepted)),
    'FAMILY_REVIEW_STALE');
  assert.equal((await db.app.query('SELECT state FROM siyue.account_deletion_family_reviews WHERE id=$1',
    [scene.reviewId])).rows[0].state, 'pending');
  assert.deepEqual((await db.app.query('SELECT consumed_at,superseded_at FROM siyue.family_review_acceptances WHERE id=$1',
    [accepted.acceptanceId])).rows[0], { consumed_at: null, superseded_at: null });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_review_resolutions'), 0);
  assert.deepEqual((await db.app.query('SELECT status,owner_subject_id FROM siyue.families WHERE id=$1',
    [scene.familyId])).rows[0], { status: 'frozen', owner_subject_id: scene.ownerId });
  // A fresh acceptance over the new scope supersedes the old record and closes the review.
  const fresh = await service.preview(scene.recipient.accessToken, scene.familyId);
  assert.equal(fresh.familyVersion, 3);
  const replacement = await accept(scene, fresh);
  assert.notEqual(replacement.acceptanceId, accepted.acceptanceId);
  assert.ok((await db.app.query('SELECT superseded_at FROM siyue.family_review_acceptances WHERE id=$1',
    [accepted.acceptanceId])).rows[0].superseded_at);
  await failures(closeReview(closureInput(scene, fresh, accepted)), 'FAMILY_REVIEW_STALE');
  const closed = await closeReview(closureInput(scene, fresh, replacement));
  assert.equal(closed.replayed, false);
  assert.equal((await db.app.query('SELECT status FROM siyue.families WHERE id=$1',
    [scene.familyId])).rows[0].status, 'active');
});

test('an acceptance past its validity window is refused and has to be given again', async () => {
  const scene = await frozenScene();
  const preview = await service.preview(scene.recipient.accessToken, scene.familyId);
  const accepted = await accept(scene, preview);
  // Age the recorded declaration past the 24-hour window the live management acceptance also uses. The row
  // stays as history; what moves is its currentness, which is exactly what the closure reads.
  await db.app.query("UPDATE siyue.family_review_acceptances SET accepted_at=accepted_at-interval '25 hours'" +
    ' WHERE id=$1', [accepted.acceptanceId]);
  await failures(closeReview(closureInput(scene, preview, accepted)), 'FAMILY_REVIEW_ACCEPTANCE_EXPIRED');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_review_resolutions'), 0);
  assert.deepEqual((await db.app.query('SELECT consumed_at,superseded_at FROM siyue.family_review_acceptances WHERE id=$1',
    [accepted.acceptanceId])).rows[0], { consumed_at: null, superseded_at: null });
  assert.deepEqual((await db.app.query('SELECT status,owner_subject_id FROM siyue.families WHERE id=$1',
    [scene.familyId])).rows[0], { status: 'frozen', owner_subject_id: scene.ownerId });
  // The operator views offer only what is still current, so an expired declaration is never presented as
  // something a review could be closed with.
  assert.deepEqual((await readFrozenFamilyReview(db.app, scene.reviewId)).acceptances, []);
  assert.equal((await listPendingFrozenFamilyReviews(db.app, 10))[0].liveAcceptanceCount, 0);
  // Accepting again inside a fresh window supersedes the aged row, and the review closes with the new one.
  const again = await accept(scene, preview);
  assert.notEqual(again.acceptanceId, accepted.acceptanceId);
  assert.ok((await db.app.query('SELECT superseded_at FROM siyue.family_review_acceptances WHERE id=$1',
    [accepted.acceptanceId])).rows[0].superseded_at);
  assert.deepEqual((await readFrozenFamilyReview(db.app, scene.reviewId)).acceptances.map(entry => entry.acceptanceId),
    [again.acceptanceId]);
  const resolution = await closeReview(closureInput(scene, preview, again));
  assert.equal(resolution.replayed, false);
  assert.equal((await db.app.query('SELECT status FROM siyue.families WHERE id=$1',
    [scene.familyId])).rows[0].status, 'active');
});

test('an ordinary member, an unwired caller and a claimed role cannot close a review', async () => {
  const scene = await frozenScene();
  const stranger = await fx.issue();
  await assert.rejects(service.preview(stranger.accessToken, scene.familyId), { code: 'FAMILY_NOT_FOUND' });
  const preview = await service.preview(scene.recipient.accessToken, scene.familyId);
  await assert.rejects(service.accept(stranger.accessToken, scene.familyId, request(preview)),
    { code: 'FAMILY_NOT_FOUND' });
  // The API's own runtime role may never be the review operator, even when an environment names it.
  await assert.rejects(transaction(db.app, client => verifyFrozenFamilyReviewOperator(client,
    { ...expectation, operators: ['siyue_app'] })), { code: 'FAMILY_REVIEW_OPERATOR_REQUIRED' });
  await assert.rejects(transaction(db.app, client => verifyFrozenFamilyReviewOperator(client,
    { ...expectation, operators: [] })), { code: 'FAMILY_REVIEW_OPERATOR_REQUIRED' });
  // A role this connection is not, and a database or environment marker this database is not, refuse.
  await assert.rejects(transaction(operator, client => verifyFrozenFamilyReviewOperator(client,
    { ...expectation, operators: ['siyue_review_backup'] })), { code: 'FAMILY_REVIEW_OPERATOR_REJECTED' });
  await assert.rejects(transaction(operator, client => verifyFrozenFamilyReviewOperator(client,
    { ...expectation, environment: 'production' })), { code: 'FAMILY_REVIEW_OPERATOR_REJECTED' });
  await assert.rejects(transaction(operator, client => verifyFrozenFamilyReviewOperator(client,
    { ...expectation, database: 'siyue_other' })), { code: 'FAMILY_REVIEW_OPERATOR_REJECTED' });
  // A caller that names a role the connection is not is refused by the kernel itself.
  await assert.rejects(transaction(operator, client => resolveFrozenFamilyReview(client,
    { ...closureInput(scene, preview, { acceptanceId: randomUUID() }), operatorRole: 'siyue_app' },
    fx.clock())), { code: 'FAMILY_REVIEW_OPERATOR_REJECTED' });
  // The kernel refuses the runtime role by name too, so the request path's own login cannot become a
  // review operator by passing that name in the input -- and the acceptance, family and marker are all
  // untouched by the attempt.
  await assert.rejects(transaction(db.app, client => resolveFrozenFamilyReview(client,
    { ...closureInput(scene, preview, { acceptanceId: randomUUID() }), operatorRole: 'siyue_app' },
    fx.clock())), { code: 'FAMILY_REVIEW_OPERATOR_REJECTED' });
  // An acceptance nobody recorded, an unknown review and an unknown family are all refusals, and none of
  // them writes anything: the review stays pending and the family stays frozen.
  await failures(closeReview(closureInput(scene, preview, { acceptanceId: randomUUID() })),
    'FAMILY_REVIEW_STALE');
  await failures(closeReview({ ...closureInput(scene, preview, { acceptanceId: randomUUID() }),
    reviewId: randomUUID() }), 'FAMILY_REVIEW_NOT_FOUND');
  await failures(closeReview({ ...closureInput(scene, preview, { acceptanceId: randomUUID() }),
    expectedChildScopeDigest: 'd'.repeat(64) }), 'FAMILY_REVIEW_STALE');
  await failures(closeReview({ ...closureInput(scene, preview, { acceptanceId: randomUUID() }),
    sharedWorkCheckedAt: new Date(+fx.clock() + day) }), 'FAMILY_REVIEW_INVALID_REQUEST');
  assert.equal((await db.app.query('SELECT state FROM siyue.account_deletion_family_reviews WHERE id=$1',
    [scene.reviewId])).rows[0].state, 'pending');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_review_resolutions'), 0);
});

test('a retained shared-work result refuses the closure and keeps every revocation standing', async () => {
  const scene = await frozenScene();
  // What the freeze left behind: a revoked child grant, a revoked invitation, an ended room of the
  // deleting adult and a revoked room invitation. Another member's own open room and seat stay theirs.
  const grantId = randomUUID();
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,
      platform,guardian_relationship_version,guardian_credential_version,scopes,created_at,expires_at,revoked_at)
      VALUES($1,$2,$3,$4,'synthetic-installation','ios',1,1,'{}',now()-interval '2 hours',now()+interval '1 day',
        now()-interval '1 hour')`, [grantId, scene.childId, scene.ownerId, scene.familyId]);
  const invitationId = randomUUID();
  await db.app.query(`INSERT INTO siyue.family_invitations(id,family_id,inviter_id,token_hash,status,
      policy_version,inviter_membership_version,family_version,expires_at)
      VALUES($1,$2,$3,$4,'revoked','invite-1',3,2,now()+interval '1 day')`,
  [invitationId, scene.familyId, scene.ownerId, hashOf(randomUUID())]);
  const ownerRoomId = randomUUID();
  await db.app.query(`INSERT INTO siyue.rooms(id,family_id,created_by_subject_id,status,version,created_at,ended_at)
      VALUES($1,$2,$3,'ended',3,now()-interval '3 hours',now()-interval '1 hour')`,
  [ownerRoomId, scene.familyId, scene.ownerId]);
  const memberRoomId = randomUUID();
  await db.app.query(`INSERT INTO siyue.rooms(id,family_id,created_by_subject_id,status,version,created_at)
      VALUES($1,$2,$3,'open',1,now()-interval '2 hours')`,
  [memberRoomId, scene.familyId, scene.recipient.session.subjectId]);
  const memberSessionId = (await db.app.query('SELECT id FROM siyue.auth_sessions WHERE subject_id=$1',
    [scene.recipient.session.subjectId])).rows[0].id;
  await db.app.query(`INSERT INTO siyue.room_seats(room_id,session_id,subject_id,seat_index)
      VALUES($1,$2,$3,1)`, [memberRoomId, memberSessionId, scene.recipient.session.subjectId]);
  await db.app.query(`INSERT INTO siyue.room_invitations(id,room_id,inviter_subject_id,invitee_subject_id,
      status,inviter_membership_version,invitee_membership_version,family_version,expires_at,created_at,revoked_at)
      VALUES($1,$2,$3,$4,'revoked',3,1,2,now()+interval '2 hours',now()-interval '3 hours',
        now()-interval '1 hour')`,
  [randomUUID(), ownerRoomId, scene.ownerId, scene.recipient.session.subjectId]);

  const preview = await service.preview(scene.recipient.accessToken, scene.familyId);
  const accepted = await accept(scene, preview);
  // The operator found shared work that still has to be kept and checked. That is a refusal, not a
  // closure: the family stays frozen, the acceptance stays live and nothing is revoked or written.
  await failures(closeReview(closureInput(scene, preview, accepted, { sharedWorkResult: 'retained_for_review' })),
    'FAMILY_REVIEW_SHARED_WORK_RETAINED');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_review_resolutions'), 0);
  assert.equal((await db.app.query('SELECT state FROM siyue.account_deletion_family_reviews WHERE id=$1',
    [scene.reviewId])).rows[0].state, 'pending');
  assert.deepEqual((await db.app.query('SELECT status,owner_subject_id FROM siyue.families WHERE id=$1',
    [scene.familyId])).rows[0], { status: 'frozen', owner_subject_id: scene.ownerId });
  assert.deepEqual((await db.app.query(`SELECT consumed_at,superseded_at FROM siyue.family_review_acceptances
      WHERE id=$1`,[accepted.acceptanceId])).rows[0], { consumed_at: null, superseded_at: null });
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.guardian_relationships r
      JOIN siyue.consent_records c ON c.id=r.consent_record_id
      WHERE r.family_id=$1 AND r.guardian_subject_id=$2 AND r.active AND c.withdrawn_at IS NULL`,
  [scene.familyId, scene.recipient.session.subjectId]), 0);

  // The same review closes once the operator records a result that actually closes it.
  await closeReview(closureInput(scene, preview, accepted));

  const grant = (await db.app.query('SELECT revoked_at,version FROM siyue.device_grants WHERE id=$1',
    [grantId])).rows[0];
  assert.ok(grant.revoked_at);
  assert.equal(grant.version, 1);
  assert.deepEqual((await db.app.query('SELECT status FROM siyue.family_invitations WHERE id=$1',
    [invitationId])).rows[0], { status: 'revoked' });
  assert.deepEqual((await db.app.query('SELECT status,version FROM siyue.rooms WHERE id=$1',
    [ownerRoomId])).rows[0], { status: 'ended', version: 3 });
  // Another member's room, its seat and the seat's instant are exactly as they were.
  assert.deepEqual((await db.app.query('SELECT status,version FROM siyue.rooms WHERE id=$1',
    [memberRoomId])).rows[0], { status: 'open', version: 1 });
  assert.deepEqual((await db.app.query('SELECT released_at FROM siyue.room_seats WHERE room_id=$1',
    [memberRoomId])).rows[0], { released_at: null });
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.device_grants WHERE family_id=$1 AND revoked_at IS NULL",
    [scene.familyId]), 0);
  const resolution = (await db.app.query('SELECT shared_work_result FROM siyue.family_review_resolutions WHERE review_id=$1',
    [scene.reviewId])).rows[0];
  assert.equal(resolution.shared_work_result, 'separated');
  assert.deepEqual(await transaction(db.app, client =>
    inspectAccountDeletionBlockers(client, scene.ownerId, fx.clock())), []);
});

test('a review cannot close once the deletion cleanup has already taken the local data', async () => {
  const scene = await frozenScene();
  const preview = await service.preview(scene.recipient.accessToken, scene.familyId);
  const accepted = await accept(scene, preview);
  // The cleanup kernel stamps the subject tombstone and this job row in one transaction, so the job is the
  // authoritative progress record the closure reads before it restores anything.
  await db.app.query('UPDATE siyue.account_deletion_jobs SET local_data_deleted=true WHERE id=$1',
    [scene.jobId]);
  await failures(closeReview(closureInput(scene, preview, accepted)), 'FAMILY_REVIEW_STATE_INVALID');
  assert.equal((await db.app.query('SELECT state FROM siyue.account_deletion_family_reviews WHERE id=$1',
    [scene.reviewId])).rows[0].state, 'pending');
  assert.deepEqual((await db.app.query('SELECT status,owner_subject_id FROM siyue.families WHERE id=$1',
    [scene.familyId])).rows[0], { status: 'frozen', owner_subject_id: scene.ownerId });
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_review_resolutions'), 0);
});

test('the operations views list a pending review, its acceptors and then nothing', async () => {
  const scene = await frozenScene();
  const listed = await listPendingFrozenFamilyReviews(db.app, 10);
  assert.deepEqual(listed.map(entry => entry.reviewId), [scene.reviewId]);
  assert.equal(listed[0].familyStatus, 'frozen');
  assert.equal(listed[0].liveAcceptanceCount, 0);
  const preview = await service.preview(scene.recipient.accessToken, scene.familyId);
  const accepted = await accept(scene, preview);
  const detail = await readFrozenFamilyReview(db.app, scene.reviewId);
  assert.equal(detail.review.state, 'pending');
  assert.equal(detail.review.deletionId, scene.jobId);
  assert.deepEqual(detail.acceptances.map(entry => entry.acceptanceId), [accepted.acceptanceId]);
  assert.equal(detail.acceptances[0].childScopeDigest, preview.childScopeDigest);
  assert.equal((await listPendingFrozenFamilyReviews(db.app, 10))[0].liveAcceptanceCount, 1);
  assert.equal(await readFrozenFamilyReview(db.app, randomUUID()), null);
  await failures(readFrozenFamilyReview(db.app, 'not-a-uuid'), 'FAMILY_REVIEW_INVALID_REQUEST');
  await closeReview(closureInput(scene, preview, accepted));
  assert.deepEqual(await listPendingFrozenFamilyReviews(db.app, 10), []);
  assert.equal((await readFrozenFamilyReview(db.app, scene.reviewId)).review.state, 'resolved');
});

test('the review login holds only the privileges the closure uses', async () => {
  const scene = await frozenScene();
  const preview = await service.preview(scene.recipient.accessToken, scene.familyId);
  const accepted = await accept(scene, preview);
  // The row lock the closure takes is available: PostgreSQL only needs UPDATE on one column of a table to
  // grant a row lock, and that is exactly the width of this grant.
  assert.equal((await operator.query('SELECT id FROM siyue.subjects WHERE id=$1 FOR UPDATE',
    [scene.ownerId])).rowCount, 1);
  // Everything the closure does not write stays out of reach: a subject's kind, status, name, credentials
  // and deletion progress cannot be rewritten from the review login.
  await refused(operator.query("UPDATE siyue.subjects SET kind='adult' WHERE id=$1", [scene.childId]),
    '42501', 'subject kind');
  await refused(operator.query("UPDATE siyue.subjects SET status='active' WHERE id=$1", [scene.ownerId]),
    '42501', 'subject status');
  await refused(operator.query("UPDATE siyue.subjects SET display_name='x' WHERE id=$1", [scene.ownerId]),
    '42501', 'subject name');
  await refused(operator.query('UPDATE siyue.subjects SET credential_version=credential_version+1 WHERE id=$1',
    [scene.ownerId]), '42501', 'credential version');
  await refused(operator.query('UPDATE siyue.account_deletion_jobs SET local_data_deleted=true WHERE id=$1',
    [scene.jobId]), '42501', 'deletion job');
  await refused(operator.query('DELETE FROM siyue.families WHERE id=$1', [scene.familyId]), '42501', 'delete');
  await refused(operator.query('TRUNCATE siyue.family_review_resolutions'), '42501', 'truncate');
  // A resolution can never claim that shared work is still retained: that result keeps the review open.
  await refused(operator.query(`INSERT INTO siyue.family_review_resolutions
      (id,review_id,acceptance_id,family_id,recipient_subject_id,operator_role,shared_work_result,
       shared_work_checked_at,reason,idempotency_key_hash,family_version,recipient_membership_version,
       owner_membership_version,child_scope_digest,child_count,closed_at)
      VALUES($1,$2,$3,$4,$5,$6,'retained_for_review',$7,'OPS-CASE-2026-0912',$8,1,1,1,$9,0,$7)`,
  [randomUUID(), scene.reviewId, accepted.acceptanceId, scene.familyId,
    scene.recipient.session.subjectId, OPERATOR_ROLE, fx.clock(), hashOf(randomUUID()),
    preview.childScopeDigest]), '23514', 'retained result');
  // The API's own login keeps every privilege its routes need and still cannot create a resolution:
  // migration 0025 revokes that write, so a closure row can only come from a designated operator login.
  await refused(db.app.query(`INSERT INTO siyue.family_review_resolutions
      (id,review_id,acceptance_id,family_id,recipient_subject_id,operator_role,shared_work_result,
       shared_work_checked_at,reason,idempotency_key_hash,family_version,recipient_membership_version,
       owner_membership_version,child_scope_digest,child_count,closed_at)
      VALUES($1,$2,$3,$4,$5,'siyue_app','separated',$6,'OPS-CASE-2026-0912',$7,1,1,1,$8,0,$6)`,
  [randomUUID(), scene.reviewId, accepted.acceptanceId, scene.familyId,
    scene.recipient.session.subjectId, fx.clock(), hashOf(randomUUID()), preview.childScopeDigest]),
  '42501', 'runtime resolution');
  // None of those refusals wrote anything.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_review_resolutions'), 0);
  assert.equal((await db.app.query('SELECT state FROM siyue.account_deletion_family_reviews WHERE id=$1',
    [scene.reviewId])).rows[0].state, 'pending');
  assert.deepEqual((await db.app.query('SELECT status,owner_subject_id FROM siyue.families WHERE id=$1',
    [scene.familyId])).rows[0], { status: 'frozen', owner_subject_id: scene.ownerId });
});

test('the closure proof columns stay required so a retry cannot lose its proof', async () => {
  // A retry of a finished closure returns the stored resolution, so every column that replay compares has
  // to survive as a real value. A later redaction of a closed review may clear the deleting adult's own
  // link on the acceptance; it must not clear anything here, and it must not clear the accepting adult's
  // own declaration below, because that record is what says a second adult accepted the family.
  const nullable = async table => (await db.app.query(
    `SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_schema='siyue' AND table_name=$1`, [table])).rows;
  const required = {
    family_review_resolutions: ['review_id', 'acceptance_id', 'family_id', 'recipient_subject_id',
      'operator_role', 'shared_work_result', 'shared_work_checked_at', 'reason', 'idempotency_key_hash',
      'family_version', 'recipient_membership_version', 'owner_membership_version', 'child_scope_digest',
      'child_count', 'closed_at'],
    family_review_acceptances: ['family_id', 'recipient_subject_id', 'family_version',
      'recipient_membership_version', 'owner_membership_version', 'child_scope_digest', 'accepted_at'],
  };
  for (const [table, columns] of Object.entries(required)) {
    const rows = await nullable(table);
    for (const column of columns)
      assert.equal(rows.find(row => row.column_name === column)?.is_nullable, 'NO', `${table}.${column}`);
  }
  // The only column of the acceptance this closure reads that a redaction may clear is the deleting adult's
  // own link: the kernel compares it with the marker and refuses when it is gone, so a redacted record can
  // never close a review or be replayed as if it were the recipient's current consent.
  assert.equal(typeof (await nullable('family_review_acceptances'))
    .find(row => row.column_name === 'deleting_subject_id')?.is_nullable, 'string');
});

test('the command entry point closes a review as the designated login and replays its own key', async () => {
  const scene = await frozenScene();
  const preview = await service.preview(scene.recipient.accessToken, scene.familyId);
  const accepted = await accept(scene, preview);
  // The command runs exactly as a deployment would run it: its own login, its own database URL, and the
  // environment allowlist that names that login. No request field and no argument can name an operator.
  const socket = (await db.admin.query("SELECT setting FROM pg_settings WHERE name='unix_socket_directories'"))
    .rows[0].setting.split(',')[0];
  const cliEnv = { ...process.env,
    SIYUE_FROZEN_FAMILY_REVIEW_DATABASE_URL:
      `postgresql://${OPERATOR_ROLE}@localhost/${db.identity.database}?host=${encodeURIComponent(socket)}`,
    SIYUE_DATABASE_NAME: db.identity.database,
    SIYUE_ENVIRONMENT: db.identity.environment,
    SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS: OPERATOR_ROLE };
  const cliPath = fileURLToPath(new URL('../../dist/frozen-family-review-cli.js', import.meta.url));
  const runCli = args => {
    const result = spawnSync(process.execPath, [cliPath, ...args], { env: cliEnv, encoding: 'utf8' });
    return { exitCode: result.status, output: JSON.parse((result.stdout || '').trim() || '{}'),
      stderr: result.stderr };
  };
  const key = keyOf();
  const checkedAt = fx.clock().toISOString();
  const args = ['resolve', '--review', scene.reviewId, '--recipient', scene.recipient.session.subjectId,
    '--acceptance', accepted.acceptanceId, '--family-version', String(preview.familyVersion),
    '--recipient-membership-version', String(preview.membershipVersion),
    '--owner-membership-version', String(preview.ownerMembershipVersion),
    '--child-scope-digest', preview.childScopeDigest, '--shared-work', 'separated',
    '--reason', REASON, '--idempotency-key', key, '--shared-work-checked-at', checkedAt];
  const closed = runCli(args);
  assert.equal(closed.exitCode, 0, closed.stderr);
  assert.equal(closed.output.ok, true);
  assert.equal(closed.output.operatorRole, OPERATOR_ROLE);
  assert.deepEqual({ operator: closed.output.resolution.operatorRole, result: closed.output.resolution.sharedWorkResult,
    children: closed.output.resolution.childCount, replayed: closed.output.resolution.replayed,
    checkedAt: closed.output.resolution.sharedWorkCheckedAt },
  { operator: OPERATOR_ROLE, result: 'separated', children: 1, replayed: false, checkedAt });
  // The same command line again is answered from the recorded closure: the proof comes back with
  // replayed=true, and the family is handed over exactly once.
  const replayed = runCli(args);
  assert.equal(replayed.exitCode, 0, replayed.stderr);
  assert.equal(replayed.output.resolution.replayed, true);
  assert.equal(replayed.output.resolution.resolutionId, closed.output.resolution.resolutionId);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_review_resolutions'), 1);
  // A retained shared-work result is carried by the command and refused by the kernel.
  const retained = runCli(args.map(value => value === 'separated' ? 'retained_for_review' : value));
  assert.equal(retained.exitCode, 1);
  assert.equal(retained.output.code, 'FAMILY_REVIEW_SHARED_WORK_RETAINED');
  // The read-only view of the same login no longer owes a review, and the closure above is the one record.
  const listed = runCli(['list']).output;
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.reviews, []);
});
