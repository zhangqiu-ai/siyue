import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';

/**
 * Internal family-room invitation repository for the confirmed C11 room rule (design 16.5, spec
 * VWC-02, acceptance V03): only a parent opens a family room and invites an existing family member,
 * children may accept, and no public room code exists. It persists the invitation a join decision is
 * re-checked against, so a durable grant is never a client-held code, a replayed request body or a
 * role the client names.
 *
 * Non-public diagnostics for an internal caller. A refusal never carries an HTTP status: this module
 * is not an entry point, and deciding the wire response stays with the authorized caller.
 */
export type RoomInvitationFailure =
  | 'ROOM_INVITATION_INVALID_REQUEST'
  | 'ROOM_INVITATION_ROOM_NOT_FOUND'
  | 'ROOM_INVITATION_FAMILY_INACTIVE'
  | 'ROOM_INVITATION_ROOM_ENDED'
  | 'ROOM_INVITATION_SESSION_INVALID'
  | 'ROOM_INVITATION_PARENT_AUTHORITY_UNRESOLVED'
  | 'ROOM_INVITATION_INVITER_INELIGIBLE'
  | 'ROOM_INVITATION_INVITEE_INELIGIBLE'
  | 'ROOM_INVITATION_INVITEE_NOT_GUARDED'
  | 'ROOM_INVITATION_SELF_INVITE'
  | 'ROOM_INVITATION_NOT_FOUND'
  | 'ROOM_INVITATION_EXPIRED'
  | 'ROOM_INVITATION_REVOKED'
  | 'ROOM_INVITATION_NOT_ACCEPTED'
  | 'ROOM_INVITATION_ALREADY_ACCEPTED'
  | 'ROOM_INVITATION_NOT_INVITER'
  | 'ROOM_INVITATION_STALE'
  | 'ROOM_INVITATION_CONFLICT';

export class RoomInvitationError extends Error {
  constructor(readonly code: RoomInvitationFailure) { super(code); }
}
function refuse(code: RoomInvitationFailure): never { throw new RoomInvitationError(code); }

const idSchema = z.uuid();
/**
 * The only identity an invitation call accepts. There is deliberately no `role`, `subjectKind`,
 * `isParent`, `guardian`, `deviceId` or `status` field: an inviter and an acceptor are one server-side
 * auth session each, so a client-reported role or parent flag can neither issue nor use an invitation.
 */
const sessionSchema = z.object({ sessionId: idSchema, subjectId: idSchema }).strict();
const createInputSchema = z.object({
  roomId: idSchema, inviteeSubjectId: idSchema, inviter: sessionSchema,
  parentAuthority: z.enum(['verified', 'unresolved']), expiresAt: z.date(),
}).strict();
const acceptInputSchema = z.object({ roomId: idSchema, invitee: sessionSchema }).strict();
const revokeInputSchema = z.object({ roomId: idSchema, inviteeSubjectId: idSchema, actor: sessionSchema }).strict();
const joinInputSchema = z.object({ roomId: idSchema, participant: sessionSchema }).strict();

/**
 * The caller's already-decided C11 parent verdict. This module verifies every fact a database can
 * prove - the caller's own server-issued session, an active adult membership of the room's family, an
 * active member invitee and, for a child invitee, the recorded guardianship - but it refuses to
 * *derive* the verdict from a family role, because no confirmed mapping says owner or admin is a
 * parent. `unresolved` is refused here, so a caller that cannot decide the C11 rule cannot issue an
 * invitation.
 *
 * This is a server-side authorization input and never request data. Only a trusted layer that has
 * already applied the confirmed C11 rule - for example by reading a live guardianship of the child it
 * is inviting - may construct `'verified'`. An HTTP adapter must never forward a client-supplied
 * field, header, query value or `isParent`-style flag into this parameter, and must not treat the
 * caller's own role or membership kind as the verdict; if it cannot decide the rule itself, it passes
 * `'unresolved'` and the invitation is refused. The strict input shape rejects unknown keys, so a role,
 * kind, device, session or status cannot ride along with the verdict either.
 */
