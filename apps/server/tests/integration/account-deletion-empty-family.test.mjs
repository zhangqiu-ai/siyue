import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createFamilyRepository } from '../../dist/modules/families/repository.js';
import { dissolveEmptyOwnedFamilyForDeletion } from '../../dist/modules/auth/account-deletion-empty-family.js';

// Isolated temporary PostgreSQL cluster only: the fixture always builds a fresh cluster on a short Unix
// socket and never reads a database URL or the workspace .env. Every subject, family, child, consent,
// invitation, pairing, grant, room, seat, acceptance and review marker below is synthetic, and no HTTP
// route, mail, provider, RTC vendor or network call happens here.
//
// "The sole owner ends a family that never had anyone else" is an internal step with no HTTP surface, so
// every call runs inside a caller-owned transaction that already holds the deleting subject lock, exactly
// as the future deletion acceptance kernel must call it.
let db, fx;
const refuses = (code, status) => error => error?.code === code && error?.status === status;
const rows = (sql, params) => db.app.query(sql, params).then(result => result.rows);
const row = (sql, params) => rows(sql, params).then(result => result[0]);
const count = (sql, params) => rows(sql, params).then(result => Number(result[0].n));
/** 64 hex characters unique per call, for the columns that store a keyed digest. */
const digest = () => randomUUID().replaceAll('-', '').repeat(2);

before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query('TRUNCATE siyue.subjects CASCADE');
  fx = await createEmailFixture(db);
});
after(async () => { await db?.stop(); });

/** An adult subject without a session, for scenes that only need a subject row to point at. */
async function adultSubject() {
  const id = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [id]);
  return id;
}

async function childSubject() {
  const id = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'child','Synthetic Child')", [id]);
  return id;
}

/** One active family whose only membership row and only create request belong to its owner. */
async function emptyFamily() {
  const owner = await fx.issue();
  const ownerId = owner.session.subjectId, key = digest();
  const family = await transaction(db.app, client =>
    createFamilyRepository(db.app).create(client, ownerId, key));
  return {owner, ownerId, key, family};
}

const dissolve = (subjectId, familyId) => transaction(db.app, client =>
  dissolveEmptyOwnedFamilyForDeletion(client, subjectId, familyId));

/** The step's own rows are gone, and nothing anywhere still hangs off the removed family. */
async function assertFamilyGone(familyId, ownerId) {
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.families WHERE id=$1', [familyId]), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.families WHERE owner_subject_id=$1',
    [ownerId]), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1',
    [familyId]), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_create_requests WHERE family_id=$1',
    [familyId]), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE subject_id=$1',
    [ownerId]), 0);
  assert.equal(await count(`SELECT ((SELECT count(*) FROM siyue.family_invitations WHERE family_id=$1)
    + (SELECT count(*) FROM siyue.guardian_relationships WHERE family_id=$1)
    + (SELECT count(*) FROM siyue.device_grants WHERE family_id=$1)
    + (SELECT count(*) FROM siyue.device_pairing_requests WHERE family_id=$1)
    + (SELECT count(*) FROM siyue.rooms WHERE family_id=$1)
    + (SELECT count(*) FROM siyue.family_management_acceptances WHERE family_id=$1)
    + (SELECT count(*) FROM siyue.account_deletion_family_reviews WHERE family_id=$1))::int AS n`, [familyId]), 0);
}

/** Everything a refused step must leave exactly as it was. */
async function assertFamilyIntact(value) {
  assert.deepEqual(await row('SELECT status,owner_subject_id,version FROM siyue.families WHERE id=$1',
    [value.family.familyId]),
  {status:'active',owner_subject_id:value.ownerId,version:1});
  assert.deepEqual(await row('SELECT role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, value.ownerId]), {role:'owner',active:true,version:1});
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_create_requests WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, value.ownerId]), 1);
  assert.equal((await createFamilyRepository(db.app).list(value.ownerId)).length, 1);
}

