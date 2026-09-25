import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createFamilyRepository } from '../../dist/modules/families/repository.js';
import { createGuardianshipService } from '../../dist/modules/families/guardianship.js';
import { createAccountDeletionImpactService, accountDeletionImpactSchema } from '../../dist/modules/auth/account-deletion-impact.js';
import { createRuntimeApp } from '../../dist/runtime-app.js';
import { createAccountDeletionJobStore } from '../../dist/modules/auth/account-deletion-jobs.js';

// Read-only pre-deletion impact inventory (design 13.2, DEL-04) against an isolated temporary
// PostgreSQL cluster. Adult sessions are real session-service rows, the primary child is created by
// the real guardianship service, and co-guardians, memberships and device grants are written directly
// because the service deliberately creates one guardian per child. No account, household, address or
// device leaves this fixture, and nothing here deletes a subject.
const pepper = randomBytes(32);
const day = 86_400_000;

let db, fx, families, guardianship, impact;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query(`TRUNCATE siyue.guardian_relationships,siyue.consent_records,siyue.device_grants,siyue.device_pairing_requests,
    siyue.family_invitations,siyue.families,siyue.family_memberships,siyue.family_create_requests,siyue.idempotency_records,
    siyue.security_events,siyue.account_emails,siyue.password_credentials,siyue.email_challenges,siyue.outbox_jobs,
    siyue.rate_limit_buckets,siyue.subjects CASCADE`);
  fx = await createEmailFixture(db);
  families = createFamilyRepository(db.app);
  guardianship = createGuardianshipService(db.app, fx.service, pepper, fx.clock);
  impact = createAccountDeletionImpactService(db.app, fx.service, fx.clock);
});
after(async () => { await db?.stop(); });

const rows = (sql, ...args) => db.app.query(sql, args).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
const refuses = (code, status) => error => error?.code === code && (status === undefined || error?.status === status);
const subjectOf = who => who.session.subjectId;
const keyHash = () => createHash('sha256').update(randomUUID()).digest('hex');
const sorted = entries => [...entries].sort((left, right) => left.familyId.localeCompare(right.familyId));
const adult = () => fx.issue();
const family = owner => transaction(db.app, client => families.create(client, subjectOf(owner), keyHash()));
const addMembership = (familyId, subjectId, role = 'member') => db.app.query(
  'INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,$3)', [familyId, subjectId, role]);

test('runtime exposes only read-only deletion preparation and receipt status', async () => {
  const who = await adult();
  const app = createRuntimeApp(db.app, db.identity, {sessions:fx.service});
  try {
    const impactReply = await app.inject({method:'GET',url:'/v1/me/account/deletion/impact',
      headers:{authorization:`Bearer ${who.accessToken}`}});
    assert.equal(impactReply.statusCode,200);
    assert.deepEqual(impactReply.json().data,{subjectId:subjectOf(who),families:[],guardianships:[],activeChildDeviceCount:0});
    assert.equal((await app.inject({method:'GET',url:'/v1/me/account/deletion/impact'})).statusCode,400);
    assert.equal((await app.inject({method:'GET',url:'/v1/me/account/deletion/impact?subjectId=x',
      headers:{authorization:`Bearer ${who.accessToken}`}})).statusCode,400);
    assert.equal((await app.inject({method:'DELETE',url:'/v1/me/account',
      headers:{authorization:`Bearer ${who.accessToken}`}})).statusCode,404);
    const wrong = await app.inject({method:'POST',url:'/v1/account/deletion/status',
      payload:{deletionId:randomUUID(),receiptSecret:'A'.repeat(43)}});
    assert.equal(wrong.statusCode,404);
    assert.equal(wrong.json().error.code,'AUTH_DELETION_RECEIPT_INVALID');
    await db.app.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1",[subjectOf(who)]);
    const receipt=await transaction(db.app,client=>createAccountDeletionJobStore(db.app).insertPending(client,
      {subjectId:subjectOf(who),receiptExpiresAt:new Date(Date.now()+86_400_000),providerRevocationPending:false}));
    const progress=await app.inject({method:'POST',url:'/v1/account/deletion/status',
      payload:{deletionId:receipt.deletionId,receiptSecret:receipt.receiptSecret}});
    assert.equal(progress.statusCode,200);
    assert.deepEqual(progress.json().data,{serverDataDeleted:false,providerRevocationPending:false,completedAt:null,lastErrorCode:null});
  } finally { await app.close(); }
});
const setDisplayName = (subjectId, value) => db.app.query('UPDATE siyue.subjects SET display_name=$2 WHERE id=$1', [subjectId, value]);
/** A supervised child as the real create path writes one, for the family that will be inspected. */
const createChild = (who, summary, displayName = 'Synthetic Child') => guardianship.create(who.accessToken, {
  familyId: summary.familyId, displayName, consentPolicyVersion: 'guardian-consent-v1', consentConfirmed: true,
  expectedMembershipVersion: summary.membershipVersion, expectedFamilyVersion: summary.familyVersion }, randomUUID());
