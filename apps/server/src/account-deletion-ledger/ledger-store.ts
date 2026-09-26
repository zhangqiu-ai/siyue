import { z } from 'zod';
import type { Pool } from 'pg';
import type { LedgerFencePoint } from './fence.js';

/**
 * Independent deletion anti-revival ledger (design 13.4) -- storage adapter prototype.
 *
 * Design 13.4: 每次数据库恢复先重放独立保管的删除防复活账本，再开启登录和对外查询. A restore of an
 * older main-database backup brings back rows for subjects that were deleted afterwards, so the
 * deletion marker cannot live in the database being restored. This module talks to that other
 * database (structure in `provision/deletion-ledger.sql`) and keeps exactly three things per subject:
 * the subject UUID, the current deletion intent UUID, and a state with its instants. No email, display
 * name, provider subject, device, receipt or content ever reaches this store.
 *
 * Protocol this store implements, in order:
 *   1. `prepare` persists the intent BEFORE the main-database transaction that starts the deletion.
 *   2. `markAccepted` persists AFTER that transaction committed. `accepted` is terminal: a later
 *      `prepare` cannot downgrade it and `cancel` refuses it outright.
 *   3. A main transaction that DEFINITELY rolled back may `cancel` its prepared row. An uncertain
 *      result must not: a prepared row blocks login and nothing is deleted on its behalf.
 *
 * Truncation detection and the format version:
 *   1. Every transition that actually changes a row advances the monotonic watermark
 *      `ledger.metadata.seq` inside its own transaction and stamps that number onto the row it wrote,
 *      so an intact ledger always satisfies `watermark = max(seq) over ledger.entries`. A repeated,
 *      conflicting or refused call changes nothing and moves nothing.
 *   2. `lookup` and `listReplayable` read the watermark and the highest entry sequence together and
 *      refuse to answer when they disagree -- entries truncated, deleted or restored without the
 *      watermark, or a watermark that went backwards. Answers never degrade to "nothing to replay".
 *   3. The format is `siyue-deletion-ledger-v2`. The v1 prototype has no watermark columns and is not
 *      migrated or overwritten by anything here; it reads as LEDGER_UNREADABLE, which fails closed.
 *   4. `highWater` reports the ledger's stable instance UUID together with its format, environment and
 *      newest sequence as the fence point a main-database fence binds to, so a newly initialized, empty
 *      ledger that carries the same format and environment is refused instead of looking identical.
 *
 * Deliberately not here: HTTP wiring, the deletion route, session revocation, cleanup of real account
 * data, and the replay that rewrites a restored main database. Nothing calls this module from the
 * runtime yet; it is the storage layer plus the facts a caller can read from it.
 */
export const DELETION_LEDGER_FORMAT = 'siyue-deletion-ledger-v2';

export type LedgerEnvironment = 'development' | 'test' | 'staging' | 'production';

export type DeletionLedgerErrorCode =
  | 'LEDGER_INVALID_REQUEST'
  | 'LEDGER_INTENT_CONFLICT'
  | 'LEDGER_NOT_PREPARED'
  | 'LEDGER_ACCEPTED_IMMUTABLE'
  | 'LEDGER_UNAVAILABLE'
  | 'LEDGER_UNREADABLE';

/** Typed ledger failure. `code` is a bounded identifier; it never carries SQL, a row or a secret. */
export class DeletionLedgerError extends Error {
  constructor(readonly code: DeletionLedgerErrorCode, readonly status = 503, options?: ErrorOptions) {
    super(code, options);
  }
}

export const ledgerStatusSchema = z.enum(['prepared', 'accepted', 'cancelled']);
export type LedgerStatus = z.infer<typeof ledgerStatusSchema>;

export interface LedgerEntry {
  subjectId: string;
  intentId: string;
  status: LedgerStatus;
  preparedAt: string;
  acceptedAt: string | null;
  cancelledAt: string | null;
}

/**
 * Ledger-side authoritative fence point: the ledger instance, its format, and the newest sequence it
 * has committed. The main-database fence stores exactly this triple (see `fence.ts`), so this value can
 * be handed to `compareLedgerFence` unchanged. `instanceId` is minted randomly when the ledger database
 * is created and never changes; without it, a ledger that was re-initialized empty would carry the same
 * format and environment as the one it replaced and read as "nothing to replay".
 */
export type LedgerHighWater = LedgerFencePoint;