async function invitationInto(familyId, inviterId) {
  const id = randomUUID();
  await db.app.query(`INSERT INTO siyue.family_invitations
    (id,family_id,inviter_id,token_hash,status,policy_version,inviter_membership_version,family_version,expires_at)
    VALUES($1,$2,$3,$4,'pending','1.0',1,1,now()+interval '1 day')`, [id, familyId, inviterId, digest()]);
  return id;
}

async function guardianshipIn(familyId, guardianId, withdrawn = false) {
  const childId = await childSubject(), consentId = randomUUID();
  await db.app.query(`INSERT INTO siyue.consent_records
    (id,actor_subject_id,subject_id,purpose,policy_version,withdrawn_at)
    VALUES($1,$2,$3,'child-guardianship','1.0',CASE WHEN $4 THEN now() ELSE NULL END)`,
  [consentId, guardianId, childId, withdrawn]);
  await db.app.query(`INSERT INTO siyue.guardian_relationships
    (family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)`,
  [familyId, guardianId, childId, consentId]);
  return {childId, consentId};
}

async function grantInto(familyId, guardianId, revoked = false) {
  const childId = await childSubject(), id = randomUUID();
  await db.app.query(`INSERT INTO siyue.device_grants
    (id,child_subject_id,guardian_id,family_id,installation_id,platform,device_label,
     guardian_relationship_version,guardian_credential_version,scopes,expires_at,revoked_at)
    VALUES($1,$2,$3,$4,$5,'ios','Synthetic iPad',1,1,ARRAY[]::text[],now()+interval '1 day',
      CASE WHEN $6 THEN now() ELSE NULL END)`,
  [id, childId, guardianId, familyId, randomUUID(), revoked]);
  return id;
}

async function pairingBy(familyId, approverId, childId) {
  const id = randomUUID();
  await db.app.query(`INSERT INTO siyue.device_pairing_requests
    (id,request_token_hash,poll_secret_hash,installation_id,platform,status,approved_by,child_subject_id,
     family_id,approved_guardian_version,approved_credential_version,created_at,expires_at,approved_at)
    VALUES($1,$2,$3,$4,'ios','approved',$5,$6,$7,1,1,now(),now()+interval '2 minutes',now())`,
  [id, digest(), digest(), randomUUID(), approverId, childId, familyId]);
  return id;
}

async function roomIn(familyId, creatorId, status = 'open') {
  const id = randomUUID();
  await db.app.query("INSERT INTO siyue.rooms(id,family_id,created_by_subject_id,status,ended_at) VALUES($1,$2,$3,$4,CASE WHEN $4::text='ended' THEN now() ELSE NULL END)",
    [id, familyId, creatorId, status]);
  return id;
}

async function seatIn(roomId, sessionId, subjectId) {
  await db.app.query('INSERT INTO siyue.room_seats(room_id,session_id,subject_id,seat_index) VALUES($1,$2,$3,1)',
    [roomId, sessionId, subjectId]);
}

async function acceptanceFor(familyId, ownerId) {
  const id = randomUUID(), recipientId = await adultSubject();
  await db.app.query(`INSERT INTO siyue.family_management_acceptances
    (id,family_id,owner_subject_id,recipient_subject_id,family_version,recipient_membership_version,
     owner_membership_version,child_scope_digest,accepted_at,expires_at,retain_until)
    VALUES($1,$2,$3,$4,1,1,1,$5,now(),now()+interval '1 hour',now()+interval '1 day')`,
  [id, familyId, ownerId, recipientId, digest()]);
  return id;
}

async function reviewFor(familyId, subjectId) {
  const jobId = randomUUID(), id = randomUUID();
  await db.app.query(`INSERT INTO siyue.account_deletion_jobs
    (id,subject_id,state,requested_at,receipt_secret_hash,receipt_expires_at)
    VALUES($1,$2,'accepted',now(),$3,now()+interval '30 days')`, [jobId, subjectId, digest()]);
  await db.app.query(`INSERT INTO siyue.account_deletion_family_reviews
    (id,deletion_id,family_id,deleting_subject_id,state,opened_at)
    VALUES($1,$2,$3,$4,'pending',now())`, [id, jobId, familyId, subjectId]);
  return id;
}