async function addChildSubject(displayName = 'Synthetic Child') {
  const id = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'child',$2)", [id, displayName]);
  return id;
}
/** Explicit guardianship of an existing child by another adult, exactly as the service records one. */
async function guard({ familyId, guardianId, childId }) {
  const consentId = randomUUID();
  await db.app.query("INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version) VALUES($1,$2,$3,'child-guardianship','0.0.1')",
    [consentId, guardianId, childId]);
  await db.app.query('INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)',
    [familyId, guardianId, childId, consentId]);
  return consentId;
}
async function addDeviceGrant({ familyId, guardianId, childId, relationshipVersion = 1, credentialVersion = 1, expiresInMs = 30 * day - 1_000 }) {
  const id = randomUUID();
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,device_label,
    guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios','Synthetic iPad',$6,$7,ARRAY[]::text[],$8)`,
  [id, childId, guardianId, familyId, randomUUID(), relationshipVersion, credentialVersion, new Date(+fx.clock() + expiresInMs)]);
  return id;
}

test('a caller with no dependency still gets an explicit empty inventory', async () => {
  const who = await adult();
  const result = await impact.inspect(who.accessToken);
  assert.deepEqual(result, { subjectId: subjectOf(who), families: [], guardianships: [], activeChildDeviceCount: 0 });
  assert.deepEqual(accountDeletionImpactSchema.parse(result), result);
});

test("the inventory reports the caller's own family, guardianship and live child devices", async () => {
  const owner = await adult();
  const own = await family(owner);
  // The real write path produces the dependency this read is supposed to find.
  const child = await createChild(owner, own, '玥玥');
  const grantId = await addDeviceGrant({ familyId: own.familyId, guardianId: subjectOf(owner), childId: child.childSubjectId });
  const result = await impact.inspect(owner.accessToken);
  assert.deepEqual(result, {
    subjectId: subjectOf(owner),
    families: [{ familyId: own.familyId, role: 'owner', soleActiveOwner: true, otherActiveAdultCount: 0, otherActiveChildCount: 1 }],
    guardianships: [{ familyId: own.familyId, childSubjectId: child.childSubjectId, soleGuardian: true, otherGuardianCount: 0, activeChildDeviceCount: 1 }],
    activeChildDeviceCount: 1,
  });
  assert.deepEqual(accountDeletionImpactSchema.parse(result), result);
  // An unchanged state answers identically, and the grant really is the one counted.
  assert.deepEqual(await impact.inspect(owner.accessToken), result);
  assert.equal((await rows('SELECT id, revoked_at FROM siyue.device_grants WHERE id=$1', grantId))[0].revoked_at, null);
});