export type RoomInvitationParentAuthority = 'verified' | 'unresolved';
export type RoomInvitationStatus = 'pending' | 'accepted' | 'revoked';
/** The verified session an invitation call is made for. Never built from a request body. */
export interface RoomInvitationSession { sessionId: string; subjectId: string; }

export interface RoomInvitationRoomRow {
  id: string; family_id: string; created_by_subject_id: string; status: 'open' | 'ended';
  version: number; created_at: Date; ended_at: Date | null;
}
export interface RoomInvitationRow {
  id: string; room_id: string; inviter_subject_id: string; invitee_subject_id: string;
  status: RoomInvitationStatus; inviter_membership_version: number; invitee_membership_version: number;
  family_version: number;
  expires_at: Date; accepted_at: Date | null; revoked_at: Date | null; created_at: Date;
}
export interface RoomInvitationCreateInput {
  roomId: string; inviteeSubjectId: string; inviter: RoomInvitationSession;
  parentAuthority: RoomInvitationParentAuthority; expiresAt: Date;
}
export interface RoomInvitationAcceptInput { roomId: string; invitee: RoomInvitationSession; }
export interface RoomInvitationRevokeInput {
  roomId: string; inviteeSubjectId: string; actor: RoomInvitationSession;
}
export interface RoomInvitationJoinInput { roomId: string; participant: RoomInvitationSession; }
/** The room and invitation a caller acts on next. The room is locked until the caller's own commit. */
export interface RoomInvitationDecision { room: RoomInvitationRoomRow; invitation: RoomInvitationRow; }
/**
 * The verdict of one join: the accepted invitation and the room it belongs to, and nothing else. It is
 * not a seat, not a credential and not a write - a refusal throws instead of returning a false verdict.
 */
export type RoomInvitationJoinAuthorization = RoomInvitationDecision;

interface FamilyRow { id: string; status: string; version: number; }
interface MemberRow {
  family_id: string; subject_id: string; role: string; active: boolean; membership_version: number;
  kind: string; subject_status: string;
}

const roomColumns = 'r.id, r.family_id, r.created_by_subject_id, r.status, r.version, r.created_at, r.ended_at';
const invitationColumns = `i.id, i.room_id, i.inviter_subject_id, i.invitee_subject_id, i.status,
  i.inviter_membership_version, i.invitee_membership_version, i.family_version,
  i.expires_at, i.accepted_at, i.revoked_at, i.created_at`;
/**
 * The invitation is only ever issued to, or accepted for, a session the server itself issued: the row
 * must exist for that subject, the subject must be active, the session must not be revoked, its
 * credential version must be the subject's current one and none of the session kernel's own deadlines
 * may have passed. Validity is read from the database clock rather than a caller-supplied timestamp, so
 * a stale call time cannot revive an expired session. Deeper child checks - device grant, guardian
 * relationship, family state - stay with the session kernel's `verifyForMutation`, which the caller
 * runs first; an invitation is not a credential and authenticates nothing on its own.
 */
const liveSession = `SELECT s.id FROM siyue.auth_sessions s JOIN siyue.subjects p ON p.id = s.subject_id
  WHERE s.id = $1 AND s.subject_id = $2 AND s.revoked_at IS NULL AND p.status = 'active'
    AND s.credential_version = p.credential_version AND s.idle_expires_at > clock_timestamp()
    AND s.absolute_expires_at > clock_timestamp()
    AND (s.grant_expires_at IS NULL OR s.grant_expires_at > clock_timestamp())`;
/** Membership of one subject in one family, with the subject's own kind and status, locked for update. */
const memberOf = `SELECT m.family_id, m.subject_id, m.role, m.active, m.version AS membership_version, p.kind,
    p.status AS subject_status
  FROM siyue.family_memberships m JOIN siyue.subjects p ON p.id = m.subject_id
  WHERE m.family_id = $1 AND m.subject_id = $2 FOR UPDATE OF m`;