test('a sole owner ends an empty family without leaving a single row that points at them', async () => {
  const value = await emptyFamily();
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_create_requests WHERE family_id=$1',
    [value.family.familyId]), 1);

  assert.equal(await dissolve(value.ownerId, value.family.familyId), undefined);

  await assertFamilyGone(value.family.familyId, value.ownerId);
  assert.deepEqual(await createFamilyRepository(db.app).list(value.ownerId), []);
  assert.equal(await createFamilyRepository(db.app).get(value.ownerId, value.family.familyId), null);
  // The idempotency row went with the family, so the very same key may create a new one instead of the
  // replay reading a family that no longer exists as a conflict.
  const recreated = await transaction(db.app, client =>
    createFamilyRepository(db.app).create(client, value.ownerId, value.key));
  assert.notEqual(recreated.familyId, value.family.familyId);
  assert.equal((await createFamilyRepository(db.app).list(value.ownerId)).length, 1);
});

test('a family that ever had another member is refused, active or inactive', async () => {
  const variants = [
    ['an active adult member', async value => {
      await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
        [value.family.familyId, await adultSubject()]);
    }],
    ['an inactive historical member', async value => {
      await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,active) VALUES($1,$2,'member',false)",
        [value.family.familyId, await adultSubject()]);
    }],
    ['an inactive historical child', async value => {
      await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,active) VALUES($1,$2,'member',false)",
        [value.family.familyId, await childSubject()]);
    }],
  ];
  for (const [label, mutate] of variants) {
    const value = await emptyFamily();
    await mutate(value);
    await assert.rejects(dissolve(value.ownerId, value.family.familyId),
      refuses('AUTH_DELETION_DEPENDENCIES', 409), label);
    await assertFamilyIntact(value);
    assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1',
      [value.family.familyId]), 2, label);
  }
});

test('a family that holds any shared or family-scoped record is refused and swept by nobody', async () => {
  const variants = [
    ['a pending invitation', async value => ({id: await invitationInto(value.family.familyId, value.ownerId),
      sql: 'SELECT count(*)::int AS n FROM siyue.family_invitations WHERE id=$1'})],
    ['a guardianship with a live consent', async value => {
      const {consentId} = await guardianshipIn(value.family.familyId, value.ownerId);
      return {id: consentId, sql: 'SELECT count(*)::int AS n FROM siyue.consent_records WHERE id=$1 AND withdrawn_at IS NULL'};
    }],
    ['a guardianship whose consent was withdrawn', async value => {
      const {consentId} = await guardianshipIn(value.family.familyId, value.ownerId, true);
      return {id: consentId,
        sql: 'SELECT count(*)::int AS n FROM siyue.guardian_relationships WHERE consent_record_id=$1'};
    }],
    ['a child device grant', async value => ({id: await grantInto(value.family.familyId, value.ownerId),
      sql: 'SELECT count(*)::int AS n FROM siyue.device_grants WHERE id=$1'})],
    ['an approved pairing request', async value =>
      ({id: await pairingBy(value.family.familyId, value.ownerId, await childSubject()),
        sql: 'SELECT count(*)::int AS n FROM siyue.device_pairing_requests WHERE id=$1'})],
    ['an open room', async value => ({id: await roomIn(value.family.familyId, value.ownerId),
      sql: 'SELECT count(*)::int AS n FROM siyue.rooms WHERE id=$1'})],
    ['a live seat in one of its rooms', async value => {
      const roomId = await roomIn(value.family.familyId, value.ownerId);
      await seatIn(roomId, value.owner.session.sessionId, value.ownerId);
      return {id: roomId, sql: 'SELECT count(*)::int AS n FROM siyue.room_seats WHERE room_id=$1 AND released_at IS NULL'};
    }],
    ['a management acceptance', async value => ({id: await acceptanceFor(value.family.familyId, value.ownerId),
      sql: 'SELECT count(*)::int AS n FROM siyue.family_management_acceptances WHERE id=$1'})],
    ['a pending family review marker', async value =>
      ({id: await reviewFor(value.family.familyId, value.ownerId),
        sql: "SELECT count(*)::int AS n FROM siyue.account_deletion_family_reviews WHERE id=$1 AND state='pending'"})],
  ];
  for (const [label, setup] of variants) {
    const value = await emptyFamily();
    const {id, sql} = await setup(value);
    await assert.rejects(dissolve(value.ownerId, value.family.familyId),
      refuses('AUTH_DELETION_DEPENDENCIES', 409), label);
    await assertFamilyIntact(value);
    assert.equal(await count(sql, [id]), 1, label);
  }
});

