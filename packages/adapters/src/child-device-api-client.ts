import {
  childCreateRequestSchema, childListResponseSchema, childDeviceListResponseSchema, childDeviceRevokeRequestSchema, childDeviceSummarySchema,
  childSummarySchema, devicePairingApproveRequestSchema, devicePairingCompleteRequestSchema,
  devicePairingCompleteResponseSchema, devicePairingCreateRequestSchema, devicePairingCreateResponseSchema,
  devicePairingStatusRequestSchema, devicePairingStatusResponseSchema,
  devicePairingPreviewRequestSchema, devicePairingPreviewResponseSchema,
  type AuthClientErrorCode, type ChildCreateRequest, type ChildDevicePlatform, type ChildDeviceSummary,
  type ChildSummary, type DevicePairingApproveRequest, type DevicePairingPreviewRequest,
  type DevicePairingPreviewResponse, type DevicePairingStatusResponse, type SessionTokens,
} from '@siyue/contracts';
import { AuthClientError, authEndpoint, type AuthEndpoint } from './auth-api-client.js';

/**
 * Child-device pairing and device management HTTP clients (SA-08 9.3b).
 *
 * Two faces with two credential worlds. `createChildDevicePairingClient` is the initiating child device:
 * it holds no adult session, and the single `pollSecret` the server issues stays inside its closure — not
 * a property, not a return value, never part of the QR payload and never an input to the guardian face.
 * `createGuardianChildDeviceClient` is the signed-in adult guardian: every call carries its own adult
 * bearer, and the restricted child session `claim()` returns is not a value it accepts. Both faces reuse
 * the auth client's endpoint rules, error vocabulary and request boundaries (single in-flight attempt,
 * bounded JSON, redirect and credential refusal, signal cancellation and a hard timeout).
 */
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type ServerErrors = Record<string, AuthClientErrorCode>;

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// The server admits exactly this single-bearer shape; a malformed credential is refused before it is
// attached to a request, and the value is never echoed in an error or copied into a log line.
const accessTokenPattern = /^[A-Za-z0-9._-]{1,4096}$/;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);

function timeoutOf(value: number | undefined): number {
  if (value === undefined) return 8_000;
  if (!Number.isInteger(value) || value < 1 || value > 30_000) throw new AuthClientError('invalid_config');
  return value;
}
function bearer(token: string): string {
  if (typeof token !== 'string' || !accessTokenPattern.test(token)) throw new AuthClientError('invalid_request');
  return token;
}
function parse<T>(schema: {parse:(value:unknown)=>T}, input: unknown): T {
  try { return schema.parse(input); } catch { throw new AuthClientError('invalid_request'); }
}
async function json(response: Response, maximum = 16_384): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body ||
      Number(response.headers.get('content-length')) > maximum) throw new AuthClientError('invalid_response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new AuthClientError('invalid_response');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new AuthClientError('invalid_response'); }
  finally { void reader.cancel().catch(() => {}); }
}

/**
 * One bounded attempt against the fixed API prefix. `failures` is the per-face allowlist of server
 * codes: every other shape is refused rather than translated, and no server text reaches the caller.
 */