/**
 * The only confirmed parent mapping a child invitee has: the inviter's own active guardianship, backed
 * by the consent that authorized it. A family role is never part of this test, so an owner or admin who
 * is not the child's recorded guardian cannot invite that child, and a withdrawn consent hides the
 * relationship exactly as it does for every guardianship read.
 */
const liveGuardianship = `SELECT 1 FROM siyue.guardian_relationships r
    JOIN siyue.consent_records c ON c.id = r.consent_record_id
      AND c.actor_subject_id = r.guardian_subject_id AND c.subject_id = r.child_subject_id
      AND c.purpose = 'child-guardianship' AND c.withdrawn_at IS NULL
  WHERE r.family_id = $1 AND r.guardian_subject_id = $2 AND r.child_subject_id = $3 AND r.active`;

/** Read-only room lookup. No lock: writers take the family and then the room lock. */
async function readRoom(client: PoolClient, roomId: string): Promise<RoomInvitationRoomRow | undefined> {
  return (await client.query<RoomInvitationRoomRow>(`SELECT ${roomColumns} FROM siyue.rooms r WHERE r.id = $1`, [roomId])).rows[0];
}
/**
 * Lock the family, then the room. The order matches the seat kernel and account deletion's freeze, so a
 * family that freezes or dissolves under a live invitation cannot be read as usable by a later step of
 * the same transaction. No external call is made while locks are held.
 */
async function lockFamily(client: PoolClient, familyId: string): Promise<FamilyRow | undefined> {
  return (await client.query<FamilyRow>('SELECT id, status, version FROM siyue.families WHERE id = $1 FOR UPDATE', [familyId])).rows[0];
}
async function lockRoom(client: PoolClient, roomId: string): Promise<RoomInvitationRoomRow | undefined> {
  return (await client.query<RoomInvitationRoomRow>(`SELECT ${roomColumns} FROM siyue.rooms r WHERE r.id = $1 FOR UPDATE`, [roomId])).rows[0];
}
/** The single invitation of one room and member. The row lock serialises create, accept and revoke. */
async function lockInvitation(client: PoolClient, roomId: string, inviteeSubjectId: string): Promise<RoomInvitationRow | undefined> {
  return (await client.query<RoomInvitationRow>(`SELECT ${invitationColumns} FROM siyue.room_invitations i
    WHERE i.room_id = $1 AND i.invitee_subject_id = $2 FOR UPDATE`, [roomId, inviteeSubjectId])).rows[0];
}
/** The server-side half of an identity claim: a session row the caller's `verifyForMutation` also saw. */
async function requireLiveSession(client: PoolClient, session: RoomInvitationSession): Promise<void> {
  if (!(await client.query(liveSession, [session.sessionId, session.subjectId])).rows[0])
    refuse('ROOM_INVITATION_SESSION_INVALID');
}
/** A caller clock may move ahead for testing or stricter expiry, but can never move time behind the
 * database and revive an invitation that has already expired. `clock_timestamp` is wall time rather
 * than the transaction-start time returned by `now()` during a long-running transaction. */
async function effectiveTime(client: PoolClient, callerNow: Date): Promise<Date> {
  if (!(callerNow instanceof Date) || !Number.isFinite(+callerNow))
    refuse('ROOM_INVITATION_INVALID_REQUEST');
  const row = (await client.query<{ current_time: Date }>(
    'SELECT clock_timestamp() AS current_time')).rows[0];
  if (!row || !Number.isFinite(+row.current_time)) refuse('ROOM_INVITATION_INVALID_REQUEST');
  return new Date(Math.max(+callerNow, +row.current_time));
}
const isActiveMember = (member: MemberRow | undefined): member is MemberRow =>
  Boolean(member && member.active && member.subject_status === 'active');

/**
 * Re-prove everything one stored invitation's reach depends on, for the member it names: the invitee is
 * still an active member, the invitation is not revoked, its deadline has not passed, the inviter still
 * holds the membership version it issued, the family still carries the version the invitation was
 * pinned to. Acceptance and the join verdict share this check, so an authorization can never be granted
 * off state that acceptance would refuse, and a refusal here writes nothing. The caller must already
 * have locked the family and the room.
 */
