import type { PoolClient } from 'pg';
import { z } from 'zod';

// Layered historical cleanup for account deletion, the rule the maintainer accepted on 2026-09-24
// (design draft option 2). It exists because the earlier kernel only had one blunt answer to ended
// family and room history: any row that still named the deleting adult stopped the run with
// `historical_family_data` and `serverDataDeleted=false`, even when the row was the adult's own dead
// material. That neither finished a deletion nor protected anybody.
//
// The accepted rule has three parts, and this module applies each one to the tables that carry the
// deleting adult's identity:
//
// 1. DELETE WHAT WAS ONLY EVER THE ADULT'S OWN. A pending invitation that can no longer be accepted,
//    an expired or consumed child-device pairing application, an inactive guardianship and its
//    withdrawn consent, and an ended room the adult opened with nobody else in it are the adult's own
//    dead material: they authorize nobody, hold no other member's work, and their subject links cannot
//    be kept without keeping the adult. Deleting them removes the link by removing the row.
// 2. KEEP WHAT BELONGS TO ANOTHER MEMBER. A family the adult once owned, a still-retained management
//    acceptance another adult signed, a room another member sat in, a child's own device history, and
//    the close-out history of a family are never deleted to finish someone else's deletion. A closed
//    freeze review (migrations 0022 and 0025) is kept whole for the same reason: another adult's
//    acceptance, the operator's reason and scope, and the closure's replay proof are not this adult's
//    material, and the bounded `family.review.resolve` security event is not a substitute for them.
// 3. REMOVE THE ADULT'S LINK FROM ENDED HISTORY WHEN THAT IS SAFE. A redaction is only ever performed
//    where it cannot damage another member's live authority, replay protection or the records the
//    audit trail needs. Three tables gained the narrowest schema support for it in migration 0024: an
//    accepted family invitation keeps its row and loses the deleted inviter or acceptor; a settled
//    device grant keeps the child's history and loses the guardian link, recording the instant it was
//    cleared; and a closed room invitation keeps its row and loses the deleted party. Migration 0026
//    does the same for the two rows of a closed freeze review that name the deleted adult and that this
//    login may write: a resolved marker and a settled acceptance keep their place and lose only that
//    adult's link. Where the record cannot be separated -- a closure this adult was the recipient of,
//    whose operator record keeps every column NOT NULL -- the case is reported instead.
//
// What is deliberately NOT done here:
//
// - NO RETENTION WINDOW IS INVENTED. The only time-bounded record in this file is
//   family_management_acceptances, and it is left alone until the row's own retain_until window has
//   passed. While it is still inside that stored window the run is reported as needs_attention,
//   because the row is another adult's declaration and Siyue has not decided how a deleting adult's
//   link is removed from it. Nothing here picks a new deadline.
// - NO SHARED OBJECT IS DISMANTLED. A dissolved family the adult still owns is reported rather than
//   rewritten: its member rows are other people's family history, and no reviewed process exists for
//   removing an owner link from it. An ended room the adult opened that another member used or was
//   admitted to, and a still-usable room invitation the adult is part of in another member's open
//   room, are reported the same way: the shared work is not separable on the server, so it waits for a
//   human decision. `rooms.created_by_subject_id` is NOT NULL, so such a room cannot be kept with the
//   adult's link cleared either -- it is this adult's own object and goes whole, or it is reported.
// - NO OTHER MEMBER'S LIVE STATE IS TOUCHED. Every redaction below is guarded so a live row cannot be
//   rewritten even if the caller's own scan was stale, and the surrounding kernel refuses the whole
//   run while any live dependency (an active membership, guardianship, child device grant, pending
//   invitation, pairing approval or open room) still exists.
//
// This module opens no route, no transaction of its own and no provider call: the kernel calls it
// inside the one transaction that already holds the subject and deletion-job locks.

/** Bounded, self-describing reasons this module refuses to finish a deletion on its own. They use the
 * same lowercase snake_case shape storage requires and are safe to show a client as a code. */
