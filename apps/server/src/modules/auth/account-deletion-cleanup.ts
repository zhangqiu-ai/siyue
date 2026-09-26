import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { transaction } from '../../adapters/postgres/database.js';
import { appleRevocationProgressCodes } from './account-deletion-revocation.js';
import {
  accountDeletionHistoryRemovedSchema, cleanupAccountDeletionHistory, emptyAccountDeletionHistoryRemoved,
  inspectAccountDeletionHistory,
} from './account-deletion-history.js';

// Server-controlled personal-data cleanup kernel for account deletion (design chapter 13.1/13.2/13.3).
//
// Scope is deliberately narrow: one already-accepted deletion of an *adult* that reached
// `deletion_pending` and has no live family or guardianship dependency. It removes the personal data
// Siyue itself controls -- profile fields, login addresses, password credential, email challenges,
// sessions and their refresh/reauth material, account consent, idempotency records and linked
// provider identities -- while keeping the subject row as a minimal tombstone plus the deletion job.
//
// Two properties are load-bearing and are the reason for most of the code below:
// 1. FAIL CLOSED. Anything this kernel cannot decide on its own (an active family membership or
//    guardianship, a live child device grant, an unconsumed invitation or pairing approval, an open
//    room, an Apple credential whose revocation was never queued) stops the whole cleanup. Nothing is
//    destroyed and the job is moved to `needs_attention`; `local_data_deleted` is never stamped.
// 2. AN APPLE SEAL LIVES ONLY WHILE IT CAN STILL REVOKE, AND NEVER TWICE. The revocation outbox is the
//    durable answer to "was Apple told?", and it is read from the database, never assumed. While a
//    pending, sending or needs_attention attempt is still inside its own bounded window the link keeps
//    its queue row and that one copy of the seal alone -- the identity's duplicate copy is destroyed --
//    and the provider dimension stays open. Once the window has closed, or the outbox already settled
//    the attempt as `expired`, nothing can revoke with that material any more: the identity, its
//    credential and its queue row are destroyed, and the job keeps `provider_revocation_pending` with
//    the bounded code the revocation coordinator reads for exactly this state. Design 13.3 is why: a
//    third-party outage must not block Siyue's own deletion forever, and neither an expired, destroyed
//    nor missing attempt is ever read as a confirmed revocation. Only a confirmed `revoked` identity
//    settles the provider dimension for an Apple-linked account.
//
// It opens no HTTP route, starts no worker and makes no provider call. Three things stay outside this
// kernel and must exist before a real deletion can be called finished: the anti-revival ledger stored
// independently of the restorable main database (design 13.4), the runtime schedule that runs this
// kernel and the Apple revocation outbox worker, and the family/child disposition procedure of design
// 13.2, which this kernel only detects instead of deciding.
//
// This kernel owns the part of the accepted historical rule the live dependency scan cannot answer:
// what to do with ended rows that still name the deleting adult. Those rows are decided by the layered
// pass in account-deletion-history.ts (remove what was only ever the adult's own dead material, keep
// another member's valid relationship and original work, and clear the adult's link from ended history
// only where that damages nobody's live authority, replay protection or the audit record). Only the
// cases that cannot be separated -- a family the adult still owns, shared room history, another adult's
// retained management acceptance, a freeze review still owed -- stop the run, and each is reported as
// its own bounded code instead of one catch-all.
//
// Two records are deliberately left to their own bounded lifetime rather than deleted here: a
// `security_events` row (already redacted, carrying no profile field, and gone within its retention)
// and an email idempotency record, which is not bound to a subject id and therefore cannot be found
// from here -- its sealed response is dropped after 60 seconds and the row after one day.

/** Bounded, self-describing reason codes. They are stored in `account_deletion_jobs.last_error_code`,
 * whose CHECK allows exactly this lowercase snake_case shape, and are safe to show to a client as a
 * code (never as a message). */
