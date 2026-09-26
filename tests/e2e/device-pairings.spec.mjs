import { test, expect } from 'playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { startPostgresFixture } from '../../apps/server/tests/integration/postgres-fixture.mjs';
import { createEmailFixture, password } from '../../apps/server/tests/integration/email-fixture.mjs';
import { createRuntimeApp } from '../../apps/server/dist/runtime-app.js';
import { createChildDevicePairingService } from '../../apps/server/dist/modules/families/device-pairings.js';
import { createGuardianshipService } from '../../apps/server/dist/modules/families/guardianship.js';
import { adultAccessToken, createAuthApiClient, createAuthController,
  createChildDevicePairingClient, createGuardianChildDeviceClient } from '../../packages/adapters/dist/index.js';

// Real Fastify runtime over real loopback HTTP against an isolated temporary PostgreSQL cluster: no
// database URL, no .env, no provider and no mail. Every account, device label and secret is synthetic.
// The real runtime registers the production pairing routes through its service option.
let db, fx, app, address;
test.beforeAll(async () => {
  db = await startPostgresFixture();
  fx = await createEmailFixture(db);
  const pairings = createChildDevicePairingService(db.app, fx.service, fx.cipher, randomBytes(32), fx.clock);
  const guardianship = createGuardianshipService(db.app, fx.service, randomBytes(32), fx.clock);
  app = createRuntimeApp(db.app, db.identity,
    { sessions: fx.service, email: fx.email, devicePairings: pairings, guardianship });
  address = await app.listen({ host: '127.0.0.1', port: 0 });
});
test.afterAll(async () => { await app?.close(); await db?.stop(); });

const minute = 60_000;
const day = 86_400_000;
const bearer = token => ({ authorization: `Bearer ${token}` });
const rows = (sql, ...params) => db.app.query(sql, params).then(result => result.rows);

async function guardianAccount() {
  return fx.register(`device-${randomUUID()}@example.test`);
}
async function familyOf(request, token) {
  const response = await request.post(`${address}/v1/families`, { headers: { ...bearer(token), 'idempotency-key': randomUUID() } });
  expect(response.status()).toBe(201, await response.text());
  return (await response.json()).data;
}
/**
 * The explicit guardian relationship is the precondition owned by the neighbouring child-create slice
 * (consent purpose `child-guardianship`, actor guardian, subject child). It is written directly so this
 * spec exercises pairing end to end; the child-create route has its own acceptance.
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
  return childSubjectId;
}
/** One household with an active guardian relationship and the guardian's own approved reauth seam. */
async function household(request) {
  const guardian = await guardianAccount();
  const family = await familyOf(request, guardian.tokens.accessToken);
  const childSubjectId = await guardianshipOf(guardian.tokens.session.subjectId, family.familyId);
  return { guardian, family, childSubjectId };
}
async function pairDevice(request, overrides = {}) {
  const response = await request.post(`${address}/v1/device-pairings`,
    { data: { installationId: randomUUID(), platform: 'ios', deviceLabel: 'E2E child iPad', ...overrides } });
  expect(response.status()).toBe(201, await response.text());
  return (await response.json()).data;
}
const deviceStatus = (request, pairing, pollSecret = pairing.pollSecret) =>
  request.post(`${address}/v1/device-pairings/${pairing.pairingId}/status`, { data: { pollSecret } });
const deviceComplete = (request, pairing, pollSecret = pairing.pollSecret) =>
  request.post(`${address}/v1/device-pairings/${pairing.pairingId}/complete`, { data: { pollSecret } });
const guardianApprove = (request, pairing, { token, childSubjectId, reauthGrant, expectedGuardianVersion = 1,
  requestToken = pairing.requestToken } = {}) => request.post(`${address}/v1/device-pairings/${pairing.pairingId}/approve`,
  { headers: bearer(token), data: { requestToken, childSubjectId, reauthGrant, expectedGuardianVersion } });
/** A real password reauth over HTTP, bound by action, exactly as the guardian device would obtain it. */
async function reauth(request, token, action = 'approve-child-device') {
  const response = await request.post(`${address}/v1/auth/reauth/password`, { headers: bearer(token), data: { password, action } });
  expect(response.status()).toBe(200, await response.text());
  return (await response.json()).data;
}