async function requireUsableInvitation(client: PoolClient, invitation: RoomInvitationRow, family: FamilyRow,
  inviteeSubjectId: string, now: Date): Promise<void> {
  const member = (await client.query<MemberRow>(memberOf, [family.id, inviteeSubjectId])).rows[0];
  // The invited member must still be in the family: leaving, being removed or being blocked ends the
  // invitation's reach even though the row itself stays readable as history.
  if (!isActiveMember(member) || (member.kind !== 'adult' && member.kind !== 'child'))
    refuse('ROOM_INVITATION_INVITEE_INELIGIBLE');
  if (member.membership_version !== invitation.invitee_membership_version)
    refuse('ROOM_INVITATION_STALE');
  if (invitation.status === 'revoked') refuse('ROOM_INVITATION_REVOKED');
  if (+invitation.expires_at <= +now) refuse('ROOM_INVITATION_EXPIRED');
  // The inviter's authority is re-read before any state change or verdict, so a withdrawn, replaced or
  // deactivated inviter cannot keep a live invitation alive, and a later family change invalidates the
  // pinned state instead of silently extending it.
  const inviterMember = (await client.query<MemberRow>(memberOf, [family.id, invitation.inviter_subject_id])).rows[0];
  if (!isActiveMember(inviterMember) || inviterMember.kind !== 'adult' ||
      inviterMember.membership_version !== invitation.inviter_membership_version)
    refuse('ROOM_INVITATION_INVITER_INELIGIBLE');
  // A second guardian may keep the child's device session valid after this inviter's own consent is
  // withdrawn. The original invitation must not outlive the relationship that authorized it.
  if (member.kind === 'child' &&
      !(await client.query(liveGuardianship, [family.id, invitation.inviter_subject_id, inviteeSubjectId])).rows[0])
    refuse('ROOM_INVITATION_INVITEE_NOT_GUARDED');
  if (family.version !== invitation.family_version) refuse('ROOM_INVITATION_STALE');
}

/**
 * Issue one invitation for one existing family member of an open room. The inviter is the subject of a
 * session the server issued and a current active adult member of the room's own family; no role grants
 * the parent verdict, which the caller must have decided and which `unresolved` refuses. The invitee
 * must already be an active member of that family and may be a child - the adult-only family invitation
 * path is deliberately not reused - while a child invitee additionally requires the inviter's recorded
 * guardianship. A repeated call for the same room, member and inviter returns the existing invitation
 * without writing, and the unique (room, invitee) index makes a concurrent duplicate impossible.
 */