export const accountDeletionCleanupBlockerSchema = z.enum([
  // Family dependency: the subject is still an active member or the active owner of a live family.
  'family_membership', 'family_owned',
  // Child dependency: a live guardianship, an open guardianship consent or a live child device grant.
  'guardianship', 'guardianship_consent', 'child_device_grant',
  // Pending authority the subject handed out or approved but that is not yet settled.
  'pending_invitation', 'pairing_approval',
  // Live shared room state the subject still occupies or created.
  'open_room', 'room_seat',
  // Ended history that still separates one adult from another member's record only on paper: a family
  // this adult still owns, shared room history, another adult's retained management acceptance, or a
  // freeze review still owed, or a closed freeze review that still names this adult and that the API's
  // own login may not rewrite or remove (migration 0025). Layer 1 and layer 3 of the historical rule
  // settle everything else, so these are the rows a person must look at, not a substitute for deciding.
  'shared_family_history', 'inseparable_shared_work',
  'retained_management_acceptance', 'pending_family_review', 'retained_review_closure',
  // Apple revocation was never queued for a stored credential, so nobody can say whether Apple was
  // ever told; the sealed credential must be kept for a human instead of being destroyed here.
  'apple_revocation_not_queued',
]);
export type AccountDeletionCleanupBlocker = z.infer<typeof accountDeletionCleanupBlockerSchema>;

/** Input is only the target subject: no access token, receipt or caller-supplied identity, because the
 * deletion was already authorized and accepted before this kernel runs. */
export const accountDeletionCleanupInputSchema = z.object({
  subjectId: z.uuid(), expectedDeletionId: z.uuid().optional(),
}).strict();

/** Row counts of what this single run actually removed, so a caller or an operator can tell a first
 * pass from an idempotent replay without reading the tables. */
export const accountDeletionCleanupRemovedSchema = z.object({
  emails: z.number().int().nonnegative(),
  passwordCredentials: z.number().int().nonnegative(),
  challenges: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  refreshTokens: z.number().int().nonnegative(),
  reauthGrants: z.number().int().nonnegative(),
  appleLoginFlows: z.number().int().nonnegative(),
  roomSeats: z.number().int().nonnegative(),
  accountConsents: z.number().int().nonnegative(),
  idempotencyRecords: z.number().int().nonnegative(),
  familyCreateRequests: z.number().int().nonnegative(),
  familyMemberships: z.number().int().nonnegative(),
  mailJobs: z.number().int().nonnegative(),
  appleCredentials: z.number().int().nonnegative(),
  appleRevocationJobs: z.number().int().nonnegative(),
  appleIdentities: z.number().int().nonnegative(),
  /** What the layered historical pass did, kept apart from the credential and temporary material above
   * so an operator can see which of the three parts acted. */
  history: accountDeletionHistoryRemovedSchema,
}).strict();
export type AccountDeletionCleanupRemoved = z.infer<typeof accountDeletionCleanupRemovedSchema>;

/** Result of one run. `serverDataDeleted` mirrors `account_deletion_jobs.local_data_deleted`: it is true
 * only once this run (or an earlier one) really removed the server-side personal data, and it never
 * claims anything about a phone, tablet or other offline copy. `providerRevocationPending` is reported
 * apart for the reason design 13.3 gives: the two cleanup dimensions are never merged.
 * `preservedAppleRevocations` counts the links whose queued seal is still able to reach Apple, so a
 * revocation this run destroyed contributes to `providerRevocationPending` without counting as kept. */
export const accountDeletionCleanupResultSchema = z.object({
  subjectId: z.uuid(),
  deletionId: z.uuid(),
  outcome: z.enum(['completed', 'cleaned', 'needs_attention']),
  serverDataDeleted: z.boolean(),
  providerRevocationPending: z.boolean(),
  preservedAppleRevocations: z.number().int().nonnegative(),
  blockers: z.array(accountDeletionCleanupBlockerSchema),
  removed: accountDeletionCleanupRemovedSchema,
}).strict();
export type AccountDeletionCleanupResult = z.infer<typeof accountDeletionCleanupResultSchema>;

export type AccountDeletionCleanupErrorCode =
  | 'cleanup_invalid_request' | 'cleanup_target_missing' | 'cleanup_target_not_adult'
  | 'cleanup_target_not_pending' | 'cleanup_job_missing' | 'cleanup_job_mismatch'
  | 'deletion_job_missing' | 'ledger_entry_missing' | 'ledger_entry_prepared'
  | 'ledger_entry_cancelled' | 'ledger_intent_mismatch' | 'ledger_entry_not_accepted';

