import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { childSummarySchema } from '@siyue/contracts';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createFamilyRepository } from '../../dist/modules/families/repository.js';
import { createGuardianshipService } from '../../dist/modules/families/guardianship.js';

// Isolated temporary PostgreSQL cluster only; never a database URL from the workspace. No account,
// household or mailbox leaves this fixture. The pepper is stable for the whole file so stored
// digests can be recomputed and raw values can be searched for in every stored row.
const pepper = randomBytes(32);
const day = 86_400_000;

let db, fx, families, guardianship;
before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query(`TRUNCATE siyue.guardian_relationships,siyue.consent_records,siyue.device_grants,siyue.device_pairing_requests,
    siyue.family_invitations,siyue.families,siyue.family_memberships,siyue.family_create_requests,siyue.idempotency_records,
    siyue.security_events,siyue.account_emails,siyue.password_credentials,siyue.email_challenges,siyue.outbox_jobs,
    siyue.rate_limit_buckets,siyue.subjects CASCADE`);
  fx = await createEmailFixture(db);
  families = createFamilyRepository(db.app);
  guardianship = createGuardianshipService(db.app, fx.service, pepper, fx.clock);
});
after(async () => { await db?.stop(); });

/** Tolerates both `rows(sql, a, b)` and `rows(sql, [a, b])` call styles. */
const bindings = args => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
const rows = (sql, ...args) => db.app.query(sql, bindings(args)).then(result => result.rows);
const count = (sql, ...args) => rows(sql, ...args).then(result => Number(result[0].n));
const refuses = (code, status) => error => error?.code === code && (status === undefined || error?.status === status);
const keyHash = () => createHash('sha256').update(randomUUID()).digest('hex');
const tokensOf = who => who.tokens ?? who;
const subjectOf = who => tokensOf(who).session?.subjectId ?? who.subjectId;
const tokenOf = who => tokensOf(who).accessToken;
const scopeOf = familyId => 'family-children:' + familyId;

/** Real adult session created through the session service. */
const adult = () => fx.issue();
/** Real family owner membership created by the existing repository. */
const family = owner => transaction(db.app, client => families.create(client, subjectOf(owner), keyHash()));
const addMembership = (familyId, subjectId, role, version = 1) => db.app.query(
  'INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,$3,true,$4)',
  [familyId, subjectId, role, version]);
/** The shared create contract with the values the caller read from the family summary. */
const createChild = (who, summary, overrides = {}, requestKey = randomUUID()) => guardianship.create(tokenOf(who), {
  familyId: summary.familyId, displayName: '玥玥', consentPolicyVersion: 'guardian-consent-v1', consentConfirmed: true,
  expectedMembershipVersion: summary.membershipVersion, expectedFamilyVersion: summary.familyVersion, ...overrides,
}, requestKey);
const listChildren = (who, familyId) => guardianship.list(tokenOf(who), familyId);
const childSubjects = familyId => count(`SELECT count(*)::int AS n FROM siyue.subjects p
  JOIN siyue.family_memberships m ON m.subject_id=p.id WHERE m.family_id=$1 AND p.kind='child'`, familyId);
const familyVersion = async familyId => (await rows('SELECT version FROM siyue.families WHERE id=$1', [familyId]))[0].version;

