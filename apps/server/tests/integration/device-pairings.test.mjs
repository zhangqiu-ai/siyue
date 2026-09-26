import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { devicePairingCreateResponseSchema, devicePairingStatusResponseSchema, devicePairingCompleteResponseSchema }
  from '@siyue/contracts';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createRuntimeApp } from '../../dist/runtime-app.js';
import { createChildDevicePairingService } from '../../dist/modules/families/device-pairings.js';
import { registerChildDevicePairingRoutes } from '../../dist/modules/families/device-pairing-routes.js';

// Isolated temporary PostgreSQL cluster and the real Fastify runtime only: no database URL, no .env, no
// provider, no mail. Every identifier, label and secret below is synthetic, and the pepper is stable for
// the whole file so stored digests can be recomputed independently of the service.
const pepper = randomBytes(32);
const minute = 60_000;
const day = 86_400_000;
const guardianAddress = '198.51.100.10';
const childAddress = '198.51.100.20';
let db, fx, app, pairings;

before(async () => { db = await startPostgresFixture(); });
beforeEach(async () => {
  await db.admin.query(`TRUNCATE siyue.device_pairing_requests,siyue.device_grants,siyue.guardian_relationships,
    siyue.consent_records,siyue.family_invitations,siyue.family_memberships,siyue.family_create_requests,siyue.families,
    siyue.auth_sessions,siyue.refresh_tokens,siyue.reauth_grants,siyue.idempotency_records,siyue.security_events,
    siyue.rate_limit_buckets,siyue.account_emails,siyue.password_credentials,siyue.email_challenges,siyue.outbox_jobs,
    siyue.subjects CASCADE`);
  fx = await createEmailFixture(db);
  pairings = createChildDevicePairingService(db.app, fx.service, fx.cipher, pepper, fx.clock);
  app = createRuntimeApp(db.app, db.identity, { sessions: fx.service });
  registerChildDevicePairingRoutes(app, pairings);
});
afterEach(async () => { await app?.close(); });
after(async () => { await db?.stop(); });

/** Real Fastify request through the runtime's own hooks; the address is part of the anonymous budget. */
const post = (url, { token, payload, ip } = {}) => app.inject({ method: 'POST', url,
  ...(payload === undefined ? {} : { payload }), ...(ip === undefined ? {} : { remoteAddress: ip }),
  ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } })});
const requestTokenHash = token => createHmac('sha256', pepper).update(JSON.stringify(['child-device-request-token', token])).digest('hex');
const pollSecretHash = secret => createHmac('sha256', pepper).update(JSON.stringify(['child-device-poll-secret', secret])).digest('hex');
const rows = (sql, ...params) => db.app.query(sql, params).then(result => result.rows);
const count = (sql, ...params) => rows(sql, ...params).then(result => Number(result[0].n));
const pairingRow = id => rows('SELECT * FROM siyue.device_pairing_requests WHERE id=$1', id).then(found => found[0]);
const secretShaped = () => randomBytes(32).toString('base64url');

/** Registered adult account with a real email-issued session. */
const account = () => fx.register(`pairing-${randomUUID()}@example.test`);