export const accountDeletionHistoryReasonSchema = z.enum([
  // A family the adult still owns that is no longer a live dependency but still holds member rows:
  // other people's family history cannot be rewritten or deleted to finish this deletion.
  'shared_family_history',
  // Shared room history that cannot be separated from the adult's identity: an ended room they opened
  // that another member used, or a still-usable invitation they are part of in another member's open
  // room.
  'inseparable_shared_work',
  // Another adult's management acceptance, still inside the retention window it was written with.
  'retained_management_acceptance',
  // A freeze review this deletion still owes for a family it froze.
  'pending_family_review',
  // A closed freeze review still names this adult in a record this pass may not clear. Migration 0025
  // made the operator's resolution unwritable for the API's own login and keeps the adult it was handed
  // to NOT NULL, so a closure the deleting adult was the recipient of cannot be separated; a live
  // acceptance naming them cannot be redacted either, because a redaction is only allowed on a closed
  // record. Both are reported instead of being removed.
  'retained_review_closure',
]);
export type AccountDeletionHistoryReason = z.infer<typeof accountDeletionHistoryReasonSchema>;

/** Row counts of the historical pass, so an operator can tell a first run from an idempotent replay
 * and can see which of the three parts acted. Every value counts rows this pass changed. */
export const accountDeletionHistoryRemovedSchema = z.object({
  invitationsDeleted: z.number().int().nonnegative(),
  invitationsRedacted: z.number().int().nonnegative(),
  invitationsClosed: z.number().int().nonnegative(),
  pairingRequests: z.number().int().nonnegative(),
  deviceGrants: z.number().int().nonnegative(),
  guardianships: z.number().int().nonnegative(),
  consents: z.number().int().nonnegative(),
  rooms: z.number().int().nonnegative(),
  roomInvitationsDeleted: z.number().int().nonnegative(),
  roomInvitationsRedacted: z.number().int().nonnegative(),
  reviews: z.number().int().nonnegative(),
  // A settled 0025 review acceptance whose deleted-owner link this pass cleared. The row, the other
  // adult's acceptance and the operator's closure record all stay; only this adult's id leaves them.
  reviewAcceptances: z.number().int().nonnegative(),
  acceptances: z.number().int().nonnegative(),
  // A dissolved family this adult still owned with nothing and nobody else attached to it.
  families: z.number().int().nonnegative(),
}).strict();
export type AccountDeletionHistoryRemoved = z.infer<typeof accountDeletionHistoryRemovedSchema>;

export const emptyAccountDeletionHistoryRemoved = (): AccountDeletionHistoryRemoved => ({
  invitationsDeleted: 0, invitationsRedacted: 0, invitationsClosed: 0, pairingRequests: 0,
  deviceGrants: 0, guardianships: 0, consents: 0, rooms: 0, roomInvitationsDeleted: 0,
  roomInvitationsRedacted: 0, reviews: 0, reviewAcceptances: 0, acceptances: 0, families: 0,
});

interface HistoryRow {
  shared_family: boolean; shared_work: boolean; live_room_authorization: boolean;
  retained_acceptance: boolean; pending_review: boolean; retained_review_closure: boolean;
}

// A dissolved family this adult still owns is this adult's own closed object only while nothing and
// nobody else is still attached to it: no other subject's membership or create request, and no
// invitation, guardianship, child pairing, device grant, room, earlier management acceptance or review
// record. Every table that carries a foreign key to `families` is named here, so a family cannot be
// judged empty while a row of one of those tables still points at it, and any one of them is another
// member's or another process's trace into the family: the family is reported and kept instead of being
// deleted out from under it. Two rows this pass is allowed to remove -- the adult's own membership and
// the adult's own create request -- are counted apart, because the kernel removes them itself and the
// teardown only runs after they are gone.
const ownEmptyDissolvedFamily = `f.owner_subject_id = $1 AND f.status = 'dissolved'
  AND NOT EXISTS(SELECT 1 FROM siyue.family_memberships m
    WHERE m.family_id = f.id AND m.subject_id <> $1)
  AND NOT EXISTS(SELECT 1 FROM siyue.family_create_requests c
    WHERE c.family_id = f.id AND c.subject_id <> $1)
  AND NOT EXISTS(SELECT 1 FROM siyue.family_invitations i WHERE i.family_id = f.id)
  AND NOT EXISTS(SELECT 1 FROM siyue.guardian_relationships g WHERE g.family_id = f.id)
  AND NOT EXISTS(SELECT 1 FROM siyue.device_pairing_requests p WHERE p.family_id = f.id)
  AND NOT EXISTS(SELECT 1 FROM siyue.device_grants d WHERE d.family_id = f.id)
  AND NOT EXISTS(SELECT 1 FROM siyue.rooms r WHERE r.family_id = f.id)
  AND NOT EXISTS(SELECT 1 FROM siyue.family_management_acceptances a WHERE a.family_id = f.id)
  AND NOT EXISTS(SELECT 1 FROM siyue.account_deletion_family_reviews v WHERE v.family_id = f.id)
  AND NOT EXISTS(SELECT 1 FROM siyue.family_review_acceptances x WHERE x.family_id = f.id)
  AND NOT EXISTS(SELECT 1 FROM siyue.family_review_resolutions y WHERE y.family_id = f.id)`;