test("another subject's dependencies and the other people in a family never cross the boundary", async () => {
  const owner = await adult(), admin = await adult(), stranger = await adult();
  await setDisplayName(subjectOf(admin), 'Co-parent marker 7fd1');
  const own = await family(owner);
  await addMembership(own.familyId, subjectOf(admin), 'admin');
  // The child belongs to the owner family but is guarded by the admin: a role is not guardianship.
  const childId = await addChildSubject('Child marker 3c9a');
  await addMembership(own.familyId, childId);
  await guard({ familyId: own.familyId, guardianId: subjectOf(admin), childId });
  const otherFamily = await family(stranger);

  const strangerView = await impact.inspect(stranger.accessToken);
  assert.deepEqual(strangerView, {
    subjectId: subjectOf(stranger),
    families: [{ familyId: otherFamily.familyId, role: 'owner', soleActiveOwner: true, otherActiveAdultCount: 0, otherActiveChildCount: 0 }],
    guardianships: [], activeChildDeviceCount: 0,
  });
  // Nothing of the other household travels: no ids, no display name, no bearer material.
  const strangerJson = JSON.stringify(strangerView);
  for (const hidden of [subjectOf(owner), subjectOf(admin), own.familyId, childId, 'Co-parent marker 7fd1', 'Child marker 3c9a',
    owner.accessToken, owner.refreshToken, stranger.accessToken, stranger.refreshToken])
    assert.equal(strangerJson.includes(hidden), false, hidden);

  // The owner keeps the family and its members but gains no guardianship from the owner role.
  const ownerView = await impact.inspect(owner.accessToken);
  assert.deepEqual(ownerView, {
    subjectId: subjectOf(owner),
    families: [{ familyId: own.familyId, role: 'owner', soleActiveOwner: true, otherActiveAdultCount: 1, otherActiveChildCount: 1 }],
    guardianships: [], activeChildDeviceCount: 0,
  });
  assert.equal(JSON.stringify(ownerView).includes(subjectOf(admin)), false);
  assert.equal(JSON.stringify(ownerView).includes('Co-parent marker 7fd1'), false);

  // The admin sees the same family below the owner and owns the guardianship itself.
  assert.deepEqual(await impact.inspect(admin.accessToken), {
    subjectId: subjectOf(admin),
    families: [{ familyId: own.familyId, role: 'admin', soleActiveOwner: false, otherActiveAdultCount: 1, otherActiveChildCount: 1 }],
    guardianships: [{ familyId: own.familyId, childSubjectId: childId, soleGuardian: true, otherGuardianCount: 0, activeChildDeviceCount: 0 }],
    activeChildDeviceCount: 0,
  });
});

