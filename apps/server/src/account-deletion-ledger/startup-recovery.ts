import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { transaction } from '../adapters/postgres/database.js';
import { compareLedgerFence, ledgerFencePointSchema, type LedgerFencePoint } from './fence.js';
import { DeletionLedgerError, type DeletionLedgerStore } from './ledger-store.js';
import { deletionReplayAcceptedSchema, deletionReplayResultSchema, deletionReplayUnresolvedSchema,
  type DeletionReplayAccepted, type DeletionReplayResult, type DeletionReplayUnresolved } from './replay.js';

/**
 * Startup recovery coordinator for the independent deletion anti-revival ledger (design 13.4).
 *
 * Design 13.4 fixes the order: 每次数据库恢复先重放独立保管的删除防复活账本，再开启登录和对外查询.
 * Restoring an older main-database backup brings back accounts that were deleted afterwards, so the
 * replay has to happen before login or external queries reopen. This directory already has the three
 * pieces: `replay.ts` pushes accepted markers into the restored database, `fence.ts` records in that
 * same database which ledger state a restore has applied, and `prepared-reconciler.ts` decides
 * prepared markers -- but each of them answers only its own question. None of them decides whether a
 * process may open, and calling them as independent steps proves nothing: a caller that reads the
 * fence, replays and then forgets to write the fence has certified nothing, and a caller that reads
 * the fence after replaying cannot tell whether the ledger moved underneath it.
 *
 * This kernel is that missing coordinator. It answers exactly one question -- may this process open
 * login and external queries against the database it is starting on -- and answers it with a bounded,
 * fail-closed result. It opens nothing itself: no HTTP, no route, no runtime wiring, no per-login
 * decision, no prepared reconciliation, no data cleanup.
 *
 * Inputs, and why each one is needed:
 *   * `fence.read()` / `fence.advance()`: the restorable main database's own record of "recovery was
 *     proved against ledger instance X at sequence N". It is read early -- an older backup moves its
 *     sequence backwards or removes the row while the independent ledger stays ahead -- and written
 *     last, only after a replay this run proved.
 *   * `ledger.highWater()`: the authoritative ledger point (instance UUID, format, newest committed
 *     sequence). The ledger is the authority; the fence only caches a proof about it. The replay
 *     kernel must be built over this same store, because it is the component that reads
 *     `listReplayable` and applies the accepted markers this kernel then certifies.
 *   * `pool`: the main database, used only to open the transaction that writes the fence.
 *
 * The run, in order, and why the order is the control:
 *   1. Capture the authoritative ledger point (`highWater`). An unreachable ledger or one that cannot
 *      prove completeness is a refusal, never an empty replay set.
 *   2. Read the main-database fence.
 *   3. Compare. A different ledger instance or format is `ledger_replaced`; a fence ahead of the
 *      ledger is `ledger_regressed`. Both refuse without writing anything. An equal point is
 *      `already_current`: the fence already records a proved replay against this exact instance and
 *      sequence, so nothing is replayed. A missing or older fence is `replay_required`.
 *   4. Replay. Accepted markers are pushed into the restored database; a prepared intent is reported
 *      and never acted on; anything the replay cannot prove stays unresolved.
 *   5. Refuse unless the replay proved completion: an unreachable ledger, an unresolved accepted
 *      marker, or a pending prepared intent all keep login closed and leave the fence untouched.
 *   6. Re-read `highWater` and require it to equal the point captured in step 1. If the ledger moved
 *      during the replay, this run cannot certify the point it replayed, so it refuses.
 *   7. Advance the fence to that same point, in one transaction on the main database. The fence store
 *      itself refuses a different instance or a backwards sequence, so a concurrent writer cannot be
 *      overwritten by this run. Only after this commit does the kernel report `openLogin: true`.
 *
 * A fresh install -- no fence row, empty ledger -- therefore replays the empty set and *binds* the
 * instance before reporting ready. It never treats "no fence" as "nothing to do" and never opens on
 * the strength of a missing row.
 *
 * Known boundary, deliberately unresolved here: a ledger and a main database that were rolled back
 * *together* agree with each other and read as `already_current`. Separating that from an honest
 * restart needs an independent witness that this repository does not have yet (see the README section
 * on what is still missing), so this kernel makes no claim about it.
 */

