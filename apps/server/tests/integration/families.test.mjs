import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createFamilyRepository } from '../../dist/modules/families/repository.js';
import { createRuntimeApp } from '../../dist/runtime-app.js';

// Real Fastify routes against an isolated temporary PostgreSQL cluster: no database URL, no .env, no
// provider. The child session below is issued from a real device grant with scopes=[], the same row the
// pairing flow creates, and the child really holds an active membership of the family it must not read.
let db, fx, app;
before(async () => {
  db = await startPostgresFixture();
  fx = await createEmailFixture(db);
  app = createRuntimeApp(db.app, db.identity, { sessions: fx.service });
});
after(async () => { await app?.close(); await db?.stop(); });

const get = (url, token) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const dataOf = async response => (await response.json()).data;
const codeOf = async response => (await response.json()).error.code;
const id = () => randomUUID();
const key = () => createHash('sha256').update(randomUUID()).digest('hex');

/** One owner family, plus a real child device session whose child membership is active. */
async function scene() {
  const guardian = await fx.issue();
  const family = await transaction(db.app, client => createFamilyRepository(db.app).create(client, guardian.session.subjectId, key()));
  const childId = id(), consentId = id(), grantId = id();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'child','小禾')", [childId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')", [family.familyId, childId]);
  await db.app.query("INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version) VALUES($1,$2,$3,'child-guardianship','0.0.1')",
    [consentId, guardian.session.subjectId, childId]);
  await db.app.query('INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)',
    [family.familyId, guardian.session.subjectId, childId, consentId]);
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,device_label,
    guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios','Synthetic iPad',1,1,ARRAY[]::text[],$6)`,
  [grantId, childId, guardian.session.subjectId, family.familyId, id(), new Date(+fx.clock() + 30 * 86_400_000 - 1_000)]);
  const child = await transaction(db.app, client => fx.service.issueChild(client, grantId));
  return { guardian, family, child, childId, grantId };
}

test('a child device session cannot read a family summary through either family read route', async () => {
  const value = await scene();
  // The denial is authorization, not absent data: the child is a listed, active member of that family.
  assert.deepEqual((await db.app.query('SELECT role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',
    [value.family.familyId, value.childId])).rows[0], { role: 'member', active: true, version: 1 });
  assert.deepEqual((await db.app.query('SELECT scopes FROM siyue.device_grants WHERE id=$1', [value.grantId])).rows[0].scopes, []);
  const list = await get('/v1/families', value.child.accessToken);
  assert.equal(list.statusCode, 403);
  assert.equal(await codeOf(list), 'FAMILY_ADULT_REQUIRED');
  const detail = await get(`/v1/families/${value.family.familyId}`, value.child.accessToken);
  assert.equal(detail.statusCode, 403);
  assert.equal(await codeOf(detail), 'FAMILY_ADULT_REQUIRED');
  // A family the child is a member of and an unknown family stay indistinguishable.
  const unknown = await get(`/v1/families/${id()}`, value.child.accessToken);
  assert.equal(unknown.statusCode, 403);
  assert.equal(await codeOf(unknown), 'FAMILY_ADULT_REQUIRED');
  // The summary keeps owner subjectId, role, membership version, family version and family id private.
  for (const response of [list, detail, unknown])
    for (const secret of [value.family.familyId, value.guardian.session.subjectId, value.childId, 'ownerSubjectId', 'membershipVersion'])
      assert.equal(response.body.includes(secret), false, `${secret} leaked: ${response.body}`);
  // Only the family summary read is closed: the child session itself stays valid, so an explicit room or
  // board grant added later is not pre-empted by this rule.
  const session = await get('/v1/account/session', value.child.accessToken);
  assert.equal(session.statusCode, 200);
  assert.equal((await session.json()).subjectKind, 'child');
});

test('adult owner, admin and member still read the same summary and a foreign family stays hidden', async () => {
  const value = await scene();
  assert.deepEqual(await dataOf(await get('/v1/families', value.guardian.accessToken)), { items: [value.family] });
  assert.deepEqual(await dataOf(await get(`/v1/families/${value.family.familyId}`, value.guardian.accessToken)), value.family);
  const admin = await fx.issue(), member = await fx.issue();
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,version) VALUES($1,$2,'admin',4)",
    [value.family.familyId, admin.session.subjectId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,version) VALUES($1,$2,'member',7)",
    [value.family.familyId, member.session.subjectId]);
  for (const [role, who, membershipVersion] of [['admin', admin, 4], ['member', member, 7]]) {
    const summary = { ...value.family, role, membershipVersion };
    assert.deepEqual(await dataOf(await get('/v1/families', who.accessToken)), { items: [summary] });
    assert.deepEqual(await dataOf(await get(`/v1/families/${value.family.familyId}`, who.accessToken)), summary);
  }
  const stranger = await fx.issue();
  assert.deepEqual(await dataOf(await get('/v1/families', stranger.accessToken)), { items: [] });
  const foreign = await get(`/v1/families/${value.family.familyId}`, stranger.accessToken);
  assert.equal(foreign.statusCode, 404);
  assert.equal(await codeOf(foreign), 'FAMILY_NOT_FOUND');
  assert.equal(foreign.body.includes(value.guardian.session.subjectId), false);
});
