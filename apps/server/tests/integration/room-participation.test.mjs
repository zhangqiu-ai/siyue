import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createAuthFixture } from './auth-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { AuthError } from '../../dist/modules/auth/sessions.js';
import { roomCapacityRepository, RoomCapacityError } from '../../dist/modules/rooms/capacity.js';
import { roomInvitationRepository, RoomInvitationError } from '../../dist/modules/rooms/invitations.js';
import { createRoomParticipationService, RoomParticipationError } from '../../dist/modules/rooms/participation.js';

// Internal RoomParticipationService (C11, design 16.5, spec VWC-02) against an isolated temporary
// PostgreSQL cluster only: the fixture always builds a fresh cluster on a short Unix socket and never
// reads a database URL or the workspace .env. Every subject, session, family, room, invitation and token
// below is synthetic, and no mail, provider, RTC vendor, shell or network call happens here.
//
// The service is an internal composition with no HTTP surface, so every call below passes the raw access
// token of a session the session service really issued, exactly as a future authorized route would: the
// subject and session that accept, join or leave are always the ones that token resolves to, and no call
// can name its own identity. Positive child cases use a device the pairing flow really granted, which is
// the only path whose grant, guardian relationship, consent and family state the session kernel re-checks
// on each call.
let db, fx, participation;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query('TRUNCATE siyue.room_invitations,siyue.room_seats,siyue.rooms,siyue.auth_sessions,' +
    'siyue.refresh_tokens,siyue.reauth_grants,siyue.device_grants,siyue.guardian_relationships,' +
    'siyue.consent_records,siyue.device_pairing_requests,siyue.family_invitations,siyue.family_memberships,' +
    'siyue.family_create_requests,siyue.families,siyue.subjects CASCADE');
  fx = await createAuthFixture(db);
  participation = createRoomParticipationService(db.app, fx.service, fx.clock);
});
after(async () => { await db?.stop(); });

/** Tolerates both rows(sql, a, b) and rows(sql, [a, b]) call styles. */
const bindings = args => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
const rows = (sql, ...args) => db.app.query(sql, bindings(args)).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
/** Asserts one refusal by its code and its own error family, so a code owned by another kernel cannot pass. */
const refusalBy = kind => expected => error => error instanceof kind && error.code === expected;
const refuses = refusalBy(RoomInvitationError);
const seatRefuses = refusalBy(RoomCapacityError);
const authRefuses = refusalBy(AuthError);
const inputRefuses = refusalBy(RoomParticipationError);
const seatCount = roomId => count('SELECT count(*)::int AS n FROM siyue.room_seats WHERE room_id=$1', roomId);
const liveSeatCount = roomId => count('SELECT count(*)::int AS n FROM siyue.room_seats WHERE room_id=$1 AND released_at IS NULL', roomId);
const liveSeatSessions = roomId => rows('SELECT session_id FROM siyue.room_seats WHERE room_id=$1 AND released_at IS NULL ORDER BY seat_index', roomId)
  .then(result => result.map(row => row.session_id));
const seatsOf = roomId => rows('SELECT session_id, subject_id, seat_index, claimed_at, released_at FROM siyue.room_seats WHERE room_id=$1 ORDER BY seat_index', roomId);
const invitationCount = () => count('SELECT count(*)::int AS n FROM siyue.room_invitations');
const invitationRow = (roomId, inviteeSubjectId) => rows('SELECT id, room_id, inviter_subject_id, invitee_subject_id, status,' +
  ' inviter_membership_version, invitee_membership_version, family_version, expires_at, accepted_at, revoked_at, created_at' +
  ' FROM siyue.room_invitations WHERE room_id=$1 AND invitee_subject_id=$2', roomId, inviteeSubjectId).then(result => result[0]);
const roomRow = roomId => rows('SELECT status, version, created_at, ended_at FROM siyue.rooms WHERE id=$1', roomId).then(result => result[0]);
const future = () => new Date(+fx.clock() + 3_600_000);