async function createInvitation(client: PoolClient, rawInput: RoomInvitationCreateInput, now: Date): Promise<RoomInvitationDecision> {
  const parsed = createInputSchema.safeParse(rawInput);
  if (!parsed.success) refuse('ROOM_INVITATION_INVALID_REQUEST');
  const { roomId, inviteeSubjectId, inviter, parentAuthority, expiresAt } = parsed.data;
  // Fail closed on the unconfirmed parent mapping instead of inferring it from owner/admin membership.
  if (parentAuthority !== 'verified') refuse('ROOM_INVITATION_PARENT_AUTHORITY_UNRESOLVED');
  if (inviteeSubjectId === inviter.subjectId) refuse('ROOM_INVITATION_SELF_INVITE');
  await requireLiveSession(client, inviter);
  const room = await readRoom(client, roomId);
  if (!room) refuse('ROOM_INVITATION_ROOM_NOT_FOUND');
  const family = await lockFamily(client, room.family_id);
  if (!family || family.status !== 'active') refuse('ROOM_INVITATION_FAMILY_INACTIVE');
  const held = await lockRoom(client, roomId);
  if (!held) refuse('ROOM_INVITATION_ROOM_NOT_FOUND');
  if (held.status !== 'open') refuse('ROOM_INVITATION_ROOM_ENDED');
  const inviterMember = (await client.query<MemberRow>(memberOf, [family.id, inviter.subjectId])).rows[0];
  if (!isActiveMember(inviterMember) || inviterMember.kind !== 'adult') refuse('ROOM_INVITATION_INVITER_INELIGIBLE');
  const inviteeMember = (await client.query<MemberRow>(memberOf, [family.id, inviteeSubjectId])).rows[0];
  if (!isActiveMember(inviteeMember) || (inviteeMember.kind !== 'adult' && inviteeMember.kind !== 'child'))
    refuse('ROOM_INVITATION_INVITEE_INELIGIBLE');
  if (inviteeMember.kind === 'child' &&
      !(await client.query(liveGuardianship, [family.id, inviter.subjectId, inviteeSubjectId])).rows[0])
    refuse('ROOM_INVITATION_INVITEE_NOT_GUARDED');
  const existing = await lockInvitation(client, roomId, inviteeSubjectId);
  // Read the database clock after contended family, room and invitation locks, so a request that
  // waited past its deadline cannot rely on a time sampled before the wait.
  const checkedNow = await effectiveTime(client, now);
  if (!Number.isFinite(+expiresAt) || +expiresAt <= +checkedNow)
    refuse('ROOM_INVITATION_INVALID_REQUEST');
  if (existing) {
    // Only the inviter that issued the row may read it back; another adult's invitation is not disclosed.
    if (existing.inviter_subject_id !== inviter.subjectId) refuse('ROOM_INVITATION_CONFLICT');
    if (existing.status === 'revoked') refuse('ROOM_INVITATION_REVOKED');
    if (existing.status === 'accepted') refuse('ROOM_INVITATION_ALREADY_ACCEPTED');
    if (+existing.expires_at <= +checkedNow) refuse('ROOM_INVITATION_EXPIRED');
    // A replay returns the durable invitation only while it is still usable: a membership or family
    // version that moved since it was issued is reported as stale instead of handing back a row that
    // acceptance would refuse anyway.
    if (inviterMember.membership_version !== existing.inviter_membership_version ||
        inviteeMember.membership_version !== existing.invitee_membership_version ||
        family.version !== existing.family_version)
      refuse('ROOM_INVITATION_STALE');
    return { room: held, invitation: existing };
  }
  // `ON CONFLICT DO NOTHING` keeps the transaction usable if a caller reaches this primitive without the
  // room lock: an aborted transaction could not re-read, and a raw constraint error could not be told
  // apart from a deliberate duplicate.
  const inserted = (await client.query<RoomInvitationRow>(`INSERT INTO siyue.room_invitations AS i(
      id, room_id, inviter_subject_id, invitee_subject_id, status,
      inviter_membership_version, invitee_membership_version, family_version, expires_at, created_at)
    VALUES($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING ${invitationColumns}`,
  [randomUUID(), roomId, inviter.subjectId, inviteeSubjectId,
    inviterMember.membership_version, inviteeMember.membership_version, family.version, expiresAt, checkedNow])).rows[0];
  // Nothing was inserted: another transaction took the (room, invitee) row first, so this one must
  // re-read or refuse instead of overwriting the invitation that already exists.
  return inserted ? { room: held, invitation: inserted } : refuse('ROOM_INVITATION_CONFLICT');
}

/**
 * Accept one invitation with the invited member's own verified session. Every condition is re-proved
 * here instead of being trusted from the invitation's creation time: the family is active, the room is
 * still open, the invitee is still an active member, the deadline has not passed, and the inviter still
 * holds the membership version and the family still carries the version the invitation was issued
 * under. Acceptance by the same member again is idempotent and returns the same accepted row, so a
 * reconnect or a second device never rewrites the evidence, and a revoked, expired, ended, frozen or
 * exited state refuses the old invitation without touching the row.
 */