/** Bounded, self-describing reason why this process must not open login and external queries. */
export const deletionStartupRecoveryReasonSchema = z.enum([
  // The ledger could not be reached at all: connection, lost privilege, timeout. Nothing was read,
  // so nothing is claimed about markers either way.
  'ledger_unavailable',
  // The ledger answered but could not prove it is complete: missing or unrecognised format, a
  // watermark disagreeing with its entries, the wrong environment, or a point this contract cannot
  // read. "I could not read the markers" is not "there are no markers".
  'ledger_unreadable',
  // The main-database fence could not be read: the query failed (privilege, connectivity) or the row
  // did not match the fence contract. A fence this kernel cannot read is not a fence that is absent.
  'fence_unreadable',
  // The fence binds a different ledger instance or format. A re-initialized, empty ledger carries the
  // same format and environment as the one it replaced, so without this check it would read as
  // "nothing to replay".
  'ledger_replaced',
  // The fence is ahead of the ledger: the authoritative sequence went backwards, so the ledger lost
  // state this database already applied. Nothing here may "re-apply" anything on that basis.
  'ledger_regressed',
  // The replay kernel did not answer, or answered with something outside this contract. No evidence
  // was obtained, so the run is not a statement about the ledger.
  'replay_unproven',
  // At least one accepted marker could not be proved applied; see `unresolved` for the bounded reason
  // per subject. The provable markers were applied, but the fence is not advanced past a marker that
  // is still open.
  'replay_unresolved',
  // At least one prepared intent has no settled outcome; see `blocked`. A prepared row proves only
  // that an intent was persisted before the main transaction, so nothing is deleted or revoked for it.
  'prepared_markers_pending',
  // The ledger advanced between the point captured before replay and the point re-read before the fence
  // write. This run cannot certify the point it replayed, and it must not advance the fence to a
  // sequence it did not prove.
  'ledger_moved_during_recovery',
  // The main database refused the fence write: a conflicting ledger identity, a backwards sequence, a
  // concurrent writer, or a failed transaction. Login stays closed.
  'fence_advance_failed',
  // A restored deletion job names an active subject, or deleted/pending authority survives outside
  // one recorded frozen-family review. The ledger cannot reconstruct a lost transfer; keep the
  // service closed until the state is repaired against independent evidence.
  'deletion_state_unresolved',
  'deletion_state_unreadable',
]);
export type DeletionStartupRecoveryReason = z.infer<typeof deletionStartupRecoveryReasonSchema>;

export const deletionStartupRecoveryResultSchema = z.object({
  // The only answer this kernel gives about opening: true only when the fence records the authoritative
  // ledger point for this database. It is a decision, not an action -- nothing is opened here.
  openLogin: z.boolean(),
  // `already_current`: the fence already proved this exact ledger point, so nothing was replayed.
  // `replayed`: the replay ran in this run and the fence was advanced to the ledger's point.
  // `refused`: nothing is opened; `reason` names the bounded cause.
  action: z.enum(['already_current', 'replayed', 'refused']),
  reason: deletionStartupRecoveryReasonSchema.nullable(),
  // The fence point as read, before any write this run: null means this database had not proved a
  // recovery yet, which is exactly the fresh-install and freshly-restored case.
  fence: ledgerFencePointSchema.nullable(),
  // The authoritative ledger point captured before replay, and the point now bound in the fence when
  // the run opened. Null only when no point could be captured at all.
  ledger: ledgerFencePointSchema.nullable(),
  // Accepted markers this run applied, with what each write changed. Empty when nothing needed replay.
  accepted: z.array(deletionReplayAcceptedSchema),
  // Subjects whose prepared intent has no settled outcome. Any entry keeps login closed.
  blocked: z.array(z.uuid()),
  // Accepted markers that could not be proved applied. Any entry keeps login closed.
  unresolved: z.array(deletionReplayUnresolvedSchema),
}).strict();
export type DeletionStartupRecoveryResult = z.infer<typeof deletionStartupRecoveryResultSchema>;

/** The main-database half of the coordination: the fence store from `fence.ts`, or an equivalent. */
export interface StartupRecoveryFenceStore {
  read(): Promise<LedgerFencePoint | null>;
  advance(client: PoolClient, point: LedgerFencePoint): Promise<void>;
}

