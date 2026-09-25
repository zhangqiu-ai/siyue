import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { deletionDependencyDispositionSchema, deletionReceiptSchema, refreshTokenSchema,
  type DeletionDependencyDisposition, type DeletionReceipt } from '@siyue/contracts';
import type { RecoveryCipher } from '../../adapters/crypto/auth-crypto.js';
import { AuthError } from './sessions.js';

/**
 * Idempotency cache for the account-deletion submission (design 14.5) over the existing
 * `siyue.idempotency_records` table.
 *
 * One `Idempotency-Key` is bound to exactly one request: the bearer access token, the single-use
 * `delete-account` grant, the explicit confirmation and the dependency disposition. Only HMACs of
 * those four values and of the key reach the table; the key, the bearer, the grant, the request body
 * and the receipt secret are never stored in clear. A replay deliberately does NOT require a
 * still-valid session -- acceptance revokes every session of the subject, which is exactly why the
 * client cannot sign in again to repeat the request -- so the exact bearer is part of the binding and
 * stands in for the session the request started with.
 *
 * Protocol the caller keeps, in this order:
 *   1. `lookup(request)` on the request path, before resolving any session:
 *        * `conflict` -- the same key was used for different content. Answer 409 AUTH_IDEMPOTENCY_CONFLICT.
 *        * `cached`   -- confirm `deletionId` against the independent anti-revival ledger (design 13.4)
 *                         and return the receipt only when the ledger holds that accepted intent.
 *        * `expired`  -- the deletion was recorded but its credential cannot be recovered. Answer 409
 *                         with the design's explicit "operation completed, sign in required" outcome.
 *                         Never redo the deletion and never mint a second receipt.
 *        * `absent`   -- no metadata for this key. That is NOT evidence that no deletion happened; see
 *                         the 24-hour boundary below. Continue with the normal acceptance path.
 *   2. `insert(client, request, {receipt})` inside the SAME main-database transaction that accepts the
 *      deletion and revokes its sessions, so the sealed receipt and its metadata commit or roll back
 *      with the acceptance itself.
 *
 * One row carries two lifetimes: the sealed `DeletionReceipt` in `response_ciphertext` is recoverable
 * for 60 seconds, and the operation metadata (the key binding) is kept for 24 hours via `expires_at`.
 * After 60 seconds the receipt is unrecoverable on purpose: design 13.3 requires an operation that
 * committed and cannot hand back its credential to say so instead of creating a second one. After the
 * 24-hour metadata window the shared bounded cleanup may remove the row, and a repeated key then reads
 * `absent`; the independent ledger, not this cache, is the authority that forbids reviving or
 * re-deleting an account. Nothing here ever deletes, rewrites or "refreshes" a recorded row: a second
 * reservation of one key fails closed, even after the metadata window has passed.
 *
 * `subject_id` is deliberately NULL. The deletion cleanup removes `idempotency_records WHERE
 * subject_id=$1`, so a subject-bound row would be destroyed by the very cleanup whose acceptance the
 * receipt documents, and the first delivery attempt that races that cleanup would lose the credential.
 * The row is bound to the ledger intent UUID in `resource_id` and to nothing else.
 *
 * Deliberately not here: the HTTP route, session or ledger verification, the receipt status read, the
 * cleanup schedule and any Apple call.
 */

export const ACCOUNT_DELETION_IDEMPOTENCY_SCOPE = 'account-deletion';
/** Recovery window of the sealed receipt: design 14.5 keeps a credential response for 60 seconds. */
export const ACCOUNT_DELETION_RECEIPT_RECOVERY_MS = 60_000;
/** Retention of the key binding and operation metadata: the design's 24-hour idempotency record. */
export const ACCOUNT_DELETION_METADATA_MS = 86_400_000;

/** The exact request a key is bound to. `accessToken` is the raw bearer value, without the scheme. */
export interface AccountDeletionIdempotencyRequest {
  key: string;
  accessToken: string;
  reauthGrant: string;
  confirmation: true;
  dependencyDisposition: DeletionDependencyDisposition;
}

/**
 * Outcome of reading one key. `cached` hands the caller the ledger intent UUID together with the
 * sealed receipt, and the caller returns the receipt only after the independent ledger holds that same
 * accepted intent. `expired` keeps the intent UUID so the caller can still name the recorded deletion
 * while refusing to recover its credential. `absent` says nothing about an earlier deletion.
 */
export type AccountDeletionIdempotencyLookup =
  | { kind: 'absent' }
  | { kind: 'cached'; deletionId: string; receipt: DeletionReceipt }
  | { kind: 'expired'; deletionId: string }
  | { kind: 'conflict' };

const requestSchema = z.object({
  // Bounded opaque caller value; the route rejects a duplicated header before this point.
  key: z.string().min(1).max(255),
  // Same shape the routes accept after "Bearer ". HMAC only; never stored, logged or reported.
  accessToken: z.string().regex(/^[A-Za-z0-9._-]{1,4096}$/),
  reauthGrant: refreshTokenSchema,
  confirmation: z.literal(true),
  dependencyDisposition: deletionDependencyDispositionSchema,
}).strict();

/**
 * A caller's JSON key or family-array order is not part of the contract. Bind each family's choice
 * and transfer recipient, sorted by family ID, so reordering an equivalent request can recover its
 * original receipt while changing any family's disposition conflicts.
 */
function canonicalDisposition(value: DeletionDependencyDisposition) {
  if (value.kind === 'none') return { kind: 'none' };
  return { kind: 'per-family', families: value.families.map(item => item.kind === 'transfer'
    ? { familyId: item.familyId, kind: 'transfer', recipientSubjectId: item.recipientSubjectId }
    : { familyId: item.familyId, kind: 'end-family-access' })
    .sort((left, right) => left.familyId.localeCompare(right.familyId)) };
}