test('a child device pairs through its guardian and receives only a restricted child session', async ({ request }) => {
  fx.advance(minute + 1_000);
  const { guardian, family, childSubjectId } = await household(request);
  const stranger = await guardianAccount();

  // The child device has no session at all: it only opens a pending request and receives two secrets.
  const pairing = await pairDevice(request, { platform: 'android', deviceLabel: 'E2E child phone' });
  expect(pairing.requestToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(pairing.pollSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(pairing.requestToken).not.toBe(pairing.pollSecret);
  const stored = (await rows('SELECT * FROM siyue.device_pairing_requests WHERE id=$1', pairing.pairingId))[0];
  expect(stored.status).toBe('pending');
  expect(JSON.stringify(stored)).not.toContain(pairing.requestToken);
  expect(JSON.stringify(stored)).not.toContain(pairing.pollSecret);

  // Polling with the initiating device's own secret returns the lifecycle and the deadline only.
  const pending = await deviceStatus(request, pairing);
  expect(pending.status()).toBe(200, await pending.text());
  expect((await pending.json()).data).toEqual({ status: 'pending', expiresAt: pairing.expiresAt });

  // An unrelated adult with a real reauth grant cannot approve for someone else's child.
  const strangerGrant = await reauth(request, stranger.tokens.accessToken);
  const denied = await guardianApprove(request, pairing, { token: stranger.tokens.accessToken, childSubjectId,
    reauthGrant: strangerGrant.reauthGrant });
  expect(denied.status()).toBe(403);
  expect((await denied.json()).error.code).toBe('CHILD_DEVICE_PAIRING_GUARDIAN_REQUIRED');

  // Design 16.3: before approving, the scanning guardian reads the requesting device and the child that
  // would be authorized, and the answer carries neither secret of the ceremony.
  const preview = await request.post(`${address}/v1/device-pairings/${pairing.pairingId}/preview`,
    { headers: bearer(guardian.tokens.accessToken), data: { requestToken: pairing.requestToken, childSubjectId } });
  expect(preview.status()).toBe(200, await preview.text());
  const previewText = await preview.text();
  expect(JSON.parse(previewText).data).toEqual({ deviceLabel: 'E2E child phone', platform: 'android',
    expiresAt: pairing.expiresAt, child: { childSubjectId, displayName: '小禾' } });
  expect(previewText).not.toContain(pairing.pollSecret);
  expect(previewText).not.toContain(pairing.requestToken);

  // The guardian approves after a fresh action-bound password reauth.
  const grant = await reauth(request, guardian.tokens.accessToken);
  const mismatch = await guardianApprove(request, pairing, { token: guardian.tokens.accessToken, childSubjectId,
    reauthGrant: grant.reauthGrant, expectedGuardianVersion: 2 });
  expect(mismatch.status()).toBe(409);
  expect((await mismatch.json()).error.code).toBe('CHILD_DEVICE_PAIRING_STALE_GUARDIAN_VERSION');
  const approved = await guardianApprove(request, pairing, { token: guardian.tokens.accessToken, childSubjectId,
    reauthGrant: grant.reauthGrant });
  expect(approved.status()).toBe(200, await approved.text());
  expect((await approved.json()).data).toEqual({ status: 'approved', expiresAt: pairing.expiresAt });
  const approvedRow = (await rows('SELECT * FROM siyue.device_pairing_requests WHERE id=$1', pairing.pairingId))[0];
  expect([approvedRow.status, approvedRow.approved_by, approvedRow.child_subject_id, approvedRow.family_id])
    .toEqual(['approved', guardian.tokens.session.subjectId, childSubjectId, family.familyId]);
  // Approval alone is not a device: no grant and no session exist before the child claims the result.
  expect(await rows('SELECT 1 FROM siyue.device_grants WHERE child_subject_id=$1', childSubjectId)).toEqual([]);

  // The child device claims the result once with its own secret and gets a child session, nothing adult.
  const completed = await deviceComplete(request, pairing);
  expect(completed.status()).toBe(200, await completed.text());
  const raw = await completed.text();
  const claimed = JSON.parse(raw).data;
  expect(claimed.sessionTokens.session.subjectKind).toBe('child');
  expect(claimed.sessionTokens.session.subjectId).toBe(childSubjectId);
  expect(raw).not.toContain(guardian.tokens.session.subjectId);
  expect(raw).not.toContain(guardian.tokens.refreshToken);
  expect(raw).not.toContain(guardian.tokens.accessToken);
  expect(raw).not.toContain(pairing.pollSecret);

  // The granted device is exactly one 30-day grant carrying no capability yet.
  const device = (await rows('SELECT * FROM siyue.device_grants WHERE id=$1', claimed.deviceGrantId))[0];
  expect([device.child_subject_id, device.guardian_id, device.family_id, device.platform, device.device_label])
    .toEqual([childSubjectId, guardian.tokens.session.subjectId, family.familyId, 'android', 'E2E child phone']);
  expect(device.scopes).toEqual([]);
  expect([device.guardian_relationship_version, device.version, device.revoked_at]).toEqual([1, 1, null]);
  expect(+device.expires_at - +device.created_at).toBe(30 * day);
  const deviceSessions = await rows('SELECT * FROM siyue.auth_sessions WHERE device_grant_id=$1', claimed.deviceGrantId);
  expect(deviceSessions).toHaveLength(1);
  expect([deviceSessions[0].subject_id, deviceSessions[0].auth_method]).toEqual([childSubjectId, 'child']);

  // The restricted session works on its own routes and carries no adult authority.
  const childSession = await request.get(`${address}/v1/account/session`,
    { headers: bearer(claimed.sessionTokens.accessToken) });
  expect(childSession.status()).toBe(200, await childSession.text());
  expect(await childSession.json()).toEqual({ subjectId: childSubjectId, subjectKind: 'child',
    sessionId: expect.any(String), expiresAt: expect.any(String) });
  const adultAttempt = await request.post(`${address}/v1/families`,
    { headers: { ...bearer(claimed.sessionTokens.accessToken), 'idempotency-key': randomUUID() } });
  expect(adultAttempt.status()).toBe(403);
  const approveAttempt = await guardianApprove(request, pairing,
    { token: claimed.sessionTokens.accessToken, childSubjectId, reauthGrant: `${randomUUID()}.${pairing.pollSecret}` });
  expect(approveAttempt.status()).toBe(403);
  // The guardian's own session is untouched by the child's pairing.
  const guardianFamilies = await request.get(`${address}/v1/families`, { headers: bearer(guardian.tokens.accessToken) });
  expect(guardianFamilies.status()).toBe(200);
  expect((await guardianFamilies.json()).data.items).toHaveLength(1);
});

test('pairing refuses wrong secrets, early claims, replay beyond recovery and revoked grants', async ({ request }) => {
  fx.advance(minute + 1_000);
  const { guardian, childSubjectId } = await household(request);
  const first = await pairDevice(request);
  const second = await pairDevice(request);

  // A different pairing's secret, and an unknown pairing id, both answer "not found" without state.
  const foreign = await deviceStatus(request, first, second.pollSecret);
  expect(foreign.status()).toBe(404);
  expect((await foreign.json()).error.code).toBe('CHILD_DEVICE_PAIRING_NOT_FOUND');
  expect(JSON.stringify(await foreign.json())).not.toContain(second.pollSecret);
  const unknown = await request.post(`${address}/v1/device-pairings/${randomUUID()}/status`, { data: { pollSecret: first.pollSecret } });
  expect(unknown.status()).toBe(404);
  // The request token is not a claim credential, and a claim before approval is refused.
  const wrongSecret = await request.post(`${address}/v1/device-pairings/${first.pairingId}/complete`,
    { data: { pollSecret: first.requestToken } });
  expect(wrongSecret.status()).toBe(404);
  const early = await deviceComplete(request, first);
  expect(early.status()).toBe(409);
  expect((await early.json()).error.code).toBe('CHILD_DEVICE_PAIRING_NOT_APPROVED');

  // Approve and claim the first request, then check the polling interval on the same device.
  const grant = await reauth(request, guardian.tokens.accessToken);
  expect((await guardianApprove(request, first, { token: guardian.tokens.accessToken, childSubjectId,
    reauthGrant: grant.reauthGrant })).status()).toBe(200);
  expect((await deviceComplete(request, first)).status()).toBe(200);
  const slow = await deviceStatus(request, first);
  expect((await slow.json()).data.status).toBe('consumed');
  const fast = await deviceStatus(request, first);
  expect(fast.status()).toBe(429);
  expect(fast.headers()['retry-after']).toBe('3');
  fx.advance(3_000);
  const settled = await deviceStatus(request, first);
  expect((await settled.json()).data).toEqual({ status: 'consumed', expiresAt: first.expiresAt });
  // A consumed request cannot be approved again, even by its own guardian with a fresh reauth.
  const again = await reauth(request, guardian.tokens.accessToken);
  const replay = await guardianApprove(request, first, { token: guardian.tokens.accessToken, childSubjectId,
    reauthGrant: again.reauthGrant });
  expect(replay.status()).toBe(409);
  expect((await replay.json()).error.code).toBe('CHILD_DEVICE_PAIRING_NOT_PENDING');
  expect(await rows('SELECT 1 FROM siyue.device_grants WHERE child_subject_id=$1', childSubjectId)).toHaveLength(1);

  // The second request expires unclaimed, and both a claim and an approval are refused afterwards.
  fx.advance(5 * minute + 1_000);
  const expired = await deviceStatus(request, second);
  expect((await expired.json()).data.status).toBe('expired');
  expect((await deviceComplete(request, second)).status()).toBe(409);
  const lateGrant = await reauth(request, guardian.tokens.accessToken);
  expect((await guardianApprove(request, second, { token: guardian.tokens.accessToken, childSubjectId,
    reauthGrant: lateGrant.reauthGrant })).status()).toBe(409);

  // Revoking the grant stops the restricted session at once, and the recovery window refuses it too.
  const third = await pairDevice(request);
  const thirdGrant = await reauth(request, guardian.tokens.accessToken);
  expect((await guardianApprove(request, third, { token: guardian.tokens.accessToken, childSubjectId,
    reauthGrant: thirdGrant.reauthGrant })).status()).toBe(200);
  const claimed = (await (await deviceComplete(request, third)).json()).data;
  const recoveryBeforeRevoke = await deviceComplete(request, third);
  expect(recoveryBeforeRevoke.status()).toBe(200);
  expect((await recoveryBeforeRevoke.json()).data.deviceGrantId).toBe(claimed.deviceGrantId);
  await db.app.query('UPDATE siyue.device_grants SET revoked_at=$2,version=version+1 WHERE id=$1',
    [claimed.deviceGrantId, fx.clock()]);
  const afterRevoke = await deviceComplete(request, third);
  expect(afterRevoke.status()).toBe(409);
  expect((await afterRevoke.json()).error.code).toBe('CHILD_DEVICE_PAIRING_CONSUMED');
  const revoked = await request.get(`${address}/v1/account/session`, { headers: bearer(claimed.sessionTokens.accessToken) });
  expect(revoked.status()).toBe(401);
});

test('the anonymous pairing surface is rate limited, minimal and closed to other shapes', async ({ request }) => {
  fx.advance(minute + 1_000);
  const statuses = [];
  for (let index = 0; index < 6; index += 1) {
    const response = await request.post(`${address}/v1/device-pairings`,
      { data: { installationId: `e2e-rate-${index}`, platform: 'ios' } });
    statuses.push(response.status());
    if (response.status() === 429) expect(Number(response.headers()['retry-after'])).toBeGreaterThanOrEqual(1);
  }
  expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  expect(await rows("SELECT 1 FROM siyue.device_pairing_requests WHERE installation_id LIKE 'e2e-rate-%'")).toHaveLength(5);

  // A query string, an unsupported shape, an unknown method and a browser origin are all refused.
  const query = await request.post(`${address}/v1/device-pairings?platform=ios`, { data: { installationId: randomUUID(), platform: 'ios' } });
  expect(query.status()).toBe(400);
  const injected = await request.post(`${address}/v1/device-pairings`,
    { data: { installationId: randomUUID(), platform: 'ios', subjectKind: 'adult', scopes: ['board.write'] } });
  expect(injected.status()).toBe(400);
  expect((await request.get(`${address}/v1/device-pairings/anything`)).status()).toBe(404);
  const origin = await request.post(`${address}/v1/device-pairings`,
    { headers: { origin: 'https://app.example.test' }, data: { installationId: randomUUID(), platform: 'ios' } });
  expect(origin.status()).toBe(403);
  expect((await origin.json()).error).toBe('origin_denied');

  // The address budget is a window, not a permanent block, and pairing still works afterwards.
  fx.advance(minute + 1_000);
  const { guardian, childSubjectId } = await household(request);
  const pairing = await pairDevice(request);
  const grant = await reauth(request, guardian.tokens.accessToken);
  expect((await guardianApprove(request, pairing, { token: guardian.tokens.accessToken, childSubjectId,
    reauthGrant: grant.reauthGrant })).status()).toBe(200);
  expect((await deviceComplete(request, pairing)).status()).toBe(200);
});

test('the guardian preview answers only the guardian of the requested child', async ({ request }) => {
  fx.advance(minute + 1_000);
  const { guardian, childSubjectId } = await household(request);
  const stranger = await guardianAccount();
  const pairing = await pairDevice(request, { platform: 'ios', deviceLabel: 'E2E preview iPad' });
  const preview = (token, data) => request.post(`${address}/v1/device-pairings/${pairing.pairingId}/preview`,
    { headers: bearer(token), data });
  const payload = { requestToken: pairing.requestToken, childSubjectId };

  // A stranger holding the real request token, and a guardian of another child, both learn nothing about
  // the device: the refusal names no label, no platform, no deadline and no pairing.
  const strangerAnswer = await preview(stranger.tokens.accessToken, payload);
  const strangerText = await strangerAnswer.text();
  expect(strangerAnswer.status()).toBe(403);
  expect(JSON.parse(strangerText).error.code).toBe('CHILD_DEVICE_PAIRING_GUARDIAN_REQUIRED');
  expect(strangerText).not.toContain('E2E preview iPad');
  expect((await preview(guardian.tokens.accessToken, { ...payload, childSubjectId: randomUUID() })).status()).toBe(403);

  // A wrong token is unknown, an unknown pairing id is unknown, an extra field is refused, and the child
  // device's own poll secret is not a preview credential.
  const unknown = await preview(guardian.tokens.accessToken, { ...payload, requestToken: randomBytes(32).toString('base64url') });
  const unknownText = await unknown.text();
  expect(unknown.status()).toBe(404);
  expect(JSON.parse(unknownText).error.code).toBe('CHILD_DEVICE_PAIRING_NOT_FOUND');
  expect(unknownText).not.toContain(pairing.requestToken);
  expect((await preview(guardian.tokens.accessToken, { ...payload, requestToken: pairing.pollSecret })).status()).toBe(404);
  expect((await preview(guardian.tokens.accessToken, { ...payload, expectedGuardianVersion: 1 })).status()).toBe(400);
  expect((await request.post(`${address}/v1/device-pairings/${randomUUID()}/preview`,
    { headers: bearer(guardian.tokens.accessToken), data: payload })).status()).toBe(404);

  // The guardian reads the request, and the read alone creates no device. Then the guardian approves with a
  // fresh reauth, and the preview is refused once the initiating device has claimed its result.
  const seen = await preview(guardian.tokens.accessToken, payload);
  expect(seen.status()).toBe(200, await seen.text());
  expect(await rows('SELECT 1 FROM siyue.device_grants WHERE child_subject_id=$1', childSubjectId)).toEqual([]);
  expect(JSON.parse(await seen.text()).data).toEqual({ deviceLabel: 'E2E preview iPad', platform: 'ios',
    expiresAt: pairing.expiresAt, child: { childSubjectId, displayName: '小禾' } });
  const grant = await reauth(request, guardian.tokens.accessToken);
  expect((await guardianApprove(request, pairing, { token: guardian.tokens.accessToken, childSubjectId,
    reauthGrant: grant.reauthGrant })).status()).toBe(200);
  const claimed = await deviceComplete(request, pairing);
  expect(claimed.status()).toBe(200, await claimed.text());
  const afterClaim = await preview(guardian.tokens.accessToken, payload);
  expect(afterClaim.status()).toBe(409);
  expect((await afterClaim.json()).error.code).toBe('CHILD_DEVICE_PAIRING_NOT_PENDING');
  expect((await preview((await claimed.json()).data.sessionTokens.accessToken, payload)).status()).toBe(403);
  expect(await rows('SELECT 1 FROM siyue.device_grants WHERE child_subject_id=$1', childSubjectId)).toHaveLength(1);
});

test('the mobile auth controller keeps the poll proof private and restores a real child session after restart', async ({ request }) => {
  fx.advance(minute + 1_000);
  const { guardian, childSubjectId } = await household(request);
  const endpoint = { environment: 'test', apiBaseUrl: `${address}/v1` };
  const vault = { value: null,
    async read() { return this.value; },
    async write(value) { this.value = value; } };
  const createHost = () => createAuthController({
    api: createAuthApiClient({ ...endpoint, fetcher: fetch }), vault, newId: randomUUID,
    createChildPairingClient: base => createChildDevicePairingClient({ ...base, fetcher: fetch }),
  });
  const host = createHost();
  await host.bootstrap();
  const ticket = await host.startChildPairing({ platform: 'ios', deviceLabel: 'E2E controller iPad' });
  expect(Object.keys(ticket).sort()).toEqual(['expiresAt', 'pairingId', 'requestToken']);
  expect(vault.value).not.toContain(ticket.requestToken);
  const guardianClient = createGuardianChildDeviceClient({ ...endpoint, fetcher: fetch });
  const adult = adultAccessToken(guardian.tokens.accessToken);
  const preview = await guardianClient.previewPairing(adult, ticket.pairingId,
    { requestToken: ticket.requestToken, childSubjectId });
  expect(preview).toMatchObject({ deviceLabel: 'E2E controller iPad', child: { childSubjectId, displayName: '小禾' } });
  const grant = await reauth(request, guardian.tokens.accessToken);
  await guardianClient.approvePairing(adult, ticket.pairingId,
    { requestToken: ticket.requestToken, childSubjectId, reauthGrant: grant.reauthGrant, expectedGuardianVersion: 1 });
  await host.claimChildPairing();
  expect(host.getState().session).toMatchObject({ subjectId: childSubjectId, subjectKind: 'child' });
  expect(vault.value).not.toContain(ticket.requestToken);
  expect(vault.value).not.toContain(guardian.tokens.accessToken);
  const stored = JSON.parse(vault.value);
  expect(stored.active.subjectKind).toBe('child');
  const sessionId = host.getState().session.sessionId;
  await host.dispose();
  const restored = createHost();
  await restored.bootstrap();
  expect(restored.getState().session).toMatchObject({ subjectId: childSubjectId, subjectKind: 'child', sessionId });
  await restored.dispose();
});

test('the guardian controller previews and approves over real HTTP without exposing its reauth grant', async ({ request }) => {
  fx.advance(minute + 1_000);
  const { guardian, family, childSubjectId } = await household(request);
  const pairing = await pairDevice(request);
  const endpoint = { environment: 'test', apiBaseUrl: `${address}/v1` };
  const vault = { value: null,
    async read() { return this.value; },
    async write(value) { this.value = value; } };
  const observed = [];
  const fetcher = async (url, init) => {
    const response = await fetch(url, init);
    if (!response.ok) observed.push({ path: new URL(url).pathname, status: response.status,
      code: (await response.clone().json().catch(() => ({}))).error?.code });
    return response;
  };
  const host = createAuthController({
    api: createAuthApiClient({ ...endpoint, fetcher }), vault, newId: randomUUID,
    now: fx.clock,
    createGuardianClient: base => createGuardianChildDeviceClient({ ...base, fetcher }),
  });
  try {
    await host.bootstrap();
    await host.login({ email: guardian.address, password, platform: 'ios' });
    const preview = await test.step('guardian preview', () =>
      host.guardianPairingPreview(pairing.pairingId, pairing.requestToken, childSubjectId));
    expect(preview).toMatchObject({ deviceLabel: 'E2E child iPad', child: { childSubjectId } });
    const target = { pairingId: pairing.pairingId, requestToken: pairing.requestToken, childSubjectId,
      familyId: family.familyId };
    await expect(host.approveChildPairingWithPassword({ ...target, pollSecret: pairing.pollSecret }, password))
      .rejects.toMatchObject({ code: 'invalid_request' });
    let approved;
    try { approved = await test.step('guardian approval', () => host.approveChildPairingWithPassword(target, password)); }
    catch (error) { throw new Error(`approval failed ${JSON.stringify(observed)}`, { cause: error }); }
    expect(approved.status).toBe('approved');
    expect(JSON.stringify(host.getState())).not.toContain(pairing.requestToken);
    expect(vault.value).not.toContain(pairing.requestToken);
    expect(vault.value).not.toContain(pairing.pollSecret);
    const claimed = await deviceComplete(request, pairing);
    expect(claimed.status()).toBe(200, await claimed.text());
    expect((await claimed.json()).data.sessionTokens.session.subjectId).toBe(childSubjectId);
  } finally {
    await host.dispose();
  }
});