/** A real adult session issued by the session service; the service never builds identity from input. */
const adult = () => fx.issue();
/** A family whose owner subject owns a real adult session and an active owner membership. */
async function familyWithOwner() {
  const owner = await adult();
  const familyId = randomUUID();
  await db.app.query('INSERT INTO siyue.families(id,owner_subject_id) VALUES($1,$2)', [familyId, owner.session.subjectId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,'owner',true,1)",
    [familyId, owner.session.subjectId]);
  return { familyId, owner };
}
/** One more active member of the family, with an adult session of its own. */
async function addAdultMember(familyId, role = 'member') {
  const who = await adult();
  await db.app.query('INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,$3,true,1)',
    [familyId, who.session.subjectId, role]);
  return who;
}
/**
 * The pairing flow's own outcome, built the way that flow builds it: an approved device grant bounded by
 * the live guardianship versions, then the session kernel's own child issuance, so the returned access
 * token is one the server really issued for a granted child device.
 */
async function grantedChildDevice(familyId, guardianSubjectId, childSubjectId) {
  const grantId = randomUUID(), now = fx.clock();
  await db.app.query('INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,' +
      "device_label,guardian_relationship_version,guardian_credential_version,scopes,version,created_at,expires_at)" +
      " VALUES($1,$2,$3,$4,$5,'ios','Synthetic child device',1,1,$6,1,$7,$8)",
  [grantId, childSubjectId, guardianSubjectId, familyId, randomUUID(), [], now, new Date(+now + 86_400_000)]);
  return transaction(db.app, async client => ({ ...await fx.service.issueChild(client, grantId), deviceGrantId: grantId }));
}
/** An active child member with one recorded guardianship, its consent and a granted child device. */
async function addChildMember(familyId, guardianSubjectId) {
  const subjectId = randomUUID(), consentRecordId = randomUUID(), recordedAt = fx.clock();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,status) VALUES($1,'child','active')", [subjectId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,'member',true,1)",
    [familyId, subjectId]);
  await db.app.query('INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version,recorded_at)' +
    " VALUES($1,$2,$3,'child-guardianship','child-guardianship-v1',$4)",
  [consentRecordId, guardianSubjectId, subjectId, recordedAt]);
  await db.app.query('INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,active,version,consent_record_id,created_at)' +
    ' VALUES($1,$2,$3,true,1,$4,$5)', [familyId, guardianSubjectId, subjectId, consentRecordId, recordedAt]);
  return { subjectId, ...await grantedChildDevice(familyId, guardianSubjectId, subjectId) };
}
/** A family, its guardian owner, a guarded child device, a second adult member and one open room. */
async function scene() {
  const { familyId, owner } = await familyWithOwner();
  const child = await addChildMember(familyId, owner.session.subjectId);
  const peer = await addAdultMember(familyId);
  const roomId = (await transaction(db.app, client =>
    roomCapacityRepository.openRoom(client, familyId, owner.session.subjectId, fx.clock()))).id;
  return { familyId, guardian: owner, child, peer, roomId };
}
/** The invite a trusted caller issued: the guardian member names an existing member of the room's family. */
const invite = (roomId, inviteeSubjectId, inviter, overrides = {}) => transaction(db.app, client =>
  roomInvitationRepository.createInvitation(client, { roomId, inviteeSubjectId,
    inviter: { sessionId: inviter.session.sessionId, subjectId: inviter.session.subjectId },
    parentAuthority: 'verified', expiresAt: future(), ...overrides }, fx.clock()));
const revoke = (roomId, inviteeSubjectId, actor) => transaction(db.app, client =>
  roomInvitationRepository.revokeInvitation(client, { roomId, inviteeSubjectId,
    actor: { sessionId: actor.session.sessionId, subjectId: actor.session.subjectId } }, fx.clock()));
const freeze = familyId => db.admin.query("UPDATE siyue.families SET status='frozen',version=version+1 WHERE id=$1", [familyId]);
const endRoomsOf = familyId => db.admin.query("UPDATE siyue.rooms SET status='ended',ended_at=GREATEST(now(),created_at),version=version+1 WHERE family_id=$1", [familyId]);