export interface StartupRecoveryDependencies {
  /** Main database: used only for the transaction around the fence write. */
  pool: Pool;
  fence: StartupRecoveryFenceStore;
  /** The independent ledger. `listReplayable` is read by the replay kernel over this same store. */
  ledger: Pick<DeletionLedgerStore, 'highWater'>;
  replay: { replay(): Promise<DeletionReplayResult> };
}

/** An unreachable ledger and an incomplete one are different operations problems: the store types the
 *  first as `LEDGER_UNAVAILABLE` and the second as `LEDGER_UNREADABLE`; anything untyped is conservatively
 *  unreachable rather than "read and empty". */
const ledgerErrorReason = (error: unknown): DeletionStartupRecoveryReason =>
  error instanceof DeletionLedgerError && error.code === 'LEDGER_UNREADABLE'
    ? 'ledger_unreadable' : 'ledger_unavailable';

/** Same three fields, compared exactly: instance and format identify the ledger, the sequence is the
 *  point. A different instance is a different ledger even at the same sequence. */
const sameLedgerPoint = (left: LedgerFencePoint, right: LedgerFencePoint) =>
  left.instanceId === right.instanceId && left.format === right.format && left.sequence === right.sequence;

/**
 * Builds the startup recovery coordinator over one main database and one independent ledger.
 *
 * Every dependency is injected and structurally typed, so the same kernel runs against the real
 * fence store, ledger store and replay kernel or against bounded equivalents -- and so a test can
 * place a deliberate failure between two steps. Nothing is wired into the runtime here.
 *
 * The returned `recover()` is idempotent by construction: a second run over unchanged state reports
 * `already_current` without replaying, because the fence was advanced to the ledger's own point.
 */
export async function hasUnresolvedDeletionState(pool:Pool): Promise<boolean> {
    const result=await pool.query<{unresolved:boolean}>(`WITH deleting_subjects AS (
      SELECT id FROM siyue.subjects WHERE status IN ('deletion_pending','deleted')
      UNION SELECT subject_id FROM siyue.account_deletion_jobs
    ), valid_reviews AS (
      SELECT r.family_id,r.deleting_subject_id FROM siyue.account_deletion_family_reviews r
        JOIN siyue.account_deletion_jobs j ON j.id=r.deletion_id
          AND j.subject_id=r.deleting_subject_id AND NOT j.local_data_deleted
        JOIN siyue.subjects s ON s.id=r.deleting_subject_id AND s.status='deletion_pending'
        JOIN siyue.families f ON f.id=r.family_id AND f.status='frozen'
          AND f.owner_subject_id=r.deleting_subject_id
      WHERE r.state='pending'
    ) SELECT
      EXISTS(SELECT 1 FROM siyue.account_deletion_jobs j JOIN siyue.subjects s ON s.id=j.subject_id
        WHERE s.status='active')
      OR EXISTS(SELECT 1 FROM siyue.account_deletion_family_reviews r
        LEFT JOIN valid_reviews v ON v.family_id=r.family_id AND v.deleting_subject_id=r.deleting_subject_id
        WHERE r.state='pending' AND v.family_id IS NULL)
      OR EXISTS(SELECT 1 FROM deleting_subjects d JOIN siyue.families f ON f.owner_subject_id=d.id
        WHERE f.status IN ('active','frozen') AND NOT EXISTS (SELECT 1 FROM valid_reviews v
          WHERE v.family_id=f.id AND v.deleting_subject_id=d.id))
      OR EXISTS(SELECT 1 FROM deleting_subjects d JOIN siyue.family_memberships m ON m.subject_id=d.id
        JOIN siyue.families f ON f.id=m.family_id
        WHERE m.active AND f.status IN ('active','frozen') AND NOT EXISTS (SELECT 1 FROM valid_reviews v
          WHERE v.family_id=f.id AND v.deleting_subject_id=d.id))
      OR EXISTS(SELECT 1 FROM deleting_subjects d JOIN siyue.guardian_relationships r ON r.guardian_subject_id=d.id
        JOIN siyue.consent_records c ON c.id=r.consent_record_id
        WHERE r.active AND c.withdrawn_at IS NULL AND NOT EXISTS (SELECT 1 FROM valid_reviews v
          WHERE v.family_id=r.family_id AND v.deleting_subject_id=d.id))
      OR EXISTS(SELECT 1 FROM deleting_subjects d JOIN siyue.consent_records c ON c.actor_subject_id=d.id
        WHERE c.purpose='child-guardianship' AND c.subject_id IS NOT NULL AND c.withdrawn_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM siyue.guardian_relationships r
            JOIN valid_reviews v ON v.family_id=r.family_id AND v.deleting_subject_id=d.id
            WHERE r.consent_record_id=c.id AND r.guardian_subject_id=d.id AND r.active))
      OR EXISTS(SELECT 1 FROM deleting_subjects d JOIN siyue.device_grants g ON g.guardian_id=d.id
        WHERE g.revoked_at IS NULL AND g.expires_at>now()) AS unresolved`);
    if(result.rows.length!==1 || typeof result.rows[0]?.unresolved!=='boolean')
      throw new Error('deletion_state_unreadable');
    return result.rows[0].unresolved;
}