test('a dependency that is no longer live is absent instead of reported stale', async () => {
  const owner = await adult(), other = await adult();
  const own = await family(owner);
  const childId = await addChildSubject();
  await addMembership(own.familyId, subjectOf(other), 'member');
  await setDisplayName(subjectOf(other), 'Inactive marker 11ab');
  await addMembership(own.familyId, childId);
  await guard({ familyId: own.familyId, guardianId: subjectOf(owner), childId });
  const full = await impact.inspect(owner.accessToken);
  assert.deepEqual(full.families, [{ familyId: own.familyId, role: 'owner', soleActiveOwner: true, otherActiveAdultCount: 1, otherActiveChildCount: 1 }]);
  assert.deepEqual(full.guardianships.map(entry => [entry.childSubjectId, entry.soleGuardian]), [[childId, true]]);

  // A revoked relationship is not a dependency any more, and is not reported as one.
  await db.app.query('UPDATE siyue.guardian_relationships SET active=false WHERE child_subject_id=$1', [childId]);
  assert.deepEqual((await impact.inspect(owner.accessToken)).guardianships, []);
  await db.app.query('UPDATE siyue.guardian_relationships SET active=true WHERE child_subject_id=$1', [childId]);
  // Withdrawing the consent behind it hides the same relationship.
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=now() WHERE subject_id=$1', [childId]);
  assert.deepEqual((await impact.inspect(owner.accessToken)).guardianships, []);
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=NULL WHERE subject_id=$1', [childId]);
  // A child removed from the family, or no longer an active child subject, is not a live dependency.
  await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2', [own.familyId, childId]);
  assert.deepEqual((await impact.inspect(owner.accessToken)).guardianships, []);
  await db.app.query('UPDATE siyue.family_memberships SET active=true WHERE family_id=$1 AND subject_id=$2', [own.familyId, childId]);
  await db.app.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1", [childId]);
  assert.deepEqual((await impact.inspect(owner.accessToken)).guardianships, []);
  await db.app.query("UPDATE siyue.subjects SET status='active' WHERE id=$1", [childId]);
  // Other members only count while they are themselves active subjects of the right kind.
  await db.app.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1", [subjectOf(other)]);
  assert.equal((await impact.inspect(owner.accessToken)).families[0].otherActiveAdultCount, 0);
  await db.app.query("UPDATE siyue.subjects SET status='active', kind='child' WHERE id=$1", [subjectOf(other)]);
  assert.deepEqual((await impact.inspect(owner.accessToken)).families[0],
    { familyId: own.familyId, role: 'owner', soleActiveOwner: true, otherActiveAdultCount: 0, otherActiveChildCount: 2 });
  await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2', [own.familyId, subjectOf(other)]);
  assert.equal((await impact.inspect(owner.accessToken)).families[0].otherActiveChildCount, 1);
  // A dissolved family and the caller's own inactive membership remove the whole family entry.
  await db.app.query("UPDATE siyue.families SET status='dissolved', version=version+1 WHERE id=$1", [own.familyId]);
  assert.deepEqual((await impact.inspect(owner.accessToken)).families, []);
  assert.deepEqual((await impact.inspect(owner.accessToken)).guardianships, []);
  await db.app.query("UPDATE siyue.families SET status='active' WHERE id=$1", [own.familyId]);
  await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2', [own.familyId, subjectOf(owner)]);
  assert.deepEqual(await impact.inspect(owner.accessToken),
    { subjectId: subjectOf(owner), families: [], guardianships: [], activeChildDeviceCount: 0 });
  await db.app.query('UPDATE siyue.family_memberships SET active=true WHERE family_id=$1 AND subject_id=$2', [own.familyId, subjectOf(owner)]);
  // A caller subject that is no longer active cannot read the inventory at all.
  await db.app.query("UPDATE siyue.subjects SET status='deletion_pending' WHERE id=$1", [subjectOf(owner)]);
  await assert.rejects(impact.inspect(owner.accessToken), refuses('AUTH_SESSION_INVALID', 401));
  await db.app.query("UPDATE siyue.subjects SET status='active' WHERE id=$1", [subjectOf(owner)]);
  assert.equal((await impact.inspect(owner.accessToken)).guardianships.length, 1);
  assert.equal(JSON.stringify(await impact.inspect(owner.accessToken)).includes('Inactive marker 11ab'), false);
});

test('an unusable access token is refused by the real session layer', async () => {
  const owner = await adult(), drifted = await adult(), expired = await adult();
  const own = await family(owner);
  await createChild(owner, own);
  for (const value of ['', 'not-a-token', owner.accessToken.slice(0, -1), `${owner.accessToken}x`, undefined, null, 42, {}])
    await assert.rejects(impact.inspect(value), refuses('AUTH_ACCESS_INVALID', 401), String(value));

  // A revoked session and a rotated credential version stop working immediately (version drift).
  await db.app.query("UPDATE siyue.auth_sessions SET revoked_at=now(), revoke_reason='user_revoked' WHERE id=$1", [owner.session.sessionId]);
  await assert.rejects(impact.inspect(owner.accessToken), refuses('AUTH_SESSION_INVALID', 401));
  await db.app.query('UPDATE siyue.subjects SET credential_version=credential_version+1 WHERE id=$1', [subjectOf(drifted)]);
  await assert.rejects(impact.inspect(drifted.accessToken), refuses('AUTH_SESSION_INVALID', 401));
  // A session whose idle window ran out is refused too. Only the stored session row is aged, so the
  // access token stays inside its own 15-minute lifetime and this really exercises the session check.
  await db.app.query("UPDATE siyue.auth_sessions SET idle_expires_at=now()-interval '2 minutes' WHERE id=$1", [expired.session.sessionId]);
  await assert.rejects(impact.inspect(expired.accessToken), refuses('AUTH_SESSION_INVALID', 401));
  // An access token that outlived its own lifetime is refused by the signer, before any session read.
  fx.advance(31 * day);
  await assert.rejects(impact.inspect(drifted.accessToken), refuses('AUTH_ACCESS_INVALID', 401));
});