test('a record that is already closed still refuses the family instead of being deleted with it', async () => {
  const variants = [
    ['a revoked device grant', async value => ({id: await grantInto(value.family.familyId, value.ownerId, true),
      sql: 'SELECT count(*)::int AS n FROM siyue.device_grants WHERE id=$1'})],
    ['a revoked invitation', async value => {
      const id = await invitationInto(value.family.familyId, value.ownerId);
      await db.app.query("UPDATE siyue.family_invitations SET status='revoked' WHERE id=$1", [id]);
      return {id, sql: 'SELECT count(*)::int AS n FROM siyue.family_invitations WHERE id=$1'};
    }],
    ['an ended room with a released seat', async value => {
      const roomId = await roomIn(value.family.familyId, value.ownerId, 'ended');
      await seatIn(roomId, value.owner.session.sessionId, value.ownerId);
      await db.app.query('UPDATE siyue.room_seats SET released_at=now() WHERE room_id=$1', [roomId]);
      return {id: roomId, sql: 'SELECT count(*)::int AS n FROM siyue.rooms WHERE id=$1'};
    }],
  ];
  for (const [label, setup] of variants) {
    const value = await emptyFamily();
    const {id, sql} = await setup(value);
    await assert.rejects(dissolve(value.ownerId, value.family.familyId),
      refuses('AUTH_DELETION_DEPENDENCIES', 409), label);
    await assertFamilyIntact(value);
    assert.equal(await count(sql, [id]), 1, label);
  }
});

test('a create request belonging to another subject refuses the family instead of being deleted', async () => {
  const value = await emptyFamily(), strangerId = await adultSubject();
  await db.app.query('INSERT INTO siyue.family_create_requests(subject_id,key_hash,family_id) VALUES($1,$2,$3)',
    [strangerId, digest(), value.family.familyId]);

  await assert.rejects(dissolve(value.ownerId, value.family.familyId),
    refuses('AUTH_DELETION_DEPENDENCIES', 409));
  await assertFamilyIntact(value);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_create_requests WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, strangerId]), 1);
});

test('refuses a caller who is not the current active owner of an active family', async () => {
  const variants = [
    // Who is asking: a stranger, an owner of a different family, or a non-owner member of this family.
    ['a stranger who is not a member', async () => ({caller: await adultSubject()})],
    ['an owner of another family', async () => ({caller: (await emptyFamily()).ownerId})],
    ['a member who is not the owner', async value => {
      const memberId = await adultSubject();
      await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
        [value.family.familyId, memberId]);
      return {caller: memberId};
    }],
    // What is being asked: a family that is not active, or an owner membership or subject that is not live.
    ['a frozen family', async value => {
      await db.app.query("UPDATE siyue.families SET status='frozen' WHERE id=$1", [value.family.familyId]);
      return {caller: value.ownerId};
    }],
    ['a dissolved family', async value => {
      await db.app.query("UPDATE siyue.families SET status='dissolved' WHERE id=$1", [value.family.familyId]);
      return {caller: value.ownerId};
    }],
    ['an owner membership that is no longer active', async value => {
      await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2',
        [value.family.familyId, value.ownerId]);
      return {caller: value.ownerId};
    }],
    ['a blocked owner subject', async value => {
      await db.app.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1", [value.ownerId]);
      return {caller: value.ownerId};
    }],
  ];
  for (const [label, setup] of variants) {
    const value = await emptyFamily();
    const {caller} = await setup(value);
    await assert.rejects(dissolve(caller, value.family.familyId),
      refuses('AUTH_DELETION_DEPENDENCIES', 409), label);
    assert.equal(await count('SELECT count(*)::int AS n FROM siyue.families WHERE id=$1',
      [value.family.familyId]), 1, label);
    assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_create_requests WHERE family_id=$1',
      [value.family.familyId]), 1, label);
  }
});