function transport(options: {endpoint:AuthEndpoint;fetcher:Fetcher;timeoutMs:number}, failures: ServerErrors) {
  const { endpoint, timeoutMs } = options;
  return async function send<T>(path: string, method: 'GET' | 'POST' | 'DELETE', schema: {parse:(value:unknown)=>T} | null,
    input: unknown, signal: AbortSignal | undefined, key: string | undefined, token: string | undefined,
    expectedStatus: number): Promise<T> {
    if (signal?.aborted) throw new AuthClientError('cancelled');
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const cancelled = new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(new AuthClientError(timedOut ? 'timeout' : 'cancelled')), { once: true }));
    try {
      const work = (async () => {
        let response: Response;
        try {
          response = await options.fetcher(endpoint.apiBaseUrl + path, {
            method,
            headers: { Accept: 'application/json', ...(input !== undefined ? {'Content-Type': 'application/json'} : {}),
              ...(key !== undefined ? {'Idempotency-Key': key} : {}),
              ...(token !== undefined ? {Authorization: `Bearer ${token}`} : {})},
            ...(input !== undefined ? {body: JSON.stringify(input)} : {}),
            signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
          });
        } catch { throw new AuthClientError('network'); }
        if (controller.signal.aborted) throw new AuthClientError('cancelled');
        if (response.redirected || (response.url && new URL(response.url).href !== endpoint.apiBaseUrl + path))
          throw new AuthClientError('invalid_response');
        if (response.status >= 500) throw new AuthClientError('unavailable');
        if (response.status === 429) {
          const seconds = Number(response.headers.get('retry-after'));
          throw new AuthClientError('rate_limited', Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 3600)) : 60);
        }
        if (!response.ok) {
          let body: unknown;
          try { body = await json(response); } catch { throw new AuthClientError(response.status === 401 ? 'reauth_required' : 'invalid_response'); }
          const server = (body as {error?:{code?:unknown}})?.error?.code;
          const mapped = typeof server === 'string' && Object.hasOwn(failures, server) ? failures[server] : undefined;
          throw new AuthClientError(mapped ?? (response.status === 401 ? 'reauth_required' : response.status === 400 ? 'invalid_request' : 'unavailable'));
        }
        if (response.status !== expectedStatus) throw new AuthClientError('invalid_response');
        if (schema === null) return undefined as T;
        const body = await json(response);
        try { return schema.parse((body as {data?:unknown})?.data); } catch { throw new AuthClientError('invalid_response'); }
      })();
      work.catch(() => {});
      return await Promise.race([work, cancelled]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}

/**
 * Refusals of the anonymous pairing surface. `NOT_APPROVED` is `busy` because the guardian may still be
 * approving; the terminal lifecycles share `challenge_invalid` with an unknown request or a wrong secret,
 * which is exactly the distinction the server publishes (it answers one 404 for both).
 */
const pairingFailures: ServerErrors = {
  CHILD_DEVICE_PAIRING_INVALID_REQUEST: 'invalid_request',
  CHILD_DEVICE_PAIRING_RATE_LIMITED: 'rate_limited', CHILD_DEVICE_PAIRING_POLL_TOO_SOON: 'rate_limited',
  CHILD_DEVICE_PAIRING_NOT_APPROVED: 'busy',
  CHILD_DEVICE_PAIRING_NOT_FOUND: 'challenge_invalid', CHILD_DEVICE_PAIRING_EXPIRED: 'challenge_invalid',
  CHILD_DEVICE_PAIRING_NOT_PENDING: 'challenge_invalid', CHILD_DEVICE_PAIRING_CONSUMED: 'challenge_invalid',
  CHILD_DEVICE_PAIRING_GUARDIAN_INELIGIBLE: 'challenge_invalid',
  CHILD_DEVICE_PAIRING_CONFLICT: 'invalid_request',
};
/**
 * Refusals of the guardian surface. A 403 is the server telling the caller to present the required adult
 * guardian (`reauth_required`); an unknown child, device or pairing is not visible to this subject
 * (`identity_not_found`); a version conflict is re-read and retried (`busy`) and a lifecycle that can no
 * longer continue is terminal (`challenge_invalid`). An idempotency key that no longer replays and an
 * ambiguous guardianship are refused as `invalid_request` instead of inviting a blind retry.
 */
const guardianFailures: ServerErrors = {
  FAMILY_INVALID_REQUEST: 'invalid_request', FAMILY_IDEMPOTENCY_KEY_REQUIRED: 'invalid_request',
  CHILD_DEVICE_INVALID_REQUEST: 'invalid_request', CHILD_DEVICE_PAIRING_INVALID_REQUEST: 'invalid_request',
  FAMILY_ADULT_REQUIRED: 'reauth_required', FAMILY_CHILD_FORBIDDEN: 'reauth_required',
  CHILD_DEVICE_GUARDIAN_REQUIRED: 'reauth_required', CHILD_DEVICE_PAIRING_GUARDIAN_REQUIRED: 'reauth_required',
  FAMILY_NOT_FOUND: 'identity_not_found', CHILD_NOT_FOUND: 'identity_not_found',
  CHILD_DEVICE_NOT_FOUND: 'identity_not_found', CHILD_DEVICE_PAIRING_NOT_FOUND: 'identity_not_found',
  CHILD_DEVICE_PAIRING_GUARDIAN_INELIGIBLE: 'identity_not_found',
  FAMILY_CHILD_FAMILY_INACTIVE: 'identity_not_found', FAMILY_CHILD_RELATIONSHIP_INACTIVE: 'identity_not_found',
  FAMILY_STALE_AUTHORIZATION: 'busy', CHILD_DEVICE_STALE_VERSION: 'busy',
  CHILD_DEVICE_PAIRING_STALE_GUARDIAN_VERSION: 'busy', FAMILY_CHILD_CREATE_CONFLICT: 'busy',
  CHILD_DEVICE_PAIRING_NOT_PENDING: 'challenge_invalid', CHILD_DEVICE_PAIRING_EXPIRED: 'challenge_invalid',
  CHILD_DEVICE_PAIRING_CONSUMED: 'challenge_invalid', CHILD_DEVICE_PAIRING_NOT_APPROVED: 'challenge_invalid',
  FAMILY_CHILD_CONFLICT: 'invalid_request', FAMILY_CHILD_RECOVERY_EXPIRED: 'invalid_request',
  CHILD_DEVICE_PAIRING_CONFLICT: 'invalid_request',
};