test('accept uses only the verified session, is idempotent and refuses every other call shape', async () => {
  const value = await scene();
  await invite(value.roomId, value.peer.session.subjectId, value.guardian);
  const accepted = await participation.accept(value.roomId, value.peer.accessToken);
  assert.deepEqual([accepted.room.id, accepted.invitation.status, accepted.invitation.invitee_subject_id],
    [value.roomId, 'accepted', value.peer.session.subjectId]);
  assert.ok(accepted.invitation.accepted_at instanceof Date);
  // Accepting again from the same session returns the durable row, and acceptance alone takes no seat.
  assert.deepEqual((await participation.accept(value.roomId, value.peer.accessToken)).invitation, accepted.invitation);
  assert.deepEqual([await seatCount(value.roomId), await invitationCount()], [0, 1]);

  // Identity is the session the token resolved to, never the caller's claim: another family member holding
  // a valid session cannot accept the peer's invitation, and the room's own creator has no entry here at
  // all, because the invitation kernel refuses a self-invite and nobody issued the creator an invitation.
  const outsider = await addAdultMember(value.familyId);
  await assert.rejects(participation.accept(value.roomId, outsider.accessToken), refuses('ROOM_INVITATION_NOT_FOUND'));
  await assert.rejects(participation.accept(value.roomId, value.guardian.accessToken), refuses('ROOM_INVITATION_NOT_FOUND'));
  await assert.rejects(participation.join(value.roomId, value.guardian.accessToken), refuses('ROOM_INVITATION_NOT_FOUND'));
  assert.deepEqual([await seatCount(value.roomId), await invitationCount()], [0, 1]);
  assert.equal((await invitationRow(value.roomId, value.peer.session.subjectId)).status, 'accepted');

  // A malformed call is refused by this service before it reaches any kernel: an unknown room id, a
  // smuggled third argument of any kind, a non-string or header-shaped credential and an object where the
  // room belongs. No role, subject, device or parent flag can ride along with an otherwise valid call.
  for (const [label, call] of [
    ['unknown room id', () => participation.accept('not-a-room', value.peer.accessToken)],
    ['smuggled role', () => participation.accept(value.roomId, value.peer.accessToken, { role: 'owner' })],
    ['smuggled subject', () => participation.accept(value.roomId, value.peer.accessToken, { subjectId: value.guardian.session.subjectId })],
    ['explicit undefined extra', () => participation.accept(value.roomId, value.peer.accessToken, undefined)],
    ['empty credential', () => participation.accept(value.roomId, '')],
    ['numeric credential', () => participation.accept(value.roomId, 42)],
    ['authorization header', () => participation.accept(value.roomId, 'Bearer ' + value.peer.accessToken)],
    ['object where the room belongs', () => participation.accept({ roomId: value.roomId, accessToken: value.peer.accessToken })],
    ['null room', () => participation.accept(null, value.peer.accessToken)],
  ]) await assert.rejects(call(), inputRefuses('ROOM_PARTICIPATION_INVALID_REQUEST'), label);
  for (const method of ['join', 'leave'])
    await assert.rejects(participation[method](value.roomId, value.peer.accessToken, { isParent: true }),
      inputRefuses('ROOM_PARTICIPATION_INVALID_REQUEST'), method);
  for (const method of ['join', 'leave'])
    await assert.rejects(participation[method](randomUUID(), value.peer.accessToken, 'extra'),
      inputRefuses('ROOM_PARTICIPATION_INVALID_REQUEST'), method);
  // A well-formed credential that names no session is the session kernel's refusal, not a shape error, so
  // the refusal keeps its own family and a caller can still tell a credential failure from bad input.
  await assert.rejects(participation.accept(value.roomId, 'not.a.real.token'), authRefuses('AUTH_ACCESS_INVALID'));
  assert.deepEqual([await seatCount(value.roomId), await invitationCount(), (await roomRow(value.roomId)).status], [0, 1, 'open']);
});

test('a join needs an accepted invitation and an unknown room is refused without a seat', async () => {
  const value = await scene();
  await invite(value.roomId, value.peer.session.subjectId, value.guardian);
  // Pending is not a join authorization, and the refusal writes nothing at all.
  await assert.rejects(participation.join(value.roomId, value.peer.accessToken), refuses('ROOM_INVITATION_NOT_ACCEPTED'));
  assert.deepEqual([await seatCount(value.roomId), await liveSeatCount(value.roomId)], [0, 0]);
  assert.deepEqual([(await invitationRow(value.roomId, value.peer.session.subjectId)).status, (await roomRow(value.roomId)).status],
    ['pending', 'open']);
  await assert.rejects(participation.join(randomUUID(), value.peer.accessToken), refuses('ROOM_INVITATION_ROOM_NOT_FOUND'));
  assert.equal(await seatCount(value.roomId), 0);

  // After acceptance the same call takes one seat for that session, and a joined room stays open.
  await participation.accept(value.roomId, value.peer.accessToken);
  const joined = await participation.join(value.roomId, value.peer.accessToken);
  assert.deepEqual([joined.authorization.invitation.status, joined.seat.seat_index, joined.seat.session_id, joined.seat.subject_id],
    ['accepted', 1, value.peer.session.sessionId, value.peer.session.subjectId]);
  assert.deepEqual([await seatCount(value.roomId), await liveSeatCount(value.roomId), (await roomRow(value.roomId)).status], [1, 1, 'open']);
});

