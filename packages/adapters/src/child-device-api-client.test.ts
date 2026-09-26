import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuthClientError } from './auth-api-client.js';
import { adultAccessToken, createChildDevicePairingClient, createGuardianChildDeviceClient } from './child-device-api-client.js';

const base = 'http://127.0.0.1:8787/v1';
const soon = () => new Date(Date.now() + 5 * 60_000).toISOString();
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const code = (value: string) => (error: unknown) => error instanceof AuthClientError && error.code === value;
const refused = (value: string, status: number, retryAfter?: string) => {
  const response = json({error: {code: value, messageKey: `family.errors.${value}`}}, status);
  if (retryAfter !== undefined) response.headers.set('Retry-After', retryAfter);
  return response;
};
const requestToken = () => 'r'.repeat(43);
const pollSecret = () => 'p'.repeat(43);
const bodyOf = (call: {init: RequestInit}) => JSON.parse(call.init.body as string);
/** A transport that records every attempt and answers with the next scripted reply. */
function stub(replies: Array<() => Promise<Response>>) {
  const calls: Array<{url: string; init: RequestInit}> = [];
  let index = 0;
  return {
    calls,
    fetcher: async (url: string, init: RequestInit) => {
      calls.push({url, init});
      const reply = replies[index++];
      if (!reply) throw new Error(`unexpected request ${index}: ${url}`);
      return reply();
    },
  };
}
const created = (expiresAt = soon()) => () =>
  Promise.resolve(json({data: {pairingId: randomUUID(), requestToken: requestToken(), pollSecret: pollSecret(), expiresAt}}, 201));
function childSessionTokens() {
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  return {tokenType: 'Bearer', accessToken: 'synthetic-child-access', accessExpiresAt: expiresAt,
    refreshToken: `${randomUUID()}.${'c'.repeat(43)}`, refreshExpiresAt: expiresAt, sessionAbsoluteExpiresAt: expiresAt,
    session: {subjectId: randomUUID(), subjectKind: 'child', sessionId: randomUUID(), expiresAt}};
}
const childSummary = (familyId: string) => ({childSubjectId: randomUUID(), familyId, guardianSubjectId: randomUUID(),
  relationshipVersion: 1, familyVersion: 2, displayName: '小禾'});
const deviceSummary = (childSubjectId: string, overrides: Record<string, unknown> = {}) => ({
  grantId: randomUUID(), childSubjectId, installationId: randomUUID(), platform: 'ios', deviceLabel: 'Child iPad',
  status: 'active', version: 1, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), revokedAt: null, ...overrides});
const started = (overrides: {now: () => number}, extra: Record<string, unknown> = {}) =>
  createChildDevicePairingClient({environment: 'test', apiBaseUrl: base, ...overrides, ...extra} as never);