/** The child-device pairing window is five minutes and is polled no faster than every three seconds. */
export const childDevicePairingPollIntervalMs = 3_000;
/** One lost completion response is replayable with the same poll secret inside the server's window. */
export const childDevicePairingRecoveryMs = 60_000;

/** A dispatch whose outcome is unknown may consume the request, so it stays replayable; a refusal that
 * proves nothing was consumed clears the window, and the caller may claim again once the guardian approves. */
const unknownClaimOutcome = new Set<AuthClientErrorCode>(['network', 'timeout', 'cancelled', 'unavailable', 'invalid_response']);

export interface ChildDevicePairingOptions extends AuthEndpoint {
  fetcher: Fetcher;
  timeoutMs?: number;
  now?: () => number;
  pollIntervalMs?: number;
}
/** What the initiating device may show as a QR code: an identifier and the request token, never the poll secret. */
export interface ChildDevicePairingTicket { pairingId: string; requestToken: string; expiresAt: string; }
/** The restricted child session: a `child` subject on one 30-day device grant, never an adult credential. */
export interface ChildDeviceSession { kind: 'child'; deviceGrantId: string; tokens: SessionTokens; }
export interface ChildDeviceCall { signal?: AbortSignal; }
export interface ChildDevicePairingClient {
  readonly started: boolean;
  start(input: {installationId:string;platform:ChildDevicePlatform;deviceLabel?:string}, call?: ChildDeviceCall): Promise<ChildDevicePairingTicket>;
  status(call?: ChildDeviceCall): Promise<DevicePairingStatusResponse>;
  claim(call?: ChildDeviceCall): Promise<ChildDeviceSession>;
}

/**
 * The initiating child device. It has no adult session and no method that accepts one: create, poll and
 * claim carry only their bound contract bodies. `start()` is admitted once per instance, so a caller
 * cannot silently open a second pending request from the same device; the poll secret of the first
 * request lives only here and the ticket that leaves this closure never contains it.
 */