test('a granted child device accepts and joins, and repeating the join reuses the same seat', async () => {
  const value = await scene();
  await invite(value.roomId, value.child.subjectId, value.guardian);
  const accepted = await participation.accept(value.roomId, value.child.accessToken);
  assert.deepEqual([accepted.invitation.status, accepted.invitation.invitee_subject_id], ['accepted', value.child.subjectId]);
  const first = await participation.join(value.roomId, value.child.accessToken);
  assert.deepEqual([first.authorization.invitation.id, first.seat.seat_index, first.seat.session_id, first.seat.subject_id],
    [accepted.invitation.id, 1, value.child.session.sessionId, value.child.subjectId]);
  // Repeating the join is idempotent: same row, same claim instant, no second seat and no new invitation.
  assert.deepEqual((await participation.join(value.roomId, value.child.accessToken)).seat, first.seat);
  assert.deepEqual([await seatCount(value.roomId), await liveSeatCount(value.roomId), await invitationCount()], [1, 1, 1]);
  // A second granted device of the same child is a separate session, so it takes its own seat.
  const secondDevice = await grantedChildDevice(value.familyId, value.guardian.session.subjectId, value.child.subjectId);
  const second = await participation.join(value.roomId, secondDevice.accessToken);
  assert.deepEqual([second.seat.seat_index, second.seat.session_id, second.seat.subject_id],
    [2, secondDevice.session.sessionId, value.child.subjectId]);
  assert.deepEqual([await seatCount(value.roomId), await liveSeatCount(value.roomId)], [2, 2]);
});

test('five devices join and the sixth is refused while the seated five stay untouched', async () => {
  const { familyId, owner } = await familyWithOwner();
  const roomId = (await transaction(db.app, client =>
    roomCapacityRepository.openRoom(client, familyId, owner.session.subjectId, fx.clock()))).id;
  const members = [], seated = [];
  for (let index = 0; index < 5; index += 1) {
    const member = await addAdultMember(familyId);
    await invite(roomId, member.session.subjectId, owner);
    await participation.accept(roomId, member.accessToken);
    members.push(member);
    seated.push(await participation.join(roomId, member.accessToken));
  }
  assert.deepEqual(seated.map(outcome => outcome.seat.seat_index), [1, 2, 3, 4, 5]);
  assert.equal(await liveSeatCount(roomId), 5);
  const before = await seatsOf(roomId);

  // The sixth member may hold an accepted invitation - a full room still refuses the seat itself, and the
  // refusal takes no seat, releases none of the seated five and leaves the accepted invitation as it was.
  const sixth = await addAdultMember(familyId);
  await invite(roomId, sixth.session.subjectId, owner);
  await participation.accept(roomId, sixth.accessToken);
  await assert.rejects(participation.join(roomId, sixth.accessToken), seatRefuses('ROOM_SEATS_FULL'));
  assert.deepEqual([await seatCount(roomId), await liveSeatCount(roomId)], [5, 5]);
  assert.deepEqual(await seatsOf(roomId), before);
  assert.deepEqual([(await invitationRow(roomId, sixth.session.subjectId)).status, (await roomRow(roomId)).status], ['accepted', 'open']);

  // An explicit departure frees a slot and is the only way in: the same sixth member now joins on it.
  const released = await participation.leave(roomId, members[0].accessToken);
  assert.deepEqual([released.session_id, released.seat_index, released.released_at !== null], [seated[0].seat.session_id, 1, true]);
  const admitted = await participation.join(roomId, sixth.accessToken);
  assert.deepEqual([admitted.seat.seat_index, admitted.seat.session_id, await liveSeatCount(roomId)], [1, sixth.session.sessionId, 5]);
  assert.deepEqual([await seatCount(roomId), (await roomRow(roomId)).status], [6, 'open']);
});

