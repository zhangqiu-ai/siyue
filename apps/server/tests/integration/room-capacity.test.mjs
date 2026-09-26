import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createAuthFixture } from './auth-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { migrateDatabase, readMigrations } from '../../dist/adapters/postgres/migrate.js';
import { roomCapacityRepository, roomSeatCapacity, RoomCapacityError } from '../../dist/modules/rooms/capacity.js';

// Isolated temporary PostgreSQL cluster only: the fixture always builds a fresh cluster on a short Unix
// socket and never reads a database URL or the workspace .env. Every subject, session, token and room is
// synthetic, and no mail, provider, RTC vendor, shell or network call happens here.
//
// The seat kernel is an internal repository with no HTTP surface, so every call below runs inside a
// caller-owned transaction with a session the session service really issued, exactly as the future
// authorized route must: verify the session in that same transaction, decide the confirmed C11
// authorization, and only then seat it.
let db, fx;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query(`TRUNCATE siyue.room_seats,siyue.rooms,siyue.auth_sessions,siyue.refresh_tokens,siyue.reauth_grants,
    siyue.device_grants,siyue.guardian_relationships,siyue.consent_records,siyue.device_pairing_requests,
    siyue.family_invitations,siyue.family_memberships,siyue.family_create_requests,siyue.families,siyue.subjects CASCADE`);
  fx = await createAuthFixture(db);
});
after(async () => { await db?.stop(); });

/** Tolerates both `rows(sql, a, b)` and `rows(sql, [a, b])` call styles. */
const bindings = args => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
const rows = (sql, ...args) => db.app.query(sql, bindings(args)).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
const refuses = expected => error => error instanceof RoomCapacityError && error.code === expected;
const failure = async (query, code, label) => {
  const error = await query.then(() => null, thrown => thrown);
  assert.equal(error?.code, code, `${label ?? ''} ${error?.constraint ?? error?.message}`.trim());
};
const indexesOf = table => db.admin.query("SELECT indexname FROM pg_indexes WHERE schemaname='siyue' AND tablename=$1 ORDER BY indexname", [table])
  .then(result => result.rows.map(row => row.indexname));
const identityOf = who => ({ sessionId: who.session.sessionId, subjectId: who.session.subjectId });
const seatCount = roomId => count('SELECT count(*)::int AS n FROM siyue.room_seats WHERE room_id=$1', [roomId]);
const liveSeatCount = roomId => count('SELECT count(*)::int AS n FROM siyue.room_seats WHERE room_id=$1 AND released_at IS NULL', [roomId]);
const storedSeats = roomId => rows(`SELECT session_id, subject_id, seat_index, claimed_at, released_at FROM siyue.room_seats
  WHERE room_id=$1 ORDER BY seat_index`, [roomId]);
const roomRow = roomId => rows('SELECT status, version, created_at, ended_at FROM siyue.rooms WHERE id=$1', [roomId]).then(result => result[0]);

/**
 * A caller-owned transaction opened by hand, so two callers can be interleaved deterministically instead
 * of racing. It carries its own backend pid, which is what makes a lock wait observable from outside.
 */
async function rawTransaction() {
  const client = await db.app.connect();
  await client.query('BEGIN');
  const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  return { client, pid, close: async () => { await client.query('ROLLBACK').catch(() => {}); client.release(); } };
}

/** Waits until a backend is visibly queued on a lock, so an interleaving is asserted instead of raced. */
async function waitForLockWait(pid) {
  for (let round = 0; round < 800; round += 1) {
    const waiting = await db.admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid]);
    if (waiting.rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`backend ${pid} never reported a lock wait`);
}

/** Turns a settlement into something an assertion can name: the SQLSTATE of a failure, or 'ok'. */
const settledValue = promise => promise.then(value => value, error => error);
const label = value => (value instanceof Error ? String(value.code ?? value.message) : 'ok');

