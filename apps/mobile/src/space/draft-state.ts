import { goalDraftSchema } from '@siyue/contracts';
import type { ActionDraft, GoalDraft } from '@siyue/contracts';
import type { LocalClient } from '@siyue/adapters';

export function validateDraftInput(payload: GoalDraft): GoalDraft | null {
  const result = goalDraftSchema.safeParse(payload);
  if (!result.success || result.data.projectTitles.length !== 1) return null;
  return result.data;
}

export function editableDraftPayload(draft: ActionDraft | null, now: number): GoalDraft | null {
  if (!draft || draft.command.kind !== 'plan.create' || draft.status !== 'draft' ||
      !Number.isFinite(now) || !Number.isFinite(Date.parse(draft.expiresAt)) || Date.parse(draft.expiresAt) <= now) return null;
  // Schema parsing trims and creates new arrays; editor changes cannot mutate the snapshot.
  return validateDraftInput(draft.command.payload);
}

export async function reconcileDraftReceipt(client: LocalClient, draft: ActionDraft): Promise<boolean> {
  const receipt = await client.receipt(draft.command.commandId);
  if (!receipt) return false;
  if (receipt.commandId !== draft.command.commandId || receipt.spaceId !== draft.spaceId ||
      draft.command.spaceId !== draft.spaceId || receipt.actorId !== draft.actorId ||
      receipt.actorKind !== draft.actorKind || receipt.payloadHash !== draft.payloadHash ||
      receipt.status !== 'applied' || receipt.result.entities.length === 0) return false;
  const snapshot = await client.snapshot();
  return receipt.result.entities.every((reference) => {
    const records = reference.kind === 'goal' ? snapshot.goals : reference.kind === 'project' ? snapshot.projects : reference.kind === 'task' ? snapshot.tasks : [];
    return records.some(record => record.id === reference.id && record.spaceId === receipt.spaceId && record.version >= reference.version);
  });
}
