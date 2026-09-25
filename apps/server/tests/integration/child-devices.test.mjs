import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createFamilyRepository } from '../../dist/modules/families/repository.js';
import { createChildDeviceService } from '../../dist/modules/families/child-devices.js';
import { freezeOwnedFamilyForDeletion } from '../../dist/modules/auth/account-deletion-family.js';

let db, fx, devices;
const day = 86_400_000;
const refuses = (code, status) => error => error?.code === code && error?.status === status;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query(`TRUNCATE siyue.device_grants,siyue.device_pairing_requests,siyue.guardian_relationships,siyue.consent_records,
    siyue.family_invitations,siyue.families,siyue.family_memberships,siyue.family_create_requests,siyue.idempotency_records,
    siyue.security_events,siyue.account_emails,siyue.password_credentials,siyue.email_challenges,siyue.outbox_jobs,
    siyue.rate_limit_buckets,siyue.subjects CASCADE`);
  fx = await createEmailFixture(db);
  devices = createChildDeviceService(db.app, fx.service, fx.clock);
});
after(async () => { await db?.stop(); });

async function scene() {
  const guardian = await fx.issue(), stranger = await fx.issue();
  const guardianId = guardian.session.subjectId;
  const family = await transaction(db.app, client => createFamilyRepository(db.app).create(client, guardianId, 'a'.repeat(64)));
  const childId = randomUUID(), consentId = randomUUID(), grantId = randomUUID();
  const now = fx.clock();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'child','Synthetic Child')", [childId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')", [family.familyId, childId]);
  await db.app.query("INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version) VALUES($1,$2,$3,'child-guardianship','0.0.1')",
    [consentId, guardianId, childId]);
  await db.app.query('INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)',
    [family.familyId, guardianId, childId, consentId]);
  const grantExpiry = new Date(+now + 30 * day - 1_000);
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,device_label,
    guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios','Synthetic iPad',1,1,ARRAY[]::text[],$6)`,
  [grantId, childId, guardianId, family.familyId, randomUUID(), grantExpiry]);
  const childTokens = await transaction(db.app, client => fx.service.issueChild(client, grantId));
  return {guardian, stranger, family, childId, consentId, grantId, childTokens, grantExpiry};
}

test('a real child session is tied to its grant and only an explicit guardian sees the device', async () => {
  const value = await scene();
  assert.equal(value.childTokens.session.subjectKind, 'child');
  assert.equal(value.childTokens.session.subjectId, value.childId);
  assert.equal((await fx.service.verify(value.childTokens.accessToken)).subjectId, value.childId);
  const listed = await devices.list(value.guardian.accessToken, value.childId);
  assert.equal(listed.items.length, 1);
  assert.deepEqual(listed.items[0], {grantId: value.grantId, childSubjectId: value.childId,
    installationId: listed.items[0].installationId, platform: 'ios', deviceLabel: 'Synthetic iPad',
    status: 'active', version: 1, expiresAt: value.grantExpiry.toISOString(), revokedAt: null});
  await assert.rejects(devices.list(value.stranger.accessToken, value.childId), refuses('CHILD_NOT_FOUND', 404));
  await assert.rejects(devices.list(value.childTokens.accessToken, value.childId), refuses('CHILD_DEVICE_GUARDIAN_REQUIRED', 403));
  await assert.rejects(devices.revoke(value.stranger.accessToken, value.childId, value.grantId, 1), refuses('CHILD_NOT_FOUND', 404));
});

test('guardian revocation commits the grant and invalidates access plus refresh immediately', async () => {
  const value = await scene();
  await assert.rejects(devices.revoke(value.guardian.accessToken, value.childId, value.grantId, 2), refuses('CHILD_DEVICE_STALE_VERSION', 409));
  assert.equal((await fx.service.verify(value.childTokens.accessToken)).subjectId, value.childId);
  const revoked = await devices.revoke(value.guardian.accessToken, value.childId, value.grantId, 1);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.version, 2);
  assert.deepEqual(await devices.revoke(value.guardian.accessToken, value.childId, value.grantId, 1), revoked);
  await assert.rejects(fx.service.verify(value.childTokens.accessToken), refuses('AUTH_SESSION_INVALID', 401));
  await assert.rejects(fx.service.refresh(value.childTokens.refreshToken, randomUUID()), refuses('AUTH_SESSION_INVALID', 401));
  const session = (await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE device_grant_id=$1', [value.grantId])).rows[0];
  assert.ok(session.revoked_at);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='child.device.revoke'")).rows[0].n, 1);
});

test('consent withdrawal, guardian version, guardian reset and family freeze/dissolution invalidate a child session', async () => {
  for (const mutate of [
    value => db.app.query('UPDATE siyue.consent_records SET withdrawn_at=now() WHERE id=$1', [value.consentId]),
    value => db.app.query('UPDATE siyue.guardian_relationships SET version=version+1 WHERE family_id=$1 AND child_subject_id=$2', [value.family.familyId, value.childId]),
    value => db.app.query('UPDATE siyue.subjects SET credential_version=credential_version+1 WHERE id=$1', [value.guardian.session.subjectId]),
    value => db.app.query("UPDATE siyue.families SET status='frozen' WHERE id=$1", [value.family.familyId]),
    value => db.app.query("UPDATE siyue.families SET status='dissolved' WHERE id=$1", [value.family.familyId]),
  ]) {
    const value = await scene();
    await mutate(value);
    await assert.rejects(fx.service.verify(value.childTokens.accessToken), refuses('AUTH_SESSION_INVALID', 401));
    await assert.rejects(fx.service.refresh(value.childTokens.refreshToken, randomUUID()), refuses('AUTH_SESSION_INVALID', 401));
  }
});