/** Kernel misuse, not an HTTP outcome: a wrong or untargetable subject refuses instead of guessing. */
export class AccountDeletionCleanupError extends Error {
  constructor(readonly code: AccountDeletionCleanupErrorCode) { super(code); }
}

interface SubjectRow { id: string; kind: 'adult' | 'child'; status: string; display_name: string; }
interface JobRow {
  id: string; state: string; local_data_deleted: boolean; provider_revocation_pending: boolean;
  completed_at: Date | null; last_error_code: string | null;
}
interface DependencyRow {
  family_memberships: number; families_owned: number; guardianships: number;
  guardianship_consents: number; child_device_grants: number; pending_invitations: number;
  pairing_approvals: number; open_rooms: number; room_seats: number;
}
interface AppleRow {
  identity_id: string; has_credential: boolean; outbox_status: string | null;
  outbox_expires_at: Date | null;
}

// The same reachability rules the read-only impact inventory uses: a family counts only while it is
// active or frozen and the subject's own membership is active, and a guardianship counts only while the
// relationship is active and its recorded consent is still un-withdrawn. A family role never implies
// guardianship, and `families.owner_subject_id` is checked separately so a live family whose owner
// membership was deactivated by a defect still stops the cleanup.
const dependencySql = `SELECT
    (SELECT count(*)::int FROM siyue.families f
       JOIN siyue.family_memberships m ON m.family_id = f.id AND m.subject_id = $1 AND m.active
      WHERE f.status IN ('active','frozen') AND NOT (f.id=ANY($3::uuid[]))) AS family_memberships,
    (SELECT count(*)::int FROM siyue.families f
      WHERE f.owner_subject_id = $1 AND f.status IN ('active','frozen')
        AND NOT (f.id=ANY($3::uuid[]))) AS families_owned,
    (SELECT count(*)::int FROM siyue.guardian_relationships r
       JOIN siyue.consent_records c ON c.id = r.consent_record_id
      WHERE r.guardian_subject_id = $1 AND r.active AND c.withdrawn_at IS NULL
        AND NOT (r.family_id=ANY($3::uuid[]))) AS guardianships,
    (SELECT count(*)::int FROM siyue.consent_records c
      WHERE c.actor_subject_id = $1 AND c.subject_id IS NOT NULL AND c.purpose = 'child-guardianship'
        AND c.withdrawn_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM siyue.guardian_relationships r
          WHERE r.consent_record_id=c.id AND r.guardian_subject_id=$1 AND r.active
            AND r.family_id=ANY($3::uuid[]))) AS guardianship_consents,
    (SELECT count(*)::int FROM siyue.device_grants g
      WHERE g.guardian_id = $1 AND g.revoked_at IS NULL AND g.expires_at > $2) AS child_device_grants,
    (SELECT count(*)::int FROM siyue.family_invitations i
      WHERE i.inviter_id = $1 AND i.status = 'pending' AND i.expires_at > $2) AS pending_invitations,
    (SELECT count(*)::int FROM siyue.device_pairing_requests p
      WHERE p.approved_by = $1 AND p.status = 'approved' AND p.expires_at > $2) AS pairing_approvals,
    (SELECT count(*)::int FROM siyue.rooms r
      WHERE r.created_by_subject_id = $1 AND r.status = 'open') AS open_rooms,
    (SELECT count(*)::int FROM siyue.room_seats s
       JOIN siyue.rooms r ON r.id = s.room_id
      WHERE s.subject_id = $1 AND s.released_at IS NULL AND r.status = 'open') AS room_seats`;

// Everything the Apple decision needs: whether a credential is still stored, and the queue row's own
// status and bounded window. `outbox_status` NULL together with a credential means the revocation was
// never queued at all, which is not a state this kernel is allowed to resolve on its own; NULL with no
// credential means there is no usable material, but does not prove Apple revoked the authorization.
const appleSql = `SELECT i.id AS identity_id,
    (c.identity_id IS NOT NULL) AS has_credential, o.status AS outbox_status,
    o.expires_at AS outbox_expires_at
  FROM siyue.external_identities i
    LEFT JOIN siyue.apple_provider_credentials c ON c.identity_id = i.id
    LEFT JOIN siyue.apple_revocation_outbox o ON o.identity_id = i.id
  WHERE i.subject_id = $1
  ORDER BY i.id`;