test('a restricted child session cannot inspect account deletion impact', async () => {
  const owner = await adult();
  const own = await family(owner);
  const child = await createChild(owner, own);
  const grantId = await addDeviceGrant({ familyId: own.familyId, guardianId: subjectOf(owner), childId: child.childSubjectId });
  const childTokens = await transaction(db.app, client => fx.service.issueChild(client, grantId));
  await assert.rejects(impact.inspect(childTokens.accessToken), refuses('AUTH_ADULT_REQUIRED', 403));
  assert.equal((await impact.inspect(owner.accessToken)).guardianships.length, 1);
});

test('the inventory takes no write and stores no decision', async () => {
  const owner = await adult();
  const own = await family(owner);
  const child = await createChild(owner, own);
  await addDeviceGrant({ familyId: own.familyId, guardianId: subjectOf(owner), childId: child.childSubjectId });
  const tables = ['subjects', 'auth_sessions', 'refresh_tokens', 'families', 'family_memberships', 'guardian_relationships',
    'consent_records', 'device_grants', 'idempotency_records', 'security_events', 'outbox_jobs'];
  const before_ = Object.fromEntries(await Promise.all(tables.map(async table => [table, await count(`SELECT count(*)::int AS n FROM siyue.${table}`)])));
  assert.equal((await impact.inspect(owner.accessToken)).activeChildDeviceCount, 1);
  await assert.rejects(impact.inspect('not-a-token'));
  const after_ = Object.fromEntries(await Promise.all(tables.map(async table => [table, await count(`SELECT count(*)::int AS n FROM siyue.${table}`)])));
  assert.deepEqual(after_, before_);
  // The read neither accepted nor queued a deletion: no deletion audit row exists at all.
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type LIKE '%deletion%'"), 0);
  assert.deepEqual(Object.keys(impact).sort(), ['inspect','inspectLocked']);
});