test('the initiating device keeps its poll secret out of every exposed value and out of every request shape', async () => {
  const tx = stub([created()]);
  const client = createChildDevicePairingClient({environment: 'test', apiBaseUrl: base, fetcher: tx.fetcher});
  const installationId = randomUUID();
  const ticket = await client.start({installationId, platform: 'android', deviceLabel: 'E2E child phone'});
  assert.deepEqual(Object.keys(ticket).sort(), ['expiresAt', 'pairingId', 'requestToken']);
  assert.equal(ticket.requestToken, requestToken());
  // The secret stays in the closure: no property, no serialized value, no key of the client itself.
  for (const exposed of [ticket, client, Object.keys(client), JSON.stringify(ticket), JSON.stringify(client)])
    assert.equal(JSON.stringify(exposed ?? null).includes(pollSecret()), false, String(exposed));
  assert.equal(client.started, true);
  // The anonymous create carries no credential of any kind, only its strict contract body.
  const call = tx.calls[0]!;
  assert.equal(call.url, `${base}/device-pairings`);
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(Object.keys(bodyOf(call)).sort(), ['deviceLabel', 'installationId', 'platform']);
  assert.deepEqual(bodyOf(call), {installationId, platform: 'android', deviceLabel: 'E2E child phone'});
  const headers = new Headers(call.init.headers);
  assert.equal(headers.has('Authorization'), false);
  assert.equal(headers.get('Accept'), 'application/json');
  assert.equal(headers.has('Idempotency-Key'), false);
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.cache, 'no-store');
  assert.equal(call.init.referrerPolicy, 'no-referrer');
  // One pending request per initiating device, and no adult-shaped body ever reaches the network.
  await assert.rejects(client.start({installationId, platform: 'android'}), code('busy'));
  assert.equal(tx.calls.length, 1);
  const fresh = stub([]);
  const other = createChildDevicePairingClient({environment: 'test', apiBaseUrl: base, fetcher: fresh.fetcher});
  await assert.rejects(other.start({installationId, platform: 'ios', subjectKind: 'adult'} as never), code('invalid_request'));
  await assert.rejects(other.start({installationId, platform: 'windows'} as never), code('invalid_request'));
  assert.equal(other.started, false);
  assert.equal(fresh.calls.length, 0);
  assert.equal('approvePairing' in client, false);
  assert.equal('listDevices' in client, false);
  assert.equal('revokeDevice' in client, false);
  assert.throws(() => createChildDevicePairingClient({environment: 'test', apiBaseUrl: base, fetcher: tx.fetcher, pollIntervalMs: 2_000}),
    code('invalid_config'));
  assert.throws(() => createChildDevicePairingClient({environment: 'production', apiBaseUrl: 'https://evil.invalid/v1', fetcher: tx.fetcher}),
    code('invalid_config'));
});

test('polling honours the three-second design interval, carries no bearer and answers an elapsed window locally', async () => {
  let clock = Date.parse('2026-09-24T00:00:00.000Z');
  const expiresAt = new Date(clock + 5 * 60_000).toISOString();
  const tx = stub([created(expiresAt),
    () => Promise.resolve(json({data: {status: 'pending', expiresAt}})),
    () => Promise.resolve(refused('CHILD_DEVICE_PAIRING_POLL_TOO_SOON', 429, '3')),
    () => Promise.resolve(json({data: {status: 'approved', expiresAt}}))]);
  const client = started({now: () => clock}, {fetcher: tx.fetcher});
  await client.start({installationId: randomUUID(), platform: 'ios'});
  // Creating the request already opened the budget, so an immediate poll never leaves the device.
  await assert.rejects(client.status(), (error: unknown) => code('rate_limited')(error) && error.retryAfterSeconds === 3);
  assert.equal(tx.calls.length, 1);
  clock += 3_000;
  assert.deepEqual(await client.status(), {status: 'pending', expiresAt});
  clock += 3_000;
  // A server-enforced wait is carried to the caller and stretches the local pace to match it.
  await assert.rejects(client.status(), (error: unknown) => code('rate_limited')(error) && error.retryAfterSeconds === 3);
  await assert.rejects(client.status(), code('rate_limited'));
  assert.equal(tx.calls.length, 3);
  clock += 3_000;
  assert.deepEqual(await client.status(), {status: 'approved', expiresAt});
  // Every poll carries exactly its own proof and nothing that identifies an adult.
  for (const call of tx.calls) assert.equal(new Headers(call.init.headers).has('Authorization'), false);
  assert.equal(tx.calls[0]!.url, `${base}/device-pairings`);
  for (const call of tx.calls.slice(1)) {
    assert.match(call.url, new RegExp(`^${base}/device-pairings/[0-9a-f-]{36}/status$`));
    assert.deepEqual(bodyOf(call), {pollSecret: pollSecret()});
  }
  // Past its own deadline the request is expired without spending a poll.
  clock = Date.parse(expiresAt) + 1;
  assert.deepEqual(await client.status(), {status: 'expired', expiresAt});
  assert.equal(tx.calls.length, 4);
});