test('an owner who is a child subject is refused', async () => {
  const childId = await childSubject();
  const familyId = randomUUID();
  await db.app.query("INSERT INTO siyue.families(id,status,owner_subject_id) VALUES($1,'active',$2)",
    [familyId, childId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,active) VALUES($1,$2,'owner',true)",
    [familyId, childId]);

  await assert.rejects(dissolve(childId, familyId), refuses('AUTH_DELETION_DEPENDENCIES', 409));
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.families WHERE id=$1', [familyId]), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1',
    [familyId]), 1);
});

test('another family, including one the same owner still owns, is left alone', async () => {
  const value = await emptyFamily();
  // A second family the very same owner owns, holding the same kinds of rows the step refuses in the
  // family it is settling: only the family named in the call may be judged or touched.
  const alsoOwned = await transaction(db.app, client =>
    createFamilyRepository(db.app).create(client, value.ownerId, digest()));
  const alsoOwnedRoom = await roomIn(alsoOwned.familyId, value.ownerId);
  await seatIn(alsoOwnedRoom, value.owner.session.sessionId, value.ownerId);
  const alsoOwnedGuardianship = await guardianshipIn(alsoOwned.familyId, value.ownerId);
  const shared = await emptyFamily();
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [shared.family.familyId, await adultSubject()]);

  await dissolve(value.ownerId, value.family.familyId);

  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.families WHERE id=$1',
    [value.family.familyId]), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1',
    [value.family.familyId]), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_create_requests WHERE family_id=$1',
    [value.family.familyId]), 0);
  assert.deepEqual(await row('SELECT status,version FROM siyue.families WHERE id=$1', [alsoOwned.familyId]),
    {status:'active',version:1});
  assert.deepEqual(await row('SELECT role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [alsoOwned.familyId, value.ownerId]), {role:'owner',active:true,version:1});
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_create_requests WHERE family_id=$1 AND subject_id=$2',
    [alsoOwned.familyId, value.ownerId]), 1);
  assert.deepEqual(await row('SELECT status,ended_at FROM siyue.rooms WHERE id=$1', [alsoOwnedRoom]),
    {status:'open',ended_at:null});
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.room_seats WHERE room_id=$1 AND released_at IS NULL',
    [alsoOwnedRoom]), 1);
  assert.equal((await row('SELECT active FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2',
    [alsoOwned.familyId, value.ownerId])).active, true);
  assert.equal((await row('SELECT withdrawn_at FROM siyue.consent_records WHERE id=$1',
    [alsoOwnedGuardianship.consentId])).withdrawn_at, null);
  await assertFamilyIntact(shared);
  assert.equal((await createFamilyRepository(db.app).list(value.ownerId)).length, 1);
  await assert.rejects(dissolve(shared.ownerId, shared.family.familyId),
    refuses('AUTH_DELETION_DEPENDENCIES', 409));
});

test('a failed deletion transaction restores the family, its membership and its create request', async () => {
  const value = await emptyFamily();
  await assert.rejects(transaction(db.app, async client => {
    await dissolveEmptyOwnedFamilyForDeletion(client, value.ownerId, value.family.familyId);
    throw new Error('synthetic_abort');
  }), /synthetic_abort/);

  await assertFamilyIntact(value);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.family_create_requests WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, value.ownerId]), 1);
  assert.equal((await createFamilyRepository(db.app).list(value.ownerId)).length, 1);
  assert.deepEqual(await row('SELECT role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, value.ownerId]), {role:'owner',active:true,version:1});
});
