import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';

/** Design 16.5 / C01–C11: one room holds at most five concurrently active device seats. */
export const roomSeatCapacity = 5;

/**
 * Non-public diagnostics for an internal caller. A refusal never carries an HTTP status: this module
 * is not an entry point, and deciding the wire response stays with the authorized caller.
 */
export type RoomCapacityFailure =
  | 'ROOM_CAPACITY_INVALID_REQUEST'
  | 'ROOM_FAMILY_NOT_FOUND'
  | 'ROOM_CREATOR_NOT_FOUND'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_ENDED'
  | 'ROOM_SEATS_FULL'
  | 'ROOM_VERSION_CONFLICT'
  | 'ROOM_SESSION_INVALID';

export class RoomCapacityError extends Error {
  constructor(readonly code: RoomCapacityFailure) { super(code); }
}
function refuse(code: RoomCapacityFailure): never { throw new RoomCapacityError(code); }

const idSchema = z.uuid();
/**
 * The only identity a seat accepts. There is deliberately no `installationId`, `deviceId`, `seatIndex`,
 * `role` or `subjectKind` field: a seat belongs to one server-side auth session, so a client-reported
 * installation id can neither merge two devices into one seat nor split one device into two.
 */
const seatIdentitySchema = z.object({ sessionId: idSchema, subjectId: idSchema }).strict();

export interface RoomRow {
  id: string; family_id: string; created_by_subject_id: string; status: 'open' | 'ended';
  version: number; created_at: Date; ended_at: Date | null;
}
export interface SeatRow {
  room_id: string; session_id: string; subject_id: string; seat_index: number;
  claimed_at: Date; released_at: Date | null;
}
/** The verified session a claim is made for. Never built from a request body. */
export interface RoomSeatIdentity { sessionId: string; subjectId: string; }
export interface ClaimedSeat { room: RoomRow; seats: SeatRow[]; seat: SeatRow; }

const roomColumns = 'r.id, r.family_id, r.created_by_subject_id, r.status, r.version, r.created_at, r.ended_at';
const seatColumns = 's.room_id, s.session_id, s.subject_id, s.seat_index, s.claimed_at, s.released_at';
/**
 * A seat is only ever claimed for a session the server itself issued: the row must exist for that
 * subject, the subject must be active, the session must not be revoked, its credential version must be
 * the subject's current one and none of the session kernel's own deadlines may have passed. Validity is
 * read from the database clock rather than a caller-supplied timestamp, so a stale claim time cannot
 * revive an expired session. The clock is read per row with `clock_timestamp()` rather than the
 * transaction-start `now()`: a caller transaction that stays open past a session deadline must see that
 * deadline pass instead of seating a session that has already lapsed.
 */
const liveSession = `SELECT s.id FROM siyue.auth_sessions s JOIN siyue.subjects p ON p.id = s.subject_id
  WHERE s.id = $1 AND s.subject_id = $2 AND s.revoked_at IS NULL AND p.status = 'active'
    AND s.credential_version = p.credential_version AND s.idle_expires_at > clock_timestamp() AND s.absolute_expires_at > clock_timestamp()
    AND (s.grant_expires_at IS NULL OR s.grant_expires_at > clock_timestamp())`;
const isForeignKeyViolation = (error: unknown) => (error as { code?: string } | null)?.code === '23503';
const requireId = (value: unknown): string => {
  if (typeof value !== 'string' || !idSchema.safeParse(value).success) refuse('ROOM_CAPACITY_INVALID_REQUEST');
  return value as string;
};
/** Lowest free slot, or null when all five are occupied. Slot choice stays server-side. */
function freeSlot(taken: ReadonlySet<number>): number | null {
  for (let slot = 1; slot <= roomSeatCapacity; slot += 1) if (!taken.has(slot)) return slot;
  return null;
}

/** Read-only room lookup. No lock: writers take the family lock, then the room lock, with lockFamilyForRoom. */
async function readRoom(client: PoolClient, roomId: string): Promise<RoomRow | undefined> {
  return (await client.query<RoomRow>(`SELECT ${roomColumns} FROM siyue.rooms r WHERE r.id = $1`, [requireId(roomId)])).rows[0];
}

