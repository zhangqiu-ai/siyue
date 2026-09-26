import { z } from 'zod';
import { DeletionLedgerError, type DeletionLedgerStore, type LedgerEntry } from './ledger-store.js';

/**
 * Decisions over the independent deletion anti-revival ledger (design 13.4). Pure policy on top of
 * the storage adapter: it answers the two questions the runtime has to ask, and it never mutates the
 * ledger, deletes account data or opens login by itself.
 *
 * `loginDecision` is the per-login check. The design fixes what each state means:
 *   * no row      -> the subject is clear.
 *   * accepted    -> the subject was deleted; a restored backup must not resurrect it.
 *   * prepared    -> the deletion outcome is not settled. This only blocks login. Nothing here, and
 *                    nothing downstream of this decision, may delete or revoke on that basis alone.
 *   * unreadable or unreachable ledger -> blocked. Fail closed, because "I could not read the marker"
 *                    and "there is no marker" are not the same answer.
 *
 * `restoreGate` is the check that runs before login and external queries reopen after a database
 * restore. It reports the replay that has to happen first; this prototype does not perform the
 * replay, so it never claims the replay is complete.
 */
export type LoginDecision =
  | { allow: true; reason: 'ledger_clear' }
  | { allow: false; reason: 'deletion_accepted' | 'deletion_prepared_unresolved'
      | 'ledger_unavailable' | 'ledger_unreadable' | 'invalid_subject' };

export interface ReplaySet { accepted: string[]; prepared: string[] }

export type RestoreDecision =
  | { openLogin: true; replay: ReplaySet | null }
  | { openLogin: false; reason: 'replay_required'; replay: ReplaySet }
  | { openLogin: false; reason: 'ledger_unavailable' | 'ledger_unreadable' | 'invalid_request' };

const unknownLedger = (error: unknown) =>
  error instanceof DeletionLedgerError && error.code === 'LEDGER_UNREADABLE' ? 'ledger_unreadable' : 'ledger_unavailable';

export function createDeletionLedgerGate(store: DeletionLedgerStore) {
  return {
    /** Read-only: an unreadable ledger blocks, and a blocked subject is never acted on here. */
    async loginDecision(subjectId: string): Promise<LoginDecision> {
      if (!z.uuid().safeParse(subjectId).success) return { allow: false, reason: 'invalid_subject' };
      let entry: LedgerEntry | null;
      try { entry = await store.lookup(subjectId); }
      catch (error) {
        return { allow: false, reason: error instanceof DeletionLedgerError && error.code === 'LEDGER_INVALID_REQUEST'
          ? 'invalid_subject' : unknownLedger(error) };
      }
      if (!entry) return { allow: true, reason: 'ledger_clear' };
      // A cancelled row is not a deletion marker: the subject withdrew before acceptance.
      if (entry.status === 'accepted') return { allow: false, reason: 'deletion_accepted' };
      if (entry.status === 'prepared') return { allow: false, reason: 'deletion_prepared_unresolved' };
      return { allow: true, reason: 'ledger_clear' };
    },
    /**
     * Startup decision after a restore. `{restored:false}` is the ordinary startup path, where only
     * the per-login decisions apply. `{restored:true}` holds login closed until the returned set has
     * been replayed into the restored database; an unreadable or unreachable ledger closes login with
     * no replay set, because it cannot prove what has to be replayed.
     */
    async restoreGate(input: { restored: boolean }): Promise<RestoreDecision> {
      if (!z.object({ restored: z.boolean() }).strict().safeParse(input).success) return { openLogin: false, reason: 'invalid_request' };
      if (!input.restored) return { openLogin: true, replay: null };
      let entries: LedgerEntry[];
      try { entries = await store.listReplayable(); }
      catch (error) { return { openLogin: false, reason: unknownLedger(error) }; }
      const replay: ReplaySet = {
        accepted: entries.filter(entry => entry.status === 'accepted').map(entry => entry.subjectId),
        prepared: entries.filter(entry => entry.status === 'prepared').map(entry => entry.subjectId),
      };
      if (!replay.accepted.length && !replay.prepared.length) return { openLogin: true, replay };
      return { openLogin: false, reason: 'replay_required', replay };
    },
  };
}
export type DeletionLedgerGate = ReturnType<typeof createDeletionLedgerGate>;
