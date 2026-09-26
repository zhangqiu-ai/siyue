import { runExecutionMetadataSchema, type RunExecutionMetadata, businessCommandSchema, commandEnvelopeSchema, commandReceiptSchema, goalDraftSchema, taskSchema, type ActionDraft, type AgentRun, type BusinessCommand, type CommandReceipt, type GoalDraft } from '@siyue/contracts';
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
  /** Host lifetime for one account/space selection. Abort before replacing the client. */
  lifetimeSignal?: AbortSignal;
}
export interface RequestPlanProposer { propose: LocalClientOptions['propose']; execution: RunExecutionMetadata }
type UpdateCommand = Extract<BusinessCommand, {entityId: string}>;
export interface LocalRequest { commandId: string; issuedAt: string }

export function createLocalClient(options: LocalClientOptions) {
  const {service, spaceId, newId, now} = options;
  const actor = {...options.actor};
  let confirmations: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, BusinessCommand>();
  const flights = new Map<string, Promise<ReturnType<typeof commandReceiptSchema.parse>>>();
  /** Per-draft edit queue: a confirmation must observe every save the user already triggered. */
  const editTails = new Map<string, Promise<unknown>>();
  const journalSchema = commandEnvelopeSchema.omit({spaceId: true}).refine((value) => value.commandId.trim().length > 0, 'Empty command identifier');
  const envelope = () => ({schemaVersion: 1 as const, commandId: newId(), spaceId, issuedAt: now()});
  const snapshot = async (): Promise<PlanSnapshot> => {
    checkCancelled();
    const plan = await service.listPlan(spaceId, actor);
    checkCancelled();
    const runs = await options.runService?.list(spaceId, actor) ?? [];
    checkCancelled();
    return {...plan, runs};
  };
  function checkCancelled(signal?: AbortSignal) {
    if (signal?.aborted||options.lifetimeSignal?.aborted) throw Object.assign(new Error('Operation was cancelled'), {name: 'AbortError', code: 'cancelled'});
  }
  function execute(body: object, request?: LocalRequest) {
    checkCancelled();
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
      checkCancelled();
      pending.set(key, command);
      async function complete() {
        if (journal && journalKey) await journal.storage.removeItem(journalKey);
        pending.delete(key);
      }
      async function verify(value: unknown) {
        checkCancelled();
        const receipt = commandReceiptSchema.parse(value);
        if (receipt.commandId !== command.commandId || receipt.spaceId !== spaceId || receipt.actorId !== actor.id || receipt.actorKind !== actor.kind ||
          (journal && receipt.payloadHash !== await journal.hash(canonicalize(command)))) throw new Error('Command receipt does not match pending request');
        checkCancelled();return receipt;
      }
      if (saved) {
        const prior = await service.getReceipt(spaceId, actor, command.commandId);
        if (prior) {const receipt = await verify(prior); await complete(); checkCancelled();return receipt;}
      }
      try {
        checkCancelled();
        const receipt = await verify(await service.execute(command, actor));
        await complete();
        checkCancelled();
        return receipt;
      } catch (error) {
        if (error instanceof CommandError) {await complete(); throw error;}
        // Unknown outcomes retain identity across retries and process restart.
        try {
          const prior = await service.getReceipt(spaceId, actor, command.commandId);
          if (prior) {const receipt = await verify(prior); await complete(); checkCancelled();return receipt;}
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
  /** Latest saved draft, for a caller that must not assert a version it has not seen. */
  async function latestDraft(id: string) {
    const draft = (await snapshot()).drafts.find((item) => item.id === id);
    if (!draft) throw new CommandError('not_found', 'Draft does not exist');
    return draft;
  }
  /** Serialises edits per draft, running the next edit whatever the previous outcome was. */
  function trackEdit(id: string, work: () => Promise<ActionDraft>): Promise<ActionDraft> {
    const previous = editTails.get(id) ?? Promise.resolve();
    const result = previous.then(work, work);
    editTails.set(id, result.then(() => undefined, () => undefined));
    return result;
  }
  const pendingEdit = (id: string) => editTails.get(id) ?? Promise.resolve();
  /** Approval and application of one specific saved version, including receipt reconciliation. */
  async function settleConfirmation(draft: ActionDraft, version: number): Promise<CommandReceipt> {
    const receipt = await service.getReceipt(spaceId, actor, draft.command.commandId);
    checkCancelled();
    if (draft.status === 'applied' && receipt) {
      await options.runService?.settleDraft(spaceId, actor, draft.id);
      checkCancelled();
      return receipt;
    }
    const approval = await service.approveDraft(spaceId, actor, draft.id, version);
    checkCancelled();
    const applied = await service.applyApproved(spaceId, actor, draft.id, approval.id);
    await options.runService?.settleDraft(spaceId, actor, draft.id);
    checkCancelled();
    return applied;
  }
  return {
    snapshot,
    async propose(goal: string, signal?: AbortSignal, proposer?: RequestPlanProposer) {
      checkCancelled(signal);
      const controller=new AbortController();
      const signals=[signal,options.lifetimeSignal].filter((item):item is AbortSignal=>!!item);
      const abort=()=>controller.abort();
      for(const source of signals){source.addEventListener('abort',abort,{once:true});if(source.aborted)abort();}
      try{return await proposeInLifetime(controller.signal);}finally{for(const source of signals)source.removeEventListener('abort',abort);}
      async function proposeInLifetime(signal:AbortSignal){
      checkCancelled(signal);
      const metadata = proposer === undefined ? undefined : runExecutionMetadataSchema.safeParse(proposer?.execution);
      if (proposer !== undefined && (typeof proposer?.propose !== 'function' || !metadata?.success)) {
        throw new CommandError('invalid_input', 'Request-scoped generation requires explicit execution metadata');
      }
      const generate = proposer?.propose ?? options.propose;
      const run = await options.runService?.start(spaceId, actor, metadata?.success ? metadata.data : undefined);
      let draft: ActionDraft | undefined;
      let draftCommand: BusinessCommand | undefined;
      let errorCode = 'provider_error';
      try {
        checkCancelled(signal);
        const output = await generate(goal, signal);
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
      }
    },
    async createManualDraft(payload: GoalDraft, request: LocalRequest): Promise<ActionDraft> {
      checkCancelled();
      // Parse before awaiting so later caller edits cannot change this attempt.
      const parsed = businessCommandSchema.safeParse({schemaVersion: 1, spaceId,
        commandId: request?.commandId, issuedAt: request?.issuedAt, kind: 'plan.create', payload});
      if (!parsed.success || parsed.data.kind !== 'plan.create' || parsed.data.payload.projectTitles.length !== 1) {
        throw new CommandError('invalid_input', 'A manual draft requires one project and a stable command identity');
      }
      const command = parsed.data;
      const expiresAt = new Date(Date.parse(command.issuedAt) + 30 * 60 * 1000).toISOString();
      const verify = (draft: ActionDraft): ActionDraft => {
        checkCancelled();
        if (draft.spaceId !== spaceId || draft.actorId !== actor.id || draft.actorKind !== actor.kind ||
            draft.source !== 'ui' || canonicalize(draft.command) !== canonicalize(command)) {
          throw new CommandError('command_conflict', 'Draft does not match the original manual request');
        }
        return draft;
      };
      try {
        return verify(await service.createDraft(command, actor, {source: 'ui', expiresAt}));
      } catch (error) {
        if (error instanceof CommandError && error.code !== 'approval_expired') throw error;
        // Expiry does not prove an earlier unknown save failed. Recover the original
        // draft as read-only evidence; do not renew its expiry or allocate another identity.
        const existing = (await service.listPlan(spaceId, actor)).drafts.find(item => item.command.commandId === command.commandId);
        if (!existing) throw error;
        return verify(existing);
      }
    },
    saveManual(payload: GoalDraft, request?: LocalRequest) { return execute({kind: 'plan.create', payload}, request); },
    /** A task belongs to a goal through a real project, including older goals without one. */
    async addTaskToGoal(goalId: string, title: string, preferredProjectId?: string, request?: LocalRequest) {
      if (!taskSchema.shape.title.safeParse(title).success) throw new CommandError('invalid_input', 'Task title is invalid');
      const plan = await snapshot();
      const goal = plan.goals.find(item => item.id === goalId && item.spaceId === spaceId);
      if (!goal || goal.status === 'archived') throw new CommandError('not_found', 'Goal is unavailable in this space');
      const projects = plan.projects.filter(item => item.goalId === goalId && item.spaceId === spaceId && item.status !== 'archived');
      const preferred = preferredProjectId ? projects.find(item => item.id === preferredProjectId) : projects[0];
      if (preferredProjectId && !preferred) throw new CommandError('not_found', 'Project is unavailable for this goal');
      let projectId = preferred?.id;
      if (!projectId) {
        const receipt = await execute({kind: 'project.create', payload: {title: goal.title, goalId}});
        projectId = receipt.result.entities.find(item => item.kind === 'project')?.id;
        if (!projectId) throw new Error('Project creation returned no project identity');
      }
      return execute({kind: 'task.create', payload: {title, projectId}}, request);
    },
    editDraft(id: string, version: number, payload: GoalDraft) {
      return trackEdit(id, async () => {
        const draft = await findDraft(id, version);
        checkCancelled();
        if (draft.command.kind !== 'plan.create') throw new CommandError('invalid_input', 'This editor requires a plan draft');
        const result = await service.editDraft(spaceId, actor, id, version, {...draft.command, payload});
        checkCancelled();
        return result;
      });
    },
    confirmDraft(id: string, version: number) {
      const result = confirmations.then(async () => {
        checkCancelled();
        const draft = await findDraft(id, version);
        return settleConfirmation(draft, version);
      });
      confirmations = result.catch(() => undefined);
      return result;
    },
    /** Confirm the latest saved draft, refusing a version the user has not seen. */
    confirmLatestDraft(id: string, expectedVisiblePayloadHash?: string, expectedVisibleVersion?: number) {
      const result = confirmations.then(async () => {
        checkCancelled();
        // Wait for a save that is already in flight, so the callback cannot confirm older content.
        await pendingEdit(id);
        checkCancelled();
        const draft = await latestDraft(id);
        if (draft.command.kind !== 'plan.create') throw new CommandError('invalid_input', 'This confirmation requires a plan draft');
        if (expectedVisiblePayloadHash !== undefined && draft.payloadHash !== expectedVisiblePayloadHash)
          throw new CommandError('draft_changed', 'Draft content changed after it was shown; review the saved draft before confirming');
        if (expectedVisibleVersion !== undefined && draft.version !== expectedVisibleVersion)
          throw new CommandError('draft_changed', 'Draft version changed after it was shown; review the saved draft before confirming');
        try {
          return await settleConfirmation(draft, draft.version);
        } catch (error) {
          // A save that landed after this read must never be approved unseen.
          if (error instanceof CommandError && error.code === 'version_conflict')
            throw new CommandError('draft_changed', 'Draft changed while confirming; review the saved draft before trying again');
          throw error;
        }
      });
      confirmations = result.catch(() => undefined);
      return result;
    },
    async discardDraft(id: string, version: number) {
      checkCancelled();
      const draft = await service.rejectDraft(spaceId, actor, id, version);
      checkCancelled();
      if (options.runService) {
        const runs = await options.runService.list(spaceId, actor);
        for (const run of runs.filter((item) => item.draftId === id)) await options.runService.cancel(spaceId, actor, run.id);
      }
      checkCancelled();
      return draft;
    },
    update(kind: 'goal' | 'project' | 'task', id: string, version: number, patch: UpdateCommand['patch'], request?: LocalRequest) {
      return execute({kind: `${kind}.update`, entityId: id, expectedVersion: version, patch}, request);
    },
    async receipt(commandId: string) { checkCancelled();const result=await service.getReceipt(spaceId, actor, commandId);checkCancelled();return result; },
  };
}
export type LocalClient = ReturnType<typeof createLocalClient>;