/**
 * Lock the room row. This single lock serialises every seat claim of one room, so the count, the slot
 * choice and the insert cannot interleave with another claim. Every writer locks the room's family before
 * the room to serialize with family freeze; no external call is made while locks are held.
 */
async function lockRoom(client: PoolClient, roomId: string): Promise<RoomRow | undefined> {
  return (await client.query<RoomRow>(`SELECT ${roomColumns} FROM siyue.rooms r WHERE r.id = $1 FOR UPDATE`, [roomId])).rows[0];
}

/**
 * Lock the family of a room before the room row itself. Claims, releases and ends all read
 * `rooms.family_id` first and then take their locks in this one order, which is also the order family
 * freeze already uses (the family row, then its rooms). A caller that needs the same family row later in
 * its own transaction — family-state bookkeeping, freeze coordination, an authorization record — therefore
 * waits for a concurrent claim instead of closing a wait cycle with it. The lock is taken whatever the
 * family's status is, because a frozen or dissolved family must still let a seated device leave and an open
 * room be closed; a caller that needs the family to be active decides that itself, as claimSeat does.
 * `rooms.family_id` has no update path, so the unlocked read that chooses the family cannot go stale.
 */
async function lockFamilyForRoom(client: PoolClient, familyId: string): Promise<void> {
  await client.query('SELECT 1 FROM siyue.families WHERE id = $1 FOR UPDATE', [familyId]);
}

/** Live seats of one room, in slot order. Released rows stay out of capacity until a new claim. */
async function activeSeats(client: PoolClient, roomId: string): Promise<SeatRow[]> {
  return (await client.query<SeatRow>(
    `SELECT ${seatColumns} FROM siyue.room_seats s WHERE s.room_id = $1 AND s.released_at IS NULL ORDER BY s.seat_index`,
    [requireId(roomId)])).rows;
}

/**
 * Open a room for one family and record who opened it. This decides no role, membership or invitation
 * policy: the caller must already have verified the session and decided the confirmed "only a parent
 * opens a room" rule before it calls this, and the created room grants nobody a seat or a board right.
 */
async function openRoom(client: PoolClient, familyId: string, createdBySubjectId: string, now: Date): Promise<RoomRow> {
  const family = requireId(familyId), creator = requireId(createdBySubjectId);
  // Serialize with account deletion's family freeze. A family that is frozen after this check
  // cannot acquire a new open room before the freeze transaction ends all existing rooms.
  if (!(await client.query("SELECT 1 FROM siyue.families WHERE id = $1 AND status = 'active' FOR UPDATE", [family])).rows[0])
    refuse('ROOM_FAMILY_NOT_FOUND');
  // The creator is the subject of the session the caller verified; a stale, foreign or deactivated id
  // must not open a room on someone else's behalf.
  const subject = (await client.query<{ status: string }>('SELECT status FROM siyue.subjects WHERE id = $1', [creator])).rows[0];
  if (!subject || subject.status !== 'active') refuse('ROOM_CREATOR_NOT_FOUND');
  try {
    return (await client.query<RoomRow>(`INSERT INTO siyue.rooms AS r(id, family_id, created_by_subject_id, status, version, created_at)
      VALUES($1,$2,$3,'open',1,$4) RETURNING ${roomColumns}`,
    [randomUUID(), family, creator, now])).rows[0]!;
  } catch (error) {
    // Both references were checked above, so this only fires if one of them was deleted concurrently.
    if (isForeignKeyViolation(error))
      refuse((error as { constraint?: string }).constraint === 'rooms_created_by_subject_id_fkey' ? 'ROOM_CREATOR_NOT_FOUND' : 'ROOM_FAMILY_NOT_FOUND');
    throw error;
  }
}