test("sole guardian and co-guardian are distinguished, and only the caller's own live devices count", async () => {
  const owner = await adult(), coGuardian = await adult();
  const own = await family(owner);
  const child = await createChild(owner, own);
  const childId = child.childSubjectId;
  await addMembership(own.familyId, subjectOf(coGuardian), 'admin');
  const ownView = () => impact.inspect(owner.accessToken).then(result => result.guardianships[0]);
  assert.deepEqual(await ownView(), { familyId: own.familyId, childSubjectId: childId, soleGuardian: true, otherGuardianCount: 0, activeChildDeviceCount: 0 });

  // A second live guardianship in the same family makes the caller a co-guardian, not the only one.
  await guard({ familyId: own.familyId, guardianId: subjectOf(coGuardian), childId });
  assert.deepEqual(await ownView(), { familyId: own.familyId, childSubjectId: childId, soleGuardian: false, otherGuardianCount: 1, activeChildDeviceCount: 0 });
  assert.deepEqual(await impact.inspect(coGuardian.accessToken).then(result => result.guardianships[0]),
    { familyId: own.familyId, childSubjectId: childId, soleGuardian: false, otherGuardianCount: 1, activeChildDeviceCount: 0 });
  // A guardian whose membership is inactive, whose relationship was revoked or whose consent was
  // withdrawn is not a remaining guardian, so the caller is the sole one again.
  await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2', [own.familyId, subjectOf(coGuardian)]);
  assert.equal((await ownView()).soleGuardian, true);
  await db.app.query('UPDATE siyue.family_memberships SET active=true WHERE family_id=$1 AND subject_id=$2', [own.familyId, subjectOf(coGuardian)]);
  await db.app.query('UPDATE siyue.guardian_relationships SET active=false WHERE guardian_subject_id=$1', [subjectOf(coGuardian)]);
  assert.equal((await ownView()).soleGuardian, true);
  await db.app.query('UPDATE siyue.guardian_relationships SET active=true WHERE guardian_subject_id=$1', [subjectOf(coGuardian)]);
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=now() WHERE actor_subject_id=$1', [subjectOf(coGuardian)]);
  assert.equal((await ownView()).soleGuardian, true);
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=NULL WHERE actor_subject_id=$1', [subjectOf(coGuardian)]);
  assert.equal((await ownView()).soleGuardian, false);
  // A live guardian of the same child in another family still supervises that child.
  const secondFamily = await family(coGuardian);
  await addMembership(secondFamily.familyId, childId);
  await db.app.query('UPDATE siyue.guardian_relationships SET active=false WHERE guardian_subject_id=$1 AND family_id=$2',
    [subjectOf(coGuardian), own.familyId]);
  assert.equal((await ownView()).soleGuardian, true);
  await db.app.query('UPDATE siyue.guardian_relationships SET active=true WHERE guardian_subject_id=$1 AND family_id=$2',
    [subjectOf(coGuardian), own.familyId]);
  await guard({ familyId: secondFamily.familyId, guardianId: subjectOf(coGuardian), childId });
  assert.deepEqual(await ownView(), { familyId: own.familyId, childSubjectId: childId, soleGuardian: false, otherGuardianCount: 2, activeChildDeviceCount: 0 });

  // Only the caller's own usable grants count: another guardian's grant, a grant with no live
  // guardianship in its family, and grants whose recorded relationship or credential version no
  // longer matches the live relationship never inflate the number the caller confirms.
  const live = await addDeviceGrant({ familyId: own.familyId, guardianId: subjectOf(owner), childId });
  const revoked = await addDeviceGrant({ familyId: own.familyId, guardianId: subjectOf(owner), childId });
  await db.app.query('UPDATE siyue.device_grants SET revoked_at=now(), version=version+1 WHERE id=$1', [revoked]);
  const driftedRelationship = await addDeviceGrant({ familyId: own.familyId, guardianId: subjectOf(owner), childId, relationshipVersion: 99 });
  const driftedCredential = await addDeviceGrant({ familyId: own.familyId, guardianId: subjectOf(owner), childId, credentialVersion: 99 });
  const coGuardianGrant = await addDeviceGrant({ familyId: own.familyId, guardianId: subjectOf(coGuardian), childId });
  const foreignFamilyGrant = await addDeviceGrant({ familyId: secondFamily.familyId, guardianId: subjectOf(owner), childId });
  const granted = await impact.inspect(owner.accessToken);
  assert.deepEqual(granted.guardianships, [{ familyId: own.familyId, childSubjectId: childId, soleGuardian: false, otherGuardianCount: 2, activeChildDeviceCount: 1 }]);
  assert.equal(granted.activeChildDeviceCount, 1);
  assert.equal((await rows('SELECT revoked_at FROM siyue.device_grants WHERE id=$1', live))[0].revoked_at, null);

  // A short-lived grant counts while it can still be used, then stops counting after its own expiry.
  const shortLived = await addDeviceGrant({ familyId: own.familyId, guardianId: subjectOf(owner), childId, expiresInMs: 60_000 });
  assert.equal((await impact.inspect(owner.accessToken)).activeChildDeviceCount, 2);
  fx.advance(2 * 60_000);
  assert.equal((await ownView()).activeChildDeviceCount, 1);
  assert.equal((await rows('SELECT revoked_at FROM siyue.device_grants WHERE id=$1', shortLived))[0].revoked_at, null);

  // Each guardian counts only their own devices, per family; the same child appears once per family.
  const coGuardianView = await impact.inspect(coGuardian.accessToken);
  assert.deepEqual(sorted(coGuardianView.guardianships),
    sorted([{ familyId: own.familyId, childSubjectId: childId, soleGuardian: false, otherGuardianCount: 1, activeChildDeviceCount: 1 },
      { familyId: secondFamily.familyId, childSubjectId: childId, soleGuardian: false, otherGuardianCount: 1, activeChildDeviceCount: 0 }]));
  assert.equal(coGuardianView.activeChildDeviceCount, 1);
  const serialized = JSON.stringify([granted, coGuardianView]);
  for (const hidden of [live, revoked, shortLived, driftedRelationship, driftedCredential, coGuardianGrant, foreignFamilyGrant])
    assert.equal(serialized.includes(hidden), false, hidden);
});
