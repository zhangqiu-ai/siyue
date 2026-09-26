import type { ActionDraft, CommandReceipt, GoalDraft } from '@siyue/contracts';
import { validateDraftInput } from './draft-state.ts';

/** Confirm / recheck / recreate for the single-page draft editor.
 * Every dependency is injected so the ordering (save first, then confirm the version the
 * user saw) is testable without React, a store or a device. */

export interface DraftReceiptCounts {
  readonly goals: number;
  readonly projects: number;
  readonly tasks: number;
  readonly goalId: string | null;
}

export function receiptCounts(receipt: CommandReceipt): DraftReceiptCounts {
  const count = (kind: 'goal' | 'project' | 'task') => receipt.result.entities.filter((entity) => entity.kind === kind).length;
  return {
    goals: count('goal'), projects: count('project'), tasks: count('task'),
    goalId: receipt.result.entities.find((entity) => entity.kind === 'goal')?.id ?? null,
  };
}

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

export type DraftConfirmResult =
  /** The saved content the user saw is in the space. A missing receipt only means it was recovered by reconciliation. */
  | { kind: 'applied'; receipt: CommandReceipt | null }
  /** The stored draft moved on after it was shown: reload it and let the user look again. */
  | { kind: 'changed' }
  /** The stored draft could not be saved, so nothing was confirmed. */
  | { kind: 'save_failed' }
  /** The confirmation may or may not have landed; the editor locks until the receipt is checked. */
  | { kind: 'unknown' };

export interface DraftConfirmDependencies {
  /** Wait for the debounced editor save so the confirmation binds to the content on screen. */
  flush: () => Promise<{ version: number }>;
  /** Identity of the draft the user is looking at, or null when nothing has been saved. */
  visible: () => { payloadHash: string; version: number } | null;
  confirm: (payloadHash: string, version: number) => Promise<CommandReceipt>;
  latest: () => Promise<ActionDraft | null>;
  reconcile: (draft: ActionDraft) => Promise<boolean>;
}

export async function confirmVisibleDraft(deps: DraftConfirmDependencies): Promise<DraftConfirmResult> {
  try {
    await deps.flush();
  } catch {
    // Unsaved content must never be approved, and the error stays in the editor for a retry.
    return { kind: 'save_failed' };
  }
  const seen = deps.visible();
  if (!seen) return { kind: 'save_failed' };
  try {
    return { kind: 'applied', receipt: await deps.confirm(seen.payloadHash, seen.version) };
  } catch (error) {
    if (errorCode(error) === 'draft_changed') return { kind: 'changed' };
    // An unknown result is only resolved by the formal receipt; a failed read keeps it unknown.
    const draft = await deps.latest().catch(() => null);
    if (draft && await deps.reconcile(draft).catch(() => false)) return { kind: 'applied', receipt: null };
    return { kind: 'unknown' };
  }
}

export type DraftRecheckResult = 'applied' | 'not_applied' | 'unavailable';

/** Resolve an unknown confirmation from the formal receipt, never from a local guess. */
export async function recheckDraft(deps: { latest: () => Promise<ActionDraft | null>; reconcile: (draft: ActionDraft) => Promise<boolean> }): Promise<DraftRecheckResult> {
  const draft = await deps.latest().catch(() => null);
  if (!draft) return 'unavailable';
  const applied = await deps.reconcile(draft).catch(() => false);
  return applied ? 'applied' : 'not_applied';
}

export interface DraftRecreateDependencies {
  payload: GoalDraft;
  /** Persist the same content as a new draft command; the caller owns the request identity. */
  create: (payload: GoalDraft) => Promise<ActionDraft>;
  now?: () => number;
}

/** An expired draft cannot be edited or confirmed, so the same content starts again. */
export async function recreateDraft(deps: DraftRecreateDependencies): Promise<ActionDraft> {
  const valid = validateDraftInput(deps.payload);
  if (!valid) throw Object.assign(new Error('The draft content cannot start a new draft'), { code: 'invalid_input' });
  return deps.create(valid);
}