/**
 * Atomic seat claim: same room+session is idempotent and returns the seat that session already holds,
 * every seated device keeps its slot, and the sixth session is refused without touching the five seats
 * that exist. An ended room refuses even a session that was seated earlier, because ending a room
 * released its seats. The identity is re-proved against `auth_sessions` here, so a caller cannot seat a
 * fabricated pair, and the caller's own `verifyForMutation` result is the only intended input.
 */
async function claimSeat(client: PoolClient, roomId: string, session: RoomSeatIdentity, now: Date): Promise<ClaimedSeat> {
  const room = requireId(roomId);
  const parsed = seatIdentitySchema.safeParse(session);
  if (!parsed.success) refuse('ROOM_CAPACITY_INVALID_REQUEST');
  const identity = parsed.data;
  if (!(await client.query(liveSession, [identity.sessionId, identity.subjectId])).rows[0]) refuse('ROOM_SESSION_INVALID');
  const initial = await readRoom(client, room);
  if (!initial) refuse('ROOM_NOT_FOUND');
  // Keep family → room lock order with deletion's freeze transaction. Even an open room restored
  // from an older backup cannot receive seats while its family is frozen.
  if (!(await client.query("SELECT 1 FROM siyue.families WHERE id=$1 AND status='active' FOR UPDATE",
    [initial.family_id])).rows[0]) refuse('ROOM_ENDED');
  const held = await lockRoom(client, room);
  if (!held) refuse('ROOM_NOT_FOUND');
  if (held.status !== 'open') refuse('ROOM_ENDED');
  const seats = await activeSeats(client, room);
  const seated = seats.find(seat => seat.session_id === identity.sessionId);
  if (seated) return { room: held, seats, seat: seated };
  const slot = freeSlot(new Set(seats.map(seat => seat.seat_index)));
  if (slot === null) refuse('ROOM_SEATS_FULL');
  // An explicit leave keeps one row per room/session. A later authorized join of that same session
  // claims a free slot again; the old slot may already belong to another device.
  const returned = (await client.query<SeatRow>(`UPDATE siyue.room_seats s
    SET seat_index=$3, claimed_at=$4, released_at=NULL
    WHERE s.room_id=$1 AND s.session_id=$2 AND s.subject_id=$5 AND s.released_at IS NOT NULL
    RETURNING ${seatColumns}`,
  [room, identity.sessionId, slot, now, identity.subjectId])).rows[0];
  if (returned) return { room: held, seats: [...seats, returned].sort((a, b) => a.seat_index - b.seat_index), seat: returned };
  // `ON CONFLICT DO NOTHING` keeps the transaction usable if a caller reaches this primitive without the
  // room lock: an aborted transaction could not re-read, and a raw constraint error could not be told
  // apart from a full room.
  const inserted = (await client.query<SeatRow>(`INSERT INTO siyue.room_seats AS s(room_id, session_id, subject_id, seat_index, claimed_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING ${seatColumns}`,
  [room, identity.sessionId, identity.subjectId, slot, now])).rows[0];
  if (inserted) return { room: held, seats: [...seats, inserted].sort((a, b) => a.seat_index - b.seat_index), seat: inserted };
  // Nothing was inserted: either this session already holds a seat (an idempotent retry won the race) or
  // the slot was taken by another session.
  const raced = (await client.query<SeatRow>(
    `SELECT ${seatColumns} FROM siyue.room_seats s WHERE s.room_id = $1 AND s.session_id = $2 AND s.released_at IS NULL`, [room, identity.sessionId])).rows[0];
  if (raced) return { room: held, seats, seat: raced };
  return refuse('ROOM_SEATS_FULL');
}

/**
 * Explicit personal departure. It changes no room state and never releases another session's seat. It
 * takes the family lock before the room lock, the same order a claim takes, so a caller that also needs
 * the family later in its transaction cannot deadlock with a concurrent claim.
 */