test('one claim per request: an unknown outcome is replayed, a completed claim and a closed window are not', async () => {
  let clock = Date.parse('2026-09-24T00:00:00.000Z');
  const expiresAt = new Date(clock + 5 * 60_000).toISOString();
  const grantId = randomUUID();
  const tx = stub([created(expiresAt),
    () => Promise.reject(new Error('socket closed')),
    () => Promise.resolve(json({data: {sessionTokens: childSessionTokens(), deviceGrantId: grantId}}))]);
  const client = started({now: () => clock}, {fetcher: tx.fetcher});
  await client.start({installationId: randomUUID(), platform: 'android'});
  // A lost completion is an unknown outcome: the same poll secret may be presented again inside the window.
  await assert.rejects(client.claim(), code('network'));
  const session = await client.claim();
  assert.equal(session.kind, 'child');
  assert.equal(session.deviceGrantId, grantId);
  // The restricted child session is a child subject, and it is never dressed as an adult credential.
  assert.equal(session.tokens.session.subjectKind, 'child');
  assert.equal(Object.keys(session).sort().join(','), 'deviceGrantId,kind,tokens');
  // One consumption: the client never asks the server for a second one, and reports consumption locally.
  await assert.rejects(client.claim(), code('challenge_invalid'));
  assert.deepEqual(await client.status(), {status: 'consumed', expiresAt});
  assert.equal(tx.calls.length, 3);
  assert.deepEqual(bodyOf(tx.calls[2]!), {pollSecret: pollSecret()});
  assert.equal(JSON.stringify(session).includes(pollSecret()), false);
  for (const call of tx.calls) assert.equal(new Headers(call.init.headers).has('Authorization'), false);
});

test('a lost completed claim can be recovered after pairing expiry within the sealed recovery window', async () => {
  let clock = Date.parse('2026-09-24T00:00:00.000Z');
  const expiresAt = new Date(clock + 5 * 60_000).toISOString();
  const tx = stub([created(expiresAt), () => Promise.reject(new Error('lost completion response')),
    () => Promise.resolve(json({data: {sessionTokens: childSessionTokens(), deviceGrantId: randomUUID()}}))]);
  const client = started({now: () => clock}, {fetcher: tx.fetcher});
  await client.start({installationId: randomUUID(), platform: 'ios'});
  clock += 5 * 60_000 - 1_000;
  await assert.rejects(client.claim(), code('network'));
  clock += 2_000;
  assert.equal((await client.claim()).kind, 'child');
  assert.equal(tx.calls.length, 3);
});

test('parallel poll and claim calls do not send duplicate requests while a response is pending', async () => {
  let clock = Date.now();
  let releasePoll!: (response: Response) => void;
  let releaseClaim!: (response: Response) => void;
  const pendingPoll = new Promise<Response>(resolve => { releasePoll = resolve; });
  const pendingClaim = new Promise<Response>(resolve => { releaseClaim = resolve; });
  const expiresAt = new Date(clock + 5 * 60_000).toISOString();
  const tx = stub([created(expiresAt), () => pendingPoll, () => pendingClaim]);
  const client = createChildDevicePairingClient({environment: 'test', apiBaseUrl: base, fetcher: tx.fetcher, now: () => clock});
  await client.start({installationId: randomUUID(), platform: 'ios'});
  clock += 3_000;
  const poll = client.status();
  await assert.rejects(client.status(), code('busy'));
  assert.equal(tx.calls.length, 2);
  releasePoll(json({data: {status: 'approved', expiresAt}}));
  assert.equal((await poll).status, 'approved');
  const claim = client.claim();
  await assert.rejects(client.claim(), code('busy'));
  assert.equal(tx.calls.length, 3);
  releaseClaim(json({data: {sessionTokens: childSessionTokens(), deviceGrantId: randomUUID()}}));
  assert.equal((await claim).kind, 'child');
  assert.equal(tx.calls.length, 3);
});