// One row answers every residual question, so a run costs one round trip and cannot half-decide.
// `families_owned` and `family_membership` already refuse an active or frozen family, so the family
// question here is only about a family that no longer lives: its owner link cannot be cleared while
// other member rows still make it a shared record, and Siyue has no reviewed process for that.
//
// The room question is asked about a room this adult created and that already ended. `rooms`.
// `created_by_subject_id` is NOT NULL and names this adult, so such a room cannot be kept with the
// adult's link cleared -- it is either this adult's own object and goes whole, or another member is
// part of it and the whole room waits for a person. "Another member is part of it" is any other
// subject's seat, whatever its release state, and any invitation that is no longer pending: a closed
// invitation is a durable admission or authorization record between two members, and its parties are
// never both this adult. A still-pending invitation is temporary material this pass destroys anyway,
// so it does not make the room shared.
const historySql = `SELECT
    EXISTS(SELECT 1 FROM siyue.families f
      WHERE f.owner_subject_id = $1 AND f.status = 'dissolved'
        AND NOT (${ownEmptyDissolvedFamily})) AS shared_family,
    EXISTS(SELECT 1 FROM siyue.rooms r
      WHERE r.created_by_subject_id = $1 AND r.status = 'ended'
        AND (EXISTS(SELECT 1 FROM siyue.room_seats s WHERE s.room_id = r.id AND s.subject_id <> $1)
          OR EXISTS(SELECT 1 FROM siyue.room_invitations i
            WHERE i.room_id = r.id AND i.status <> 'pending'))) AS shared_work,
    EXISTS(SELECT 1 FROM siyue.room_invitations i JOIN siyue.rooms r ON r.id = i.room_id
      WHERE i.status = 'accepted' AND r.status = 'open'
        AND (i.inviter_subject_id = $1 OR i.invitee_subject_id = $1)) AS live_room_authorization,
    EXISTS(SELECT 1 FROM siyue.family_management_acceptances a
      WHERE (a.owner_subject_id = $1 OR a.recipient_subject_id = $1) AND a.retain_until > $2)
      AS retained_acceptance,
    EXISTS(SELECT 1 FROM siyue.account_deletion_family_reviews v
      WHERE v.deleting_subject_id = $1 AND v.state = 'pending') AS pending_review,
    (EXISTS(SELECT 1 FROM siyue.family_review_resolutions c
        WHERE c.recipient_subject_id = $1)
      OR EXISTS(SELECT 1 FROM siyue.family_review_acceptances a
        WHERE a.recipient_subject_id = $1
          OR (a.deleting_subject_id = $1 AND a.consumed_at IS NULL AND a.superseded_at IS NULL)))
      AS retained_review_closure`;

/**
 * The residual reasons one accepted deletion cannot finish on its own. Returns an empty list when the
 * layered rules can settle everything, in which case the kernel may run cleanupAccountDeletionHistory.
 * An empty list is not a claim that no history exists: it means every historical row was decided.
 */