async function releaseSeat(client: PoolClient, roomId: string, session: RoomSeatIdentity, now: Date): Promise<SeatRow | null> {
  const room = requireId(roomId);
  const parsed = seatIdentitySchema.safeParse(session);
  if (!parsed.success) refuse('ROOM_CAPACITY_INVALID_REQUEST');
  const identity = parsed.data;
  if (!(await client.query(liveSession, [identity.sessionId, identity.subjectId])).rows[0]) refuse('ROOM_SESSION_INVALID');
  const initial = await readRoom(client, room);
  if (!initial) refuse('ROOM_NOT_FOUND');
  // Leaving must not depend on the family being active: a frozen family must not trap the device that
  // already holds a seat, so this only takes the lock, never the status decision a claim makes.
  await lockFamilyForRoom(client, initial.family_id);
  const held = await lockRoom(client, room);
  if (!held) refuse('ROOM_NOT_FOUND');
  if (held.status !== 'open') refuse('ROOM_ENDED');
  const seat = (await client.query<SeatRow>(`SELECT ${seatColumns} FROM siyue.room_seats s
    WHERE s.room_id=$1 AND s.session_id=$2 AND s.subject_id=$3`,
  [room, identity.sessionId, identity.subjectId])).rows[0];
  if (!seat || seat.released_at) return seat ?? null;
  return (await client.query<SeatRow>(`UPDATE siyue.room_seats s SET released_at=$3
    WHERE s.room_id=$1 AND s.session_id=$2 AND s.released_at IS NULL RETURNING ${seatColumns}`,
  [room, identity.sessionId, now])).rows[0] ?? null;
}

/**
 * End a room and release its seats under the room lock. Ending is idempotent: a room that already ended
 * returns its durable state instead of bumping the version twice, while a stale `expectedVersion` on an
 * open room is refused without a write. The caller must already have decided the confirmed "a parent
 * with authority ends the room" rule; this function only records the transition. Like a release, it takes
 * the family lock before the room lock so it stays ordered with claims and with family freeze.
 */
async function endRoom(client: PoolClient, roomId: string, expectedVersion: number, now: Date): Promise<RoomRow> {
  const room = requireId(roomId);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) refuse('ROOM_CAPACITY_INVALID_REQUEST');
  const initial = await readRoom(client, room);
  if (!initial) refuse('ROOM_NOT_FOUND');
  await lockFamilyForRoom(client, initial.family_id);
  const held = await lockRoom(client, room);
  if (!held) refuse('ROOM_NOT_FOUND');
  if (held.status === 'ended') return held;
  if (held.version !== expectedVersion) refuse('ROOM_VERSION_CONFLICT');
  const ended = (await client.query<RoomRow>(`UPDATE siyue.rooms r SET status = 'ended', version = r.version + 1, ended_at = $2
    WHERE r.id = $1 RETURNING ${roomColumns}`, [room, now])).rows[0]!;
  await client.query('UPDATE siyue.room_seats SET released_at = $2 WHERE room_id = $1 AND released_at IS NULL', [room, now]);
  return ended;
}

/**
 * Internal family-room seat repository for the SA-08 9.4 kernel (design 16.5, acceptance RTC-01/RTC-02).
 * It owns only the seat-count invariants: one room seats at most five sessions, a seat is bound to the
 * server's own auth session rather than a client-reported installation id, retrying the same claim is
 * idempotent, the sixth session is refused while the seated five stay untouched, and a room that has
 * ended refuses new seats. Explicit departure releases only that session's seat and keeps the room open.
 *
 * This is not an entry point. It is deliberately imported by no route, and it grants no subject a join
 * right: it decides no family relationship, no invitation and no parent authority. Every function must
 * be called inside a transaction owned by an already-authorized caller that has (1) verified the session
 * with the session kernel's `verifyForMutation` on that same transaction and (2) decided the confirmed
 * C11 authorization before seating anyone or ending a room. It signs no RTC credential, sends nothing to
 * a vendor, and decides no unplanned disconnect or reconnect-retention window: 9.4 stays open until the
 * room/whiteboard authorization and real-device acceptance land. Holding a seat row is not a credential
 * and authenticates nothing on its own.
 */
export const roomCapacityRepository = {
  readRoom,
  activeSeats,
  openRoom,
  claimSeat,
  releaseSeat,
  endRoom,
};