test('a claim refused because the guardian is not yet approving is retryable, a lost relationship is not', async () => {
  let clock = Date.parse('2026-09-24T00:00:00.000Z');
  const expiresAt = new Date(clock + 5 * 60_000).toISOString();
  const tx = stub([created(expiresAt),
    () => Promise.resolve(refused('CHILD_DEVICE_PAIRING_NOT_APPROVED', 409)),
    () => Promise.resolve(refused('CHILD_DEVICE_PAIRING_GUARDIAN_INELIGIBLE', 409))]);
  const client = started({now: () => clock}, {fetcher: tx.fetcher});
  await client.start({installationId: randomUUID(), platform: 'ios'});
  await assert.rejects(client.claim(), code('busy'));
  // The guardian has still to approve, so a later claim is admitted instead of being closed as terminal.
  clock += 30_000;
  await assert.rejects(client.claim(), code('challenge_invalid'));
  await assert.rejects(client.claim(), code('challenge_invalid'));
  assert.equal(tx.calls.length, 3);
  // Beyond the sealed recovery window an unresolved dispatch is closed instead of being replayed.
  const pending = stub([created(expiresAt), () => Promise.reject(new Error('socket closed'))]);
  const lost = started({now: () => clock}, {fetcher: pending.fetcher});
  await lost.start({installationId: randomUUID(), platform: 'ios'});
  await assert.rejects(lost.claim(), code('network'));
  clock += 60_000;
  await assert.rejects(lost.claim(), code('challenge_invalid'));
  assert.equal(pending.calls.length, 2);
});

test('the guardian face binds one adult bearer to the fixed routes and never accepts a poll secret', async () => {
  const access = adultAccessToken('synthetic-adult-access');
  const familyId = randomUUID(), childId = randomUUID(), key = randomUUID(), grantId = randomUUID();
  const grant = `${randomUUID()}.${'g'.repeat(43)}`;
  const tx = stub([
    () => Promise.resolve(json({data: childSummary(familyId)}, 201)),
    () => Promise.resolve(json({data: {items: [deviceSummary(childId)]}})),
    () => Promise.resolve(json({data: deviceSummary(childId, {grantId, status: 'revoked', version: 2})})),
    () => Promise.resolve(json({data: {deviceLabel: 'Child iPad', platform: 'ios', expiresAt: soon(),
      child: {childSubjectId: childId, displayName: '小禾'}}})),
    () => Promise.resolve(json({data: {status: 'approved', expiresAt: soon()}})),
  ]);
  const guardian = createGuardianChildDeviceClient({environment: 'test', apiBaseUrl: base, fetcher: tx.fetcher});
  const summary = await guardian.createChild(access, familyId,
    {displayName: '小禾', consentPolicyVersion: 'child-device-v1', consentConfirmed: true,
      expectedMembershipVersion: 1, expectedFamilyVersion: 1}, key);
  assert.equal(summary.familyId, familyId);
  const devices = await guardian.listDevices(access, childId);
  assert.equal(devices.length, 1);
  assert.equal(devices[0]!.childSubjectId, childId);
  const revoked = await guardian.revokeDevice(access, childId, grantId, 1);
  assert.equal(revoked.status, 'revoked');
  const preview = await guardian.previewPairing(access, grantId, {requestToken: requestToken(), childSubjectId: childId});
  assert.deepEqual([preview.deviceLabel, preview.child.displayName], ['Child iPad', '小禾']);
  const approved = await guardian.approvePairing(access, grantId,
    {requestToken: requestToken(), childSubjectId: childId, reauthGrant: grant, expectedGuardianVersion: 1});
  assert.equal(approved.status, 'approved');
  assert.equal(tx.calls[0]!.url, `${base}/families/${familyId}/children`);
  assert.equal(new Headers(tx.calls[0]!.init.headers).get('Idempotency-Key'), key);
  assert.equal(tx.calls[1]!.url, `${base}/children/${childId}/devices`);
  assert.equal(tx.calls[1]!.init.method, 'GET');
  assert.equal(tx.calls[1]!.init.body, undefined);
  assert.equal(tx.calls[2]!.url, `${base}/children/${childId}/devices/${grantId}`);
  assert.equal(tx.calls[2]!.init.method, 'DELETE');
  assert.deepEqual(bodyOf(tx.calls[2]!), {expectedVersion: 1});
  assert.equal(tx.calls[3]!.url, `${base}/device-pairings/${grantId}/preview`);
  assert.deepEqual(bodyOf(tx.calls[3]!), {requestToken: requestToken(), childSubjectId: childId});
  assert.equal(tx.calls[4]!.url, `${base}/device-pairings/${grantId}/approve`);
  assert.deepEqual(Object.keys(bodyOf(tx.calls[4]!)).sort(),
    ['childSubjectId', 'expectedGuardianVersion', 'reauthGrant', 'requestToken']);
  for (const call of tx.calls) {
    assert.equal(new Headers(call.init.headers).get('Authorization'), `Bearer ${access}`);
    assert.equal(JSON.stringify(call.init.body ?? '').includes(pollSecret()), false);
  }
  // The initiating device's own secret is refused here, before any adult request is built.
  await assert.rejects(guardian.approvePairing(access, grantId,
    {requestToken: requestToken(), childSubjectId: childId, reauthGrant: grant, expectedGuardianVersion: 1,
      pollSecret: pollSecret()} as never), code('invalid_request'));
  await assert.rejects(guardian.previewPairing(access, grantId,
    {requestToken: requestToken(), childSubjectId: childId, pollSecret: pollSecret()} as never), code('invalid_request'));
  assert.equal(tx.calls.length, 5);
});