export async function inspectAccountDeletionHistory(client: PoolClient, subjectId: string, now: Date,
): Promise<AccountDeletionHistoryReason[]> {
  const row = (await client.query<HistoryRow>(historySql, [subjectId, now])).rows[0];
  const found: AccountDeletionHistoryReason[] = [];
  if (!row) return found;
  if (row.shared_family) found.push('shared_family_history');
  // A still-usable invitation into another member's open room is as inseparable as a room the adult
  // opened that others used: the authorization reaches into shared state that is still live.
  if (row.shared_work || row.live_room_authorization) found.push('inseparable_shared_work');
  if (row.retained_acceptance) found.push('retained_management_acceptance');
  if (row.pending_review) found.push('pending_family_review');
  if (row.retained_review_closure) found.push('retained_review_closure');
  return found;
}

// An ended room the adult opened that nobody else ever used or was admitted to is the adult's own work
// object. The guard repeats the scan's own room question -- no other subject's seat and no invitation
// that is no longer pending -- and is restated inside every statement that touches the room, so a
// concurrent seat, acceptance or revocation cannot make this pass drop another member's record.
const ownUnsharedEndedRoom = `r.created_by_subject_id = $1 AND r.status = 'ended'
  AND NOT EXISTS(SELECT 1 FROM siyue.room_seats s WHERE s.room_id = r.id AND s.subject_id <> $1)
  AND NOT EXISTS(SELECT 1 FROM siyue.room_invitations i2
    WHERE i2.room_id = r.id AND i2.status <> 'pending')`;

/**
 * Applies the three accepted parts to one already-authorized deletion, inside the caller's transaction
 * and after the caller has satisfied itself that no live dependency or residual reason remains.
 *
 * `addresses` are the login addresses the subject still owned when the run began: an invitation another
 * member addressed to one of them can never be accepted again once the account is gone, so its sealed
 * material is destroyed and the address it was written with is cleared instead of being left as a way
 * back into a family for whoever holds the address next.
 *
 * Every statement is idempotent: a replay finds the rows already gone or already redacted and changes
 * nothing, so no counter here can grow on a second pass.
 */
