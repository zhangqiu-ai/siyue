import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { transaction } from '../../adapters/postgres/database.js';
import type { SessionService } from '../auth/sessions.js';
import {
  roomInvitationRepository,
  type RoomInvitationDecision,
  type RoomInvitationJoinAuthorization,
} from './invitations.js';
import { roomCapacityRepository, type RoomRow, type SeatRow } from './capacity.js';

/**
 * Non-public diagnostic for an internal caller. A refusal never carries an HTTP status: this module is
 * not an entry point, and deciding the wire response stays with the authorized caller. Only the call
 * shape is refused here; an identity failure surfaces as the session kernel's own `AuthError` (which
 * still distinguishes a retryable 503 from a credential failure), an invitation refusal as
 * `RoomInvitationError` and a seat refusal as `RoomCapacityError`, so a caller keeps the diagnostic
 * that says which kernel refused.
 */
export type RoomParticipationFailure = 'ROOM_PARTICIPATION_INVALID_REQUEST';

export class RoomParticipationError extends Error {
  constructor(readonly code: RoomParticipationFailure) { super(code); }
}
function refuse(code: RoomParticipationFailure): never { throw new RoomParticipationError(code); }

const roomIdSchema = z.uuid();
/**
 * The token shape the session route itself accepts, so an obviously malformed credential never reaches
 * the database. Whether a well-formed token names a live session stays the session kernel's own decision.
 */
const accessTokenPattern = /^[A-Za-z0-9._~+/-]+=*$/;

/**
 * The only input a participation call accepts: a room and one access token, in that order, and nothing
 * else. There is deliberately no `subjectId`, `sessionId`, `role`, `subjectKind`, `deviceId`,
 * `installationId`, `parentAuthority` or `invitationId` parameter - the acting subject, its session,
 * its family membership and its invitation are all read from the token the server issued, so a caller
 * cannot name itself, another member or a stronger role. The argument count is part of that shape: a third
 * argument of any kind is refused instead of being silently ignored, which is how a smuggled role, device
 * or identity object would otherwise ride along with an otherwise valid call.
 */
function requireCall(roomId: unknown, accessToken: unknown, extra: readonly unknown[]): { roomId: string; accessToken: string } {
  if (extra.length !== 0) refuse('ROOM_PARTICIPATION_INVALID_REQUEST');
  if (typeof roomId !== 'string' || !roomIdSchema.safeParse(roomId).success) refuse('ROOM_PARTICIPATION_INVALID_REQUEST');
  if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > 8_192 ||
      !accessTokenPattern.test(accessToken)) refuse('ROOM_PARTICIPATION_INVALID_REQUEST');
  return { roomId, accessToken };
}

/**
 * One successful join: the invitation verdict it was authorized by plus the seat kernel's own outcome -
 * the room under its lock, every live seat and the row this session took. Both halves are returned
 * because neither is usable alone - a seat without the verdict would not say why the device is in the
 * room, and a verdict without a seat reserved nothing - and the caller can answer "how full is this
 * room?" from the same transaction instead of reading it again.
 */
export interface RoomJoinOutcome {
  authorization: RoomInvitationJoinAuthorization;
  room: RoomRow;
  seats: SeatRow[];
  seat: SeatRow;
}