test('guardian child list uses a bodyless read and rejects children from another family', async () => {
  const access = adultAccessToken('synthetic-adult-access');
  const familyId = randomUUID();
  const summary = childSummary(familyId);
  const tx = stub([
    () => Promise.resolve(json({data: {items: [summary]}})),
    () => Promise.resolve(json({data: {items: [childSummary(randomUUID())]}})),
  ]);
  const guardian = createGuardianChildDeviceClient({environment: 'test', apiBaseUrl: base, fetcher: tx.fetcher});
  assert.deepEqual(await guardian.listChildren(access, familyId), [summary]);
  assert.equal(tx.calls[0]!.url, `${base}/families/${familyId}/children`);
  assert.equal(tx.calls[0]!.init.method, 'GET');
  assert.equal(tx.calls[0]!.init.body, undefined);
  assert.equal(new Headers(tx.calls[0]!.init.headers).get('Idempotency-Key'), null);
  assert.equal(new Headers(tx.calls[0]!.init.headers).get('Authorization'), `Bearer ${access}`);
  await assert.rejects(guardian.listChildren(access, familyId), code('invalid_response'));
  await assert.rejects(guardian.listChildren(access, 'not-a-uuid'), code('invalid_request'));
  assert.equal(tx.calls.length, 2);
});

test('guardian inputs and responses are validated before and after the single request each method makes', async () => {
  const access = adultAccessToken('synthetic-adult-access');
  const familyId = randomUUID(), childId = randomUUID(), key = randomUUID(), grantId = randomUUID();
  const grant = `${randomUUID()}.${'g'.repeat(43)}`;
  const tx = stub([() => Promise.resolve(json({data: {items: [deviceSummary(randomUUID())]}}))]);
  const guardian = createGuardianChildDeviceClient({environment: 'test', apiBaseUrl: base, fetcher: tx.fetcher});
  // A device list that answers about another child is a protocol error, not a result.
  await assert.rejects(guardian.listDevices(access, childId), code('invalid_response'));
  assert.equal(tx.calls.length, 1);
  assert.throws(() => adultAccessToken('bad token'), code('invalid_request'));
  assert.throws(() => adultAccessToken(''), code('invalid_request'));
  await assert.rejects(guardian.listDevices(access, 'not-a-uuid'), code('invalid_request'));
  await assert.rejects(guardian.revokeDevice(access, childId, grantId, 0), code('invalid_request'));
  await assert.rejects(guardian.revokeDevice(access, childId, 'not-a-uuid', 1), code('invalid_request'));
  await assert.rejects(guardian.createChild(access, 'not-a-uuid',
    {displayName: '小禾', consentPolicyVersion: 'child-device-v1', consentConfirmed: true,
      expectedMembershipVersion: 1, expectedFamilyVersion: 1}, key), code('invalid_request'));
  // Consent is explicit and is never defaulted: a false or absent confirmation is refused locally.
  await assert.rejects(guardian.createChild(access, familyId,
    {displayName: '小禾', consentPolicyVersion: 'child-device-v1', consentConfirmed: false,
      expectedMembershipVersion: 1, expectedFamilyVersion: 1} as never, key), code('invalid_request'));
  await assert.rejects(guardian.createChild(access, familyId,
    {displayName: '小禾', consentPolicyVersion: 'child-device-v1', consentConfirmed: true,
      expectedMembershipVersion: 1, expectedFamilyVersion: 1}, 'not-a-uuid'), code('invalid_request'));
  await assert.rejects(guardian.approvePairing(access, 'not-a-uuid',
    {requestToken: requestToken(), childSubjectId: childId, reauthGrant: grant, expectedGuardianVersion: 1}), code('invalid_request'));
  await assert.rejects(guardian.approvePairing(access, grantId,
    {requestToken: 'short', childSubjectId: childId, reauthGrant: grant, expectedGuardianVersion: 1} as never), code('invalid_request'));
  assert.equal(tx.calls.length, 1);
});