export function createChildDevicePairingClient(options: ChildDevicePairingOptions): ChildDevicePairingClient {
  const endpoint = authEndpoint(options); const timeoutMs = timeoutOf(options.timeoutMs);
  const now = options.now ?? (() => Date.now());
  const interval = options.pollIntervalMs ?? childDevicePairingPollIntervalMs;
  if (!Number.isInteger(interval) || interval < childDevicePairingPollIntervalMs || interval > 60_000)
    throw new AuthClientError('invalid_config');
  const send = transport({ endpoint, fetcher: options.fetcher, timeoutMs }, pairingFailures);
  let pollSecret: string | undefined;
  let ticket: ChildDevicePairingTicket | undefined;
  let starting = false;
  let nextPollAt = 0;
  let pollInFlight = false;
  let claimDispatchedAt: number | undefined;
  let claimInFlight = false;
  let claimRefused = false;
  let settled = false;
  const secondsUntil = (deadline: number) => Math.max(1, Math.ceil((deadline - now()) / 1000));
  const bound = () => {
    if (!ticket || pollSecret === undefined) throw new AuthClientError('invalid_request');
    return { ticket, pollSecret };
  };
  return {
    get started() { return ticket !== undefined; },
    async start(input, call) {
      if (ticket || starting) throw new AuthClientError('busy');
      const request = parse(devicePairingCreateRequestSchema, input);
      starting = true;
      try {
        const created = await send('/device-pairings', 'POST', devicePairingCreateResponseSchema, request,
          call?.signal, undefined, undefined, 201);
        pollSecret = created.pollSecret;
        ticket = { pairingId: created.pairingId, requestToken: created.requestToken, expiresAt: created.expiresAt };
        nextPollAt = now() + interval;
        return { ...ticket };
      } finally { starting = false; }
    },
    async status(call) {
      const state = bound();
      // A claimed request is consumed and an elapsed window is expired by definition, so neither needs a
      // poll: answering locally keeps the secret off the network and respects the three-second budget.
      if (settled) return { status: 'consumed', expiresAt: state.ticket.expiresAt };
      if (Date.parse(state.ticket.expiresAt) <= now()) return { status: 'expired', expiresAt: state.ticket.expiresAt };
      if (pollInFlight) throw new AuthClientError('busy');
      if (now() < nextPollAt) throw new AuthClientError('rate_limited', secondsUntil(nextPollAt));
      pollInFlight = true;
      nextPollAt = now() + interval;
      try {
        return await send(`/device-pairings/${state.ticket.pairingId}/status`, 'POST', devicePairingStatusResponseSchema,
          parse(devicePairingStatusRequestSchema, { pollSecret: state.pollSecret }), call?.signal, undefined, undefined, 200);
      } catch (failure) {
        if (failure instanceof AuthClientError && failure.code === 'rate_limited')
          nextPollAt = Math.max(nextPollAt, now() + failure.retryAfterSeconds * 1000);
        throw failure;
      } finally { pollInFlight = false; }
    },
    async claim(call) {
      const state = bound();
      if (settled || claimRefused) throw new AuthClientError('challenge_invalid');
      if (claimInFlight) throw new AuthClientError('busy');
      // An initial claim cannot start after expiry. A claim already dispatched just before expiry
      // may have consumed the request despite a lost response; its sealed result remains recoverable
      // for the separate 60-second window even when the five-minute application window has closed.
      if (claimDispatchedAt === undefined && Date.parse(state.ticket.expiresAt) <= now()) {
        claimRefused = true; throw new AuthClientError('challenge_invalid');
      }
      if (claimDispatchedAt !== undefined && now() >= claimDispatchedAt + childDevicePairingRecoveryMs) {
        // The server's sealed recovery record has closed; a repeat could neither consume nor recover.
        claimRefused = true;
        throw new AuthClientError('challenge_invalid');
      }
      if (call?.signal?.aborted) throw new AuthClientError('cancelled');
      if (claimDispatchedAt === undefined) claimDispatchedAt = now();
      claimInFlight = true;
      try {
        const claimed = await send(`/device-pairings/${state.ticket.pairingId}/complete`, 'POST',
          devicePairingCompleteResponseSchema, parse(devicePairingCompleteRequestSchema, { pollSecret: state.pollSecret }),
          call?.signal, undefined, undefined, 200);
        settled = true; claimDispatchedAt = undefined;
        return { kind: 'child' as const, deviceGrantId: claimed.deviceGrantId, tokens: claimed.sessionTokens };
      } catch (failure) {
        if (!(failure instanceof AuthClientError) || !unknownClaimOutcome.has(failure.code)) {
          claimDispatchedAt = undefined;
          if (!(failure instanceof AuthClientError) || failure.code === 'challenge_invalid' || failure.code === 'invalid_request')
            claimRefused = true;
        }
        throw failure;
      } finally { claimInFlight = false; }
    },
  };
}

/** An adult session bearer, produced only through `adultAccessToken` so a restricted child session and an
 * adult session cannot be interchanged by a typed caller. */
declare const adultSessionBrand: unique symbol;
export type AdultAccessToken = string & {readonly [adultSessionBrand]: true};
export function adultAccessToken(value: string): AdultAccessToken {
  return bearer(value) as AdultAccessToken;
}

export interface ChildDeviceApiOptions extends AuthEndpoint { fetcher: Fetcher; timeoutMs?: number; }
export interface GuardianChildDeviceClient {
  createChild(access: AdultAccessToken, familyId: string, input: ChildCreateRequest, key: string, call?: ChildDeviceCall): Promise<ChildSummary>;
  listChildren(access: AdultAccessToken, familyId: string, call?: ChildDeviceCall): Promise<ChildSummary[]>;
  listDevices(access: AdultAccessToken, childId: string, call?: ChildDeviceCall): Promise<ChildDeviceSummary[]>;
  revokeDevice(access: AdultAccessToken, childId: string, grantId: string, expectedVersion: number, call?: ChildDeviceCall): Promise<ChildDeviceSummary>;
  previewPairing(access: AdultAccessToken, pairingId: string, input: DevicePairingPreviewRequest, call?: ChildDeviceCall): Promise<DevicePairingPreviewResponse>;
  approvePairing(access: AdultAccessToken, pairingId: string, input: DevicePairingApproveRequest, call?: ChildDeviceCall): Promise<DevicePairingStatusResponse>;
}