/** A real adult session issued by the session service; the kernel never builds identity from input. */
const adult = () => fx.issue();
/** Several real sessions of one subject, so one account can occupy several seats. */
async function sessionsForOneSubject(amount, installationId = null) {
  const subjectId = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [subjectId]);
  const issued = [];
  for (let index = 0; index < amount; index += 1)
    issued.push(await transaction(db.app, client => fx.service.issue(client, subjectId, installationId ?? randomUUID(), 'email')));
  return { subjectId, issued };
}
const family = async () => {
  const owner = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [owner]);
  const id = randomUUID();
  await db.app.query('INSERT INTO siyue.families(id,owner_subject_id) VALUES($1,$2)', [id, owner]);
  return id;
};
/** A restricted child session row, shaped like the ones the pairing slice issues. */
async function childSession(grantExpiresAt) {
  const subjectId = randomUUID(), sessionId = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'child')", [subjectId]);
  await db.app.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,credential_version,
      authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at,grant_expires_at)
    VALUES($1,$2,$3,'child',1,now(),now(),now(),now()+interval '30 days',now()+interval '180 days',$4)`,
  [sessionId, subjectId, randomUUID(), grantExpiresAt]);
  return { session: { sessionId, subjectId } };
}

// Every seat call is a caller-owned transaction on the repository, never an accessToken entry point.
const openRoom = (familyId, createdBySubjectId, now = fx.clock()) => transaction(db.app, client =>
  roomCapacityRepository.openRoom(client, familyId, createdBySubjectId, now));
const claim = (roomId, who, now = fx.clock()) => transaction(db.app, client =>
  roomCapacityRepository.claimSeat(client, roomId, identityOf(who), now));
const claimIdentity = (roomId, identity, now = fx.clock()) => transaction(db.app, client =>
  roomCapacityRepository.claimSeat(client, roomId, identity, now));
const leave = (roomId, who, now = fx.clock()) => transaction(db.app, client =>
  roomCapacityRepository.releaseSeat(client, roomId, identityOf(who), now));
const endRoom = (roomId, expectedVersion, now = fx.clock()) => transaction(db.app, client =>
  roomCapacityRepository.endRoom(client, roomId, expectedVersion, now));
const liveSeats = roomId => transaction(db.app, client => roomCapacityRepository.activeSeats(client, roomId));
const roomOf = roomId => transaction(db.app, client => roomCapacityRepository.readRoom(client, roomId));
/** Opens a room through the repository with the subject of a real verified session as its creator. */
async function roomWithOwner(familyId) {
  const owner = await adult();
  const id = familyId ?? await family();
  const room = await openRoom(id, owner.session.subjectId);
  assert.deepEqual([room.status, room.version, room.ended_at, room.created_by_subject_id, room.family_id],
    ['open', 1, null, owner.session.subjectId, id]);
  return { roomId: room.id, owner, familyId: id };
}

test('a frozen or dissolved family cannot open a new room', async () => {
  const familyId = await family();
  const creator = await adult();
  await db.app.query("UPDATE siyue.families SET status='frozen' WHERE id=$1", [familyId]);
  await assert.rejects(openRoom(familyId, creator.session.subjectId), refuses('ROOM_FAMILY_NOT_FOUND'));
  await db.app.query("UPDATE siyue.families SET status='dissolved' WHERE id=$1", [familyId]);
  await assert.rejects(openRoom(familyId, creator.session.subjectId), refuses('ROOM_FAMILY_NOT_FOUND'));
  assert.equal((await rows('SELECT count(*)::int AS n FROM siyue.rooms WHERE family_id=$1', familyId))[0].n, 0);
});

test('an open room left under a frozen family cannot admit a seat', async () => {
  const value = await roomWithOwner();
  const participant = await adult();
  await db.app.query("UPDATE siyue.families SET status='frozen' WHERE id=$1", [value.familyId]);
  await assert.rejects(claim(value.roomId, participant), refuses('ROOM_ENDED'));
  assert.equal(await liveSeatCount(value.roomId), 0);
  assert.equal((await roomRow(value.roomId)).status, 'open');
});

// A freeze must stop new seats without trapping the devices that already hold one: leaving and ending stay
// possible under a frozen or dissolved family, and a room left open by an earlier backup can still be closed.
test('a frozen or dissolved family still lets a seated device leave and its room end', async () => {
  const frozen = await roomWithOwner();
  await claim(frozen.roomId, frozen.owner);
  await db.app.query("UPDATE siyue.families SET status='frozen' WHERE id=$1", [frozen.familyId]);
  const left = await leave(frozen.roomId, frozen.owner);
  assert.deepEqual([left?.session_id, left?.released_at !== null], [frozen.owner.session.sessionId, true]);
  assert.deepEqual([await liveSeatCount(frozen.roomId), (await roomRow(frozen.roomId)).status], [0, 'open']);
  const ended = await endRoom(frozen.roomId, 1);
  assert.deepEqual([ended.status, ended.version, ended.ended_at !== null], ['ended', 2, true]);

  const dissolved = await roomWithOwner();
  await claim(dissolved.roomId, dissolved.owner);
  await db.app.query("UPDATE siyue.families SET status='dissolved' WHERE id=$1", [dissolved.familyId]);
  assert.equal((await leave(dissolved.roomId, dissolved.owner))?.session_id, dissolved.owner.session.sessionId);
  assert.deepEqual([await liveSeatCount(dissolved.roomId), (await endRoom(dissolved.roomId, 1)).status], [0, 'ended']);
});

test('0013 upgrades a real 0012 database additively and leaves the seat kernel usable there', async () => {
  const legacy = await startPostgresFixture({ migrate: false });
  const directory = mkdtempSync('/tmp/siyue-room-capacity-upgrade-');
  try {
    const migrations = await readMigrations();
    const previous = migrations.filter(migration => migration.version < '0013_room_capacity.sql');
    assert.equal(previous.length, 12);
    for (const migration of previous) writeFileSync(join(directory, migration.version), migration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 12);
    for (const table of ['rooms', 'room_seats'])
      assert.equal((await legacy.admin.query('SELECT to_regclass($1) AS present', [`siyue.${table}`])).rows[0].present, null, table);
    // A session that predates the upgrade stays valid, and applying 0013 rewrites neither it nor the
    // history of 0001–0012.
    const legacyFx = await createAuthFixture({ app: legacy.app });
    const who = await legacyFx.issue();
    const seatMigration = migrations.find(migration => migration.version === '0013_room_capacity.sql');
    assert.ok(seatMigration);
    writeFileSync(join(directory, seatMigration.version), seatMigration.sql);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity, pathToFileURL(`${directory}/`)), 1);
    assert.equal(await migrateDatabase(legacy.migrator, legacy.identity), migrations.length - 13);
    for (const table of ['rooms', 'room_seats']) {
      assert.equal((await legacy.admin.query('SELECT to_regclass($1) IS NOT NULL AS present', [`siyue.${table}`])).rows[0].present, true, table);
      assert.equal((await legacy.admin.query("SELECT has_table_privilege('siyue_app',$1,'SELECT,INSERT,UPDATE,DELETE') AS ok", [`siyue.${table}`])).rows[0].ok, true, table);
      // The runtime role uses rows but can never wipe a room or its seats.
      assert.equal((await legacy.admin.query("SELECT has_table_privilege('siyue_app',$1,'TRUNCATE') AS ok", [`siyue.${table}`])).rows[0].ok, false, table);
    }
    const owner = randomUUID();
    await legacy.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [owner]);
    const legacyFamily = randomUUID();
    await legacy.app.query('INSERT INTO siyue.families(id,owner_subject_id) VALUES($1,$2)', [legacyFamily, owner]);
    const opened = await transaction(legacy.app, client => roomCapacityRepository.openRoom(client, legacyFamily, owner, legacyFx.clock()));
    const seated = await transaction(legacy.app, client =>
      roomCapacityRepository.claimSeat(client, opened.id, identityOf(who), legacyFx.clock()));
    assert.deepEqual([seated.room.status, seated.seat.seat_index, seated.seat.session_id, seated.seat.subject_id],
      ['open', 1, who.session.sessionId, who.session.subjectId]);
  } finally { rmSync(directory, { recursive: true, force: true }); await legacy.stop(); }
});

test('the room tables hold their five-slot bound, their links and their live-slot index', async () => {
  assert.deepEqual(await indexesOf('rooms'), ['rooms_family', 'rooms_pkey']);
  assert.deepEqual(await indexesOf('room_seats'), ['room_seats_active_slot', 'room_seats_pkey', 'room_seats_session']);
  const slotIndex = (await rows("SELECT indexdef FROM pg_indexes WHERE schemaname='siyue' AND indexname='room_seats_active_slot'"))[0].indexdef;
  // At most one live seat per slot is a database fact, not only a service rule.
  assert.match(slotIndex, /CREATE UNIQUE INDEX/);
  assert.match(slotIndex, /WHERE \(released_at IS NULL\)/);

  const insertRoom = (overrides = {}) => {
    const row = { id: randomUUID(), family_id: null, created_by_subject_id: null, status: 'open', version: 1,
      created_at: fx.clock(), ended_at: null, ...overrides };
    return db.app.query(`INSERT INTO siyue.rooms(id,family_id,created_by_subject_id,status,version,created_at,ended_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [row.id, row.family_id, row.created_by_subject_id, row.status, row.version, row.created_at, row.ended_at]);
  };
  const insertSeat = (overrides = {}) => {
    const row = { room_id: null, session_id: null, subject_id: null, seat_index: 1, claimed_at: fx.clock(), released_at: null, ...overrides };
    return db.app.query(`INSERT INTO siyue.room_seats(room_id,session_id,subject_id,seat_index,claimed_at,released_at)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [row.room_id, row.session_id, row.subject_id, row.seat_index, row.claimed_at, row.released_at]);
  };
  const familyId = await family();
  const creator = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [creator]);

  // Room shape: an ended room always names when it ended, an open one never does.
  const started = fx.clock();
  assert.equal((await insertRoom({ family_id: familyId, created_by_subject_id: creator })).rows[0].status, 'open');
  await failure(insertRoom({ family_id: randomUUID(), created_by_subject_id: creator }), '23503', 'unknown family');
  await failure(insertRoom({ family_id: familyId, created_by_subject_id: randomUUID() }), '23503', 'unknown creator');
  await failure(insertRoom({ family_id: familyId, created_by_subject_id: creator, status: 'paused' }), '23514', 'unknown status');
  await failure(insertRoom({ family_id: familyId, created_by_subject_id: creator, ended_at: new Date(+started + 1_000) }), '23514', 'open room with an end stamp');
  await failure(insertRoom({ family_id: familyId, created_by_subject_id: creator, status: 'ended' }), '23514', 'ended room without an end stamp');
  await failure(insertRoom({ family_id: familyId, created_by_subject_id: creator, status: 'ended', ended_at: new Date(+started - 1_000) }), '23514', 'end before creation');
  await failure(insertRoom({ family_id: familyId, created_by_subject_id: creator, version: 0 }), '23514', 'room version bound');

  // Seat shape: one row per session, one live row per slot, and only slots 1–5 exist.
  const room = (await insertRoom({ family_id: familyId, created_by_subject_id: creator })).rows[0];
  const first = await sessionsForOneSubject(1);
  const second = await sessionsForOneSubject(1);
  const third = await sessionsForOneSubject(1);
  const seat = (who, overrides = {}) => insertSeat({ room_id: room.id, session_id: who.session.sessionId, subject_id: who.session.subjectId, ...overrides });
  assert.equal((await seat(first.issued[0], { seat_index: 5 })).rows[0].seat_index, 5);
  await failure(seat(first.issued[0]), '23505', 'second seat for one session');
  await failure(seat(second.issued[0], { seat_index: 5 }), '23505', 'two live seats in one slot');
  await failure(seat(second.issued[0], { seat_index: 0 }), '23514', 'slot below one');
  await failure(seat(second.issued[0], { seat_index: 6 }), '23514', 'sixth slot');
  await failure(seat(second.issued[0], { released_at: new Date(+fx.clock() - 1_000) }), '23514', 'release before claim');
  await failure(insertSeat({ room_id: randomUUID(), session_id: second.issued[0].session.sessionId, subject_id: second.subjectId }), '23503', 'unknown room');
  await failure(insertSeat({ room_id: room.id, session_id: randomUUID(), subject_id: second.subjectId }), '23503', 'unknown session');
  await failure(insertSeat({ room_id: room.id, session_id: second.issued[0].session.sessionId, subject_id: randomUUID() }), '23503', 'unknown subject');
  await failure(insertSeat({ room_id: room.id, session_id: second.issued[0].session.sessionId, subject_id: second.subjectId, seat_index: null }), '23502', 'slot required');
  // A released slot leaves the live index and can host another session, while history stays readable.
  await db.app.query('UPDATE siyue.room_seats SET released_at = $2 WHERE room_id = $1', [room.id, new Date(+fx.clock() + 1_000)]);
  assert.equal((await seat(second.issued[0], { seat_index: 5 })).rows[0].seat_index, 5);
  assert.equal((await seat(third.issued[0], { seat_index: 1 })).rows[0].seat_index, 1);
  assert.equal(await seatCount(room.id), 3);
});

test('only a session the server can still prove takes a seat', async () => {
  const { roomId } = await roomWithOwner();
  const owner = await adult();
  // The documented caller pattern: verify the session inside the very transaction that seats it, then
  // pass that exact identity. No accessToken ever reaches this module.
  const seated = await transaction(db.app, async client => {
    const session = await fx.service.verifyForMutation(client, owner.accessToken);
    return roomCapacityRepository.claimSeat(client, roomId, { sessionId: session.sessionId, subjectId: session.subjectId }, fx.clock());
  });
  assert.deepEqual([seated.seat.seat_index, seated.seat.session_id, seated.seat.subject_id],
    [1, owner.session.sessionId, owner.session.subjectId]);
  assert.equal((await liveSeats(roomId)).length, 1);

  const other = await adult();
  // A real session paired with another subject is not an identity, and neither is an invented session.
  await assert.rejects(claimIdentity(roomId, { sessionId: owner.session.sessionId, subjectId: other.session.subjectId }), refuses('ROOM_SESSION_INVALID'));
  await assert.rejects(claimIdentity(roomId, { sessionId: randomUUID(), subjectId: other.session.subjectId }), refuses('ROOM_SESSION_INVALID'));
  // Revoked, expired, blocked and credential-reset sessions are all refused by the database state.
  const revoked = await adult();
  await fx.service.logoutAccess(revoked.accessToken);
  await assert.rejects(claim(roomId, revoked), refuses('ROOM_SESSION_INVALID'));
  const expired = await adult();
  await db.app.query("UPDATE siyue.auth_sessions SET idle_expires_at = now() - interval '1 minute' WHERE id=$1", [expired.session.sessionId]);
  await assert.rejects(claim(roomId, expired), refuses('ROOM_SESSION_INVALID'));
  const blocked = await adult();
  await db.app.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1", [blocked.session.subjectId]);
  await assert.rejects(claim(roomId, blocked), refuses('ROOM_SESSION_INVALID'));
  const bumped = await adult();
  await db.app.query('UPDATE siyue.subjects SET credential_version = credential_version + 1 WHERE id=$1', [bumped.session.subjectId]);
  await assert.rejects(claim(roomId, bumped), refuses('ROOM_SESSION_INVALID'));
  const lapsedChild = await childSession(new Date(Date.now() - 300_000));
  await assert.rejects(claim(roomId, lapsedChild), refuses('ROOM_SESSION_INVALID'));
  // Boundary: this kernel proves the session row itself. The deeper child checks — device grant,
  // guardian relationship, family state — stay with verifyForMutation, which the caller runs first;
  // a seat row is not a credential either way.
  const liveChild = await childSession(new Date(Date.now() + 3_600_000));
  assert.equal((await claim(roomId, liveChild)).seat.seat_index, 2);
  // Every refusal above wrote nothing, and the refused sessions were never revoked by the kernel.
  assert.deepEqual((await liveSeats(roomId)).map(row => row.session_id), [owner.session.sessionId, liveChild.session.sessionId]);
  assert.deepEqual(await fx.service.verify(revoked.accessToken).then(() => 'still live', () => 'revoked'), 'revoked');
});

test('a session that lapses while the claim transaction is open is refused', async () => {
  const { roomId } = await roomWithOwner();
  const who = await adult();
  const client = await db.app.connect();
  try {
    await client.query('BEGIN');
    // The deadline falls 300 ms after this transaction started, so a session validity read pinned to the
    // transaction start would still call the session live for as long as the caller's transaction runs.
    // A caller that opens a transaction and seats someone seconds later must see the deadline pass.
    await db.app.query("UPDATE siyue.auth_sessions SET idle_expires_at = now() + interval '300 milliseconds' WHERE id=$1",
      [who.session.sessionId]);
    await client.query('SELECT pg_sleep(1)');
    await assert.rejects(roomCapacityRepository.claimSeat(client, roomId, identityOf(who), fx.clock()),
      refuses('ROOM_SESSION_INVALID'));
  } finally {
    // Roll back even when the assertion above fails: a leaked open transaction would block the next test.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  assert.deepEqual([await seatCount(roomId), await liveSeatCount(roomId)], [0, 0]);
  assert.deepEqual(await fx.service.verify(who.accessToken).then(() => 'still issued', () => 'revoked'), 'still issued');
});

test('five different sessions take the five seats and a sixth is refused without evicting anyone', async () => {
  const { roomId } = await roomWithOwner();
  const seated = [];
  for (let index = 1; index <= roomSeatCapacity; index += 1) {
    const who = await adult();
    const claimed = await claim(roomId, who);
    assert.deepEqual([claimed.seats.length, claimed.seat.seat_index, claimed.seat.session_id, claimed.seat.subject_id],
      [index, index, who.session.sessionId, who.session.subjectId]);
    seated.push(who);
  }
  const stored = await storedSeats(roomId);
  assert.deepEqual(stored.map(row => row.seat_index), [1, 2, 3, 4, 5]);
  assert.deepEqual(stored.map(row => row.session_id), seated.map(who => who.session.sessionId));
  assert.equal(await liveSeatCount(roomId), roomSeatCapacity);

  const sixth = await adult();
  await assert.rejects(claim(roomId, sixth), refuses('ROOM_SEATS_FULL'));
  // The refusal changes nothing: the seated five keep their sessions, slots and claim instants.
  assert.deepEqual((await storedSeats(roomId)).map(row => [row.session_id, row.seat_index, +row.claimed_at, row.released_at]),
    stored.map(row => [row.session_id, row.seat_index, +row.claimed_at, row.released_at]));
  assert.equal(await seatCount(roomId), roomSeatCapacity);
  // Refusing a seat is not a revocation, and the refused session holds no seat at all.
  assert.deepEqual(await fx.service.verify(sixth.accessToken), sixth.session);
  assert.equal((await liveSeats(roomId)).some(row => row.session_id === sixth.session.sessionId), false);
});

test('one subject on two sessions holds two seats and a retry never adds one', async () => {
  const { roomId } = await roomWithOwner();
  const { subjectId, issued } = await sessionsForOneSubject(2);
  const [first, second] = issued;
  const held = [await claim(roomId, first), await claim(roomId, second)];
  assert.deepEqual(held.map(entry => entry.seat.seat_index), [1, 2]);
  // Identity is the server session, not the account: one subject on two devices costs two seats.
  assert.deepEqual(held.map(entry => entry.seat.subject_id), [subjectId, subjectId]);
  assert.deepEqual(held.map(entry => entry.seat.session_id), [first.session.sessionId, second.session.sessionId]);

  // A retry of the same room+session returns the seat that session already holds, never a second one.
  assert.deepEqual((await claim(roomId, first)).seat, held[0].seat);
  assert.deepEqual((await claim(roomId, second)).seat, held[1].seat);
  assert.equal(await seatCount(roomId), 2);
  // The same session in another room is a separate seat, and a third session still takes a third one.
  const other = await roomWithOwner();
  assert.equal((await claim(other.roomId, first)).seat.seat_index, 1);
  assert.deepEqual([await seatCount(roomId), await seatCount(other.roomId)], [2, 1]);
  const { issued: thirds } = await sessionsForOneSubject(1);
  assert.equal((await claim(roomId, thirds[0])).seat.seat_index, 3);
});

test('a client-reported installation id can neither merge nor multiply seats', async () => {
  const { roomId } = await roomWithOwner();
  const installationId = randomUUID();
  // Two real sessions that report the same installation are two devices: the bound counts sessions, so a
  // copied or forged installation id cannot dodge it and cannot collapse two devices into one seat.
  const { subjectId, issued } = await sessionsForOneSubject(2, installationId);
  const [first, second] = issued;
  const stored = await rows('SELECT id, installation_id FROM siyue.auth_sessions WHERE subject_id=$1', [subjectId]);
  assert.deepEqual(stored.map(row => row.installation_id), [installationId, installationId]);
  assert.equal(new Set(stored.map(row => row.id)).size, 2);
  assert.deepEqual([(await claim(roomId, first)).seat.seat_index, (await claim(roomId, second)).seat.seat_index], [1, 2]);
  assert.equal(await seatCount(roomId), 2);
  // The identity shape is strict, so an installation id, a slot or a role can never be smuggled in.
  await assert.rejects(claimIdentity(roomId, { ...identityOf(first), installationId }), refuses('ROOM_CAPACITY_INVALID_REQUEST'));
  assert.equal(await count("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='siyue' AND table_name='room_seats' AND column_name LIKE '%installation%'"), 0);
});

test('concurrent claims for the last seat admit exactly one session', async () => {
  const { roomId } = await roomWithOwner();
  for (let index = 1; index < roomSeatCapacity; index += 1) await claim(roomId, await adult());
  assert.equal(await liveSeatCount(roomId), roomSeatCapacity - 1);

  const contenders = [await adult(), await adult(), await adult()];
  const settled = await Promise.allSettled(contenders.map(who => claim(roomId, who)));
  const won = settled.filter(entry => entry.status === 'fulfilled');
  assert.equal(won.length, 1, 'exactly one concurrent claim may take the last seat');
  for (const lost of settled.filter(entry => entry.status === 'rejected')) assert.ok(refuses('ROOM_SEATS_FULL')(lost.reason), String(lost.reason?.code));
  const stored = await storedSeats(roomId);
  assert.deepEqual(stored.map(row => row.seat_index), [1, 2, 3, 4, 5]);
  const winner = won[0].value.seat.session_id;
  assert.equal(stored.filter(row => row.session_id === winner).length, 1);
  assert.equal(stored.find(row => row.seat_index === roomSeatCapacity).session_id, winner);
  for (const loser of contenders) if (loser.session.sessionId !== winner)
    assert.equal(stored.some(row => row.session_id === loser.session.sessionId), false);
  assert.equal(await liveSeatCount(roomId), roomSeatCapacity);
});

// The kernel writes family → room. A caller that legitimately needs the family row later in the same
// transaction — its own family-state bookkeeping, a freeze coordination step, an authorization record —
// must wait for a concurrent claim, never close a wait cycle with it. A deadlock is an error, not a refusal.
test('a release that needs the family row later cannot deadlock a concurrent claim', async () => {
  const { roomId, owner, familyId } = await roomWithOwner();
  await claim(roomId, owner);
  const releaser = await rawTransaction();
  const joiner = await rawTransaction();
  try {
    // Exactly what an authorized caller runs, still inside its own transaction.
    assert.equal((await roomCapacityRepository.releaseSeat(releaser.client, roomId, identityOf(owner), fx.clock()))?.session_id,
      owner.session.sessionId);
    const contender = await adult();
    const claiming = settledValue(roomCapacityRepository.claimSeat(joiner.client, roomId, identityOf(contender), fx.clock()));
    // Assert the interleaving instead of racing it: the claim is already queued on a lock before the
    // releasing transaction asks for the family row.
    await waitForLockWait(joiner.pid);
    const family = settledValue(releaser.client.query('SELECT 1 FROM siyue.families WHERE id=$1 FOR UPDATE', [familyId]));
    const releasedCommit = settledValue(releaser.client.query('COMMIT'));
    const claimed = await claiming;
    await settledValue(joiner.client.query('COMMIT'));
    assert.deepEqual([label(await family), label(await releasedCommit), label(claimed)], ['ok', 'ok', 'ok'],
      `a release must take the family lock before the room lock: ${label(claimed)}`);
    assert.deepEqual((await liveSeats(roomId)).map(seat => seat.session_id), [contender.session.sessionId]);
  } finally { await releaser.close(); await joiner.close(); }
});

test('an end that needs the family row later cannot deadlock a concurrent claim', async () => {
  const { roomId, familyId } = await roomWithOwner();
  const ender = await rawTransaction();
  const joiner = await rawTransaction();
  try {
    assert.equal((await roomCapacityRepository.endRoom(ender.client, roomId, 1, fx.clock())).status, 'ended');
    const contender = await adult();
    const claiming = settledValue(roomCapacityRepository.claimSeat(joiner.client, roomId, identityOf(contender), fx.clock()));
    await waitForLockWait(joiner.pid);
    const family = settledValue(ender.client.query('SELECT 1 FROM siyue.families WHERE id=$1 FOR UPDATE', [familyId]));
    const endedCommit = settledValue(ender.client.query('COMMIT'));
    const claimed = await claiming;
    await settledValue(joiner.client.query('COMMIT'));
    assert.deepEqual([label(await family), label(await endedCommit)], ['ok', 'ok'],
      `an end must take the family lock before the room lock: ${label(claimed)}`);
    // The queued claim waits, then reads the durable end instead of failing with a deadlock.
    assert.ok(claimed instanceof RoomCapacityError && claimed.code === 'ROOM_ENDED',
      `the queued claim must see the ended room rather than deadlock: ${label(claimed)}`);
    assert.equal(await liveSeatCount(roomId), 0);
  } finally { await ender.close(); await joiner.close(); }
});

test('an initiator leaving releases only its seat and the room remains open', async () => {
  const { roomId, owner } = await roomWithOwner();
  const other = await adult();
  await claim(roomId, owner);
  await claim(roomId, other);
  assert.equal(await leave(roomId, await adult()), null, 'an unseated caller cannot remove another session');
  assert.equal(await liveSeatCount(roomId), 2);
  const left = await leave(roomId, owner);
  assert.equal(left?.session_id, owner.session.sessionId);
  assert.ok(left?.released_at);
  assert.deepEqual([await liveSeatCount(roomId), (await roomOf(roomId)).status], [1, 'open']);
  assert.deepEqual((await liveSeats(roomId)).map(seat => seat.session_id), [other.session.sessionId]);
  assert.deepEqual(await leave(roomId, owner), left, 'leaving twice must not release another seat');
  const next = await adult();
  const replacement = await claim(roomId, next);
  assert.equal(replacement.seat.seat_index, 1);
  assert.deepEqual(replacement.seats.map(seat => seat.seat_index), [1, 2]);
  assert.deepEqual((await liveSeats(roomId)).map(seat => seat.session_id), [next.session.sessionId, other.session.sessionId]);
  const returned = await claim(roomId, owner);
  assert.equal(returned.seat.seat_index, 3, 'the same session may join again in a free slot');
  assert.deepEqual(returned.seats.map(seat => seat.seat_index), [1, 2, 3]);
  assert.equal(await liveSeatCount(roomId), 3);
  assert.equal(await seatCount(roomId), 3, 'rejoining must reactivate the existing row');
  await leave(roomId, owner);
  for (let index = 0; index < 3; index += 1) await claim(roomId, await adult());
  assert.equal(await liveSeatCount(roomId), roomSeatCapacity);
  await assert.rejects(claim(roomId, owner), refuses('ROOM_SEATS_FULL'));
  assert.equal((await rows('SELECT released_at FROM siyue.room_seats WHERE room_id=$1 AND session_id=$2',
    roomId, owner.session.sessionId))[0].released_at !== null, true, 'a full room must not silently revive an old seat');
});

test('an ended room refuses new seats, never resurrects a released seat and ends idempotently', async () => {
  const { roomId } = await roomWithOwner();
  const seated = await adult();
  await claim(roomId, seated);
  const ended = await endRoom(roomId, 1);
  assert.deepEqual([ended.status, ended.version, ended.ended_at !== null], ['ended', 2, true]);
  assert.deepEqual((await storedSeats(roomId)).map(row => [row.seat_index, row.released_at !== null]), [[1, true]]);
  assert.deepEqual(await liveSeats(roomId), []);
  // Room history is kept: the seat row survives as released evidence instead of being deleted.
  assert.equal(await seatCount(roomId), 1);

  // No new seat, and no resurrection of the released one, because the room itself is closed.
  await assert.rejects(claim(roomId, await adult()), refuses('ROOM_ENDED'));
  await assert.rejects(claim(roomId, seated), refuses('ROOM_ENDED'));
  assert.equal(await seatCount(roomId), 1);
  // Ending again is idempotent: the version does not move a second time.
  assert.deepEqual((await endRoom(roomId, 1)).version, 2);
  // A stale version on an open room is refused without a write.
  const other = await roomWithOwner();
  await assert.rejects(endRoom(other.roomId, 7), refuses('ROOM_VERSION_CONFLICT'));
  const stale = await roomRow(other.roomId);
  assert.deepEqual([stale.status, stale.version, stale.ended_at], ['open', 1, null]);
});

test('a failed transaction leaves no seat and no room end behind', async () => {
  const { roomId } = await roomWithOwner();
  const who = await adult();
  // The repository is caller-scoped: a claim that fails after its insert rolls back whole.
  await assert.rejects(transaction(db.app, async client => {
    await roomCapacityRepository.claimSeat(client, roomId, identityOf(who), fx.clock());
    throw new Error('synthetic_failure_after_claim');
  }), /synthetic_failure_after_claim/);
  assert.deepEqual([await seatCount(roomId), await liveSeatCount(roomId)], [0, 0]);
  await claim(roomId, who);
  // Ending a room releases its seats in the same transaction, so a failure there restores both.
  await assert.rejects(transaction(db.app, async client => {
    await roomCapacityRepository.endRoom(client, roomId, 1, fx.clock());
    throw new Error('synthetic_failure_after_end');
  }), /synthetic_failure_after_end/);
  const restored = await roomRow(roomId);
  assert.deepEqual([restored.status, restored.version, restored.ended_at], ['open', 1, null]);
  assert.deepEqual((await storedSeats(roomId)).map(row => [row.seat_index, row.released_at]), [[1, null]]);
  assert.equal((await claim(roomId, who)).seat.seat_index, 1);
  await assert.rejects(transaction(db.app, async client => {
    await roomCapacityRepository.releaseSeat(client, roomId, identityOf(who), fx.clock());
    throw new Error('synthetic_failure_after_leave');
  }), /synthetic_failure_after_leave/);
  assert.deepEqual((await storedSeats(roomId)).map(row => [row.seat_index, row.released_at]), [[1, null]]);
});

test('rooms keep independent capacity, one session may sit in two rooms and an end stays local', async () => {
  const first = await roomWithOwner();
  const second = await roomWithOwner();
  const both = await adult();
  const others = [await adult(), await adult(), await adult(), await adult()];
  for (const who of [both, ...others]) assert.equal((await claim(first.roomId, who)).room.id, first.roomId);
  await assert.rejects(claim(first.roomId, await adult()), refuses('ROOM_SEATS_FULL'));
  // Another room starts empty, and the same session may hold one seat in each room.
  const seatedElsewhere = await claim(second.roomId, both);
  assert.deepEqual([seatedElsewhere.room.id, seatedElsewhere.seat.seat_index], [second.roomId, 1]);
  assert.deepEqual([await liveSeatCount(first.roomId), await liveSeatCount(second.roomId)], [roomSeatCapacity, 1]);
  assert.deepEqual((await liveSeats(first.roomId)).filter(row => row.session_id === both.session.sessionId).map(row => row.seat_index), [1]);
  // Ending the full room frees nothing for a later claim and does not touch the other room.
  await endRoom(first.roomId, 1);
  await assert.rejects(claim(first.roomId, await adult()), refuses('ROOM_ENDED'));
  assert.deepEqual([await liveSeatCount(first.roomId), await liveSeatCount(second.roomId)], [0, 1]);
  assert.deepEqual([(await roomOf(first.roomId)).status, (await roomOf(second.roomId)).status], ['ended', 'open']);
});

test('malformed input and unknown objects are refused before any write', async () => {
  const { roomId } = await roomWithOwner();
  const owner = await adult();
  for (const badRoom of ['', 'not-a-uuid', `${roomId} `, null, 42, undefined])
    await assert.rejects(claimIdentity(badRoom, identityOf(owner)), refuses('ROOM_CAPACITY_INVALID_REQUEST'));
  // The seat identity is strict: an installation id, a slot, a role or a partial pair never seats.
  for (const badIdentity of [{}, { sessionId: randomUUID() }, { subjectId: randomUUID() },
    { ...identityOf(owner), seatIndex: 1 }, { ...identityOf(owner), role: 'owner' }, { ...identityOf(owner), subjectKind: 'adult' },
    null, undefined, 'session-a'])
    await assert.rejects(claimIdentity(roomId, badIdentity), refuses('ROOM_CAPACITY_INVALID_REQUEST'));
  await assert.rejects(openRoom('family-a', owner.session.subjectId), refuses('ROOM_CAPACITY_INVALID_REQUEST'));
  await assert.rejects(openRoom(await family(), randomUUID()), refuses('ROOM_CREATOR_NOT_FOUND'));
  await assert.rejects(openRoom(randomUUID(), owner.session.subjectId), refuses('ROOM_FAMILY_NOT_FOUND'));
  await assert.rejects(openRoom(await family(), 'not-a-uuid'), refuses('ROOM_CAPACITY_INVALID_REQUEST'));
  await assert.rejects(claimIdentity(randomUUID(), identityOf(owner)), refuses('ROOM_NOT_FOUND'));
  await assert.rejects(endRoom(randomUUID(), 1), refuses('ROOM_NOT_FOUND'));
  for (const badVersion of [0, -1, 1.5, '1', null, undefined])
    await assert.rejects(endRoom(roomId, badVersion), refuses('ROOM_CAPACITY_INVALID_REQUEST'));
  await assert.rejects(endRoom(roomId, 7), refuses('ROOM_VERSION_CONFLICT'));
  await assert.rejects(roomOf('not-a-uuid'), refuses('ROOM_CAPACITY_INVALID_REQUEST'));
  await assert.rejects(liveSeats('not-a-uuid'), refuses('ROOM_CAPACITY_INVALID_REQUEST'));
  // Every refusal above wrote nothing: one room exists, it is still open, and no seat does.
  assert.deepEqual([await count('SELECT count(*)::int AS n FROM siyue.rooms'), await liveSeatCount(roomId),
    (await roomRow(roomId)).status], [1, 0, 'open']);
});