const noRemovals = (): AccountDeletionCleanupRemoved => ({
  emails: 0, passwordCredentials: 0, challenges: 0, sessions: 0, refreshTokens: 0, reauthGrants: 0,
  appleLoginFlows: 0, roomSeats: 0, accountConsents: 0, idempotencyRecords: 0,
  familyCreateRequests: 0, mailJobs: 0, appleCredentials: 0, appleRevocationJobs: 0,
  appleIdentities: 0, familyMemberships: 0, history: emptyAccountDeletionHistoryRemoved(),
});

const blockersOf = (row: DependencyRow): AccountDeletionCleanupBlocker[] => {
  const found: AccountDeletionCleanupBlocker[] = [];
  if (row.family_memberships > 0) found.push('family_membership');
  if (row.families_owned > 0) found.push('family_owned');
  if (row.guardianships > 0) found.push('guardianship');
  if (row.guardianship_consents > 0) found.push('guardianship_consent');
  if (row.child_device_grants > 0) found.push('child_device_grant');
  if (row.pending_invitations > 0) found.push('pending_invitation');
  if (row.pairing_approvals > 0) found.push('pairing_approval');
  if (row.open_rooms > 0) found.push('open_room');
  if (row.room_seats > 0) found.push('room_seat');
  return found;
};

/** The internal acceptance transaction may retain only links to families it just froze and recorded
 * for review. Cleanup always calls this without exemptions: no pending family case is data deletion. */
export async function inspectAccountDeletionBlockers(client: PoolClient, subjectId: string, now: Date,
  frozenForReview: readonly string[] = []) {
  return blockersOf((await client.query<DependencyRow>(dependencySql,
    [subjectId, now, frozenForReview])).rows[0] as DependencyRow);
}

/**
 * Builds the internal cleanup kernel over one database pool.
 *
 * The whole run is one transaction that locks the subject row first -- the lock order every other auth
 * mutation uses -- then the deletion job. A second concurrent run therefore cannot interleave with the
 * first, and a failure part-way through leaves the account exactly as it was.
 *
 * The run is idempotent by construction rather than by a flag: every delete is a no-op once the rows
 * are gone, and both surviving writes carry a guard so a replay changes no column and no timestamp. A
 * job already in `completed` returns immediately without touching anything, which keeps a finished
 * job's `completed_at` stable.
 */