// A timestamp reaches us either as JSON from the transition functions or as a pg `Date`; both are
// normalised to UTC ISO strings so a caller never has to know the ledger's session time zone.
const timestamp = z.union([z.string(), z.date()]);
const rawEntrySchema = z.object({
  subjectId: z.uuid(),
  intentId: z.uuid(),
  status: ledgerStatusSchema,
  preparedAt: timestamp,
  acceptedAt: timestamp.nullable(),
  cancelledAt: timestamp.nullable(),
}).strict();
const outcomeSchema = z.object({
  outcome: z.enum(['prepared', 'accepted', 'cancelled', 'intent_conflict', 'not_prepared', 'accepted_immutable']),
  entry: rawEntrySchema.nullable(),
}).strict();
const mutationInputSchema = z.object({ subjectId: z.uuid(), intentId: z.uuid() }).strict();
/** The instance identity and watermark, read as text so a bigint never loses precision on the way in. */
const highWaterSchema = z.object({
  instance_id: z.uuid(),
  watermark: z.string().regex(/^(0|[1-9][0-9]*)$/),
});

const iso = (value: string | Date) => {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** Returns null instead of throwing so each caller decides whether the row is unusable (fail closed). */
const normaliseEntry = (raw: unknown): LedgerEntry | null => {
  const parsed = rawEntrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const preparedAt = iso(parsed.data.preparedAt);
  const acceptedAt = parsed.data.acceptedAt === null ? null : iso(parsed.data.acceptedAt);
  const cancelledAt = parsed.data.cancelledAt === null ? null : iso(parsed.data.cancelledAt);
  if (!preparedAt || (parsed.data.acceptedAt !== null && !acceptedAt) || (parsed.data.cancelledAt !== null && !cancelledAt)) return null;
  return { subjectId: parsed.data.subjectId, intentId: parsed.data.intentId, status: parsed.data.status,
    preparedAt, acceptedAt, cancelledAt };
};

const unreadable = () => new DeletionLedgerError('LEDGER_UNREADABLE');
const unavailable = (cause: unknown) => new DeletionLedgerError('LEDGER_UNAVAILABLE', 503, { cause });

/**
 * Storage adapter over the independent ledger database. `pool` must be a connection for the ledger
 * runtime role against the ledger database; it is deliberately not the main-database pool, and the
 * ledger grants that role no table write privilege at all.
 */
export function createDeletionLedgerStore(pool: Pool,
  expected: {database:string;environment:LedgerEnvironment},
  clock: () => Date = () => new Date()) {
  if(!/^siyue_deletion_ledger(_[a-z0-9_]+)?$/.test(expected.database))
    throw new DeletionLedgerError('LEDGER_INVALID_REQUEST',400);
  async function assertIdentity() {
    let row:{database:string;role:string;format:string|null;environment:string|null}|undefined;
    try {row=(await pool.query(`SELECT current_database() AS database,session_user AS role,
      (SELECT format FROM ledger.metadata WHERE singleton) AS format,
      (SELECT environment FROM ledger.metadata WHERE singleton) AS environment`)).rows[0];}
    catch(error){throw unavailable(error);}
    if(!row||row.database!==expected.database||row.role!=='siyue_deletion_ledger_app'||
      row.format!==DELETION_LEDGER_FORMAT||row.environment!==expected.environment)throw unreadable();
  }
  const at = () => {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(+now)) throw new DeletionLedgerError('LEDGER_INVALID_REQUEST', 400);
    return now;
  };
  async function transition(sql: string, params: unknown[]) {
    await assertIdentity();
    let raw: unknown;
    try { raw = (await pool.query<{ outcome: unknown }>(sql, params)).rows[0]?.outcome; }
    catch (error) {
      if ((error as { code?: string; message?: string })?.code === '55000'
        && (error as { message?: string }).message?.includes('deletion_ledger_watermark_mismatch')) throw unreadable();
      throw unavailable(error);
    }
    const parsed = outcomeSchema.safeParse(raw);
    if (!parsed.success) throw unreadable();
    const entry = parsed.data.entry === null ? null : normaliseEntry(parsed.data.entry);
    if (parsed.data.entry !== null && entry === null) throw unreadable();
    return { outcome: parsed.data.outcome, entry };
  }
  return {
    /**
     * Persist the deletion intent before any main-database work. Repeating the same intent is
     * idempotent; a different intent while one is still prepared is refused instead of overwriting
     * it, and an accepted subject is returned as accepted without being downgraded.
     */
    async prepare(input: { subjectId: string; intentId: string }): Promise<LedgerEntry> {
      const parsed = mutationInputSchema.safeParse(input);
      if (!parsed.success) throw new DeletionLedgerError('LEDGER_INVALID_REQUEST', 400);
      const { outcome, entry } = await transition('SELECT ledger.prepare_intent($1,$2,$3) AS outcome',
        [parsed.data.subjectId, parsed.data.intentId, at()]);
      if (outcome === 'intent_conflict') throw new DeletionLedgerError('LEDGER_INTENT_CONFLICT', 409);
      if (!entry) throw unreadable();
      return entry;
    },
    /**
     * Mark the deletion accepted after the main-database transaction committed. Only a prepared row
     * with the same intent can become accepted; an accepted row stays accepted and a retry with the
     * same intent is a no-op, so an uncertain outcome can be resolved by repeating this call.
     */
    async markAccepted(input: { subjectId: string; intentId: string }): Promise<LedgerEntry> {
      const parsed = mutationInputSchema.safeParse(input);
      if (!parsed.success) throw new DeletionLedgerError('LEDGER_INVALID_REQUEST', 400);
      const { outcome, entry } = await transition('SELECT ledger.mark_accepted($1,$2,$3) AS outcome',
        [parsed.data.subjectId, parsed.data.intentId, at()]);
      if (outcome === 'not_prepared') throw new DeletionLedgerError('LEDGER_NOT_PREPARED', 409);
      if (outcome === 'intent_conflict') throw new DeletionLedgerError('LEDGER_INTENT_CONFLICT', 409);
      if (!entry) throw unreadable();
      return entry;
    },
    /**
     * Withdraw a prepared intent: the compensation for a main transaction that definitely rolled back,
     * or a subject cancelling before acceptance. An accepted row is refused (`LEDGER_ACCEPTED_IMMUTABLE`)
     * -- there is no path in this store that turns a deleted subject back into a login-eligible one.
     */
    async cancel(input: { subjectId: string; intentId: string }): Promise<LedgerEntry> {
      const parsed = mutationInputSchema.safeParse(input);
      if (!parsed.success) throw new DeletionLedgerError('LEDGER_INVALID_REQUEST', 400);
      const { outcome, entry } = await transition('SELECT ledger.cancel_intent($1,$2,$3) AS outcome',
        [parsed.data.subjectId, parsed.data.intentId, at()]);
      if (outcome === 'accepted_immutable') throw new DeletionLedgerError('LEDGER_ACCEPTED_IMMUTABLE', 409);
      if (outcome === 'not_prepared') throw new DeletionLedgerError('LEDGER_NOT_PREPARED', 409);
      if (outcome === 'intent_conflict') throw new DeletionLedgerError('LEDGER_INTENT_CONFLICT', 409);
      if (!entry) throw unreadable();
      return entry;
    },
    /**
     * Read one subject's marker, together with the ledger format and the watermark check. A missing
     * row is `null`; an unreachable database is `LEDGER_UNAVAILABLE`, and a database whose format
     * marker is absent, unrecognised, or whose watermark disagrees with the entries is
     * `LEDGER_UNREADABLE` -- never "this subject is clear".
     */
    async lookup(subjectId: string): Promise<LedgerEntry | null> {
      if (!z.uuid().safeParse(subjectId).success) throw new DeletionLedgerError('LEDGER_INVALID_REQUEST', 400);
      await assertIdentity();
      const sql = `SELECT (SELECT format FROM ledger.metadata WHERE singleton) AS ledger_format,
        ((SELECT seq FROM ledger.metadata WHERE singleton)
          IS NOT DISTINCT FROM COALESCE((SELECT max(seq) FROM ledger.entries), 0)
          AND (SELECT entry_count FROM ledger.metadata WHERE singleton)
          IS NOT DISTINCT FROM (SELECT count(*) FROM ledger.entries)) AS watermark_intact,
        e.subject_id, e.intent_id, e.status, e.prepared_at, e.accepted_at, e.cancelled_at
        FROM (SELECT 1) AS single_row LEFT JOIN ledger.entries e ON e.subject_id = $1`;
      let row: Record<string, unknown> | undefined;
      try { row = (await pool.query(sql, [subjectId])).rows[0]; }
      catch (error) { throw unavailable(error); }
      if (!row || row.ledger_format !== DELETION_LEDGER_FORMAT) throw unreadable();
      // The sequence and row count are read with the target row in one statement. A mismatch means
      // "no row for this subject" cannot be trusted.
      if (row.watermark_intact !== true) throw unreadable();
      if (row.subject_id == null) return null;
      const entry = normaliseEntry({ subjectId: row.subject_id, intentId: row.intent_id, status: row.status,
        preparedAt: row.prepared_at, acceptedAt: row.accepted_at, cancelledAt: row.cancelled_at });
      if (!entry) throw unreadable();
      return entry;
    },
    /**
     * Everything a recovery must replay before login reopens: the prepared and accepted markers, in
     * the order they were written. Cancelled rows are not replayable state. The read carries the same
     * format and watermark checks as `lookup`, so a ledger whose newest markers are gone -- and an
     * unreadable ledger generally -- cannot report an empty replay set.
     */
    async listReplayable(): Promise<LedgerEntry[]> {
      await assertIdentity();
      const sql = `SELECT (SELECT format FROM ledger.metadata WHERE singleton) AS ledger_format,
        ((SELECT seq FROM ledger.metadata WHERE singleton)
          IS NOT DISTINCT FROM COALESCE((SELECT max(seq) FROM ledger.entries), 0)
          AND (SELECT entry_count FROM ledger.metadata WHERE singleton)
          IS NOT DISTINCT FROM (SELECT count(*) FROM ledger.entries)) AS watermark_intact,
        COALESCE(jsonb_agg(jsonb_build_object('subjectId', e.subject_id, 'intentId', e.intent_id,
          'status', e.status, 'preparedAt', e.prepared_at, 'acceptedAt', e.accepted_at,
          'cancelledAt', e.cancelled_at) ORDER BY e.prepared_at, e.subject_id), '[]'::jsonb) AS entries
        FROM ledger.entries e WHERE e.status IN ('prepared','accepted')`;
      let row: Record<string, unknown> | undefined;
      try { row = (await pool.query(sql)).rows[0]; }
      catch (error) { throw unavailable(error); }
      if (!row || row.ledger_format !== DELETION_LEDGER_FORMAT) throw unreadable();
      // The integrity checks cover all rows, including cancelled ones, before this filtered replay
      // set may be trusted.
      if (row.watermark_intact !== true) throw unreadable();
      const rows = z.array(z.unknown()).safeParse(row.entries);
      if (!rows.success) throw unreadable();
      const entries: LedgerEntry[] = [];
      for (const candidate of rows.data) {
        const entry = normaliseEntry(candidate);
        if (!entry) throw unreadable();
        entries.push(entry);
      }
      return entries;
    },
    /**
     * The authoritative fence point of the ledger database this pool is pointed at: instance UUID,
     * format and newest committed sequence, shaped exactly as `fence.ts` stores it. Binding to the
     * instance UUID is what stops a freshly initialized, empty ledger with a matching format and
     * environment from reading as "nothing to replay". The same identity and watermark checks as the
     * reads above apply, so a ledger that cannot prove it is complete cannot be bound either -- and a
     * ledger whose database, role, format or environment is not this one is refused, not described.
     */
    async highWater(): Promise<LedgerHighWater> {
      const sql = `SELECT current_database() AS database, session_user AS role,
        (SELECT format FROM ledger.metadata WHERE singleton) AS ledger_format,
        (SELECT environment FROM ledger.metadata WHERE singleton) AS environment,
        (SELECT instance_id FROM ledger.metadata WHERE singleton) AS instance_id,
        (SELECT seq::text FROM ledger.metadata WHERE singleton) AS watermark,
        ((SELECT seq FROM ledger.metadata WHERE singleton)
          IS NOT DISTINCT FROM COALESCE((SELECT max(seq) FROM ledger.entries), 0)
          AND (SELECT entry_count FROM ledger.metadata WHERE singleton)
          IS NOT DISTINCT FROM (SELECT count(*) FROM ledger.entries)) AS watermark_intact`;
      let row: Record<string, unknown> | undefined;
      try { row = (await pool.query(sql)).rows[0]; }
      catch (error) { throw unavailable(error); }
      if (!row || row.database !== expected.database || row.role !== 'siyue_deletion_ledger_app'
        || row.ledger_format !== DELETION_LEDGER_FORMAT || row.environment !== expected.environment) throw unreadable();
      if (row.watermark_intact !== true) throw unreadable();
      const parsed = highWaterSchema.safeParse(row);
      if (!parsed.success) throw unreadable();
      // Exact, not a float: the sequence is a bigint in the ledger, the fence and here.
      return { instanceId: parsed.data.instance_id, format: DELETION_LEDGER_FORMAT,
        sequence: BigInt(parsed.data.watermark) };
    },
  };
}
export type DeletionLedgerStore = ReturnType<typeof createDeletionLedgerStore>;
