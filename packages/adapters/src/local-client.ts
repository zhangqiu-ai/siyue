import { businessCommandSchema, commandEnvelopeSchema, commandReceiptSchema, goalDraftSchema, type ActionDraft, type AgentRun, type BusinessCommand, type GoalDraft } from '@siyue/contracts';
import { canonicalize, CommandError, type Actor, type CommandService, type RunService } from '@siyue/domain';
import type { RequestJournal } from './request-journal.js';

export type PlanSnapshot = Awaited<ReturnType<CommandService['listPlan']>> & {runs: AgentRun[]};
export interface LocalClientOptions {
  service: CommandService;
  runService?: RunService;
  requestJournal?: RequestJournal;
  spaceId: string;
  actor: Actor;
  newId: () => string;
  now: () => string;
  propose: (goal: string, signal?: AbortSignal) => Promise<GoalDraft>;
}
type UpdateCommand = Extract<BusinessCommand, {entityId: string}>;
export interface LocalRequest { commandId: string; issuedAt: string }

export function createLocalClient(options: LocalClientOptions) {
  const {service, spaceId, newId, now} = options;
  const actor = {...options.actor};
  let confirmations: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, BusinessCommand>();
  const flights = new Map<string, Promise<ReturnType<typeof commandReceiptSchema.parse>>>();
  const journalSchema = commandEnvelopeSchema.omit({spaceId: true}).refine((value) => value.commandId.trim().length > 0, 'Empty command identifier');
  const envelope = () => ({schemaVersion: 1 as const, commandId: newId(), spaceId, issuedAt: now()});
  const snapshot = async (): Promise<PlanSnapshot> => {
    const plan = await service.listPlan(spaceId, actor);
    const runs = await options.runService?.list(spaceId, actor) ?? [];
    return {...plan, runs};
  };
  function checkCancelled(signal?: AbortSignal) {
    if (signal?.aborted) throw Object.assign(new Error('Operation was cancelled'), {name: 'AbortError', code: 'cancelled'});
  }
  function execute(body: object, request?: LocalRequest) {
    const key = canonicalize({body, request});
    const active = flights.get(key);
    if (active) return active;
    // Snapshot caller-owned inputs before the first asynchronous journal operation.
    const input = JSON.parse(JSON.stringify(body)) as object;
    const explicit = request ? {commandId: request.commandId, issuedAt: request.issuedAt} : undefined;
    const result = (async () => {
      // Explicit desktop requests retain their existing IPC-owned journal behavior.
      const journal = explicit ? undefined : options.requestJournal;
      let journalKey: string | undefined;
      let saved: LocalRequest | undefined;
      if (journal) {
        const digest = await journal.hash(canonicalize({spaceId, actor, body: input}));
        if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Request journal requires a SHA-256 hex digest');
        journalKey = `siyue.pending.v1.${digest}`;
        const raw = await journal.storage.getItem(journalKey);
        if (raw !== null) {
          let value: unknown;
          try {value = JSON.parse(raw);} catch {throw new Error('Pending request metadata is corrupt; original data was preserved');}
          const parsed = journalSchema.safeParse(value);
          if (!parsed.success) throw new Error('Pending request metadata is unsupported or corrupt; original data was preserved');
          saved = {commandId: parsed.data.commandId, issuedAt: parsed.data.issuedAt};
        }
      }
      const memory = pending.get(key);
      if (memory && saved && (memory.commandId !== saved.commandId || memory.issuedAt !== saved.issuedAt)) throw new Error('Pending request identity changed; original metadata was preserved');
      const candidate = memory ?? {...envelope(), ...(saved ?? explicit ?? {}), ...input};
      const parsed = businessCommandSchema.safeParse(candidate);
      if (!parsed.success) throw new CommandError('invalid_input', 'Command does not match schema version 1');
      const command = parsed.data;
      if (journal && journalKey && !saved) await journal.storage.setItem(journalKey, JSON.stringify({schemaVersion: 1, commandId: command.commandId, issuedAt: command.issuedAt}));
      pending.set(key, command);
      async function complete() {
        if (journal && journalKey) await journal.storage.removeItem(journalKey);
        pending.delete(key);
      }
      async function verify(value: unknown) {
        const receipt = commandReceiptSchema.parse(value);
        if (receipt.commandId !== command.commandId || receipt.spaceId !== spaceId || receipt.actorId !== actor.id || receipt.actorKind !== actor.kind ||
          (journal && receipt.payloadHash !== await journal.hash(canonicalize(command)))) throw new Error('Command receipt does not match pending request');
        return receipt;
      }
      if (saved) {
        const prior = await service.getReceipt(spaceId, actor, command.commandId);
        if (prior) {const receipt = await verify(prior); await complete(); return receipt;}
      }
      try {
        const receipt = await verify(await service.execute(command, actor));
        await complete();
        return receipt;
      } catch (error) {
        if (error instanceof CommandError) {await complete(); throw error;}
        // Unknown outcomes retain identity across retries and process restart.
        try {
          const prior = await service.getReceipt(spaceId, actor, command.commandId);
          if (prior) {const receipt = await verify(prior); await complete(); return receipt;}
        } catch { /* Preserve the original error and pending identity. */ }
        throw error;
      }
    })();
    flights.set(key, result);
    void result.then(() => {flights.delete(key);}, () => {flights.delete(key);});
    return result;
  }
  async function findDraft(id: string, version: number) {
    const draft = (await snapshot()).drafts.find((item) => item.id === id);
    if (!draft) throw new CommandError('not_found', 'Draft does not exist');
    if (draft.version !== version) throw new CommandError('version_conflict', 'Draft changed; review it before trying again');
    return draft;
  }
  return {
    snapshot,
    async propose(goal: string, signal?: AbortSignal) {
      checkCancelled(signal);
      const run = await options.runService?.start(spaceId, actor);
      let draft: ActionDraft | undefined;
      let draftCommand: BusinessCommand | undefined;
      let errorCode = 'provider_error';
      try {
        checkCancelled(signal);
        const output = await options.propose(goal, signal);
        checkCancelled(signal);
        errorCode = 'invalid_output';
        const payload = goalDraftSchema.parse(output);
        errorCode = 'draft_save_failed';
        draftCommand = {...envelope(), kind: 'plan.create' as const, payload};
        draft = await service.createDraft(draftCommand, actor, {source: 'ai', expiresAt: new Date(Date.parse(draftCommand.issuedAt) + 30 * 60 * 1000).toISOString(), ...(run ? {runId: run.id} : {})});
        checkCancelled(signal);
        return draft;
      } catch (error) {
        const cancelled = signal?.aborted || (error instanceof Error && (error.name === 'AbortError' || 'code' in error && error.code === 'cancelled'));
        if (draftCommand && !draft) {
          // createDraft atomically links its run. A missing response is not evidence
          // of failure: reconcile that command, preserving unknown state on read errors.
          try {
            const plan = await service.listPlan(spaceId, actor);
            draft = plan.drafts.find((item) => item.command.commandId === draftCommand!.commandId);
            if (run) {
              const current = (await options.runService!.list(spaceId, actor)).find((item) => item.id === run.id);
              if (!current || (draft && current.draftId !== draft.id)) throw error;
            }
          } catch { throw error; }
        }
        if (draft && !cancelled) return draft;
        if (cancelled && draft) {
          if (draft.status === 'applied') await options.runService?.settleDraft(spaceId, actor, draft.id);
          else await service.rejectDraft(spaceId, actor, draft.id, draft.version, 'cancelled');
        }
        if (run) {
          if (cancelled) await options.runService!.cancel(spaceId, actor, run.id);
          else await options.runService!.fail(spaceId, actor, run.id, errorCode);
        }
        if (cancelled) throw Object.assign(new Error('Operation was cancelled'), {name: 'AbortError', code: 'cancelled'});
        throw error;
      }
    },
    saveManual(payload: GoalDraft, request?: LocalRequest) { return execute({kind: 'plan.create', payload}, request); },
    async editDraft(id: string, version: number, payload: GoalDraft) {
      const draft = await findDraft(id, version);
      if (draft.command.kind !== 'plan.create') throw new CommandError('invalid_input', 'This editor requires a plan draft');
      return service.editDraft(spaceId, actor, id, version, {...draft.command, payload});
    },
    confirmDraft(id: string, version: number) {
      const result = confirmations.then(async () => {
        const draft = await findDraft(id, version);
        const receipt = await service.getReceipt(spaceId, actor, draft.command.commandId);
        if (draft.status === 'applied' && receipt) {
          await options.runService?.settleDraft(spaceId, actor, id);
          return receipt;
        }
        const approval = await service.approveDraft(spaceId, actor, id, version);
        const applied = await service.applyApproved(spaceId, actor, id, approval.id);
        await options.runService?.settleDraft(spaceId, actor, id);
        return applied;
      });
      confirmations = result.catch(() => undefined);
      return result;
    },
    async discardDraft(id: string, version: number) {
      const draft = await service.rejectDraft(spaceId, actor, id, version);
      if (options.runService) {
        const runs = await options.runService.list(spaceId, actor);
        for (const run of runs.filter((item) => item.draftId === id)) await options.runService.cancel(spaceId, actor, run.id);
      }
      return draft;
    },
    update(kind: 'goal' | 'project' | 'task', id: string, version: number, patch: UpdateCommand['patch'], request?: LocalRequest) {
      return execute({kind: `${kind}.update`, entityId: id, expectedVersion: version, patch}, request);
    },
    receipt(commandId: string) { return service.getReceipt(spaceId, actor, commandId); },
  };
}
export type LocalClient = ReturnType<typeof createLocalClient>;