export function createDeletionStartupRecovery({ pool, fence, ledger, replay }: StartupRecoveryDependencies) {
  return {
    /**
     * Decides whether this process may open. The result is the whole answer: it carries the fence as
     * read, the authoritative ledger point, what the replay applied, and -- on a refusal -- the bounded
     * reason plus whatever evidence the replay did produce.
     */
    async recover(): Promise<DeletionStartupRecoveryResult> {
      const evidence = { accepted: [] as DeletionReplayAccepted[], blocked: [] as string[],
        unresolved: [] as DeletionReplayUnresolved[] };
      let fencePoint: LedgerFencePoint | null = null;
      let ledgerPoint: LedgerFencePoint | null = null;
      // Reads the current closure state, so a refusal reports exactly what had been established when it
      // happened and never a value from a later step.
      const refuse = (reason: DeletionStartupRecoveryReason) => deletionStartupRecoveryResultSchema.parse(
        { openLogin: false, action: 'refused', reason, fence: fencePoint, ledger: ledgerPoint, ...evidence });

      // (1) The authoritative point, captured before anything is replayed. Everything below is a
      // statement about this one point, or it is a refusal.
      let rawLedgerPoint: unknown;
      try { rawLedgerPoint = await ledger.highWater(); }
      catch (error) { return refuse(ledgerErrorReason(error)); }
      const parsedPoint = ledgerFencePointSchema.safeParse(rawLedgerPoint);
      if (!parsedPoint.success) return refuse('ledger_unreadable');
      const captured = parsedPoint.data;
      ledgerPoint = captured;

      // (2) The fence this database carries. The store already validates its row; a point that does not
      // match the contract is refused here too, because an unreadable fence is not an absent one.
      try {
        const rawFence = await fence.read();
        if (rawFence !== null) {
          const parsedFence = ledgerFencePointSchema.safeParse(rawFence);
          if (!parsedFence.success) return refuse('fence_unreadable');
          fencePoint = parsedFence.data;
        }
      } catch { return refuse('fence_unreadable'); }

      // (3) Compare. Replacement and regression never replay: in both cases the fence and the ledger
      // disagree about which ledger this database is talking to, and no write here could settle that.
      const decision = compareLedgerFence(fencePoint, captured);
      if (decision === 'ledger_replaced') return refuse('ledger_replaced');
      if (decision === 'ledger_regressed') return refuse('ledger_regressed');
      if (decision === 'ready') {
        // The fence records a proved replay against this exact instance, format and sequence. Every
        // ledger transition advances the watermark (the store enforces that), so a prepared intent or
        // accepted marker written after that proof would have moved the ledger past this fence and
        // produced `replay_required` instead. An equal point therefore means there is nothing new to
        // replay, and re-applying the whole history on every start is exactly what the fence exists to
        // avoid.
        try { if(await hasUnresolvedDeletionState(pool))return refuse('deletion_state_unresolved'); }
        catch { return refuse('deletion_state_unreadable'); }
        return deletionStartupRecoveryResultSchema.parse({ openLogin: true, action: 'already_current',
          reason: null, fence: fencePoint, ledger: captured, accepted: [], blocked: [], unresolved: [] });
      }

      // (4) Replay. The kernel reads the ledger once, so this is one consistent replay set; it applies
      // accepted markers, reports prepared intents without acting on them, and never invents an outcome.
      let rawReplay: unknown;
      try { rawReplay = await replay.replay(); }
      catch { return refuse('replay_unproven'); }
      const parsedReplay = deletionReplayResultSchema.safeParse(rawReplay);
      if (!parsedReplay.success) return refuse('replay_unproven');
      const replayed = parsedReplay.data;
      evidence.accepted = replayed.accepted;
      evidence.blocked = replayed.blocked.map(entry => entry.subjectId);
      evidence.unresolved = replayed.unresolved;

      // (5) What the replay proved, checked here rather than copied from the kernel's own verdict: an
      // unreadable ledger, an accepted marker that could not be applied, and a prepared intent with no
      // settled outcome each keep login closed and leave the fence exactly as the restore left it.
      if (replayed.ledgerError !== null) return refuse(replayed.ledgerError);
      if (evidence.unresolved.length > 0) return refuse('replay_unresolved');
      if (evidence.blocked.length > 0) return refuse('prepared_markers_pending');
      // Replay stops account revival, but a restored backup may predate the deletion job. Without
      // that job no cleanup runner can finish removing server data, so the process must not open.
      if (evidence.accepted.length) {
        let jobs: Array<{id:string;subject_id:string}>;
        try { jobs=(await pool.query<{id:string;subject_id:string}>(
          `SELECT id,subject_id FROM siyue.account_deletion_jobs
           WHERE id = ANY($1::uuid[]) OR subject_id = ANY($2::uuid[])`,
          [evidence.accepted.map(entry=>entry.intentId),evidence.accepted.map(entry=>entry.subjectId)]
        )).rows; }
        catch { return refuse('replay_unproven'); }
        for(const entry of evidence.accepted){
          const matching=jobs.find(job=>job.id===entry.intentId&&job.subject_id===entry.subjectId);
          if(!matching)evidence.unresolved.push({subjectId:entry.subjectId,intentId:entry.intentId,
            reason:jobs.some(job=>job.subject_id===entry.subjectId||job.id===entry.intentId)
              ?'job_intent_mismatch':'job_missing'});
        }
        if(evidence.unresolved.length)return refuse('replay_unresolved');
      }

      try { if(await hasUnresolvedDeletionState(pool))return refuse('deletion_state_unresolved'); }
      catch { return refuse('deletion_state_unreadable'); }

      // (6) Race check. The replay took time, and another process may have written to the ledger while
      // it ran -- a new intent, an acceptance, a cancellation. This run proved the replay set it read,
      // not a later one, so a moved ledger refuses instead of being certified by a stale proof.
      let rawConfirmedPoint: unknown;
      try { rawConfirmedPoint = await ledger.highWater(); }
      catch (error) { return refuse(ledgerErrorReason(error)); }
      const parsedConfirmed = ledgerFencePointSchema.safeParse(rawConfirmedPoint);
      if (!parsedConfirmed.success) return refuse('ledger_unreadable');
      if (!sameLedgerPoint(parsedConfirmed.data, captured)) return refuse('ledger_moved_during_recovery');

      // (7) Bind. This is the only write the coordinator makes, it is one main-database transaction, and
      // the fence store refuses a different instance or a backwards sequence inside it. A fresh install
      // reaches this line with an empty replay set and binds the ledger instance before reporting ready;
      // a missing fence row is never treated as proof by itself.
      try { await transaction(pool, client => fence.advance(client, captured)); }
      catch { return refuse('fence_advance_failed'); }
      // The fence write itself has a race window. A marker committed while that main transaction
      // ran leaves the fence behind; refuse this startup and let the next pass replay it.
      let rawAfterFence: unknown;
      try { rawAfterFence = await ledger.highWater(); }
      catch (error) { return refuse(ledgerErrorReason(error)); }
      const afterFence = ledgerFencePointSchema.safeParse(rawAfterFence);
      if (!afterFence.success) return refuse('ledger_unreadable');
      if (!sameLedgerPoint(afterFence.data, captured)) return refuse('ledger_moved_during_recovery');

      return deletionStartupRecoveryResultSchema.parse({ openLogin: true, action: 'replayed', reason: null,
        fence: fencePoint, ledger: captured, ...evidence });
    },
  };
}
export type DeletionStartupRecovery = ReturnType<typeof createDeletionStartupRecovery>;