test('a revoked invitation authorizes neither acceptance nor a seat', async () => {
  const value = await scene();
  await invite(value.roomId, value.peer.session.subjectId, value.guardian);
  await revoke(value.roomId, value.peer.session.subjectId, value.guardian);
  await assert.rejects(participation.accept(value.roomId, value.peer.accessToken), refuses('ROOM_INVITATION_REVOKED'));
  await assert.rejects(participation.join(value.roomId, value.peer.accessToken), refuses('ROOM_INVITATION_REVOKED'));
  const stored = await invitationRow(value.roomId, value.peer.session.subjectId);
  assert.deepEqual([await seatCount(value.roomId), stored.status, stored.accepted_at, stored.revoked_at instanceof Date],
    [0, 'revoked', null, true]);
});

test('an invitation that expires authorizes neither a late acceptance nor a seat', async () => {
  const late = await scene();
  await invite(late.roomId, late.peer.session.subjectId, late.guardian, { expiresAt: new Date(+fx.clock() + 2_000) });
  fx.advance(3_000);
  await assert.rejects(participation.accept(late.roomId, late.peer.accessToken), refuses('ROOM_INVITATION_EXPIRED'));
  await assert.rejects(participation.join(late.roomId, late.peer.accessToken), refuses('ROOM_INVITATION_EXPIRED'));
  assert.deepEqual([await seatCount(late.roomId), (await invitationRow(late.roomId, late.peer.session.subjectId)).status], [0, 'pending']);

  // An invitation accepted in time stops authorizing the room once its deadline passes.
  const early = await scene();
  await invite(early.roomId, early.peer.session.subjectId, early.guardian, { expiresAt: new Date(+fx.clock() + 2_000) });
  assert.equal((await participation.accept(early.roomId, early.peer.accessToken)).invitation.status, 'accepted');
  fx.advance(3_000);
  await assert.rejects(participation.join(early.roomId, early.peer.accessToken), refuses('ROOM_INVITATION_EXPIRED'));
  const stored = await invitationRow(early.roomId, early.peer.session.subjectId);
  assert.deepEqual([await seatCount(early.roomId), stored.status, stored.accepted_at instanceof Date, stored.revoked_at], [0, 'accepted', true, null]);
});

test('a frozen family refuses acceptance and a new seat', async () => {
  const value = await scene();
  await invite(value.roomId, value.peer.session.subjectId, value.guardian);
  await freeze(value.familyId);
  await assert.rejects(participation.accept(value.roomId, value.peer.accessToken), refuses('ROOM_INVITATION_FAMILY_INACTIVE'));
  await assert.rejects(participation.join(value.roomId, value.peer.accessToken), refuses('ROOM_INVITATION_FAMILY_INACTIVE'));
  assert.deepEqual([await seatCount(value.roomId), (await invitationRow(value.roomId, value.peer.session.subjectId)).status], [0, 'pending']);
});

test('a freeze that ends the family rooms refuses a departure instead of silently releasing the seat', async () => {
  const value = await scene();
  await invite(value.roomId, value.peer.session.subjectId, value.guardian);
  await participation.accept(value.roomId, value.peer.accessToken);
  await participation.join(value.roomId, value.peer.accessToken);
  assert.equal(await liveSeatCount(value.roomId), 1);

  // The account-deletion freeze ends the family's rooms in the same step, so the seated device's own leave
  // is refused by the seat kernel and its row keeps its unreleased state; this service promises no
  // departure that the kernels themselves refuse.
  await freeze(value.familyId);
  await endRoomsOf(value.familyId);
  await assert.rejects(participation.leave(value.roomId, value.peer.accessToken), seatRefuses('ROOM_ENDED'));
  const stored = (await seatsOf(value.roomId))[0];
  assert.deepEqual([stored.session_id, stored.released_at, await liveSeatCount(value.roomId), (await roomRow(value.roomId)).status],
    [value.peer.session.sessionId, null, 1, 'ended']);

  // A covered child session is dead under the same freeze, so its own leave never reaches the seat kernel.
  const child = await scene();
  await invite(child.roomId, child.child.subjectId, child.guardian);
  await participation.accept(child.roomId, child.child.accessToken);
  await participation.join(child.roomId, child.child.accessToken);
  await freeze(child.familyId);
  await assert.rejects(participation.leave(child.roomId, child.child.accessToken), authRefuses('AUTH_SESSION_INVALID'));
  assert.deepEqual([await liveSeatCount(child.roomId), (await seatsOf(child.roomId))[0].released_at], [1, null]);
});