test('ending sole management freezes the family and revokes its child grants in one transaction', async () => {
  const value = await scene();
  const roomId = randomUUID();
  await db.app.query('INSERT INTO siyue.rooms(id,family_id,created_by_subject_id) VALUES($1,$2,$3)',
    [roomId,value.family.familyId,value.guardian.session.subjectId]);
  await db.app.query('INSERT INTO siyue.room_seats(room_id,session_id,subject_id,seat_index) VALUES($1,$2,$3,1)',
    [roomId,value.childTokens.session.sessionId,value.childId]);
  const invitationId = randomUUID();
  await db.app.query(`INSERT INTO siyue.family_invitations
    (id,family_id,inviter_id,token_hash,policy_version,inviter_membership_version,family_version,expires_at)
    VALUES($1,$2,$3,$4,'1.0',1,1,$5)`,
  [invitationId,value.family.familyId,value.guardian.session.subjectId,'c'.repeat(64),new Date(+fx.clock()+day)]);
  const pairingId = randomUUID();
  await db.app.query(`INSERT INTO siyue.device_pairing_requests
    (id,request_token_hash,poll_secret_hash,installation_id,platform,status,approved_by,child_subject_id,
     family_id,approved_guardian_version,approved_credential_version,created_at,expires_at,approved_at)
    VALUES($1,$2,$3,$4,'ios','approved',$5,$6,$7,1,1,$8,$9,$8)`,
  [pairingId,'d'.repeat(64),'e'.repeat(64),randomUUID(),value.guardian.session.subjectId,value.childId,
    value.family.familyId,fx.clock(),new Date(+fx.clock()+300_000)]);
  await transaction(db.app, client => freezeOwnedFamilyForDeletion(client,
    value.guardian.session.subjectId, value.family.familyId, fx.clock()));
  const family = (await db.app.query('SELECT status,owner_subject_id FROM siyue.families WHERE id=$1',
    [value.family.familyId])).rows[0];
  assert.deepEqual(family, {status:'frozen',owner_subject_id:value.guardian.session.subjectId});
  assert.deepEqual(await createFamilyRepository(db.app).list(value.guardian.session.subjectId), []);
  const grant = (await db.app.query('SELECT revoked_at,version FROM siyue.device_grants WHERE id=$1',
    [value.grantId])).rows[0];
  assert.ok(grant.revoked_at);
  assert.equal(grant.version, 2);
  const session = (await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE device_grant_id=$1',
    [value.grantId])).rows[0];
  assert.ok(session.revoked_at);
  await assert.rejects(fx.service.verify(value.childTokens.accessToken), refuses('AUTH_SESSION_INVALID', 401));
  await assert.rejects(fx.service.refresh(value.childTokens.refreshToken, randomUUID()), refuses('AUTH_SESSION_INVALID', 401));
  assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.guardian_relationships WHERE family_id=$1',
    [value.family.familyId])).rows[0].n, 1);
  assert.deepEqual((await db.app.query('SELECT status,ended_at IS NOT NULL AS ended FROM siyue.rooms WHERE id=$1',
    [roomId])).rows[0], {status:'ended',ended:true});
  assert.ok((await db.app.query('SELECT released_at FROM siyue.room_seats WHERE room_id=$1', [roomId])).rows[0].released_at);
  assert.deepEqual((await db.app.query('SELECT status,token_ciphertext FROM siyue.family_invitations WHERE id=$1',
    [invitationId])).rows[0], {status:'revoked',token_ciphertext:null});
  assert.equal((await db.app.query('SELECT status FROM siyue.device_pairing_requests WHERE id=$1',
    [pairingId])).rows[0].status, 'expired');
});

test('a failed deletion transaction rolls back the family freeze and child revocation', async () => {
  const value = await scene();
  await assert.rejects(transaction(db.app, async client => {
    await freezeOwnedFamilyForDeletion(client, value.guardian.session.subjectId,
      value.family.familyId, fx.clock());
    throw new Error('synthetic_abort');
  }), /synthetic_abort/);
  assert.equal((await db.app.query('SELECT status FROM siyue.families WHERE id=$1',
    [value.family.familyId])).rows[0].status, 'active');
  assert.equal((await db.app.query('SELECT revoked_at FROM siyue.device_grants WHERE id=$1',
    [value.grantId])).rows[0].revoked_at, null);
  assert.equal((await fx.service.verify(value.childTokens.accessToken)).subjectId, value.childId);
});

test('freeze refuses a different adult or a family without remaining active members', async () => {
  const value = await scene();
  await assert.rejects(transaction(db.app, client => freezeOwnedFamilyForDeletion(client,
    value.stranger.session.subjectId, value.family.familyId, fx.clock())),
  refuses('AUTH_DELETION_DEPENDENCIES', 409));
  await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId,value.childId]);
  await assert.rejects(transaction(db.app, client => freezeOwnedFamilyForDeletion(client,
    value.guardian.session.subjectId, value.family.familyId, fx.clock())),
  refuses('AUTH_DELETION_DEPENDENCIES', 409));
  assert.equal((await db.app.query('SELECT status FROM siyue.families WHERE id=$1',
    [value.family.familyId])).rows[0].status, 'active');
  assert.equal((await db.app.query('SELECT revoked_at FROM siyue.device_grants WHERE id=$1',
    [value.grantId])).rows[0].revoked_at, null);
});