/** One family through the real route, so the owner membership is written by the trusted repository. */
async function familyOf(who) {
  const response = await app.inject({ method: 'POST', url: '/v1/families',
    headers: { authorization: `Bearer ${who.tokens.accessToken}`, 'idempotency-key': randomUUID() } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().data;
}

/**
 * Precondition owned by the neighbouring 9.2 slice: an explicit guardian relationship backed by a
 * recorded consent, an active child membership and a live child subject. The rows are written directly
 * here so this file tests only pairing behaviour; the child-create route has its own acceptance.
 */
async function guardianshipOf(guardianSubjectId, familyId) {
  const childSubjectId = randomUUID(), consentRecordId = randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'child','小禾')", [childSubjectId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,'member',true,1)",
    [familyId, childSubjectId]);
  await db.app.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version,recorded_at)
    VALUES($1,$2,$3,'child-guardianship','child-device-pairing-v1',$4)`, [consentRecordId, guardianSubjectId, childSubjectId, fx.clock()]);
  await db.app.query(`INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,active,version,
      consent_record_id,created_at) VALUES($1,$2,$3,true,1,$4,$5)`, [familyId, guardianSubjectId, childSubjectId, consentRecordId, fx.clock()]);
  await db.app.query('UPDATE siyue.families SET version=version+1 WHERE id=$1', [familyId]);
  return { childSubjectId, consentRecordId };
}

/** One paired household: guardian account, family, child and the guardian's own reauth seam. */
async function household() {
  const guardian = await account();
  const family = await familyOf(guardian);
  const child = await guardianshipOf(guardian.tokens.session.subjectId, family.familyId);
  return { guardian, family, ...child };
}

/** A persisted reauth grant, exactly as the session service issues one after fresh verification. */
const reauthGrant = (who, action = 'approve-child-device') =>
  transaction(db.app, client => fx.service.issueReauth(client, who.tokens.session.sessionId, action));

async function createPairing(overrides = {}, ip = childAddress) {
  const response = await post('/v1/device-pairings', { ip,
    payload: { installationId: randomUUID(), platform: 'ios', deviceLabel: 'Synthetic child iPad', ...overrides } });
  assert.equal(response.statusCode, 201, response.body);
  return { response, created: devicePairingCreateResponseSchema.parse(response.json().data) };
}
const readStatus = (created, { secret = created.pollSecret, ip = childAddress, pairingId = created.pairingId } = {}) =>
  post(`/v1/device-pairings/${pairingId}/status`, { ip, payload: { pollSecret: secret } });
const complete = (created, { secret = created.pollSecret, ip = childAddress, pairingId = created.pairingId } = {}) =>
  post(`/v1/device-pairings/${pairingId}/complete`, { ip, payload: { pollSecret: secret } });
const approve = (created, { token, reauthGrant: grant, childSubjectId, expectedGuardianVersion = 1,
  requestToken = created.requestToken, pairingId = created.pairingId } = {}) =>
  post(`/v1/device-pairings/${pairingId}/approve`, { token, payload: { requestToken, childSubjectId, reauthGrant: grant, expectedGuardianVersion } });

test('create stores only keyed digests and returns two independent secrets', async () => {
  const { response, created } = await createPairing({ platform: 'android', deviceLabel: 'Synthetic child phone' });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(created).sort(), ['expiresAt', 'pairingId', 'pollSecret', 'requestToken']);
  assert.match(created.requestToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.pollSecret, /^[A-Za-z0-9_-]{43}$/);
  // Design 16.3: the two secrets are different, because a reader of the request must not be able to claim
  // the child session with the same value.
  assert.notEqual(created.requestToken, created.pollSecret);
  assert.equal(created.expiresAt, new Date(+fx.clock() + 5 * minute).toISOString());

  const stored = await pairingRow(created.pairingId);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.platform, 'android');
  assert.equal(stored.device_label, 'Synthetic child phone');
  assert.deepEqual([stored.approved_by, stored.approved_at, stored.child_subject_id, stored.family_id, stored.consumed_at],
    [null, null, null, null, null]);
  assert.equal(stored.request_token_hash, requestTokenHash(created.requestToken));
  assert.equal(stored.poll_secret_hash, pollSecretHash(created.pollSecret));
  assert.notEqual(stored.request_token_hash, stored.poll_secret_hash);
  assert.equal(+stored.expires_at - +stored.created_at, 5 * minute);
  // No raw secret, and nothing but the device description, reaches the row.
  assert.equal(JSON.stringify(stored).includes(created.requestToken), false);
  assert.equal(JSON.stringify(stored).includes(created.pollSecret), false);

  // An anonymous create cannot assert an identity, a role or a capability for itself.
  for (const payload of [
    { installationId: randomUUID(), platform: 'web' }, { installationId: '', platform: 'ios' },
    { installationId: randomUUID(), platform: 'ios', deviceLabel: 'x'.repeat(101) },
    { installationId: randomUUID(), platform: 'ios', role: 'owner' },
    { installationId: randomUUID(), platform: 'ios', subjectKind: 'adult' },
    { installationId: randomUUID(), platform: 'ios', scopes: ['board.write'] },
    { installationId: randomUUID(), platform: 'ios', childSubjectId: randomUUID() },
    { installationId: randomUUID(), platform: 'ios', guardianSubjectId: randomUUID() },
  ]) assert.equal((await post('/v1/device-pairings', { ip: childAddress, payload })).statusCode, 400, JSON.stringify(payload));
  assert.equal((await post('/v1/device-pairings?platform=ios', { ip: childAddress, payload: { installationId: randomUUID(), platform: 'ios' } })).statusCode, 400);
  const oversized = await app.inject({ method: 'POST', url: '/v1/device-pairings', headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ installationId: randomUUID(), platform: 'ios', deviceLabel: 'x'.repeat(9000) }) });
  assert.equal(oversized.statusCode, 413);
  // Only the one well-formed call above produced a request.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.device_pairing_requests'), 1);
});

test('anonymous creation is strongly rate limited per address and per installation', async () => {
  for (let index = 0; index < 5; index += 1)
    assert.equal((await post('/v1/device-pairings', { ip: guardianAddress,
      payload: { installationId: `synthetic-device-${index}`, platform: 'ios' } })).statusCode, 201, `request ${index}`);
  const limited = await post('/v1/device-pairings', { ip: guardianAddress, payload: { installationId: 'synthetic-device-5', platform: 'ios' } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'CHILD_DEVICE_PAIRING_RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.device_pairing_requests'), 5);

  // A different address has its own budget, and the refused call is recorded as a refusal.
  assert.equal((await post('/v1/device-pairings', { ip: childAddress, payload: { installationId: 'synthetic-device-6', platform: 'ios' } })).statusCode, 201);
  // One address may re-pair the same installation only a few times inside the installation window.
  for (let index = 0; index < 2; index += 1)
    assert.equal((await post('/v1/device-pairings', { ip: '198.51.100.31', payload: { installationId: 'synthetic-device-6', platform: 'ios' } })).statusCode, 201);
  assert.equal((await post('/v1/device-pairings', { ip: '198.51.100.32', payload: { installationId: 'synthetic-device-6', platform: 'ios' } })).statusCode, 429);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='child.device.pairing.create' AND outcome='rate_limited'"), 2);

  // The window is a window, not a permanent lock: the same address may start again after it closes.
  fx.advance(minute + 1_000);
  assert.equal((await post('/v1/device-pairings', { ip: guardianAddress, payload: { installationId: 'synthetic-device-7', platform: 'desktop' } })).statusCode, 201);
});

test('status needs the poll secret, returns lifecycle only and refuses polls closer than three seconds', async () => {
  const { created, response: createdResponse } = await createPairing();
  const pending = await readStatus(created);
  assert.equal(pending.statusCode, 200, pending.body);
  const status = devicePairingStatusResponseSchema.parse(pending.json().data);
  assert.deepEqual(status, { status: 'pending', expiresAt: created.expiresAt });
  assert.deepEqual(Object.keys(pending.json().data).sort(), ['expiresAt', 'status']);
  // The create response is the only place both secrets exist; the status answer repeats neither secret nor
  // the pairing id.
  assert.equal(pending.body.includes(created.pollSecret), false);
  assert.equal(pending.body.includes(created.requestToken), false);
  assert.equal(pending.body.includes(created.pairingId), false);

  const tooSoon = await readStatus(created);
  assert.equal(tooSoon.statusCode, 429);
  assert.equal(tooSoon.json().error.code, 'CHILD_DEVICE_PAIRING_POLL_TOO_SOON');
  assert.equal(tooSoon.headers['retry-after'], '3');
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='child.device.pairing.status'"), 0);
  fx.advance(3_000);
  assert.equal((await readStatus(created)).statusCode, 200);

  // Polling is a child-device capability: another pairing's secret, an unknown id or the request token
  // itself are all refused, and the refusal does not distinguish an unknown id from a wrong secret.
  const other = await createPairing();
  const wrongSecret = await readStatus(created, { secret: other.created.pollSecret });
  assert.equal(wrongSecret.statusCode, 404);
  assert.equal(wrongSecret.json().error.code, 'CHILD_DEVICE_PAIRING_NOT_FOUND');
  assert.equal(wrongSecret.body.includes(other.created.pollSecret), false);
  assert.equal((await readStatus(created, { pairingId: randomUUID() })).statusCode, 404);
  assert.equal((await post(`/v1/device-pairings/${created.pairingId}/status`, { ip: childAddress,
    payload: { pollSecret: created.pollSecret, requestToken: created.requestToken } })).statusCode, 400);
  assert.equal((await post(`/v1/device-pairings/${created.pairingId}/status`, { ip: childAddress,
    payload: { requestToken: created.requestToken } })).statusCode, 400);
  assert.equal(createdResponse.statusCode, 201);
  assert.equal((await pairingRow(created.pairingId)).status, 'pending');
});

test('preview shows the scanning guardian the requesting device and the intended child, and nothing else', async () => {
  const scene = await household();
  const stranger = await account();
  const strangerFamily = await familyOf(stranger);
  const strangerChild = await guardianshipOf(stranger.tokens.session.subjectId, strangerFamily.familyId);
  const preview = (created, { token, childSubjectId, requestToken = created.requestToken,
    pairingId = created.pairingId } = {}) => post(`/v1/device-pairings/${pairingId}/preview`,
    { token, payload: { requestToken, childSubjectId } });
  const { created } = await createPairing({ installationId: 'synthetic-installation-preview', deviceLabel: 'Synthetic child iPad' });

  // The request token is a ceremony identifier, not an adult credential: without the guardian's own
  // session the route refuses the call before it reads anything.
  assert.equal((await preview(created, { childSubjectId: scene.childSubjectId })).statusCode, 400);

  // Design 16.3: the guardian sees the requesting device, the deadline and the child that would be
  // authorized, and the answer holds nothing else - no poll secret, no token, no approving adult.
  const seen = await preview(created, { token: scene.guardian.tokens.accessToken, childSubjectId: scene.childSubjectId });
  assert.equal(seen.statusCode, 200, seen.body);
  const answer = seen.json().data;
  assert.deepEqual(Object.keys(answer).sort(), ['child', 'deviceLabel', 'expiresAt', 'platform']);
  assert.deepEqual(answer, { deviceLabel: 'Synthetic child iPad', platform: 'ios', expiresAt: created.expiresAt,
    child: { childSubjectId: scene.childSubjectId, displayName: '小禾' } });
  for (const hidden of [created.requestToken, created.pollSecret, created.pairingId,
    scene.guardian.tokens.session.subjectId, scene.family.familyId]) assert.equal(seen.body.includes(hidden), false, hidden);
  // Reading is not approving: the request stays pending, no reauth grant is spent and no device exists.
  assert.equal((await pairingRow(created.pairingId)).status, 'pending');
  assert.deepEqual(await Promise.all([
    count('SELECT count(*)::int AS n FROM siyue.device_grants'),
    count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE auth_method=$1', 'child'),
    count('SELECT count(*)::int AS n FROM siyue.reauth_grants'),
  ]), [0, 0, 0]);

  // An adult who is not this child's guardian learns nothing about the device, and being the guardian of a
  // different child is not being the guardian of this one. Both refusals match the approval refusal.
  const strangerAnswer = await preview(created, { token: stranger.tokens.accessToken, childSubjectId: scene.childSubjectId });
  assert.equal(strangerAnswer.statusCode, 403);
  assert.equal(strangerAnswer.json().error.code, 'CHILD_DEVICE_PAIRING_GUARDIAN_REQUIRED');
  assert.equal(strangerAnswer.body.includes('Synthetic child iPad'), false);
  assert.equal(strangerAnswer.body.includes(scene.childSubjectId), false);
  const wrongChild = await preview(created, { token: scene.guardian.tokens.accessToken, childSubjectId: strangerChild.childSubjectId });
  assert.equal(wrongChild.statusCode, 403);
  assert.equal(wrongChild.json().error.code, 'CHILD_DEVICE_PAIRING_GUARDIAN_REQUIRED');

  // A wrong request token and a real token under another path id share one answer, so the route is not a
  // token oracle, and the poll secret is not a preview credential either.
  const wrongToken = await preview(created, { token: scene.guardian.tokens.accessToken,
    childSubjectId: scene.childSubjectId, requestToken: secretShaped() });
  assert.equal(wrongToken.statusCode, 404);
  assert.equal(wrongToken.json().error.code, 'CHILD_DEVICE_PAIRING_NOT_FOUND');
  assert.equal(wrongToken.body.includes(created.requestToken), false);
  assert.equal((await preview(created, { token: scene.guardian.tokens.accessToken, childSubjectId: scene.childSubjectId,
    pairingId: randomUUID() })).statusCode, 404);
  assert.equal((await preview(created, { token: scene.guardian.tokens.accessToken, childSubjectId: scene.childSubjectId,
    requestToken: created.pollSecret })).statusCode, 404);

  // Only the two documented fields are accepted, and the route stays closed to a query string.
  for (const payload of [
    { requestToken: created.requestToken, childSubjectId: scene.childSubjectId, expectedGuardianVersion: 1 },
    { requestToken: created.requestToken, childSubjectId: scene.childSubjectId, reauthGrant: secretShaped() },
    { requestToken: created.requestToken },
    { requestToken: created.requestToken, childSubjectId: 'not-a-uuid' },
  ]) assert.equal((await post(`/v1/device-pairings/${created.pairingId}/preview`,
    { token: scene.guardian.tokens.accessToken, payload })).statusCode, 400, JSON.stringify(payload));
  assert.equal((await post(`/v1/device-pairings/${created.pairingId}/preview?childSubjectId=${scene.childSubjectId}`,
    { token: scene.guardian.tokens.accessToken,
      payload: { requestToken: created.requestToken, childSubjectId: scene.childSubjectId } })).statusCode, 400);

  // The preview survives approval unchanged, because the ceremony is open until the device claims it.
  const grant = await reauthGrant(scene.guardian);
  assert.equal((await approve(created, { token: scene.guardian.tokens.accessToken, childSubjectId: scene.childSubjectId,
    reauthGrant: grant.reauthGrant, expectedGuardianVersion: 1 })).statusCode, 200);
  const afterApproval = await preview(created, { token: scene.guardian.tokens.accessToken, childSubjectId: scene.childSubjectId });
  assert.equal(afterApproval.statusCode, 200, afterApproval.body);
  assert.deepEqual(afterApproval.json().data, answer);

  // Once claimed the same token and session are refused, and a restricted child session cannot preview as
  // an adult: it reaches the route and is refused for being a child, not for being invalid.
  const claimed = devicePairingCompleteResponseSchema.parse((await complete(created)).json().data);
  const afterClaim = await preview(created, { token: scene.guardian.tokens.accessToken, childSubjectId: scene.childSubjectId });
  assert.equal(afterClaim.statusCode, 409);
  assert.equal(afterClaim.json().error.code, 'CHILD_DEVICE_PAIRING_NOT_PENDING');
  const reflexive = await preview(created, { token: claimed.sessionTokens.accessToken, childSubjectId: scene.childSubjectId });
  assert.equal(reflexive.statusCode, 403);
  assert.equal(reflexive.json().error.code, 'CHILD_DEVICE_PAIRING_GUARDIAN_REQUIRED');

  // Expiry is committed by the read itself and the refusal still carries no device description.
  const stale = await createPairing();
  fx.advance(5 * minute + 1_000);
  const late = await preview(stale.created, { token: scene.guardian.tokens.accessToken, childSubjectId: scene.childSubjectId });
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error.code, 'CHILD_DEVICE_PAIRING_EXPIRED');
  assert.equal(late.body.includes('Synthetic child iPad'), false);
  assert.equal((await pairingRow(stale.created.pairingId)).status, 'expired');

  // Only refused relationships are audited; reading the guardian's own request is not an event.
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='child.device.pairing.preview' AND outcome='rejected' AND redacted_metadata->>'reason'='guardian_required'"), 2);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='child.device.pairing.preview' AND outcome<>'rejected'"), 0);
});

test('approval needs an adult session, the live relationship version and an action-bound reauth grant', async () => {
  const scene = await household();
  const stranger = await account();
  const strangerFamily = await familyOf(stranger);
  const strangerChild = await guardianshipOf(stranger.tokens.session.subjectId, strangerFamily.familyId);
  const approval = (created, who, childSubjectId, grant, expectedGuardianVersion = 1) =>
    approve(created, { token: who.tokens.accessToken, childSubjectId, reauthGrant: grant, expectedGuardianVersion });

  // An unknown request token, and a real token under the wrong path id, are both "not found".
  const unknown = await createPairing();
  const strangerGrant = await reauthGrant(stranger);
  const unknownAttempt = await approve(unknown.created, { token: scene.guardian.tokens.accessToken,
    childSubjectId: scene.childSubjectId, reauthGrant: strangerGrant.reauthGrant, requestToken: secretShaped() });
  assert.equal(unknownAttempt.statusCode, 404, unknownAttempt.body);
  assert.equal((await pairingRow(unknown.created.pairingId)).status, 'pending');
  // A grant issued to another session cannot be borrowed, even with a real request token and a real guardian.
  const borrowed = await approval(unknown.created, scene.guardian, scene.childSubjectId, strangerGrant.reauthGrant);
  assert.equal(borrowed.statusCode, 401);
  assert.equal(borrowed.json().error.code, 'AUTH_REAUTH_REQUIRED');
  assert.equal((await pairingRow(unknown.created.pairingId)).status, 'pending');
  const wrongPath = await approve(unknown.created, { token: scene.guardian.tokens.accessToken,
    childSubjectId: scene.childSubjectId, reauthGrant: strangerGrant.reauthGrant, pairingId: randomUUID() });
  assert.equal(wrongPath.statusCode, 404);

  // A real guardian-relationship mismatch is refused without consuming the reauth grant.
  const mine = await createPairing();
  const strangerAttempt = await approval(mine.created, stranger, scene.childSubjectId, strangerGrant.reauthGrant);
  assert.equal(strangerAttempt.statusCode, 403);
  assert.equal(strangerAttempt.json().error.code, 'CHILD_DEVICE_PAIRING_GUARDIAN_REQUIRED');
  assert.equal((await approval(mine.created, scene.guardian, strangerChild.childSubjectId, strangerGrant.reauthGrant)).statusCode, 403);
  const stale = await approval(mine.created, scene.guardian, scene.childSubjectId, strangerGrant.reauthGrant, 2);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'CHILD_DEVICE_PAIRING_STALE_GUARDIAN_VERSION');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE consumed_at IS NOT NULL'), 0);
  assert.equal((await pairingRow(mine.created.pairingId)).status, 'pending');

  // Reauth grants are single use and bound to this action and to this session.
  const wrongAction = await reauthGrant(scene.guardian, 'change-password');
  const wrongActionAttempt = await approval(mine.created, scene.guardian, scene.childSubjectId, wrongAction.reauthGrant);
  assert.equal(wrongActionAttempt.statusCode, 401);
  assert.equal(wrongActionAttempt.json().error.code, 'AUTH_REAUTH_REQUIRED');
  const missing = await approval(mine.created, scene.guardian, scene.childSubjectId, `${randomUUID()}.${secretShaped()}`);
  assert.equal(missing.statusCode, 401);
  const expired = await reauthGrant(scene.guardian);
  await db.app.query("UPDATE siyue.reauth_grants SET expires_at=$2 WHERE id=$1", [expired.reauthGrant.split('.')[0], new Date(+fx.clock() - 1_000)]);
  assert.equal((await approval(mine.created, scene.guardian, scene.childSubjectId, expired.reauthGrant)).statusCode, 401);
  const foreignSession = await account();
  const foreignGrant = await reauthGrant(foreignSession);
  assert.equal((await approval(mine.created, scene.guardian, scene.childSubjectId, foreignGrant.reauthGrant)).statusCode, 401);

  // A withdrawn consent and an inactive relationship both hide the guardianship entirely.
  const withdrawn = await createPairing();
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=$2 WHERE id=$1', [scene.consentRecordId, fx.clock()]);
  const validGrant = await reauthGrant(scene.guardian);
  assert.equal((await approval(withdrawn.created, scene.guardian, scene.childSubjectId, validGrant.reauthGrant)).statusCode, 403);
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=NULL WHERE id=$1', [scene.consentRecordId]);
  await db.app.query('UPDATE siyue.guardian_relationships SET active=false WHERE family_id=$1 AND guardian_subject_id=$2',
    [scene.family.familyId, scene.guardian.tokens.session.subjectId]);
  assert.equal((await approval(withdrawn.created, scene.guardian, scene.childSubjectId, validGrant.reauthGrant)).statusCode, 403);
  await db.app.query('UPDATE siyue.guardian_relationships SET active=true WHERE family_id=$1 AND guardian_subject_id=$2',
    [scene.family.familyId, scene.guardian.tokens.session.subjectId]);

  // The consent is bound, not merely present: another purpose, another actor or another child hides the
  // relationship, so no unrelated consent record can authorize a device pairing.
  const bound = await createPairing();
  const boundGrant = await reauthGrant(scene.guardian);
  const boundAttempt = () => approval(bound.created, scene.guardian, scene.childSubjectId, boundGrant.reauthGrant);
  await db.app.query("UPDATE siyue.consent_records SET purpose='email-verification' WHERE id=$1", [scene.consentRecordId]);
  assert.equal((await boundAttempt()).statusCode, 403);
  await db.app.query("UPDATE siyue.consent_records SET purpose='child-guardianship',actor_subject_id=$2 WHERE id=$1",
    [scene.consentRecordId, stranger.tokens.session.subjectId]);
  assert.equal((await boundAttempt()).statusCode, 403);
  await db.app.query('UPDATE siyue.consent_records SET actor_subject_id=$2,subject_id=$3 WHERE id=$1',
    [scene.consentRecordId, scene.guardian.tokens.session.subjectId, strangerChild.childSubjectId]);
  assert.equal((await boundAttempt()).statusCode, 403);
  await db.app.query('UPDATE siyue.consent_records SET subject_id=$2 WHERE id=$1', [scene.consentRecordId, scene.childSubjectId]);
  assert.equal((await pairingRow(bound.created.pairingId)).status, 'pending');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE consumed_at IS NOT NULL'), 0);

  // A live relationship at the observed version approves exactly once, and approval alone creates no grant.
  const grant = await reauthGrant(scene.guardian);
  const approved = await approval(mine.created, scene.guardian, scene.childSubjectId, grant.reauthGrant);
  assert.equal(approved.statusCode, 200, approved.body);
  assert.deepEqual(devicePairingStatusResponseSchema.parse(approved.json().data),
    { status: 'approved', expiresAt: mine.created.expiresAt });
  const row = await pairingRow(mine.created.pairingId);
  assert.equal(row.status, 'approved');
  assert.equal(row.approved_by, scene.guardian.tokens.session.subjectId);
  assert.equal(row.child_subject_id, scene.childSubjectId);
  assert.equal(row.family_id, scene.family.familyId);
  assert.deepEqual([row.approved_guardian_version, row.approved_credential_version], [1, 1]);
  assert.equal(+row.approved_at, +fx.clock());
  assert.equal(row.consumed_at, null);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.device_grants'), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE auth_method=$1', 'child'), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE consumed_at IS NOT NULL'), 1);

  // A consumed grant never approves twice, and the guardian's session cannot approve its own child as an adult.
  assert.equal((await approval(mine.created, scene.guardian, scene.childSubjectId, grant.reauthGrant)).statusCode, 401);
  const repeat = await reauthGrant(scene.guardian);
  const repeated = await approval(mine.created, scene.guardian, scene.childSubjectId, repeat.reauthGrant);
  assert.equal(repeated.statusCode, 200);
  assert.equal((await pairingRow(mine.created.pairingId)).status, 'approved');
  const strangerRepeat = await reauthGrant(stranger);
  assert.equal((await approval(mine.created, stranger, scene.childSubjectId, strangerRepeat.reauthGrant)).statusCode, 409);
});

test('completion consumes one secret and creates a 30-day grant with a restricted child session', async () => {
  const scene = await household();
  const installationId = randomUUID();
  const { created } = await createPairing({ installationId, deviceLabel: 'Synthetic child iPad' });
  assert.equal((await complete(created)).statusCode, 409);
  const grant = await reauthGrant(scene.guardian);
  assert.equal((await approve(created, { token: scene.guardian.tokens.accessToken, childSubjectId: scene.childSubjectId,
    reauthGrant: grant.reauthGrant, expectedGuardianVersion: 1 })).statusCode, 200);

  const completed = await complete(created);
  assert.equal(completed.statusCode, 200, completed.body);
  const result = devicePairingCompleteResponseSchema.parse(completed.json().data);
  assert.deepEqual(Object.keys(result).sort(), ['deviceGrantId', 'sessionTokens']);
  assert.equal(result.sessionTokens.session.subjectKind, 'child');
  assert.equal(result.sessionTokens.session.subjectId, scene.childSubjectId);
  assert.equal(result.sessionTokens.session.expiresAt, result.sessionTokens.accessExpiresAt);
  // Nothing adult may ride along: no guardian identity, no guardian credential, no second session.
  assert.equal(completed.body.includes(scene.guardian.tokens.session.subjectId), false);
  assert.equal(completed.body.includes(scene.guardian.tokens.refreshToken), false);
  assert.equal(completed.body.includes(scene.guardian.tokens.accessToken), false);
  assert.equal(completed.body.includes(created.pollSecret), false);
  const verified = await fx.service.verify(result.sessionTokens.accessToken);
  assert.deepEqual([verified.subjectId, verified.subjectKind], [scene.childSubjectId, 'child']);

  const stored = (await rows('SELECT * FROM siyue.device_grants WHERE id=$1', result.deviceGrantId))[0];
  assert.deepEqual([stored.child_subject_id, stored.guardian_id, stored.family_id, stored.installation_id, stored.platform,
    stored.device_label], [scene.childSubjectId, scene.guardian.tokens.session.subjectId, scene.family.familyId,
    installationId, 'ios', 'Synthetic child iPad']);
  assert.deepEqual([stored.guardian_relationship_version, stored.guardian_credential_version, stored.version, stored.revoked_at],
    [1, 1, 1, null]);
  assert.deepEqual(stored.scopes, []);
  assert.equal(+stored.expires_at - +stored.created_at, 30 * day);
  const childSessions = await rows('SELECT * FROM siyue.auth_sessions WHERE device_grant_id=$1', result.deviceGrantId);
  assert.equal(childSessions.length, 1);
  assert.deepEqual([childSessions[0].subject_id, childSessions[0].auth_method, childSessions[0].installation_id],
    [scene.childSubjectId, 'child', stored.installation_id]);
  assert.equal(+childSessions[0].grant_expires_at, +stored.expires_at);
  assert.equal(+childSessions[0].idle_expires_at, +stored.expires_at);
  const consumedRow = await pairingRow(created.pairingId);
  assert.equal(consumedRow.status, 'consumed');
  assert.equal(+consumedRow.consumed_at, +fx.clock());
  fx.advance(3_000);
  assert.equal((await readStatus(created)).json().data.status, 'consumed');

  // The same poll secret recovers the same result inside the short window instead of minting a second one.
  const recovered = await complete(created);
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.deepEqual(devicePairingCompleteResponseSchema.parse(recovered.json().data), result);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.device_grants'), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE auth_method=$1', 'child'), 1);
  // The raw poll secret never lands in the recovery record, and the grant is not a credential store.
  assert.equal((await rows('SELECT * FROM siyue.idempotency_records WHERE resource_id=$1', result.deviceGrantId))
    .some(record => JSON.stringify(record).includes(created.pollSecret)), false);

  // The restricted session is real: it refreshes inside the grant ceiling and never outlives it.
  const rotated = await fx.service.refresh(result.sessionTokens.refreshToken, randomUUID());
  assert.equal(rotated.session.subjectKind, 'child');
  assert.equal(rotated.refreshExpiresAt, stored.expires_at.toISOString());
  assert.equal((await fx.service.verify(rotated.accessToken)).subjectId, scene.childSubjectId);
  // A completed-response retry must not resurrect the original refresh proof after rotation.
  const staleCredential = await complete(created);
  assert.equal(staleCredential.statusCode, 409);
  assert.equal(staleCredential.json().error.code, 'CHILD_DEVICE_PAIRING_CONSUMED');

  // Outside the recovery window the same secret is refused, still without a second grant.
  fx.advance(minute + 1_000);
  const expiredRecovery = await complete(created);
  assert.equal(expiredRecovery.statusCode, 409);
  assert.equal(expiredRecovery.json().error.code, 'CHILD_DEVICE_PAIRING_CONSUMED');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.device_grants'), 1);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE auth_method='child'"), 1);
});

test('a concurrent claim yields exactly one grant and one child session', async () => {
  const scene = await household();
  const { created } = await createPairing();
  const grant = await reauthGrant(scene.guardian);
  assert.equal((await approve(created, { token: scene.guardian.tokens.accessToken, childSubjectId: scene.childSubjectId,
    reauthGrant: grant.reauthGrant, expectedGuardianVersion: 1 })).statusCode, 200);
  const [first, second] = await Promise.all([complete(created), complete(created)]);
  assert.deepEqual([first.statusCode, second.statusCode], [200, 200]);
  const one = devicePairingCompleteResponseSchema.parse(first.json().data);
  const two = devicePairingCompleteResponseSchema.parse(second.json().data);
  assert.equal(one.deviceGrantId, two.deviceGrantId);
  assert.deepEqual(one.sessionTokens, two.sessionTokens);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.device_grants'), 1);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE auth_method='child'"), 1);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope LIKE 'child-device-pairing-complete:%'"), 1);
});

test('an approval is bound to the guardian versions at approval time', async () => {
  for (const drift of [
    scene => db.app.query('UPDATE siyue.guardian_relationships SET version=version+1 WHERE family_id=$1 AND child_subject_id=$2',
      [scene.family.familyId, scene.childSubjectId]),
    scene => db.app.query('UPDATE siyue.subjects SET credential_version=credential_version+1 WHERE id=$1',
      [scene.guardian.tokens.session.subjectId]),
  ]) {
    const scene = await household();
    const { created } = await createPairing();
    const grant = await reauthGrant(scene.guardian);
    assert.equal((await approve(created, { token: scene.guardian.tokens.accessToken, childSubjectId: scene.childSubjectId,
      reauthGrant: grant.reauthGrant, expectedGuardianVersion: 1 })).statusCode, 200);
    await drift(scene);
    const refused = await complete(created);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json().error.code, 'CHILD_DEVICE_PAIRING_GUARDIAN_INELIGIBLE');
    assert.equal(await count('SELECT count(*)::int AS n FROM siyue.device_grants'), 0);
  }
});

test('expired, withdrawn and revoked pairing attempts are refused without adult state', async () => {
  const scene = await household();
  // Expiry is committed by the cheap read, and both later attempts are refused.
  const stale = await createPairing();
  fx.advance(5 * minute + 1_000);
  const expiredStatus = await readStatus(stale.created);
  assert.equal(expiredStatus.statusCode, 200);
  assert.equal(devicePairingStatusResponseSchema.parse(expiredStatus.json().data).status, 'expired');
  assert.equal((await pairingRow(stale.created.pairingId)).status, 'expired');
  assert.equal((await complete(stale.created)).statusCode, 409);
  assert.equal((await complete(stale.created)).json().error.code, 'CHILD_DEVICE_PAIRING_EXPIRED');
  const freshGrant = await reauthGrant(scene.guardian);
  const lateApproval = await approve(stale.created, { token: scene.guardian.tokens.accessToken,
    childSubjectId: scene.childSubjectId, reauthGrant: freshGrant.reauthGrant, expectedGuardianVersion: 1 });
  assert.equal(lateApproval.statusCode, 409);
  assert.equal(lateApproval.json().error.code, 'CHILD_DEVICE_PAIRING_EXPIRED');
  assert.equal((await pairingRow(stale.created.pairingId)).status, 'expired');

  // Withdrawing consent between approval and claim refuses the claim and creates nothing.
  const withdrawn = await createPairing();
  const withdrawnGrant = await reauthGrant(scene.guardian);
  assert.equal((await approve(withdrawn.created, { token: scene.guardian.tokens.accessToken,
    childSubjectId: scene.childSubjectId, reauthGrant: withdrawnGrant.reauthGrant, expectedGuardianVersion: 1 })).statusCode, 200);
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=$2 WHERE id=$1', [scene.consentRecordId, fx.clock()]);
  const refused = await complete(withdrawn.created);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, 'CHILD_DEVICE_PAIRING_GUARDIAN_INELIGIBLE');
  assert.equal(refused.body.includes(scene.guardian.tokens.session.subjectId), false);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.device_grants'), 0);
  assert.equal((await pairingRow(withdrawn.created.pairingId)).status, 'approved');
  await db.app.query('UPDATE siyue.consent_records SET withdrawn_at=NULL WHERE id=$1', [scene.consentRecordId]);

  // A grant revoked while the recovery window is open is refused there and stops authenticating at once.
  const pairAgain = await createPairing();
  const pairAgainGrant = await reauthGrant(scene.guardian);
  assert.equal((await approve(pairAgain.created, { token: scene.guardian.tokens.accessToken,
    childSubjectId: scene.childSubjectId, reauthGrant: pairAgainGrant.reauthGrant, expectedGuardianVersion: 1 })).statusCode, 200);
  const claimed = await complete(pairAgain.created);
  assert.equal(claimed.statusCode, 200);
  const claimedResult = devicePairingCompleteResponseSchema.parse(claimed.json().data);
  await db.app.query('UPDATE siyue.device_grants SET revoked_at=$2,version=version+1 WHERE id=$1',
    [claimedResult.deviceGrantId, fx.clock()]);
  assert.equal((await complete(pairAgain.created)).statusCode, 409);
  await assert.rejects(fx.service.verify(claimedResult.sessionTokens.accessToken));
  await assert.rejects(fx.service.refresh(claimedResult.sessionTokens.refreshToken, randomUUID()));

  // The same immediate denial follows an invalidated guardian relationship, without touching the grant.
  const relationshipChange = await createPairing();
  const relationshipGrant = await reauthGrant(scene.guardian);
  assert.equal((await approve(relationshipChange.created, { token: scene.guardian.tokens.accessToken,
    childSubjectId: scene.childSubjectId, reauthGrant: relationshipGrant.reauthGrant, expectedGuardianVersion: 1 })).statusCode, 200);
  const secondClaim = devicePairingCompleteResponseSchema.parse((await complete(relationshipChange.created)).json().data);
  await db.app.query('UPDATE siyue.guardian_relationships SET active=false WHERE family_id=$1 AND child_subject_id=$2',
    [scene.family.familyId, scene.childSubjectId]);
  await assert.rejects(fx.service.verify(secondClaim.sessionTokens.accessToken));
  await assert.rejects(fx.service.refresh(secondClaim.sessionTokens.refreshToken, randomUUID()));
  assert.equal((await rows('SELECT revoked_at FROM siyue.device_grants WHERE id=$1', secondClaim.deviceGrantId))[0].revoked_at, null);
});

test('cleanup closes expired requests, keeps history and drops closed recovery windows', async () => {
  const scene = await household();
  const pending = await createPairing();
  const approved = await createPairing();
  const approvedGrant = await reauthGrant(scene.guardian);
  assert.equal((await approve(approved.created, { token: scene.guardian.tokens.accessToken,
    childSubjectId: scene.childSubjectId, reauthGrant: approvedGrant.reauthGrant, expectedGuardianVersion: 1 })).statusCode, 200);
  const claimed = await createPairing();
  const claimedGrant = await reauthGrant(scene.guardian);
  assert.equal((await approve(claimed.created, { token: scene.guardian.tokens.accessToken,
    childSubjectId: scene.childSubjectId, reauthGrant: claimedGrant.reauthGrant, expectedGuardianVersion: 1 })).statusCode, 200);
  const survivingGrant = devicePairingCompleteResponseSchema.parse((await complete(claimed.created)).json().data);

  fx.advance(5 * minute + minute + 1_000);
  await pairings.cleanupExpired();
  assert.deepEqual([(await pairingRow(pending.created.pairingId)).status, (await pairingRow(approved.created.pairingId)).status,
    (await pairingRow(claimed.created.pairingId)).status], ['expired', 'expired', 'consumed']);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.idempotency_records WHERE scope LIKE 'child-device-pairing-complete:%'"), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.rate_limit_buckets WHERE expires_at<=$1', fx.clock()), 0);
  // Consumption survives maintenance: the grant and the child session are not history to clean up.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.device_grants WHERE id=$1', survivingGrant.deviceGrantId), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE device_grant_id=$1', survivingGrant.deviceGrantId), 1);
});

test('a paired child session cannot approve another pairing or act as an adult', async () => {
  const scene = await household();
  const { created } = await createPairing();
  const grant = await reauthGrant(scene.guardian);
  assert.equal((await approve(created, { token: scene.guardian.tokens.accessToken, childSubjectId: scene.childSubjectId,
    reauthGrant: grant.reauthGrant, expectedGuardianVersion: 1 })).statusCode, 200);
  const childTokens = devicePairingCompleteResponseSchema.parse((await complete(created)).json().data).sessionTokens;

  // The restricted session is a real session, so it reaches the pairing routes and is refused there for
  // being a child, not for being invalid.
  const second = await createPairing();
  const reflexive = await approve(second.created, { token: childTokens.accessToken, childSubjectId: scene.childSubjectId,
    reauthGrant: `${randomUUID()}.${secretShaped()}`, expectedGuardianVersion: 1 });
  assert.equal(reflexive.statusCode, 403);
  assert.equal(reflexive.json().error.code, 'CHILD_DEVICE_PAIRING_GUARDIAN_REQUIRED');
  const familyAttempt = await app.inject({ method: 'POST', url: '/v1/families',
    headers: { authorization: `Bearer ${childTokens.accessToken}`, 'idempotency-key': randomUUID() } });
  assert.equal(familyAttempt.statusCode, 403);
  assert.equal(familyAttempt.json().error.code, 'FAMILY_ADULT_REQUIRED');
});