async function acceptInvitation(client: PoolClient, rawInput: RoomInvitationAcceptInput, now: Date): Promise<RoomInvitationDecision> {
  const parsed = acceptInputSchema.safeParse(rawInput);
  if (!parsed.success) refuse('ROOM_INVITATION_INVALID_REQUEST');
  const { roomId, invitee } = parsed.data;
  await requireLiveSession(client, invitee);
  const room = await readRoom(client, roomId);
  if (!room) refuse('ROOM_INVITATION_ROOM_NOT_FOUND');
  const family = await lockFamily(client, room.family_id);
  if (!family || family.status !== 'active') refuse('ROOM_INVITATION_FAMILY_INACTIVE');
  const held = await lockRoom(client, roomId);
  if (!held) refuse('ROOM_INVITATION_ROOM_NOT_FOUND');
  if (held.status !== 'open') refuse('ROOM_INVITATION_ROOM_ENDED');
  // No row for this room and member covers an uninvited caller and a member of another family alike: an
  // invitation is only ever written for an existing member of the room's own family.
  const invitation = await lockInvitation(client, roomId, invitee.subjectId);
  if (!invitation) refuse('ROOM_INVITATION_NOT_FOUND');
  const checkedNow = await effectiveTime(client, now);
  await requireUsableInvitation(client, invitation, family, invitee.subjectId, checkedNow);
  if (invitation.status === 'accepted') return { room: held, invitation };
  const accepted = (await client.query<RoomInvitationRow>(`UPDATE siyue.room_invitations i
    SET status = 'accepted', accepted_at = GREATEST($3::timestamptz, i.created_at)
    WHERE i.room_id = $1 AND i.invitee_subject_id = $2 AND i.status = 'pending' RETURNING ${invitationColumns}`,
  [roomId, invitee.subjectId, checkedNow])).rows[0];
  // Only reachable without the room lock; an already accepted row was returned above instead of rewritten.
  return accepted ? { room: held, invitation: accepted } : refuse('ROOM_INVITATION_CONFLICT');
}

/**
 * Close a pending invitation before anyone accepted it. Only the verified session that issued the
 * invitation may revoke it: no role, guardian flag or caller-supplied authority is accepted here, so a
 * refusal never closes another adult's invitation on the caller's word. Revoking twice is idempotent,
 * and revoking an accepted invitation is refused because removing an already joined member is a
 * separate owner decision (O01) that this slice does not invent.
 */
async function revokeInvitation(client: PoolClient, rawInput: RoomInvitationRevokeInput, now: Date): Promise<RoomInvitationDecision> {
  const parsed = revokeInputSchema.safeParse(rawInput);
  if (!parsed.success) refuse('ROOM_INVITATION_INVALID_REQUEST');
  const { roomId, inviteeSubjectId, actor } = parsed.data;
  await requireLiveSession(client, actor);
  const room = await readRoom(client, roomId);
  if (!room) refuse('ROOM_INVITATION_ROOM_NOT_FOUND');
  // The family lock is taken first even though revocation may not need its state, so the family -> room
  // order cannot invert against a freeze that is ending this room in the same instant.
  await lockFamily(client, room.family_id);
  const held = await lockRoom(client, roomId);
  if (!held) refuse('ROOM_INVITATION_ROOM_NOT_FOUND');
  const invitation = await lockInvitation(client, roomId, inviteeSubjectId);
  if (!invitation) refuse('ROOM_INVITATION_NOT_FOUND');
  const checkedNow = await effectiveTime(client, now);
  if (invitation.inviter_subject_id !== actor.subjectId) refuse('ROOM_INVITATION_NOT_INVITER');
  if (invitation.status === 'accepted') refuse('ROOM_INVITATION_ALREADY_ACCEPTED');
  if (invitation.status === 'revoked') return { room: held, invitation };
  const revoked = (await client.query<RoomInvitationRow>(`UPDATE siyue.room_invitations i
    SET status = 'revoked', revoked_at = GREATEST($3::timestamptz, i.created_at)
    WHERE i.room_id = $1 AND i.invitee_subject_id = $2 AND i.status = 'pending' RETURNING ${invitationColumns}`,
  [roomId, inviteeSubjectId, checkedNow])).rows[0];
  return revoked ? { room: held, invitation: revoked } : refuse('ROOM_INVITATION_CONFLICT');
}