/**
 * The signed-in adult guardian. Device management is based on a live guardian relationship, so the routes
 * are exactly the ones that check it: explicit consent creates the supervised child, the relationship
 * lists and revokes its devices, and approval spends a single-use `approve-child-device` reauth grant.
 * A pairing request token is accepted only by `approvePairing`; a poll secret is refused here before the
 * schema sees it, so it can never travel in a parent request or be echoed in an error.
 */
export function createGuardianChildDeviceClient(options: ChildDeviceApiOptions): GuardianChildDeviceClient {
  const endpoint = authEndpoint(options); const timeoutMs = timeoutOf(options.timeoutMs);
  const send = transport({ endpoint, fetcher: options.fetcher, timeoutMs }, guardianFailures);
  return {
    async createChild(access, familyId, input, key, call) {
      const token = bearer(access);
      if (!isUuid(familyId) || !isUuid(key)) throw new AuthClientError('invalid_request');
      const request = parse(childCreateRequestSchema, input);
      const summary = await send(`/families/${familyId}/children`, 'POST', childSummarySchema, request, call?.signal, key, token, 201);
      if (summary.familyId !== familyId) throw new AuthClientError('invalid_response');
      return summary;
    },
    async listChildren(access, familyId, call) {
      const token = bearer(access);
      if (!isUuid(familyId)) throw new AuthClientError('invalid_request');
      const page = await send(`/families/${familyId}/children`, 'GET', childListResponseSchema, undefined,
        call?.signal, undefined, token, 200);
      if (page.items.some(child => child.familyId !== familyId)) throw new AuthClientError('invalid_response');
      return page.items;
    },
    async listDevices(access, childId, call) {
      const token = bearer(access);
      if (!isUuid(childId)) throw new AuthClientError('invalid_request');
      const page = await send(`/children/${childId}/devices`, 'GET', childDeviceListResponseSchema, undefined, call?.signal, undefined, token, 200);
      if (page.items.some((device) => device.childSubjectId !== childId)) throw new AuthClientError('invalid_response');
      return page.items;
    },
    async revokeDevice(access, childId, grantId, expectedVersion, call) {
      const token = bearer(access);
      if (!isUuid(childId) || !isUuid(grantId)) throw new AuthClientError('invalid_request');
      const request = parse(childDeviceRevokeRequestSchema, { expectedVersion });
      const summary = await send(`/children/${childId}/devices/${grantId}`, 'DELETE', childDeviceSummarySchema, request, call?.signal, undefined, token, 200);
      if (summary.grantId !== grantId || summary.childSubjectId !== childId) throw new AuthClientError('invalid_response');
      return summary;
    },
    async approvePairing(access, pairingId, input, call) {
      const token = bearer(access);
      if (!isUuid(pairingId)) throw new AuthClientError('invalid_request');
      // The initiating device's own poll secret is not a guardian credential: it is refused here rather
      // than being carried into an adult request, and the pairing object the child device holds is never
      // an approvable shape.
      if (input !== null && typeof input === 'object' && 'pollSecret' in input) throw new AuthClientError('invalid_request');
      const request = parse(devicePairingApproveRequestSchema, input);
      const approved = await send(`/device-pairings/${pairingId}/approve`, 'POST', devicePairingStatusResponseSchema,
        request, call?.signal, undefined, token, 200);
      if (approved.status !== 'approved') throw new AuthClientError('invalid_response');
      return approved;
    },
    async previewPairing(access, pairingId, input, call) {
      const token = bearer(access);
      if (!isUuid(pairingId)) throw new AuthClientError('invalid_request');
      const request = parse(devicePairingPreviewRequestSchema, input);
      const preview = await send(`/device-pairings/${pairingId}/preview`, 'POST', devicePairingPreviewResponseSchema,
        request, call?.signal, undefined, token, 200);
      if (preview.child.childSubjectId !== request.childSubjectId) throw new AuthClientError('invalid_response');
      return preview;
    },
  };
}