test('guardian refusals keep their published meaning and never echo a credential', async () => {
  const access = adultAccessToken('synthetic-adult-access');
  const childId = randomUUID();
  const cases: Array<[number, string, string]> = [
    [401, 'AUTH_SESSION_INVALID', 'reauth_required'],
    [403, 'FAMILY_ADULT_REQUIRED', 'reauth_required'],
    [403, 'CHILD_DEVICE_GUARDIAN_REQUIRED', 'reauth_required'],
    [404, 'CHILD_NOT_FOUND', 'identity_not_found'],
    [404, 'CHILD_DEVICE_NOT_FOUND', 'identity_not_found'],
    [409, 'CHILD_DEVICE_STALE_VERSION', 'busy'],
    [429, 'CHILD_DEVICE_BUSY', 'rate_limited'],
    [503, 'CHILD_DEVICE_TEMPORARILY_UNAVAILABLE', 'unavailable'],
    [418, 'CHILD_DEVICE_UNKNOWN', 'unavailable'],
  ];
  for (const [status, server, expected] of cases) {
    let attempts = 0;
    const guardian = createGuardianChildDeviceClient({environment: 'test', apiBaseUrl: base,
      fetcher: async () => { attempts += 1; return refused(server, status, status === 429 ? '2' : undefined); }});
    await assert.rejects(guardian.listDevices(access, childId),
      (error: unknown) => code(expected)(error) && !String(error).includes(access) && !String(error).includes(server));
    assert.equal(attempts, 1);
    if (status === 429) await assert.rejects(guardian.listDevices(access, childId),
      (error: unknown) => code('rate_limited')(error) && error.retryAfterSeconds === 2);
  }
});

test('both faces keep a bounded, cancellable call and refuse a second attempt after a timeout', async () => {
  const access = adultAccessToken('synthetic-adult-access');
  const childId = randomUUID();
  const hanging = {environment: 'test', apiBaseUrl: base, timeoutMs: 10, fetcher: () => new Promise<Response>(() => {})};
  await assert.rejects(createGuardianChildDeviceClient(hanging).listDevices(access, childId), code('timeout'));
  await assert.rejects(createChildDevicePairingClient(hanging).start({installationId: randomUUID(), platform: 'ios'}), code('timeout'));
  const aborted = new AbortController();
  aborted.abort();
  const tx = stub([]);
  await assert.rejects(createChildDevicePairingClient({environment: 'test', apiBaseUrl: base, fetcher: tx.fetcher})
    .start({installationId: randomUUID(), platform: 'ios'}, {signal: aborted.signal}), code('cancelled'));
  await assert.rejects(createGuardianChildDeviceClient({environment: 'test', apiBaseUrl: base, fetcher: tx.fetcher})
    .listDevices(access, childId, {signal: aborted.signal}), code('cancelled'));
  assert.equal(tx.calls.length, 0);
  // A response that is not the contract, or that arrives under a wrong status, is never accepted.
  const wrong = stub([() => Promise.resolve(json({data: {items: [deviceSummary(childId)]}}, 201))]);
  await assert.rejects(createGuardianChildDeviceClient({environment: 'test', apiBaseUrl: base, fetcher: wrong.fetcher})
    .listDevices(access, childId), code('invalid_response'));
  const oversized = stub([() => Promise.resolve(json({data: {items: [], extra: 'x'.repeat(17_000)}}))]);
  await assert.rejects(createGuardianChildDeviceClient({environment: 'test', apiBaseUrl: base, fetcher: oversized.fetcher})
    .listDevices(access, childId), code('invalid_response'));
});
