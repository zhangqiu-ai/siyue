import { test, expect } from 'playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { startPostgresFixture } from '../../apps/server/tests/integration/postgres-fixture.mjs';
import { createEmailFixture } from '../../apps/server/tests/integration/email-fixture.mjs';
import { createRuntimeApp } from '../../apps/server/dist/runtime-app.js';
import { createGuardianshipService } from '../../apps/server/dist/modules/families/guardianship.js';

// Real Fastify + isolated PostgreSQL. No account, household or mailbox leaves this fixture.
// The guardian service reaches the app the way production wires it: as the `guardianship` option of
// createRuntimeApp. These cases therefore cover the real route registration as well as the behaviour.
const day = 86_400_000;
let db, fx, app, address;
test.beforeAll(async () => {
  db = await startPostgresFixture();
  fx = await createEmailFixture(db);
  const guardianship = createGuardianshipService(db.app, fx.service, randomBytes(32), fx.clock);
  app = createRuntimeApp(db.app, db.identity, { sessions: fx.service, email: fx.email, guardianship });
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
test.afterAll(async () => { await app?.close(); await db?.stop(); });

/** Everything this slice writes, counted inside one family so parallel fixtures never interfere. */
const familyState = familyId => db.app.query(`SELECT
    (SELECT count(*)::int FROM siyue.subjects p JOIN siyue.family_memberships m ON m.subject_id = p.id
      WHERE m.family_id = $1 AND p.kind = 'child') AS children,
    (SELECT count(*)::int FROM siyue.guardian_relationships r WHERE r.family_id = $1) AS relationships,
    (SELECT count(*)::int FROM siyue.consent_records c
      WHERE c.subject_id IN (SELECT subject_id FROM siyue.family_memberships WHERE family_id = $1)) AS consents,
    (SELECT count(*)::int FROM siyue.idempotency_records i WHERE i.scope = $2) AS records,
    (SELECT version FROM siyue.families WHERE id = $1) AS family_version`,
  [familyId, `family-children:${familyId}`]).then(result => result.rows[0]);
const headers = (token, key) => ({ authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) });
async function createFamily(request, token) {
  const response = await request.post(address + '/v1/families', { headers: headers(token, randomUUID()) });
  expect(response.status()).toBe(201);
  return (await response.json()).data;
}
const childBody = (family, overrides = {}) => ({ displayName: '玥玥', consentPolicyVersion: 'guardian-consent-v1',
  consentConfirmed: true, expectedMembershipVersion: family.membershipVersion, expectedFamilyVersion: family.familyVersion,
  ...overrides });
const childUrl = family => `${address}/v1/families/${family.familyId}/children`;
const createChild = (request, token, family, key, overrides = {}) =>
  request.post(childUrl(family), { headers: headers(token, key), data: childBody(family, overrides) });
const listChildren = (request, token, family) => request.get(childUrl(family), { headers: headers(token) });

/** A restricted child session behind a live device grant, exactly as one pairing completion writes it. */
async function childSessionToken(child, guardianSubjectId, familyId) {
  const now = fx.clock(), grantId = randomUUID(), installationId = randomUUID(), sessionId = randomUUID();
  // The grant's own 720-hour bound is measured from its creation, so both timestamps come from one clock.
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,
      device_label,guardian_relationship_version,guardian_credential_version,scopes,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios','测试设备',1,1,ARRAY['child-room'],$6,$7)`,
  [grantId, child.childSubjectId, guardianSubjectId, familyId, installationId, now, new Date(+now + 30 * day)]);
  await db.app.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,credential_version,authenticated_at,
      created_at,last_seen_at,idle_expires_at,absolute_expires_at,grant_expires_at,device_grant_id)
    VALUES($1,$2,$3,'child',1,$4,$4,$4,$5,$6,$5,$7)`,
  [sessionId, child.childSubjectId, installationId, now, new Date(+now + 30 * day), new Date(+now + 180 * day), grantId]);
  return fx.signer.sign(child.childSubjectId, sessionId, 1, now, new Date(+now + 900_000));
}
test('an owner creates one supervised child over HTTP and the same key replays that child', async ({ request }) => {
  const owner = await fx.register(`child-${randomUUID()}@example.test`);
  const token = owner.tokens.accessToken, family = await createFamily(request, token), key = randomUUID();
  const created = await createChild(request, token, family, key);
  expect(created.status()).toBe(201);
  const body = await created.json();
  expect(body.data).toEqual({ childSubjectId: expect.any(String), familyId: family.familyId,
    guardianSubjectId: owner.tokens.session.subjectId, relationshipVersion: 1, familyVersion: 2, displayName: '玥玥' });
  expect(body.meta.requestId).toEqual(expect.any(String));
  // The same request key replays the same child instead of creating a second one.
  const replay = await createChild(request, token, family, key);
  expect(replay.status()).toBe(201);
  expect((await replay.json()).data).toEqual(body.data);
  expect((await familyState(family.familyId)).children).toBe(1);
  // The stored rows are one relationship, its consent, a plain member membership and one version bump.
  const stored = (await db.app.query(`SELECT p.kind, m.role, m.active AS member_active, c.purpose, c.policy_version,
      c.withdrawn_at, r.active AS relationship_active, r.version AS relationship_version, f.version AS family_version
    FROM siyue.guardian_relationships r
      JOIN siyue.subjects p ON p.id = r.child_subject_id
      JOIN siyue.family_memberships m ON m.family_id = r.family_id AND m.subject_id = r.child_subject_id
      JOIN siyue.consent_records c ON c.id = r.consent_record_id
      JOIN siyue.families f ON f.id = r.family_id
    WHERE r.family_id = $1`, [family.familyId])).rows;
  expect(stored).toEqual([{ kind: 'child', role: 'member', member_active: true, purpose: 'child-guardianship',
    policy_version: 'guardian-consent-v1', withdrawn_at: null, relationship_active: true, relationship_version: 1,
    family_version: 2 }]);
  // No response or stored row carries the raw request key.
  const dump = JSON.stringify(await replay.json()) + JSON.stringify(await db.app.query('SELECT * FROM siyue.idempotency_records'));
  expect(dump.includes(key)).toBe(false);
  // Another payload under the same key conflicts; a fresh key bound to the old family version is stale.
  const conflict = await createChild(request, token, family, key, { displayName: '另一个孩子' });
  expect(conflict.status()).toBe(409);
  expect((await conflict.json()).error.code).toBe('FAMILY_CHILD_CONFLICT');
  const stale = await createChild(request, token, family, randomUUID());
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe('FAMILY_STALE_AUTHORIZATION');
  expect(await familyState(family.familyId)).toMatchObject({ children: 1, relationships: 1, consents: 1, records: 1, family_version: 2 });
  // The adult still reads the family it owns, now at the advanced version.
  const list = await request.get(address + '/v1/families', { headers: headers(token) });
  expect((await list.json()).data.items).toEqual([{ ...family, familyVersion: 2 }]);
});

test('child creation requires one Bearer session, one UUID key and an unmodified consent body', async ({ request }) => {
  const owner = await fx.register(`child-${randomUUID()}@example.test`);
  const token = owner.tokens.accessToken, family = await createFamily(request, token), body = childBody(family);
  const target = childUrl(family);
  // A missing or non-Bearer credential is a refusal, not a session.
  expect((await request.post(target, { headers: { 'idempotency-key': randomUUID() }, data: body })).status()).toBe(400);
  expect((await request.post(target, { headers: { authorization: 'Basic c2l5dWU=', 'idempotency-key': randomUUID() },
    data: body })).status()).toBe(400);
  expect((await request.post(target, { headers: { authorization: `bearer ${token}`, 'idempotency-key': randomUUID() },
    data: body })).status()).toBe(400);
  expect((await request.post(target, { headers: headers('not a bearer token'), data: body })).status()).toBe(400);
  // A missing or non-UUID key never reaches the service.
  expect((await request.post(target, { headers: headers(token), data: body })).status()).toBe(400);
  expect((await request.post(target, { headers: headers(token, 'not-a-uuid'), data: body })).status()).toBe(400);
  // A query string cannot smuggle identity, and no body field can declare a role, kind or relationship.
  expect((await request.post(target + '?role=owner', { headers: headers(token, randomUUID()), data: body })).status()).toBe(400);
  for (const forged of [{ role: 'owner' }, { subjectKind: 'adult' }, { kind: 'adult' }, { subjectKind: 'child' },
    { guardianSubjectId: randomUUID() }, { childSubjectId: randomUUID() }, { relationshipVersion: 1 },
    { familyVersion: 5 }, { ...body, consentConfirmed: false }, { ...body, displayName: '' }]) {
    const response = await request.post(target, { headers: headers(token, randomUUID()), data: forged });
    expect(response.status(), JSON.stringify(forged)).toBe(400);
  }
  // Nothing was created by any refusal and the family version never moved.
  expect(await familyState(family.familyId)).toEqual({ children: 0, relationships: 0, consents: 0, records: 0, family_version: 1 });
});

test('only a current owner or admin creates a child, and a revoked relationship blocks the replay', async ({ request }) => {
  const owner = await fx.register(`child-${randomUUID()}@example.test`);
  const member = await fx.register(`child-${randomUUID()}@example.test`);
  const stranger = await fx.register(`child-${randomUUID()}@example.test`);
  const token = owner.tokens.accessToken, family = await createFamily(request, token);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [family.familyId, member.tokens.session.subjectId]);
  // A plain member is refused management and a foreign subject never learns the family exists.
  for (const who of [member, stranger]) {
    const response = await createChild(request, who.tokens.accessToken, family, randomUUID());
    expect(response.status()).toBe(who === member ? 403 : 404);
    expect((await response.json()).error.code).toBe(who === member ? 'FAMILY_CHILD_FORBIDDEN' : 'FAMILY_NOT_FOUND');
  }
  const key = randomUUID();
  const created = await createChild(request, token, family, key);
  expect(created.status()).toBe(201);
  const child = (await created.json()).data;
  // Revoking the relationship refuses the original key instead of restoring the child.
  await db.app.query('UPDATE siyue.guardian_relationships SET active=false, version=version+1 WHERE family_id=$1 AND child_subject_id=$2',
    [family.familyId, child.childSubjectId]);
  const replay = await createChild(request, token, family, key);
  expect(replay.status()).toBe(409);
  expect((await replay.json()).error.code).toBe('FAMILY_CHILD_RELATIONSHIP_INACTIVE');
  expect((await familyState(family.familyId)).children).toBe(1);
  expect((await db.app.query('SELECT active FROM siyue.guardian_relationships WHERE family_id=$1',
    [family.familyId])).rows[0].active).toBe(false);
  expect((await familyState(family.familyId)).family_version).toBe(2);
  // Withdrawing the consent hides the same relationship, and a revoked session writes nothing at all.
  await db.app.query('UPDATE siyue.guardian_relationships SET active=true WHERE family_id=$1', [family.familyId]);
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=recorded_at WHERE subject_id=$1', [child.childSubjectId]);
  expect((await createChild(request, token, family, key)).status()).toBe(409);
  await db.app.query('UPDATE siyue.auth_sessions SET revoked_at=now() WHERE id=$1', [owner.tokens.session.sessionId]);
  const revoked = await createChild(request, token, family, key);
  expect(revoked.status()).toBe(401);
  expect((await revoked.json()).error.code).toBe('AUTH_SESSION_INVALID');
  expect((await familyState(family.familyId)).children).toBe(1);
});

test("the child list answers over HTTP with the caller's own live children and nothing else", async ({ request }) => {
  const owner = await fx.register(`child-${randomUUID()}@example.test`);
  const admin = await fx.register(`child-${randomUUID()}@example.test`);
  const member = await fx.register(`child-${randomUUID()}@example.test`);
  const token = owner.tokens.accessToken, family = await createFamily(request, token);
  for (const [who, role] of [[admin, 'admin'], [member, 'member']])
    await db.app.query('INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,$3)',
      [family.familyId, who.tokens.session.subjectId, role]);
  const first = (await (await createChild(request, token, family, randomUUID())).json()).data;
  fx.advance(1000);
  const second = (await (await createChild(request, token, family, randomUUID(),
    { displayName: '小禾', expectedFamilyVersion: 2 })).json()).data;
  fx.advance(1000);
  const theirs = (await (await createChild(request, admin.tokens.accessToken, family, randomUUID(),
    { displayName: '别人的孩子', expectedMembershipVersion: 1, expectedFamilyVersion: 3 })).json()).data;

  // The guardian's own children, each as the exact minimal view at the current family version.
  const list = await listChildren(request, token, family);
  expect(list.status()).toBe(200);
  const body = await list.json();
  expect(body.meta.requestId).toEqual(expect.any(String));
  expect(body.data.items).toEqual([
    { childSubjectId: first.childSubjectId, familyId: family.familyId, guardianSubjectId: owner.tokens.session.subjectId,
      relationshipVersion: 1, familyVersion: 4, displayName: '玥玥' },
    { childSubjectId: second.childSubjectId, familyId: family.familyId, guardianSubjectId: owner.tokens.session.subjectId,
      relationshipVersion: 1, familyVersion: 4, displayName: '小禾' },
  ]);
  // The admin's own child is theirs, and the admin never reads the owner's children: a family role alone
  // grants no child, so the pair of lists is disjoint.
  const adminList = (await (await listChildren(request, admin.tokens.accessToken, family)).json()).data.items;
  expect(adminList).toEqual([{ ...theirs, familyVersion: 4 }]);
  expect(adminList.map(item => item.childSubjectId)).not.toContain(first.childSubjectId);
  // A plain member that guards nobody in a family it belongs to gets an empty list, not a refusal.
  const memberList = await listChildren(request, member.tokens.accessToken, family);
  expect(memberList.status()).toBe(200);
  expect((await memberList.json()).data.items).toEqual([]);
  // Reading is not writing: the family version, the children and the stored views are unchanged.
  expect(await familyState(family.familyId)).toMatchObject({ children: 3, relationships: 3, family_version: 4 });
});

test('the child list is a bodyless GET: no query, no foreign adult, no child session', async ({ request }) => {
  const owner = await fx.register(`child-${randomUUID()}@example.test`);
  const stranger = await fx.register(`child-${randomUUID()}@example.test`);
  const token = owner.tokens.accessToken, family = await createFamily(request, token);
  const created = (await (await createChild(request, token, family, randomUUID())).json()).data;
  const target = childUrl(family);

  // One path and one Bearer credential are the whole request; anything else is refused before the service.
  expect((await request.get(target)).status()).toBe(400);
  expect((await request.get(target, { headers: { authorization: 'Basic c2l5dWU=' } })).status()).toBe(400);
  expect((await request.get(target, { headers: headers('not a bearer token') })).status()).toBe(400);
  for (const query of ['?role=owner', `?familyId=${randomUUID()}`, `?childSubjectId=${created.childSubjectId}`, '?familyId='])
    expect((await request.get(target + query, { headers: headers(token) })).status(), query).toBe(400);
  // This read is bodyless, so a forged payload cannot claim a role, another family or another child.
  const forged = await request.get(target, { headers: headers(token), data: {
    role: 'owner', guardianSubjectId: stranger.tokens.session.subjectId, childSubjectId: randomUUID(), familyId: randomUUID() } });
  expect(forged.status()).toBe(200);
  expect((await forged.json()).data.items.map(item => item.childSubjectId)).toEqual([created.childSubjectId]);
  // A foreign adult never learns the family exists, and a restricted child session is not an adult read.
  const foreign = await listChildren(request, stranger.tokens.accessToken, family);
  expect(foreign.status()).toBe(404);
  expect((await foreign.json()).error.code).toBe('FAMILY_NOT_FOUND');
  const childToken = await childSessionToken(created, owner.tokens.session.subjectId, family.familyId);
  const childRead = await listChildren(request, childToken, family);
  expect(childRead.status()).toBe(403);
  expect((await childRead.json()).error.code).toBe('FAMILY_ADULT_REQUIRED');
  // A revoked adult session reads nothing at all, and none of the refusals removed the child.
  await db.app.query('UPDATE siyue.auth_sessions SET revoked_at=now() WHERE id=$1', [owner.tokens.session.sessionId]);
  const revoked = await listChildren(request, token, family);
  expect(revoked.status()).toBe(401);
  expect((await revoked.json()).error.code).toBe('AUTH_SESSION_INVALID');
  expect(await familyState(family.familyId)).toMatchObject({ children: 1, relationships: 1, family_version: 2 });
});

test('a withdrawn consent or an ended relationship empties the list instead of hiding the family', async ({ request }) => {
  const owner = await fx.register(`child-${randomUUID()}@example.test`);
  const token = owner.tokens.accessToken, family = await createFamily(request, token);
  const child = (await (await createChild(request, token, family, randomUUID())).json()).data;
  const listed = async () => (await (await listChildren(request, token, family)).json()).data.items;
  expect((await listed()).map(item => item.childSubjectId)).toEqual([child.childSubjectId]);

  // The family stays readable for its owner, and the stored child and relationship stay in place.
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=recorded_at WHERE subject_id=$1', [child.childSubjectId]);
  expect(await listed()).toEqual([]);
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=NULL WHERE subject_id=$1', [child.childSubjectId]);
  expect((await listed()).map(item => item.childSubjectId)).toEqual([child.childSubjectId]);
  await db.app.query('UPDATE siyue.guardian_relationships SET active=false, version=version+1 WHERE child_subject_id=$1',
    [child.childSubjectId]);
  expect(await listed()).toEqual([]);
  expect(await familyState(family.familyId)).toMatchObject({ children: 1, relationships: 1, consents: 1, family_version: 2 });
  // Re-approval elsewhere restores the same row at the version it wrote; no read above rewrote it.
  await db.app.query('UPDATE siyue.guardian_relationships SET active=true WHERE child_subject_id=$1', [child.childSubjectId]);
  expect((await listed()).map(item => [item.childSubjectId, item.relationshipVersion])).toEqual([[child.childSubjectId, 2]]);
});