export async function cleanupAccountDeletionHistory(client: PoolClient, subjectId: string, now: Date,
  addresses: readonly string[],): Promise<AccountDeletionHistoryRemoved> {
  const removed = emptyAccountDeletionHistoryRemoved();
  const run = async (sql: string, params: unknown[]): Promise<number> =>
    (await client.query(sql, params)).rowCount ?? 0;

  // Part 1a. An invitation another member addressed to a login address this account owned is dead the
  // moment the account is: nobody can accept it as this person any more, and a later holder of the same
  // address must not inherit a way into that family. The row stays as the issuer's history, with its
  // recoverable response destroyed, its status closed and the address removed. The address is cleared
  // on *every* row the address can still be read from, whatever its status: an invitation that already
  // expired or was revoked, and whose sealed response was already destroyed, still stores the deleted
  // adult's address, and a narrower condition here would leave exactly that residue behind while the
  // run reported the address gone. Nothing live is touched: a row this clears is never `accepted`, so
  // it authorizes nobody.
  if (addresses.length > 0) removed.invitationsClosed = await run(
    `UPDATE siyue.family_invitations
        SET status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END,
            token_ciphertext = NULL, token_ciphertext_expires_at = NULL, intended_email = NULL
      WHERE status <> 'accepted' AND inviter_id IS DISTINCT FROM $1
        AND intended_email = ANY($2::text[])`, [subjectId, addresses]);

  // Part 1b. An invitation this adult issued that nobody can accept any more: it expired on its own
  // deadline, it was revoked (by the family disposition or by the adult), or it is still marked pending
  // past its deadline. A live pending invitation is a dependency the kernel refuses to run with.
  removed.invitationsDeleted = await run(
    `DELETE FROM siyue.family_invitations
      WHERE inviter_id = $1
        AND (status IN ('expired','revoked') OR (status = 'pending' AND expires_at <= $2))`,
    [subjectId, now]);

  // Part 3a. An accepted invitation is the family's record of how a member was admitted. The row stays
  // and the deleting adult's side of it goes. Clearing the address is only done for the side that
  // accepted, because acceptance is what proved that address belonged to them.
  removed.invitationsRedacted = await run(
    `UPDATE siyue.family_invitations
        SET inviter_id = CASE WHEN inviter_id = $1 THEN NULL ELSE inviter_id END,
            accepted_by = CASE WHEN accepted_by = $1 THEN NULL ELSE accepted_by END,
            intended_email = CASE WHEN accepted_by = $1 THEN NULL ELSE intended_email END
      WHERE status = 'accepted' AND (inviter_id = $1 OR accepted_by = $1)`, [subjectId]);

  // Part 1c. A pairing application is bounded temporary material (five minutes by CHECK) and never a
  // capability: the child's durable authorization is the device grant below. A consumed application,
  // an expired one, and one whose own window closed while still marked approved are all dead.
  removed.pairingRequests = await run(
    `DELETE FROM siyue.device_pairing_requests
      WHERE approved_by = $1
        AND (status IN ('consumed','expired') OR (status = 'approved' AND expires_at <= $2))`,
    [subjectId, now]);

  // Part 3b. A settled grant is the child's own device history and must outlive the guardian's
  // account: the row keeps its place and loses the link to the deleting adult, stamped with the instant
  // it was cleared so the row still says why its approver is missing. A live grant is a dependency the
  // kernel refuses to run with; an expired-but-unrevoked grant is settled by its own deadline, and this
  // pass revokes it explicitly instead of leaving an anonymous row that a later `expires_at` write
  // could make live again. Migration 0024 refuses such an anonymous grant outright; revoking here is
  // what lets the redaction satisfy that check. `GREATEST` keeps the stamped instant from landing before
  // the row's own `created_at` when the caller's clock and the database clock disagree by a moment.
  removed.deviceGrants = await run(
    `UPDATE siyue.device_grants
        SET guardian_id = NULL, guardian_redacted_at = $2,
            revoked_at = COALESCE(revoked_at, GREATEST($2, created_at))
      WHERE guardian_id = $1 AND (revoked_at IS NOT NULL OR expires_at <= $2)`,
    [subjectId, now]);

  // Part 1d. An inactive guardianship is an ended relationship between this adult and a child, and its
  // primary key *is* the guardian link, so it cannot be redacted without restructuring the table. The
  // audit trail for the change lives in security_events, which this kernel keeps, so removing the row
  // removes the adult's link to the child without removing any live guardianship, membership or device
  // grant. An active guardianship is a dependency the kernel refuses to run with.
  removed.guardianships = await run(
    `DELETE FROM siyue.guardian_relationships WHERE guardian_subject_id = $1 AND NOT active`,
    [subjectId]);

  // Part 1e. A consent record is kept for as long as any retained relationship still cites it. After
  // the inactive relationships above are gone, a consent this adult recorded is removable only when
  // nothing else points at it: an active relationship (already refused by the kernel) or another
  // guardian's own row would keep it, because that row is somebody else's record.
  removed.consents = await run(
    `DELETE FROM siyue.consent_records c
      WHERE c.actor_subject_id = $1
        AND NOT EXISTS(SELECT 1 FROM siyue.guardian_relationships r
          WHERE r.consent_record_id = c.id AND (r.active OR r.guardian_subject_id <> $1))`,
    [subjectId]);

  // Part 1f. An ended room this adult opened that nobody else ever used or was admitted to is their own
  // work object, so it and its now-pointless rows go. The seats belong to this adult's sessions (the
  // guard refuses any other subject's seat) and the kernel removes them together with every other seat
  // of this subject before it removes the sessions they reference.
  removed.roomInvitationsDeleted += await run(
    `DELETE FROM siyue.room_invitations i USING siyue.rooms r
      WHERE i.room_id = r.id AND ${ownUnsharedEndedRoom}`, [subjectId]);
  await run(`DELETE FROM siyue.room_seats s USING siyue.rooms r
      WHERE s.room_id = r.id AND ${ownUnsharedEndedRoom}`, [subjectId]);
  removed.rooms = await run(`DELETE FROM siyue.rooms r WHERE ${ownUnsharedEndedRoom}`, [subjectId]);

  // Part 1g. A still-pending room invitation is one authorization between two members that can never
  // be exercised once either account is deleted: acceptance re-reads the inviter's own active adult
  // membership and the invitee's own active membership. It is temporary material, so it goes.
  removed.roomInvitationsDeleted += await run(
    `DELETE FROM siyue.room_invitations
      WHERE status = 'pending' AND (inviter_subject_id = $1 OR invitee_subject_id = $1)`,
    [subjectId]);

  // Part 3c. A closed invitation into another member's *ended* room is history that belongs to both
  // members, so the row stays and the deleting adult's side of it is cleared. A closed invitation into
  // a room that is still open is reported by the scan instead of being rewritten, because that room's
  // shared state is still live, and a room this adult created is left entirely to the scan: clearing
  // its invitation here would keep the row while the room's own NOT NULL creator link still named the
  // deleted adult, which is a partial redaction this pass must never leave behind.
  removed.roomInvitationsRedacted = await run(
    `UPDATE siyue.room_invitations i
        SET inviter_subject_id = CASE WHEN i.inviter_subject_id = $1 THEN NULL ELSE i.inviter_subject_id END,
            invitee_subject_id = CASE WHEN i.invitee_subject_id = $1 THEN NULL ELSE i.invitee_subject_id END
      FROM siyue.rooms r
      WHERE i.room_id = r.id AND r.status = 'ended' AND r.created_by_subject_id <> $1
        AND i.status <> 'pending'
        AND (i.inviter_subject_id = $1 OR i.invitee_subject_id = $1)`, [subjectId]);

  // Part 3d. A closed freeze review is kept whole -- the 0022 marker and the resolution that closed it,
  // and the 0025 acceptance another adult signed, with the family, membership and child-scope versions
  // the handover was made against, the operator's reason, shared-work result and idempotency proof. None
  // of that is this adult's to take, and migration 0025 makes the resolution unwritable for this login
  // anyway. Only the deleted adult's own link leaves: the marker's `deleting_subject_id` once the
  // review is `resolved`, and the acceptance's `deleting_subject_id` once the declaration is settled
  // (`consumed` or `superseded`). Migration 0026 adds those two nullable links with a stamp and refuses
  // any redaction on a record that is not already closed, so a live review can never be blinded here.
  // A closure this adult was the *recipient* of, and a live acceptance naming them, cannot be separated
  // this way: the scan has already reported `retained_review_closure` and this pass never runs.
  removed.reviewAcceptances = await run(
    `UPDATE siyue.family_review_acceptances
        SET deleting_subject_id = NULL, deleting_redacted_at = $2
      WHERE deleting_subject_id = $1 AND (consumed_at IS NOT NULL OR superseded_at IS NOT NULL)`,
    [subjectId, now]);
  removed.reviews = await run(
    `UPDATE siyue.account_deletion_family_reviews
        SET deleting_subject_id = NULL, deleting_redacted_at = $2
      WHERE deleting_subject_id = $1 AND state = 'resolved'`, [subjectId, now]);

  // Part 1i. A management acceptance another adult signed is kept for exactly the window it was
  // written with. Once that window has passed the row has no more purpose than any other expired
  // declaration, so it goes; while it is still inside the window the scan reports it instead of this
  // pass shortening somebody else's retention.
  removed.acceptances = await run(
    `DELETE FROM siyue.family_management_acceptances
      WHERE (owner_subject_id = $1 OR recipient_subject_id = $1) AND retain_until <= $2`,
    [subjectId, now]);

  // Part 1j. A dissolved family this adult still owned with nothing and nobody else attached to it is
  // the adult's own closed object: no other member row or create request, and no invitation,
  // guardianship, child pairing, device grant, room, management acceptance or review record ever
  // attached to it. Its owner link is NOT NULL, so the family cannot be kept with the adult's link
  // cleared -- it goes whole, exactly as the kernel's own empty-family step does for a live one. Any
  // one of those rows means somebody or some process is still part of the family, and then the scan has
  // already reported `shared_family_history` and this pass never runs. The adult's own membership and
  // create request for the family were removed by the kernel before this call, which is what leaves
  // the family with no remaining reference.
  removed.families = await run(
    `DELETE FROM siyue.families f WHERE ${ownEmptyDissolvedFamily}`, [subjectId]);

  return accountDeletionHistoryRemovedSchema.parse(removed);
}