/**
 * Internal RoomParticipationService factory for the C11 room slice (design 16.5, spec VWC-02): the one
 * place where a verified session, a stored invitation and a capacity seat compose, so the three kernels
 * cannot be wired in a different order or in separate transactions by an individual caller.
 *
 * Each call owns exactly one transaction, and inside it the order is fixed: the session kernel's
 * `verifyForMutation` runs first, so a dead, revoked, expired, frozen or unguarded child session throws
 * before anything is written and the transaction rolls back instead of committing a mutation for a
 * blocked subject; then the invitation kernel, then the seat kernel. `join` chains the invitation
 * kernel's `authorizeJoin` verdict straight into `claimSeat` in that same transaction, so a seat can only
 * ever be taken on an accepted invitation whose family, room, membership, inviter and pinned versions are
 * still live. `leave` releases the verified session's own seat and nothing else.
 *
 * What it deliberately does not do:
 * - No HTTP route, handler or RPC is registered or exported here, and no RTC credential, board, recording
 *   or media state is written. This internal composition is not a room entry point.
 * - It has no creator path. It creates no room, no invitation and no seat for the room's creator, and the
 *   invitation kernel refuses a self-invite, so a creator that holds no invitation cannot be seated here
 *   at all. This service admits invited members only; seating the creator needs its own authorization
 *   decision and stays outside this slice.
 * - It never decides or infers the C11 parent verdict from a family role, so no owner or admin membership
 *   becomes an authorization here. Issuing an invitation keeps that decision with the trusted caller of
 *   the invitation kernel; this factory only spends an invitation another layer already issued.
 * - It never derives identity from its arguments beyond the token. The subject and session that accept,
 *   join or leave are exactly the ones `verifyForMutation` returned for that token.
 */
export function createRoomParticipationService(pool: Pool, sessionService: SessionService,
  clock: () => Date = () => new Date()) {
  /** The verified identity of one call. A token that does not name a live session throws before any write. */
  async function verifiedIdentity(client: PoolClient, accessToken: string) {
    const session = await sessionService.verifyForMutation(client, accessToken);
    return { sessionId: session.sessionId, subjectId: session.subjectId };
  }
  const service = {
    /**
     * Accept the invitation this session's own subject holds for this room, in one transaction that
     * verifies the session first. Acceptance writes the invitation only: it takes no seat and sends
     * nothing, so a member can accept now and join later on the same or another granted device.
     */
    async accept(roomId: string, accessToken: string, ...extra: unknown[]): Promise<RoomInvitationDecision> {
      const call = requireCall(roomId, accessToken, extra);
      return transaction(pool, async client => {
        const invitee = await verifiedIdentity(client, call.accessToken);
        return roomInvitationRepository.acceptInvitation(client, { roomId: call.roomId, invitee }, clock());
      });
    },
    /**
     * Join the room as the verified session: re-check the accepted invitation, then claim a seat, both in
     * one transaction, so a refusal of either kernel leaves no seat and no half-written state, and a
     * repeated call returns the same seat instead of adding one.
     */
    async join(roomId: string, accessToken: string, ...extra: unknown[]): Promise<RoomJoinOutcome> {
      const call = requireCall(roomId, accessToken, extra);
      return transaction(pool, async client => {
        const participant = await verifiedIdentity(client, call.accessToken);
        const now = clock();
        const authorization = await roomInvitationRepository.authorizeJoin(client,
          { roomId: call.roomId, participant }, now);
        const claimed = await roomCapacityRepository.claimSeat(client, call.roomId, participant, now);
        return { authorization, room: claimed.room, seats: claimed.seats, seat: claimed.seat };
      });
    },
    /**
     * Leave the room as the verified session: release this session's own seat. It never releases another
     * device's seat, never changes the room state and takes no family-status decision of its own - which is
     * not a promise that departure survives a freeze. The freeze that covers this room ends the family's
     * rooms and revokes the child device sessions it covers, so a leave arriving after it is refused: by the
     * session kernel when the session is already dead, or by the seat kernel's room-ended check. Leaving
     * twice is idempotent, and leaving without a seat returns no row.
     */
    async leave(roomId: string, accessToken: string, ...extra: unknown[]): Promise<SeatRow | null> {
      const call = requireCall(roomId, accessToken, extra);
      return transaction(pool, async client => {
        const participant = await verifiedIdentity(client, call.accessToken);
        return roomCapacityRepository.releaseSeat(client, call.roomId, participant, clock());
      });
    },
  };
  return service;
}
export type RoomParticipationService = ReturnType<typeof createRoomParticipationService>;