test('an owner creates one supervised child, records consent and bumps the family version', async () => {
  const owner = await adult();
  const own = await family(owner);
  const requestKey = randomUUID(), now = fx.clock();
  const created = await createChild(owner, own, { displayName: '玥玥' }, requestKey);

  assert.deepEqual(childSummarySchema.parse(created), created);
  assert.ok(childSummarySchema.shape.childSubjectId.safeParse(created.childSubjectId).success);
  assert.deepEqual([created.familyId, created.guardianSubjectId, created.relationshipVersion, created.familyVersion, created.displayName],
    [own.familyId, subjectOf(owner), 1, 2, '玥玥']);

  const kid = (await rows('SELECT * FROM siyue.subjects WHERE id=$1', [created.childSubjectId]))[0];
  assert.deepEqual([kid.kind, kid.status, kid.display_name], ['child', 'active', '玥玥']);
  const membership = (await rows('SELECT * FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [own.familyId, created.childSubjectId]))[0];
  // A supervised child joins as a plain member: the guardian relationship is separate from the role.
  assert.deepEqual([membership.role, membership.active, membership.version], ['member', true, 1]);
  const [consent] = await rows('SELECT * FROM siyue.consent_records');
  assert.deepEqual([consent.actor_subject_id, consent.subject_id, consent.purpose, consent.policy_version, consent.withdrawn_at],
    [subjectOf(owner), created.childSubjectId, 'child-guardianship', 'guardian-consent-v1', null]);
  assert.equal(+consent.recorded_at, +now);
  const [relationship] = await rows('SELECT * FROM siyue.guardian_relationships');
  assert.deepEqual([relationship.family_id, relationship.guardian_subject_id, relationship.child_subject_id,
    relationship.active, relationship.version, relationship.consent_record_id],
  [own.familyId, subjectOf(owner), created.childSubjectId, true, 1, consent.id]);
  assert.equal(+relationship.created_at, +now);
  assert.deepEqual((await rows('SELECT owner_subject_id, version FROM siyue.families WHERE id=$1', [own.familyId]))[0],
    { owner_subject_id: subjectOf(owner), version: 2 });
  const [record] = await rows('SELECT * FROM siyue.idempotency_records');
  assert.deepEqual([record.scope, record.status, record.resource_id, record.subject_id, record.key_hash.length],
    [scopeOf(own.familyId), 'complete', created.childSubjectId, subjectOf(owner), 64]);
  assert.equal(+record.expires_at, +now + 90 * day);
  // Only digested key material reaches storage: the raw idempotency key is nowhere in the rows.
  const dump = JSON.stringify(await rows('SELECT * FROM siyue.idempotency_records'))
    + JSON.stringify(await rows('SELECT * FROM siyue.security_events'))
    + JSON.stringify(await rows('SELECT * FROM siyue.consent_records'));
  for (const secret of [requestKey, tokenOf(owner)]) assert.equal(dump.includes(secret), false, secret);
  const [event] = await rows("SELECT * FROM siyue.security_events WHERE event_type='family.child.create'");
  assert.deepEqual([event.outcome, event.subject_id, event.session_id, event.redacted_metadata],
    ['success', subjectOf(owner), tokensOf(owner).session.sessionId, { familyId: own.familyId, childSubjectId: created.childSubjectId }]);
  assert.equal(event.request_id.includes(requestKey), false);
  // The existing repository now reports the advanced family version and one owner membership only.
  assert.deepEqual(await families.list(subjectOf(owner)),
    [{ familyId: own.familyId, ownerSubjectId: subjectOf(owner), role: 'owner', membershipVersion: 1, familyVersion: 2 }]);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.family_memberships
    WHERE family_id=$1 AND role IN ('owner','admin')`, [own.familyId]), 1);
});

test('one create key replays its child, conflicts on another payload and any guardian may reuse the value', async () => {
  const owner = await adult(), admin = await adult(), other = await adult();
  const own = await family(owner);
  await addMembership(own.familyId, subjectOf(admin), 'admin', 1);
  const requestKey = randomUUID();
  const first = await createChild(owner, own, {}, requestKey);

  assert.deepEqual(await createChild(owner, own, {}, requestKey), first);
  assert.equal(await childSubjects(own.familyId), 1);
  // The same key with another payload is a conflict instead of a second child.
  await assert.rejects(createChild(owner, own, { displayName: '另一个孩子' }, requestKey), refuses('FAMILY_CHILD_CONFLICT', 409));
  await assert.rejects(createChild(owner, own, { expectedMembershipVersion: 2 }, requestKey), refuses('FAMILY_CHILD_CONFLICT', 409));
  await assert.rejects(createChild(owner, own, { consentPolicyVersion: 'guardian-consent-v2' }, requestKey), refuses('FAMILY_CHILD_CONFLICT', 409));
  assert.equal(await childSubjects(own.familyId), 1);
  // A fresh key is bound to the family version it read: the version this write itself advanced is stale.
  await assert.rejects(createChild(owner, own), refuses('FAMILY_STALE_AUTHORIZATION', 409));
  assert.equal(await childSubjects(own.familyId), 1);
  // The key value belongs to one guardian/family pair, so another guardian creates its own child.
  const adminChild = await createChild(admin, { familyId: own.familyId, membershipVersion: 1, familyVersion: 2 }, {}, requestKey);
  assert.notEqual(adminChild.childSubjectId, first.childSubjectId);
  assert.equal(adminChild.guardianSubjectId, subjectOf(admin));
  assert.equal(adminChild.familyVersion, 3);
  assert.equal(await childSubjects(own.familyId), 2);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope=$1', [scopeOf(own.familyId)]), 2);
  // Concurrent identical creates converge on one child, one record and one summary.
  const raceKey = randomUUID(), otherFamily = await family(other);
  const raced = await Promise.all([createChild(other, otherFamily, {}, raceKey), createChild(other, otherFamily, {}, raceKey)]);
  assert.deepEqual(raced[0], raced[1]);
  assert.equal(await childSubjects(otherFamily.familyId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope=$1', [scopeOf(otherFamily.familyId)]), 1);
  assert.equal(await familyVersion(otherFamily.familyId), 2);
});

test('only a current owner or admin with current versions can create a child, and no refusal writes', async () => {
  const owner = await adult(), admin = await adult(), member = await adult(), stranger = await adult(), blocked = await adult();
  const own = await family(owner);
  await addMembership(own.familyId, subjectOf(admin), 'admin', 3);
  await addMembership(own.familyId, subjectOf(member), 'member', 2);
  await addMembership(own.familyId, subjectOf(blocked), 'member', 1);

  // A foreign subject and an unknown family stay indistinguishable.
  await assert.rejects(createChild(stranger, own), refuses('FAMILY_NOT_FOUND', 404));
  await assert.rejects(createChild(owner, { familyId: randomUUID(), membershipVersion: 1, familyVersion: 1 }),
    refuses('FAMILY_NOT_FOUND', 404));
  // The existing domain policy keeps a plain member below family management.
  await assert.rejects(createChild(member, { familyId: own.familyId, membershipVersion: 2, familyVersion: 1 }),
    refuses('FAMILY_CHILD_FORBIDDEN', 403));
  // Stale versions are refused for the owner too, and are never silently corrected.
  await assert.rejects(createChild(owner, { familyId: own.familyId, membershipVersion: 2, familyVersion: 1 }),
    refuses('FAMILY_STALE_AUTHORIZATION', 409));
  await assert.rejects(createChild(owner, { familyId: own.familyId, membershipVersion: 1, familyVersion: 4 }),
    refuses('FAMILY_STALE_AUTHORIZATION', 409));
  // A blocked adult cannot even hold a usable session.
  await db.app.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1", [subjectOf(blocked)]);
  await assert.rejects(createChild(blocked, { familyId: own.familyId, membershipVersion: 1, familyVersion: 1 }),
    refuses('AUTH_SESSION_INVALID', 401));
  // A dissolved family and a deactivated membership remove management without rewriting versions.
  await db.app.query("UPDATE siyue.families SET status='dissolved', version=version+1 WHERE id=$1", [own.familyId]);
  await assert.rejects(createChild(owner, { familyId: own.familyId, membershipVersion: 1, familyVersion: 2 }),
    refuses('FAMILY_CHILD_FAMILY_INACTIVE', 409));
  await db.app.query("UPDATE siyue.families SET status='active', version=1 WHERE id=$1", [own.familyId]);
  await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2',
    [own.familyId, subjectOf(admin)]);
  await assert.rejects(createChild(admin, { familyId: own.familyId, membershipVersion: 3, familyVersion: 1 }),
    refuses('FAMILY_NOT_FOUND', 404));
  // Losing the role is a refusal, not a silent downgrade to member-level creation.
  await db.app.query("UPDATE siyue.family_memberships SET active=true, role='member' WHERE family_id=$1 AND subject_id=$2",
    [own.familyId, subjectOf(admin)]);
  await assert.rejects(createChild(admin, { familyId: own.familyId, membershipVersion: 3, familyVersion: 1 }),
    refuses('FAMILY_CHILD_FORBIDDEN', 403));

  // Malformed requests, unknown fields and invalid keys are refused before any work.
  const valid = { familyId: own.familyId, displayName: '玥玥', consentPolicyVersion: 'guardian-consent-v1',
    consentConfirmed: true, expectedMembershipVersion: 1, expectedFamilyVersion: 1 };
  for (const bad of [
    { ...valid, familyId: 'not-a-uuid' },
    { ...valid, expectedMembershipVersion: 0 },
    { ...valid, expectedFamilyVersion: 1.5 },
    { ...valid, role: 'owner' },
    { ...valid, subjectKind: 'adult' },
    { ...valid, kind: 'adult' },
    { ...valid, guardianSubjectId: randomUUID() },
    { ...valid, childSubjectId: randomUUID() },
    { ...valid, relationshipVersion: 1 },
    { ...valid, consentConfirmed: false },
    { ...valid, consentPolicyVersion: 'Guardian Consent V1' },
    { ...valid, consentPolicyVersion: 'a'.repeat(41) },
    { ...valid, displayName: '' },
    { ...valid, displayName: 'x'.repeat(101) },
    { ...valid, displayName: undefined },
    (() => { const copy = { ...valid }; delete copy.consentConfirmed; return copy; })(),
    {}, null, undefined,
  ]) await assert.rejects(guardianship.create(tokenOf(owner), bad, randomUUID()), refuses('FAMILY_INVALID_REQUEST', 400));
  for (const badKey of ['', 'not-a-uuid', `${randomUUID()} `, randomUUID().slice(0, 35), randomUUID().replace('-', '_'), 42, null, undefined])
    await assert.rejects(guardianship.create(tokenOf(owner), valid, badKey), refuses('FAMILY_INVALID_REQUEST', 400), String(badKey));
  // An unusable access token is refused by the session layer, not by a family decision.
  await assert.rejects(guardianship.create('not-a-token', valid, randomUUID()), refuses('AUTH_ACCESS_INVALID', 401));
  await assert.rejects(guardianship.create('', valid, randomUUID()), refuses('AUTH_ACCESS_INVALID', 401));

  // No part of a refused request is written: no child subject, consent, relationship, record or audit.
  assert.equal(await childSubjects(own.familyId), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.subjects WHERE kind='child'"), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.consent_records'), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.guardian_relationships'), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records'), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.child.create'"), 0);
  assert.equal(await familyVersion(own.familyId), 1);
});

test('a revoked relationship, withdrawn consent or removed child is never restored by the original key', async () => {
  const owner = await adult();
  const own = await family(owner);
  const key = randomUUID();
  const created = await createChild(owner, own, {}, key);

  // Revoking the relationship stops the replay instead of resurrecting the child.
  await db.app.query('UPDATE siyue.guardian_relationships SET active=false, version=version+1 WHERE family_id=$1 AND guardian_subject_id=$2',
    [own.familyId, subjectOf(owner)]);
  await assert.rejects(createChild(owner, own, {}, key), refuses('FAMILY_CHILD_RELATIONSHIP_INACTIVE', 409));
  assert.equal((await rows('SELECT active FROM siyue.guardian_relationships WHERE guardian_subject_id=$1',
    [subjectOf(owner)]))[0].active, false);
  // Re-approval is an explicit update somewhere else; the old key only reads that live state back.
  await db.app.query('UPDATE siyue.guardian_relationships SET active=true WHERE family_id=$1 AND guardian_subject_id=$2',
    [own.familyId, subjectOf(owner)]);
  assert.equal((await createChild(owner, own, {}, key)).childSubjectId, created.childSubjectId);
  // Withdrawing the consent behind the relationship hides it too, and clearing it restores the read.
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=now() WHERE subject_id=$1', [created.childSubjectId]);
  await assert.rejects(createChild(owner, own, {}, key), refuses('FAMILY_CHILD_RELATIONSHIP_INACTIVE', 409));
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=NULL WHERE subject_id=$1', [created.childSubjectId]);
  assert.equal((await createChild(owner, own, {}, key)).childSubjectId, created.childSubjectId);
  // Removing the child from the family is a removal, not a reason to recreate one.
  await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2',
    [own.familyId, created.childSubjectId]);
  await assert.rejects(createChild(owner, own, {}, key), refuses('FAMILY_CHILD_RELATIONSHIP_INACTIVE', 409));
  await db.app.query('UPDATE siyue.family_memberships SET active=true WHERE family_id=$1 AND subject_id=$2',
    [own.familyId, created.childSubjectId]);

  // A guardian that lost the role, the version, the membership or the subject recovers nothing either.
  await db.app.query("UPDATE siyue.family_memberships SET role='member' WHERE family_id=$1 AND subject_id=$2",
    [own.familyId, subjectOf(owner)]);
  await assert.rejects(createChild(owner, own, {}, key), refuses('FAMILY_CHILD_FORBIDDEN', 403));
  await db.app.query("UPDATE siyue.family_memberships SET role='owner' WHERE family_id=$1 AND subject_id=$2",
    [own.familyId, subjectOf(owner)]);
  await db.app.query('UPDATE siyue.family_memberships SET version=2 WHERE family_id=$1 AND subject_id=$2',
    [own.familyId, subjectOf(owner)]);
  await assert.rejects(createChild(owner, own, {}, key), refuses('FAMILY_STALE_AUTHORIZATION', 409));
  await db.app.query('UPDATE siyue.family_memberships SET version=1 WHERE family_id=$1 AND subject_id=$2',
    [own.familyId, subjectOf(owner)]);
  await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2',
    [own.familyId, subjectOf(owner)]);
  await assert.rejects(createChild(owner, own, {}, key), refuses('FAMILY_NOT_FOUND', 404));
  await db.app.query('UPDATE siyue.family_memberships SET active=true WHERE family_id=$1 AND subject_id=$2',
    [own.familyId, subjectOf(owner)]);
  // A dissolved family closes the relationship for every guardian, and the old key never reopens it.
  await db.app.query("UPDATE siyue.families SET status='dissolved' WHERE id=$1", [own.familyId]);
  await assert.rejects(createChild(owner, own, {}, key), refuses('FAMILY_CHILD_FAMILY_INACTIVE', 409));
  await db.app.query("UPDATE siyue.families SET status='active' WHERE id=$1", [own.familyId]);

  // Through every path the original key produced exactly one child, one consent and one bump.
  assert.equal(await childSubjects(own.familyId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.consent_records'), 1);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.child.create'"), 1);
  assert.equal(await familyVersion(own.familyId), 2);
});

test('the child, consent, membership and relationship commit together or not at all', async () => {
  const owner = await adult();
  const own = await family(owner);
  const key = randomUUID();
  // A synthetic failure on the last relationship insert proves the whole transaction rolls back.
  await db.admin.query(`CREATE FUNCTION siyue.synthetic_guardian_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic_guardian_failure'; END $$;`);
  await db.admin.query(`CREATE TRIGGER synthetic_guardian_failure BEFORE INSERT ON siyue.guardian_relationships
    FOR EACH ROW EXECUTE FUNCTION siyue.synthetic_guardian_failure();`);
  try {
    const failure = await createChild(owner, own, {}, key).then(() => null, error => error);
    assert.match(String(failure?.message), /synthetic_guardian_failure/);
  } finally {
    await db.admin.query('DROP TRIGGER IF EXISTS synthetic_guardian_failure ON siyue.guardian_relationships');
    await db.admin.query('DROP FUNCTION IF EXISTS siyue.synthetic_guardian_failure()');
  }
  // No orphan child subject, consent, membership, relationship, idempotency record or audit row remains.
  assert.equal(await childSubjects(own.familyId), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.subjects WHERE kind='child'`), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.consent_records'), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.guardian_relationships'), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records'), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.security_events'), 0);
  assert.equal(await familyVersion(own.familyId), 1);
  // The key was never consumed, so the corrected request still creates exactly one child.
  const created = await createChild(owner, own, {}, key);
  assert.equal(created.familyVersion, 2);
  assert.equal(await childSubjects(own.familyId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.consent_records'), 1);
  assert.deepEqual(await createChild(owner, own, {}, key), created);
});

test('a restricted child session is real and still cannot create a guardianship', async () => {
  const owner = await adult();
  const own = await family(owner);
  const created = await createChild(owner, own);
  // A restricted child session is only valid behind a live device grant chain (design 16.3), so the
  // fixture writes the same rows a pairing completion would and points at the relationship this slice
  // created: guardian relationship version, live consent, active family and both memberships.
  const now = fx.clock(), grantId = randomUUID(), installationId = randomUUID(), sessionId = randomUUID();
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,
      platform,device_label,guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios','测试设备',1,1,ARRAY['child-room'],$6)`,
  [grantId, created.childSubjectId, subjectOf(owner), own.familyId, installationId, new Date(+now + 30 * day)]);
  await db.app.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,credential_version,
      authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at,grant_expires_at,device_grant_id)
    VALUES($1,$2,$3,'child',1,$4,$4,$4,$5,$6,$5,$7)`,
  [sessionId, created.childSubjectId, installationId, now, new Date(+now + 30 * day), new Date(+now + 180 * day), grantId]);
  const token = await fx.signer.sign(created.childSubjectId, sessionId, 1, now, new Date(+now + 900_000));

  // The session is genuinely usable as the child it claims to be, and still holds no family management.
  assert.deepEqual((await fx.service.verify(token)).subjectKind, 'child');
  await assert.rejects(guardianship.create(token, { familyId: own.familyId, displayName: '玥玥',
    consentPolicyVersion: 'guardian-consent-v1', consentConfirmed: true, expectedMembershipVersion: 1, expectedFamilyVersion: 2 },
  randomUUID()), refuses('FAMILY_ADULT_REQUIRED', 403));
  // The same restricted session is refused the trusted child list, so the family read stays adult-only.
  await assert.rejects(guardianship.list(token, own.familyId), refuses('FAMILY_ADULT_REQUIRED', 403));
  // Revoking the grant ends the child session immediately, without any family-management path.
  await db.app.query('UPDATE siyue.device_grants SET revoked_at=created_at WHERE id=$1', [grantId]);
  await assert.rejects(fx.service.verify(token), refuses('AUTH_SESSION_INVALID', 401));
  assert.equal(await childSubjects(own.familyId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.consent_records'), 1);
});

test('a guardian lists only their own live children of one family, with the current relationship version', async () => {
  const owner = await adult(), admin = await adult();
  const own = await family(owner);
  await addMembership(own.familyId, subjectOf(admin), 'admin', 1);
  fx.advance(1000);
  const mine = await createChild(owner, own, { displayName: '玥玥' });
  fx.advance(1000);
  const theirs = await createChild(admin, { familyId: own.familyId, membershipVersion: 1, familyVersion: 2 }, { displayName: '小禾' });

  // Each guardian reads exactly their own child, in the shared minimal summary, at the current versions.
  const version = await familyVersion(own.familyId);
  assert.deepEqual(await listChildren(owner, own.familyId), [{ ...mine, familyVersion: version }]);
  assert.deepEqual(await listChildren(admin, own.familyId), [{ ...theirs, familyVersion: version }]);
  assert.equal(childSummarySchema.safeParse((await listChildren(owner, own.familyId))[0]).success, true);
  // The other guardian's child is never listed: guardianship is per relationship, not per family role.
  assert.deepEqual((await listChildren(owner, own.familyId)).map(item => item.childSubjectId), [mine.childSubjectId]);
  assert.deepEqual((await listChildren(admin, own.familyId)).map(item => item.childSubjectId), [theirs.childSubjectId]);
  // The relationship version the list reports is the one the row holds now, and a newer family version is
  // reported instead of the one the caller last read.
  await db.app.query('UPDATE siyue.guardian_relationships SET version=4 WHERE family_id=$1 AND guardian_subject_id=$2',
    [own.familyId, subjectOf(owner)]);
  await db.app.query('UPDATE siyue.families SET version=version+1 WHERE id=$1', [own.familyId]);
  assert.deepEqual((await listChildren(owner, own.familyId)).map(item => [item.relationshipVersion, item.familyVersion]), [[4, version + 1]]);
  // The read writes nothing at all.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records'), 2);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.child.create'"), 2);
});

test('a family role is not guardianship, and every dead part of a relationship hides its child', async () => {
  const owner = await adult(), admin = await adult(), member = await adult(), stranger = await adult();
  const own = await family(owner);
  await addMembership(own.familyId, subjectOf(admin), 'admin', 1);
  await addMembership(own.familyId, subjectOf(member), 'member', 1);
  const created = await createChild(owner, own);
  assert.deepEqual((await listChildren(owner, own.familyId)).map(item => item.childSubjectId), [created.childSubjectId]);

  // An admin or plain member of the same family reads no child they do not actually guard, and losing the
  // managing role does not take the relationship away: the relationship decides, never the role.
  for (const who of [admin, member]) assert.deepEqual(await listChildren(who, own.familyId), []);
  await db.app.query("UPDATE siyue.family_memberships SET role='member' WHERE family_id=$1 AND subject_id=$2",
    [own.familyId, subjectOf(owner)]);
  assert.equal((await listChildren(owner, own.familyId)).length, 1);
  await db.app.query("UPDATE siyue.family_memberships SET role='owner' WHERE family_id=$1 AND subject_id=$2",
    [own.familyId, subjectOf(owner)]);

  // A foreign subject, an unknown family and a malformed id never turn into an empty list, and an unusable
  // access token is refused by the session layer instead of by a family decision.
  await assert.rejects(listChildren(stranger, own.familyId), refuses('FAMILY_NOT_FOUND', 404));
  await assert.rejects(listChildren(owner, randomUUID()), refuses('FAMILY_NOT_FOUND', 404));
  await assert.rejects(listChildren(owner, 'not-a-uuid'), refuses('FAMILY_INVALID_REQUEST', 400));
  await assert.rejects(guardianship.list('not-a-token', own.familyId), refuses('AUTH_ACCESS_INVALID', 401));
  await assert.rejects(guardianship.list('', own.familyId), refuses('AUTH_ACCESS_INVALID', 401));

  // Withdrawn consent, an ended relationship, a removed child, a blocked child and a dissolved family each
  // hide the child from its own guardian, and clearing the exact cause brings the same row back.
  const setConsentWithdrawn = at => db.app.query('UPDATE siyue.consent_records SET withdrawn_at=$2 WHERE subject_id=$1',
    [created.childSubjectId, at]);
  const setRelationshipActive = active => db.app.query('UPDATE siyue.guardian_relationships SET active=$2 WHERE child_subject_id=$1',
    [created.childSubjectId, active]);
  await setConsentWithdrawn(fx.clock());
  assert.deepEqual(await listChildren(owner, own.familyId), []);
  await setConsentWithdrawn(null);
  await setRelationshipActive(false);
  assert.deepEqual(await listChildren(owner, own.familyId), []);
  await setRelationshipActive(true);
  await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2',
    [own.familyId, created.childSubjectId]);
  assert.deepEqual(await listChildren(owner, own.familyId), []);
  await db.app.query('UPDATE siyue.family_memberships SET active=true WHERE family_id=$1 AND subject_id=$2',
    [own.familyId, created.childSubjectId]);
  await db.app.query("UPDATE siyue.subjects SET status='blocked' WHERE id=$1", [created.childSubjectId]);
  assert.deepEqual(await listChildren(owner, own.familyId), []);
  await db.app.query("UPDATE siyue.subjects SET status='active' WHERE id=$1", [created.childSubjectId]);
  assert.equal((await listChildren(owner, own.familyId)).length, 1);
  // The guardian side is live state too: an adult removed from the family reads no family and no child.
  await db.app.query('UPDATE siyue.family_memberships SET active=false WHERE family_id=$1 AND subject_id=$2',
    [own.familyId, subjectOf(owner)]);
  await assert.rejects(listChildren(owner, own.familyId), refuses('FAMILY_NOT_FOUND', 404));
  await db.app.query('UPDATE siyue.family_memberships SET active=true WHERE family_id=$1 AND subject_id=$2',
    [own.familyId, subjectOf(owner)]);
  await db.app.query("UPDATE siyue.families SET status='dissolved' WHERE id=$1", [own.familyId]);
  await assert.rejects(listChildren(owner, own.familyId), refuses('FAMILY_NOT_FOUND', 404));
  await db.app.query("UPDATE siyue.families SET status='active' WHERE id=$1", [own.familyId]);
  assert.equal((await listChildren(owner, own.familyId)).length, 1);

  // Every refusal and empty list above left the stored relationship and the write-side tables untouched.
  assert.deepEqual(await rows('SELECT active, version FROM siyue.guardian_relationships WHERE child_subject_id=$1',
    [created.childSubjectId]), [{ active: true, version: 1 }]);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records'), 1);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='family.child.create'"), 1);
});

test('the consent behind a relationship is bound to its own actor, child and purpose', async () => {
  const owner = await adult(), admin = await adult();
  const own = await family(owner);
  await addMembership(own.familyId, subjectOf(admin), 'admin', 1);
  fx.advance(1000);
  const first = await createChild(owner, own, { displayName: '玥玥' });
  fx.advance(1000);
  const second = await createChild(owner, { ...own, familyVersion: 2 }, { displayName: '小禾' });
  const listed = async () => (await listChildren(owner, own.familyId)).map(item => item.childSubjectId);
  assert.deepEqual(await listed(), [first.childSubjectId, second.childSubjectId]);

  const [firstConsent] = await rows('SELECT id FROM siyue.consent_records WHERE subject_id=$1', [first.childSubjectId]);
  const [secondConsent] = await rows('SELECT id FROM siyue.consent_records WHERE subject_id=$1', [second.childSubjectId]);
  const otherActor = randomUUID(), otherPurpose = randomUUID();
  // A different adult's consent about the same child, the right adult's consent for another purpose, and the
  // right adult's consent about another child are all merely present: none of them authorizes this row.
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-guardianship','guardian-consent-v1')`, [otherActor, subjectOf(admin), first.childSubjectId]);
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version)
    VALUES($1,$2,$3,'child-device-pairing','guardian-consent-v1')`, [otherPurpose, subjectOf(owner), first.childSubjectId]);

  const repoint = consentId => db.app.query('UPDATE siyue.guardian_relationships SET consent_record_id=$1 WHERE child_subject_id=$2',
    [consentId, first.childSubjectId]);
  for (const [consentId, why] of [[otherActor, 'another actor'], [otherPurpose, 'another purpose'], [secondConsent.id, 'another child']]) {
    await repoint(consentId);
    assert.deepEqual(await listed(), [second.childSubjectId], why);
    await repoint(firstConsent.id);
    assert.deepEqual(await listed(), [first.childSubjectId, second.childSubjectId], why);
  }
  // Withdrawing one child's consent hides that child only.
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=recorded_at WHERE id=$1', [secondConsent.id]);
  assert.deepEqual(await listed(), [first.childSubjectId]);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.guardian_relationships'), 2);
});

test('the periodic sweep drops expired family-children keys and spares live keys and other scopes', async () => {
  const staleOwner = await adult();
  const stale = await family(staleOwner);
  const staleKey = randomUUID();
  await createChild(staleOwner, stale, {}, staleKey);
  // Past this family's own 90-day window: the create key is now only a dead row in the table.
  fx.advance(91 * day);
  const owner = await adult();
  const own = await family(owner);
  const liveKey = randomUUID();
  const live = await createChild(owner, own, {}, liveKey);
  // Expired rows from the scopes of other businesses: this module's sweep must leave every one alone.
  const others = ['family-invitation:' + randomUUID(), 'family-invitation-accept:' + randomUUID(),
    'child-device-pairing-complete:' + randomUUID(), 'register:' + randomUUID()];
  for (const scope of others) await db.app.query(
    "INSERT INTO siyue.idempotency_records(scope,key_hash,request_mac,status,expires_at) VALUES($1,$2,'mac','complete',$3)",
    [scope, keyHash(), new Date(+fx.clock() - day)]);

  await guardianship.cleanupExpired();

  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope=$1', [scopeOf(stale.familyId)]), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope=$1', [scopeOf(own.familyId)]), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope = ANY($1::text[])', [others]), others.length);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.idempotency_records'), 1 + others.length);
  // A live key still replays its own child, so the sweep ended one dead window and changed nothing else.
  assert.deepEqual(await createChild(owner, own, {}, liveKey), live);
});