test('a revoked child device grant stops the child and disturbs nobody else', async () => {
  const value = await scene();
  await invite(value.roomId, value.child.subjectId, value.guardian);
  await invite(value.roomId, value.peer.session.subjectId, value.guardian);
  await participation.accept(value.roomId, value.child.accessToken);
  await participation.accept(value.roomId, value.peer.accessToken);
  const peerSeat = (await participation.join(value.roomId, value.peer.accessToken)).seat;
  assert.deepEqual([peerSeat.seat_index, peerSeat.subject_id], [1, value.peer.session.subjectId]);

  // The session kernel owns the grant, guardian, consent and family checks, so a revoked device grant makes
  // the child's token unusable for every participation call - acceptance included - and this service writes
  // nothing before that refusal.
  await db.admin.query('UPDATE siyue.device_grants SET revoked_at=$2,version=version+1 WHERE id=$1',
    [value.child.deviceGrantId, fx.clock()]);
  await assert.rejects(participation.accept(value.roomId, value.child.accessToken), authRefuses('AUTH_SESSION_INVALID'));
  await assert.rejects(participation.join(value.roomId, value.child.accessToken), authRefuses('AUTH_SESSION_INVALID'));
  await assert.rejects(participation.leave(value.roomId, value.child.accessToken), authRefuses('AUTH_SESSION_INVALID'));
  assert.deepEqual([await seatCount(value.roomId), await liveSeatSessions(value.roomId)], [1, [peerSeat.session_id]]);
  assert.equal((await invitationRow(value.roomId, value.child.subjectId)).status, 'accepted');
});

test('leave releases only the verified session own seat and is idempotent', async () => {
  const value = await scene();
  await invite(value.roomId, value.child.subjectId, value.guardian);
  await participation.accept(value.roomId, value.child.accessToken);
  const childSeat = (await participation.join(value.roomId, value.child.accessToken)).seat;
  const secondDevice = await grantedChildDevice(value.familyId, value.guardian.session.subjectId, value.child.subjectId);
  const secondSeat = (await participation.join(value.roomId, secondDevice.accessToken)).seat;
  assert.deepEqual([childSeat.seat_index, secondSeat.seat_index], [1, 2]);

  const released = await participation.leave(value.roomId, value.child.accessToken);
  assert.deepEqual([released.session_id, released.seat_index, released.released_at !== null], [childSeat.session_id, 1, true]);
  // Only that session left: the other device of the same child keeps its seat and the room stays open.
  assert.deepEqual(await liveSeatSessions(value.roomId), [secondSeat.session_id]);
  assert.equal((await roomRow(value.roomId)).status, 'open');
  // Leaving twice returns the same released row instead of writing a second departure.
  assert.deepEqual(await participation.leave(value.roomId, value.child.accessToken), released);
  // A member that never held a seat leaves nothing behind and creates no row.
  assert.equal(await participation.leave(value.roomId, value.peer.accessToken), null);
  assert.deepEqual([await seatCount(value.roomId), await liveSeatCount(value.roomId)], [2, 1]);
  // Re-joining competes for a free slot again instead of reusing the old one unconditionally.
  const rejoined = await participation.join(value.roomId, value.child.accessToken);
  assert.deepEqual([rejoined.seat.seat_index, rejoined.seat.session_id, (await roomRow(value.roomId)).status], [1, childSeat.session_id, 'open']);
  assert.deepEqual([await seatCount(value.roomId), await liveSeatCount(value.roomId)], [2, 2]);
  await assert.rejects(participation.leave(randomUUID(), value.child.accessToken), seatRefuses('ROOM_NOT_FOUND'));
  assert.equal(await liveSeatCount(value.roomId), 2);
});

test('no entry point imports the participation service, so the formal room entry stays closed', () => {
  // The join path still has no HTTP route, RTC credential or media layer, so no server entry point, route
  // module or index may import this composition. This is a source-level guard, not a runtime check.
  const source = fileURLToPath(new URL('../../src/', import.meta.url));
  const referencing = readdirSync(source, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.ts') && name !== 'modules/rooms/participation.ts')
    .filter(name => readFileSync(join(source, name), 'utf8').includes('rooms/participation'));
  assert.deepEqual(referencing, [], 'no module may import the participation service yet');
  for (const entry of ['index.ts', 'app.ts', 'runtime-app.ts', 'session.ts']) {
    const contents = readFileSync(join(source, entry), 'utf8');
    assert.equal(/rooms\/participation|createRoomParticipationService|RoomParticipationService/.test(contents), false, entry);
  }
});