/**
 * The join verdict: re-check one already accepted invitation for the member it names and return the
 * authorization, or refuse. It is the only method a seat may be taken on, and it is deliberately not a
 * seat: it writes nothing, signs nothing and reserves no slot, so a caller can ask "may this verified
 * session join now?" without changing any state. A pending invitation is refused here (it must be
 * accepted first), and the whole reach of the invitation is re-proved - the room is open, the family is
 * active, the member is still an active member, the inviter still holds the membership version it issued
 * under, the family still carries the version the invitation was pinned to, and the deadline has not
 * passed. The verdict is only meaningful inside the transaction that uses it: the caller must chain it
 * straight into the seat kernel, which re-reads the room under its own lock, so an end or a freeze that
 * lands first cannot be overtaken by a stale verdict.
 *
 * This is not an entry point either. Until a trusted C11 authorization layer decides the parent rule and
 * a route exists to call it, no HTTP surface may import this module or accept a client-supplied verdict,
 * so the confirmed room feature stays closed rather than reachable through an unverified caller.
 */
async function authorizeJoin(client: PoolClient, rawInput: RoomInvitationJoinInput,
  now: Date): Promise<RoomInvitationJoinAuthorization> {
  const parsed = joinInputSchema.safeParse(rawInput);
  if (!parsed.success) refuse('ROOM_INVITATION_INVALID_REQUEST');
  const { roomId, participant } = parsed.data;
  await requireLiveSession(client, participant);
  const room = await readRoom(client, roomId);
  if (!room) refuse('ROOM_INVITATION_ROOM_NOT_FOUND');
  const family = await lockFamily(client, room.family_id);
  if (!family || family.status !== 'active') refuse('ROOM_INVITATION_FAMILY_INACTIVE');
  const held = await lockRoom(client, roomId);
  if (!held) refuse('ROOM_INVITATION_ROOM_NOT_FOUND');
  if (held.status !== 'open') refuse('ROOM_INVITATION_ROOM_ENDED');
  // An uninvited member of this family and a member of another family are the same answer here.
  const invitation = await lockInvitation(client, roomId, participant.subjectId);
  if (!invitation) refuse('ROOM_INVITATION_NOT_FOUND');
  const checkedNow = await effectiveTime(client, now);
  await requireUsableInvitation(client, invitation, family, participant.subjectId, checkedNow);
  // Only an invitation this member accepted authorizes a join: a pending row must go through
  // `acceptInvitation` first, so no seat can ever be taken off an unaccepted invitation.
  if (invitation.status !== 'accepted') refuse('ROOM_INVITATION_NOT_ACCEPTED');
  return { room: held, invitation };
}

/**
 * Internal family-room invitation repository for the C11 slice (design 16.5, spec VWC-02). It owns one
 * durable invitation per room and existing family member and the rules that make it usable: only a
 * verified adult member of the room's family can issue one, the parent verdict is the caller's explicit
 * input and never derived from a role, the invitee must already be an active member of that family and
 * may be a child, a child invitee needs the inviter's recorded guardianship, and acceptance re-proves
 * the family, room, membership, deadline and inviter versions before it writes. A revoked, expired,
 * ended, frozen or exited state refuses every later attempt, and repeats are idempotent.
 *
 * This is not an entry point. It is deliberately imported by no route, it signs no RTC credential and
 * it writes no board, seat or recording state: the caller must run `verifyForMutation` on the same
 * transaction, decide the confirmed C11 parent authorization, then use `authorizeJoin` - a verdict that
 * writes nothing - before chaining that verdict into the seat kernel itself. The formal room entry stays
 * closed until a trusted authorization layer can decide the C11 parent rule, so no route may expose this
 * module or forward a client-supplied parent verdict to it. Invitation lifetime and every per-member
 * admission, removal and delegation detail beyond C11 stay with the owner decisions in design O01.
 */
export const roomInvitationRepository = {
  readRoom,
  createInvitation,
  acceptInvitation,
  revokeInvitation,
  authorizeJoin,
};