export function createAccountDeletionCleanupKernel(pool: Pool, clock: () => Date = () => new Date()) {
  return {
    async cleanupSubject(input: unknown): Promise<AccountDeletionCleanupResult> {
      const parsed = accountDeletionCleanupInputSchema.safeParse(input);
      if (!parsed.success) throw new AccountDeletionCleanupError('cleanup_invalid_request');
      const { subjectId, expectedDeletionId } = parsed.data;
      return transaction(pool, async client => {
        const now = clock();
        const subject = (await client.query<SubjectRow>(
          'SELECT id,kind,status,display_name FROM siyue.subjects WHERE id=$1 FOR UPDATE',
          [subjectId])).rows[0];
        if (!subject) throw new AccountDeletionCleanupError('cleanup_target_missing');
        if (subject.kind !== 'adult') throw new AccountDeletionCleanupError('cleanup_target_not_adult');
        // Only an accepted deletion is a target. `deleted` is accepted too, so a retry after a crash --
        // or after the Apple revocation finally settled -- can finish the same job.
        if (subject.status !== 'deletion_pending' && subject.status !== 'deleted')
          throw new AccountDeletionCleanupError('cleanup_target_not_pending');
        const job = (await client.query<JobRow>(
          `SELECT id,state,local_data_deleted,provider_revocation_pending,completed_at,last_error_code
             FROM siyue.account_deletion_jobs WHERE subject_id=$1 FOR UPDATE`,
          [subjectId])).rows[0];
        // No accepted job means no proof that a deletion was ever authorized: refuse instead of
        // cleaning an account nobody asked to delete.
        if (!job) throw new AccountDeletionCleanupError('cleanup_job_missing');
        if (expectedDeletionId !== undefined && job.id !== expectedDeletionId)
          throw new AccountDeletionCleanupError('cleanup_job_mismatch');
        if (job.state === 'completed') return {
          subjectId, deletionId: job.id, outcome: 'completed' as const,
          serverDataDeleted: job.local_data_deleted,
          providerRevocationPending: job.provider_revocation_pending,
          preservedAppleRevocations: 0, blockers: [], removed: noRemovals(),
        };

        const blockers = await inspectAccountDeletionBlockers(client, subjectId, now);
        // Ended history is decided by the layered rule, and it is only reported once no live dependency
        // remains: an operator then sees the next thing to resolve instead of a backlog that cannot be
        // acted on yet.
        if (blockers.length === 0)
          blockers.push(...await inspectAccountDeletionHistory(client, subjectId, now));

        // Decide the Apple dimension before anything is deleted: an unqueued credential both blocks the
        // run and forbids destroying the seal, and it is the queue's own bounded window -- not this pass
        // -- that decides whether the material can still revoke with Apple.
        const appleRows = (await client.query<AppleRow>(appleSql, [subjectId])).rows;
        // `removableIdentities` collects every link whose rows this pass drops: a confirmed revocation,
        // an unqueued link without a credential, and an unresolved revocation whose window has closed.
        // `duplicateSealIdentities` keeps its link and its queue row but gives up the identity's own
        // second copy of the seal, so one credential is never retained in two places.
        const removableIdentities: string[] = [];
        const duplicateSealIdentities: string[] = [];
        let preserved = 0, unconfirmed = false, confirmed = 0;
        let destroyedExpired = false, destroyedNeedsAttention = false;
        for (const row of appleRows) {
          const status = row.outbox_status;
          if (status === 'revoked') { confirmed += 1; removableIdentities.push(row.identity_id); continue; }
          if (status === null) {
            if (row.has_credential) {
              // Nobody can say whether Apple was told, so the seal is kept and the run stops.
              preserved += 1;
              blockers.push('apple_revocation_not_queued');
            } else {
              // The missing credential cannot be used to revoke Apple, and cannot prove that Apple
              // revoked the authorization. Delete the personal link while keeping the receipt's
              // provider dimension open for manual revocation guidance.
              unconfirmed = true;
              removableIdentities.push(row.identity_id);
            }
            continue;
          }
          // pending | sending | needs_attention | expired: Apple was not confirmed. The window decides
          // what may still be delivered, and expiry is never success.
          unconfirmed = true;
          const windowClosed = row.outbox_expires_at !== null && +row.outbox_expires_at <= +now;
          if (status === 'expired' || windowClosed) {
            if (status === 'needs_attention') destroyedNeedsAttention = true; else destroyedExpired = true;
            removableIdentities.push(row.identity_id);
            continue;
          }
          // Still inside the window: the queue row keeps the one seal that can still reach Apple, and the
          // identity's duplicate copy of that seal is destroyed instead of both copies being held.
          preserved += 1;
          if (row.has_credential) duplicateSealIdentities.push(row.identity_id);
        }
        // A confirmed revocation is the only evidence that clears the provider dimension: every link is
        // either revoked or never held a credential. Anything less keeps the job open, which is why an
        // expired, destroyed or purged attempt can never be read as success.
        const allConfirmed = appleRows.length > 0 && confirmed === appleRows.length;
        const providerRevocationPending = unconfirmed ||
          (job.provider_revocation_pending && !allConfirmed);
        // Only a pass that destroyed an unresolved revocation owes the job a code, and it is the bounded
        // code the revocation coordinator keeps once the identities are gone instead of reading that
        // absence as a provider success. A rejected `needs_attention` attempt is named before the plain
        // closed window, the same order the coordinator reports its blockers in.
        const retainedErrorCode = destroyedNeedsAttention ? appleRevocationProgressCodes.needsAttention
          : destroyedExpired ? appleRevocationProgressCodes.expired : null;

        // One code per reason, so two runs of the same state return the same list. A blocker stops the
        // whole run before any delete, so a closed-window seal is destroyed on the first pass that has no
        // dependency left to resolve; the scheduled re-run reaches that pass, so it is not final.
        const uniqueBlockers = [...new Set(blockers)];
        if (uniqueBlockers.length > 0) {
          await client.query(
            `UPDATE siyue.account_deletion_jobs
              SET state='needs_attention',local_data_deleted=false,completed_at=NULL,last_error_code=$2
              WHERE id=$1 AND (state<>'needs_attention' OR local_data_deleted
                OR completed_at IS NOT NULL OR last_error_code IS DISTINCT FROM $2)`,
            [job.id, uniqueBlockers[0]]);
          return accountDeletionCleanupResultSchema.parse({
            subjectId, deletionId: job.id, outcome: 'needs_attention',
            serverDataDeleted: false,
            providerRevocationPending: job.provider_revocation_pending,
            preservedAppleRevocations: preserved, blockers: uniqueBlockers, removed: noRemovals(),
          });
        }

        const removed = noRemovals();
        const del = async (sql: string, params: unknown[]): Promise<number> =>
          (await client.query(sql, params)).rowCount ?? 0;

        const sessions = (await client.query<{ id: string }>(
          'SELECT id FROM siyue.auth_sessions WHERE subject_id=$1', [subjectId])).rows.map(row => row.id);
        const addresses = (await client.query<{ email_normalized: string }>(
          'SELECT email_normalized FROM siyue.account_emails WHERE subject_id=$1', [subjectId]))
          .rows.map(row => row.email_normalized);
        // A historical challenge for this address may belong to an earlier account that used it.
        // Only subject/session-bound challenges and anonymous password resets for the currently
        // owned address are attributable here. Anonymous registration belongs to the applicant.
        const challenges = (await client.query<{ id: string }>(
          `SELECT id FROM siyue.email_challenges
            WHERE subject_id=$1 OR initiating_session_id = ANY($2::uuid[])
               OR (subject_id IS NULL AND purpose='password-reset'
                 AND email_normalized = ANY($3::text[]))`,
          [subjectId, sessions, addresses])).rows.map(row => row.id);

        // Queued mail still names the address and carries a live code. Cancelling it and destroying the
        // sealed payload is what actually removes the address from the outbox; a job already leased by
        // the mail worker is left to that worker rather than being cancelled underneath it.
        removed.mailJobs = (await client.query(
          `UPDATE siyue.outbox_jobs SET status='cancelled', payload_ciphertext=NULL, completed_at=$2
            WHERE status='pending' AND (aggregate_id=$1 OR aggregate_id = ANY($3::uuid[]))`,
          [subjectId, now, challenges])).rowCount ?? 0;

        // Delete order follows the foreign keys into the rows that are removed: everything pointing at a
        // session or a challenge goes before them, and the subject row itself is kept.
        removed.challenges = await del(
          'DELETE FROM siyue.email_challenges WHERE id = ANY($1::uuid[])', [challenges]);
        removed.refreshTokens = await del(
          'DELETE FROM siyue.refresh_tokens WHERE session_id = ANY($1::uuid[])', [sessions]);
        removed.reauthGrants = await del('DELETE FROM siyue.reauth_grants WHERE subject_id=$1', [subjectId]);
        removed.appleLoginFlows = await del(
          `DELETE FROM siyue.apple_login_flows f
            WHERE f.session_id = ANY($1::uuid[]) OR f.completed_session_id = ANY($1::uuid[])
              OR EXISTS (SELECT 1 FROM siyue.external_identities i WHERE i.subject_id=$2
                AND i.provider='apple' AND i.provider_subject=f.expected_subject
                AND i.client_id=f.client_id)`, [sessions, subjectId]);
        removed.roomSeats = await del('DELETE FROM siyue.room_seats WHERE subject_id=$1', [subjectId]);
        // The adult's own membership and create-request rows go before the historical pass, because the
        // pass may have to remove a dissolved family nobody else is attached to, and a family cannot be
        // deleted while those two rows still reference it. Nothing references either row, and the live
        // cases that would need them were rejected by the scan above, so moving them ahead of the pass
        // changes no foreign-key order.
        removed.familyCreateRequests = await del(
          'DELETE FROM siyue.family_create_requests WHERE subject_id=$1', [subjectId]);
        // Active memberships in a live family were rejected above. Once a transfer or member exit
        // deactivates the caller's row, no other member needs that stale subject-to-family link.
        removed.familyMemberships = await del(
          'DELETE FROM siyue.family_memberships WHERE subject_id=$1', [subjectId]);
        // Layer 1 removes the adult's own dead rows, layer 2 leaves another member's records alone, and
        // layer 3 clears the adult's link from an ended row that must outlive them. The pass is guarded
        // by the scan above, so it never rewrites a live row.
        removed.history = await cleanupAccountDeletionHistory(client, subjectId, now, addresses);
        removed.sessions = await del('DELETE FROM siyue.auth_sessions WHERE subject_id=$1', [subjectId]);
        removed.idempotencyRecords = await del(
          'DELETE FROM siyue.idempotency_records WHERE subject_id=$1', [subjectId]);
        removed.emails = await del('DELETE FROM siyue.account_emails WHERE subject_id=$1', [subjectId]);
        removed.passwordCredentials = await del(
          'DELETE FROM siyue.password_credentials WHERE subject_id=$1', [subjectId]);
        removed.accountConsents = await del(
          'DELETE FROM siyue.account_consents WHERE subject_id=$1', [subjectId]);

        // Both the credential and the queue row reference the identity, so they go before the identity
        // it belongs to. A queued revocation is dropped only as part of a confirmed or closed attempt,
        // never because deleting the identity happened to remove it.
        const credentialIds = [...removableIdentities, ...duplicateSealIdentities];
        if (credentialIds.length > 0) removed.appleCredentials = await del(
          'DELETE FROM siyue.apple_provider_credentials WHERE identity_id = ANY($1::uuid[])', [credentialIds]);
        if (removableIdentities.length > 0) {
          removed.appleRevocationJobs = await del(
            'DELETE FROM siyue.apple_revocation_outbox WHERE identity_id = ANY($1::uuid[])',
            [removableIdentities]);
          removed.appleIdentities = await del(
            'DELETE FROM siyue.external_identities WHERE id = ANY($1::uuid[]) AND subject_id=$2',
            [removableIdentities, subjectId]);
        }

        // Minimal tombstone: the row stays so every historical reference (a family the subject created,
        // a consent about a child, an audit event) keeps pointing at a real subject, the profile is
        // emptied (display name only -- the bounded locale carries no user text), and one more
        // credential version step makes any token that somehow survived unusable. The guard keeps a
        // replay from touching a single column or timestamp.
        await client.query(
          `UPDATE siyue.subjects SET status='deleted', display_name='', deleted_at=COALESCE(deleted_at,$2),
             credential_version=credential_version+1, updated_at=$2
            WHERE id=$1 AND (status<>'deleted' OR display_name<>'' OR deleted_at IS NULL)`,
          [subjectId, now]);

        const completed = !providerRevocationPending;
        // `completed_at` and `state` move together, which is exactly the pair the table's CHECK ties: a
        // half-finished job can never present itself as done. `last_error_code` is written only by a run
        // that has a code to keep -- a destroyed unresolved revocation -- and the guard repeats that
        // condition, so an idempotent replay still changes no column and no timestamp.
        await client.query(
          `UPDATE siyue.account_deletion_jobs
             SET state=$2, local_data_deleted=true, provider_revocation_pending=$3, completed_at=$4,
                 last_error_code=CASE WHEN $2='completed' THEN NULL
                   ELSE COALESCE($5::text, last_error_code) END
            WHERE id=$1 AND (state<>$2 OR NOT local_data_deleted
              OR provider_revocation_pending<>$3 OR completed_at IS DISTINCT FROM $4::timestamptz
              OR ($2='completed' AND last_error_code IS NOT NULL)
              OR ($5::text IS NOT NULL AND last_error_code IS DISTINCT FROM $5::text))`,
          [job.id, completed ? 'completed' : 'processing', providerRevocationPending,
            completed ? now : null, retainedErrorCode]);

        return accountDeletionCleanupResultSchema.parse({
          subjectId, deletionId: job.id, outcome: completed ? 'completed' : 'cleaned',
          serverDataDeleted: true, providerRevocationPending,
          preservedAppleRevocations: preserved, blockers: [], removed,
        });
      });
    },
  };
}
export type AccountDeletionCleanupKernel = ReturnType<typeof createAccountDeletionCleanupKernel>;
