import { verifiedAccountSessionSchema, type VerifiedAccountSession } from '@siyue/contracts';

export type AccountSessionErrorCode =
  | 'invalid_config'
  | 'invalid_credential'
  | 'cancelled'
  | 'timeout'
  | 'unauthorized'
  | 'busy'
  | 'unavailable'
  | 'invalid_response'
  | 'expired';

export class AccountSessionError extends Error {
  constructor(readonly code: AccountSessionErrorCode) {
    super(code);
    this.name = 'AccountSessionError';
  }
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
export interface AccountSessionClientOptions {
  baseUrl: string;
  /** Host-selected transport. Native callers must inject a fetch implementation with response streams and redirect:error support. */
  fetcher: Fetcher;
  timeoutMs?: number;
  now?: () => number;
  maxResponseBytes?: number;
}

export interface AccountSessionClient {
  query(accessToken: string, options?: {signal?: AbortSignal}): Promise<VerifiedAccountSession>;
}

const tokenPattern = /^[A-Za-z0-9._~+/-]+=*$/i;

function endpointFor(baseUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AccountSessionError('invalid_config');
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new AccountSessionError('invalid_config');
  }
  return new URL('/v1/account/session', parsed).toString();
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) throw new AccountSessionError('invalid_response');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new AccountSessionError('invalid_response');
  if (!response.body) throw new AccountSessionError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) throw new AccountSessionError('invalid_response');
      chunks.push(item.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {
    throw new AccountSessionError('invalid_response');
  }
}

export function createAccountSessionClient(options: AccountSessionClientOptions): AccountSessionClient {
  const endpoint = endpointFor(options.baseUrl);
  const fetcher = options.fetcher;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maximum = options.maxResponseBytes ?? 4_096;
  const now = options.now ?? Date.now;
  if (typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || !Number.isInteger(maximum) || maximum < 256 || maximum > 65_536) {
    throw new AccountSessionError('invalid_config');
  }

  return {async query(accessToken, queryOptions = {}) {
    if (accessToken.length < 1 || accessToken.length > 4_096 || !tokenPattern.test(accessToken)) throw new AccountSessionError('invalid_credential');
    if (queryOptions.signal?.aborted) throw new AccountSessionError('cancelled');
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    queryOptions.signal?.addEventListener('abort', cancel, {once: true});
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new AccountSessionError(timedOut ? 'timeout' : 'cancelled')), {once: true});
    });
    try {
      const request = Promise.resolve().then(() => fetcher(endpoint, {
        method: 'GET',
        headers: {Accept: 'application/json', Authorization: `Bearer ${accessToken}`},
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      }));
      request.catch(() => {});
      let response: Response;
      try {
        response = await Promise.race([request, aborted]);
      } catch (error) {
        if (error instanceof AccountSessionError) throw error;
        if (controller.signal.aborted) throw new AccountSessionError(timedOut ? 'timeout' : 'cancelled');
        throw new AccountSessionError('unavailable');
      }
      if (response.status === 401) throw new AccountSessionError('unauthorized');
      if (response.status === 429) throw new AccountSessionError('busy');
      if (response.status !== 200) throw new AccountSessionError('unavailable');
      let body: unknown;
      try {
        const reading = readBoundedJson(response, maximum);
        reading.catch(() => {});
        body = await Promise.race([reading, aborted]);
      } catch (error) {
        if (error instanceof AccountSessionError) throw error;
        if (controller.signal.aborted) throw new AccountSessionError(timedOut ? 'timeout' : 'cancelled');
        throw new AccountSessionError('unavailable');
      }
      if (controller.signal.aborted) throw new AccountSessionError(timedOut ? 'timeout' : 'cancelled');
      const parsed = verifiedAccountSessionSchema.safeParse(body);
      if (!parsed.success) throw new AccountSessionError('invalid_response');
      if (controller.signal.aborted) throw new AccountSessionError(timedOut ? 'timeout' : 'cancelled');
      if (Date.parse(parsed.data.expiresAt) <= now()) throw new AccountSessionError('expired');
      return parsed.data;
    } finally {
      clearTimeout(timer);
      queryOptions.signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }};
}

export type AccountSessionState =
  | {status: 'disconnected'; generation: number; session: null; error: null}
  | {status: 'idle' | 'loading'; generation: number; session: null; error: null}
  | {status: 'ready'; generation: number; session: VerifiedAccountSession; error: null}
  | {status: 'signed-out' | 'error'; generation: number; session: null; error: AccountSessionErrorCode};

/** Keeps late responses and failures from an old credential generation out of the current account state. */
export function createAccountSessionCoordinator(client: AccountSessionClient) {
  let generation = 0;
  let credential: string | null = null;
  let requestId = 0;
  let controller: AbortController | null = null;
  let state: AccountSessionState = {status: 'disconnected', generation, session: null, error: null};
  return {
    setCredential(accessToken: string | null) {
      generation += 1;
      requestId += 1;
      controller?.abort();
      controller = null;
      credential = accessToken;
      state = accessToken === null
        ? {status: 'disconnected', generation, session: null, error: null}
        : {status: 'idle', generation, session: null, error: null};
    },
    getState: () => state,
    async refresh(): Promise<{status: 'ready'; session: VerifiedAccountSession} | {status: 'stale'}> {
      if (credential === null) throw new AccountSessionError('invalid_credential');
      controller?.abort();
      const ownController = new AbortController();
      controller = ownController;
      const ownGeneration = generation;
      const ownRequest = ++requestId;
      const token = credential;
      state = {status: 'loading', generation, session: null, error: null};
      try {
        const session = await client.query(token, {signal: ownController.signal});
        if (ownGeneration !== generation || ownRequest !== requestId || token !== credential) return {status: 'stale'};
        state = {status: 'ready', generation, session, error: null};
        return {status: 'ready', session};
      } catch (error) {
        if (ownGeneration !== generation || ownRequest !== requestId || token !== credential) return {status: 'stale'};
        const safe = error instanceof AccountSessionError ? error : new AccountSessionError('unavailable');
        state = {status: safe.code === 'unauthorized' || safe.code === 'expired' ? 'signed-out' : 'error', generation, session: null, error: safe.code};
        throw safe;
      } finally {
        if (controller === ownController) controller = null;
      }
    },
  };
}