interface RecordRow {
  request_mac: string;
  status: string;
  resource_id: string | null;
  response_ciphertext: string | null;
  response_expires_at: Date | null;
}

export function createAccountDeletionIdempotencyStore(pool: Pool, cipher: RecoveryCipher,
  pepper: Buffer, clock: () => Date = () => new Date()) {
  if (pepper.length !== 32) throw new Error('invalid_pepper');
  const mac = (label: string, ...parts: unknown[]) =>
    createHmac('sha256', pepper).update(JSON.stringify([label, ...parts])).digest('hex');
  const keyHashOf = (key: string) => mac('account-deletion-idempotency-key', key);
  const bindingOf = (request: AccountDeletionIdempotencyRequest) => mac('account-deletion-request',
    ACCOUNT_DELETION_IDEMPOTENCY_SCOPE, request.accessToken, request.reauthGrant, request.confirmation,
    canonicalDisposition(request.dependencyDisposition));
  // The key hash is part of the AEAD context, so a sealed receipt is only readable from its own row.
  const contextOf = (keyHash: string) => `idem:${ACCOUNT_DELETION_IDEMPOTENCY_SCOPE}:${keyHash}`;
  const parse = (input: unknown) => {
    const request = requestSchema.safeParse(input);
    if (!request.success) throw new AuthError('AUTH_INVALID_REQUEST', 400);
    return request.data;
  };
  /** Serializes concurrent reservations of one key; the HMAC-derived value never contains the key. */
  async function lock(client: PoolClient, key: string) {
    const value = BigInt.asIntN(64, BigInt(`0x${mac('account-deletion-lock', key).slice(0, 16)}`));
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [value.toString()]);
  }
  return {
    /** Request-path read. Never mutates, never extends a window and never mints a receipt. */
    async lookup(input: AccountDeletionIdempotencyRequest): Promise<AccountDeletionIdempotencyLookup> {
      const request = parse(input);
      const keyHash = keyHashOf(request.key);
      const row = (await pool.query<RecordRow>(`SELECT request_mac,status,resource_id,response_ciphertext,
        response_expires_at FROM siyue.idempotency_records WHERE scope=$1 AND key_hash=$2`,
      [ACCOUNT_DELETION_IDEMPOTENCY_SCOPE, keyHash])).rows[0];
      if (!row) return { kind: 'absent' };
      // One key means one request. A different bearer, grant, confirmation or disposition under the same
      // key is a conflict before any expiry question, so a caller never learns another request's state.
      if (row.request_mac !== bindingOf(request)) return { kind: 'conflict' };
      const deletionId = row.resource_id;
      // Every row this store writes is a completed acceptance carrying the ledger intent UUID. Anything
      // else under this scope was not written here and is refused rather than read as absent/expired.
      if (row.status !== 'complete' || deletionId === null || !z.uuid().safeParse(deletionId).success)
        throw new AuthError('AUTH_TEMPORARILY_UNAVAILABLE', 503);
      const sealed = row.response_ciphertext, deadline = row.response_expires_at;
      // Missing credential, closed window or an unusable seal: the deletion may well have committed, but
      // this receipt cannot be recovered and the caller must report that instead of retrying the work.
      if (!sealed || !deadline || +deadline <= +clock()) return { kind: 'expired', deletionId };
      try {
        const receipt = deletionReceiptSchema.parse(cipher.open(sealed, contextOf(keyHash)));
        if (receipt.deletionId !== deletionId) return { kind: 'expired', deletionId };
        return { kind: 'cached', deletionId, receipt };
      } catch { return { kind: 'expired', deletionId }; }
    },
    /**
     * Reserves the key inside the caller's deletion transaction. `saved.receipt.deletionId` must be the
     * intent UUID the caller prepared in the independent ledger; this store cannot read that database.
     * A key that is already recorded is never overwritten, whatever its content: the caller re-reads the
     * key and lets the ledger decide. Concurrent reservations serialize on the advisory lock below.
     */
    async insert(client: PoolClient, input: AccountDeletionIdempotencyRequest,
      saved: { receipt: DeletionReceipt }): Promise<void> {
      const request = parse(input);
      const receipt = deletionReceiptSchema.safeParse(saved?.receipt);
      if (!receipt.success) throw new AuthError('AUTH_INVALID_REQUEST', 400);
      const keyHash = keyHashOf(request.key);
      await lock(client, request.key);
      const previous = (await client.query<{ request_mac: string }>(
        'SELECT request_mac FROM siyue.idempotency_records WHERE scope=$1 AND key_hash=$2',
      [ACCOUNT_DELETION_IDEMPOTENCY_SCOPE, keyHash])).rows[0];
      if (previous) throw new AuthError('AUTH_IDEMPOTENCY_CONFLICT', 409);
      const now = clock();
      await client.query(`INSERT INTO siyue.idempotency_records
        (scope,key_hash,request_mac,subject_id,resource_id,status,response_ciphertext,response_expires_at,expires_at)
        VALUES($1,$2,$3,NULL,$4,'complete',$5,$6,$7)`,
      [ACCOUNT_DELETION_IDEMPOTENCY_SCOPE, keyHash, bindingOf(request), receipt.data.deletionId,
        cipher.seal(receipt.data, contextOf(keyHash)),
        new Date(+now + ACCOUNT_DELETION_RECEIPT_RECOVERY_MS),
        new Date(+now + ACCOUNT_DELETION_METADATA_MS)]);
    },
  };
}
export type AccountDeletionIdempotencyStore = ReturnType<typeof createAccountDeletionIdempotencyStore>;
