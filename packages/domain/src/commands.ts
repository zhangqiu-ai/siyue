import {
  businessCommandSchema, personalSpaceSchema, spaceStateSchema, actionDraftSchema, approvalSchema, commandReceiptSchema, planViewSchema,
  type ActionDraft, type Approval, type BusinessCommand, type CommandReceipt,
  type EntityRef, type PersonalSpace, type SpaceState,
} from '@siyue/contracts';

/** Actor is supplied by the trusted local host/session, never accepted from model output. */
export interface Actor { id: string; kind: 'user' | 'ai' }
/** Implementations serialize each space's transactions and roll back on callback failure.
 * Callbacks receive isolated data; only a fulfilled transaction may atomically commit
 * records, events, approvals and receipts. Implementations validate both loaded and
 * committed data with spaceStateSchema. read must never expose live mutable state.
 */
export interface SpaceStore {
  transaction<T>(spaceId: string, work: (state: SpaceState) => Promise<T>): Promise<T>;
  read<T>(spaceId: string, query: (state: SpaceState) => T): Promise<T>;
}
export interface CommandDependencies {
  store: SpaceStore;
  now: () => string;
  newId: () => string;
  /** Use a collision-resistant hash (e.g. SHA-256), not a timestamp or checksum. */
  hash: (canonicalPayload: string) => string | Promise<string>;
}
export type CommandErrorCode = 'invalid_input' | 'forbidden' | 'not_found' | 'version_conflict' |
  'command_conflict' | 'approval_required' | 'approval_invalid' | 'approval_expired' | 'invalid_state' | 'id_collision';
export class CommandError extends Error {
  constructor(public readonly code: CommandErrorCode, message: string) { super(message); this.name = 'CommandError'; }
}
export function createSpaceState(space: PersonalSpace, ownerId: string): SpaceState {
  personalSpaceSchema.parse(space);
  if (!ownerId.trim()) throw new CommandError('invalid_input', 'Owner is required');
  return spaceStateSchema.parse({schemaVersion: 1, space: personalSpaceSchema.parse(space), members: [{actorId: ownerId, canRead: true, canWrite: true}],
    goals: [], projects: [], tasks: [], drafts: [], approvals: [], receipts: [], events: []});
}
/** Only schema-validated JSON contracts cross this copy boundary. JSON cloning is
 * intentional: contracts contain no Date, Map, BigInt or undefined array elements,
 * and mobile runtimes need not provide structuredClone.
 */
function cloneValidated<T>(schema: {parse(value: unknown): T}, value: unknown): T {
  return JSON.parse(JSON.stringify(schema.parse(value))) as T;
}
/** Stable serialization makes key ordering irrelevant; undefined optional fields are omitted. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function parseCommand(value: unknown): BusinessCommand {
  const parsed = businessCommandSchema.safeParse(value);
  if (!parsed.success) throw new CommandError('invalid_input', 'Command does not match schema version 1');
  return parsed.data;
}
function authorize(state: SpaceState, spaceId: string, actor: Actor, write = true) {
  if (state.space.id !== spaceId || !state.members.some((m) => m.actorId === actor.id && m.canRead && (!write || m.canWrite)))
    throw new CommandError('forbidden', 'Space access is unavailable');
}
function human(actor: Actor) {
  if (actor.kind !== 'user') throw new CommandError('approval_required', 'Only a user may confirm or directly edit records');
}
function draftFor(state: SpaceState, draftId: string, actor: Actor) {
  const draft = state.drafts.find((item) => item.id === draftId && item.spaceId === state.space.id && item.actorId === actor.id);
  if (!draft) throw new CommandError('not_found', 'Draft is unavailable');
  return draft;
}
function assertVersion(actual: number, expected: number) {
  if (actual !== expected) throw new CommandError('version_conflict', 'Record changed; review it before trying again');
}
function revokeApprovals(state: SpaceState, draftId: string) {
  for (const approval of state.approvals) if (approval.draftId === draftId && approval.status === 'active') approval.status = 'revoked';
}

export function createCommandService(deps: CommandDependencies) {
  const {store, now, newId, hash} = deps;
  const fingerprint = (command: BusinessCommand) => hash(canonicalize(command));
  function allocateId(state: SpaceState) {
    const id = newId();
    if (!id || [...state.goals, ...state.projects, ...state.tasks, ...state.drafts, ...state.approvals, ...state.runs].some((item) => item.id === id) || state.events.some((item) => item.eventId === id))
      throw new CommandError('id_collision', 'Generated identifier is already in use');
    return id;
  }
  function checkReferences(state: SpaceState, command: BusinessCommand) {
    const goalId = command.kind === 'project.create' ? command.payload.goalId : command.kind === 'project.update' ? command.patch.goalId : undefined;
    const projectId = command.kind === 'task.create' ? command.payload.projectId : command.kind === 'task.update' ? command.patch.projectId : undefined;
    if (goalId && !state.goals.some((item) => item.id === goalId && item.spaceId === command.spaceId)) throw new CommandError('not_found', 'Referenced goal is unavailable in this space');
    if (projectId && !state.projects.some((item) => item.id === projectId && item.spaceId === command.spaceId)) throw new CommandError('not_found', 'Referenced project is unavailable in this space');
    if ('entityId' in command) {
      const records = command.kind === 'goal.update' ? state.goals : command.kind === 'project.update' ? state.projects : state.tasks;
      const entity = records.find((item) => item.id === command.entityId && item.spaceId === command.spaceId);
      if (!entity) throw new CommandError('not_found', 'Record is unavailable in this space');
      assertVersion(entity.version, command.expectedVersion);
      if (entity.status === 'archived') throw new CommandError('invalid_state', 'Archived records cannot be changed');
    }
  }
  function relatedVersions(state: SpaceState, command: BusinessCommand): EntityRef[] {
    const refs: EntityRef[] = [];
    const goalId = command.kind === 'project.create' ? command.payload.goalId : command.kind === 'project.update' ? command.patch.goalId : undefined;
    const projectId = command.kind === 'task.create' ? command.payload.projectId : command.kind === 'task.update' ? command.patch.projectId : undefined;
    if (goalId) refs.push({kind: 'goal', id: goalId, version: state.goals.find((item) => item.id === goalId && item.spaceId === command.spaceId)!.version});
    if (projectId) refs.push({kind: 'project', id: projectId, version: state.projects.find((item) => item.id === projectId && item.spaceId === command.spaceId)!.version});
    if ('entityId' in command) refs.push({kind: command.kind === 'goal.update' ? 'goal' : command.kind === 'project.update' ? 'project' : 'task', id: command.entityId, version: command.expectedVersion});
    return refs;
  }
  function bindDraftRun(state: SpaceState, draft: ActionDraft, actor: Actor, runId?: string) {
    if (runId === undefined) return;
    const run = state.runs.find((item) => item.id === runId && item.spaceId === draft.spaceId && item.actorId === actor.id && item.actorKind === actor.kind);
    if (!run) throw new CommandError('not_found', 'Run is unavailable to this executor');
    if (state.runs.some((item) => item.id !== runId && item.draftId === draft.id) || (run.draftId && run.draftId !== draft.id))
      throw new CommandError('command_conflict', 'Draft and run identities already belong to another operation');
    if (run.draftId === draft.id && run.commandId === draft.command.commandId) return;
    if (run.status !== 'running' || (draft.status !== 'draft' && draft.status !== 'approved'))
      throw new CommandError('invalid_state', 'Only a running operation may accept a pending draft');
    run.draftId = draft.id; run.commandId = draft.command.commandId;
    run.status = 'awaiting_approval'; run.updatedAt = now(); run.seq += 1;
    run.events.push({schemaVersion: 1, runId: run.id, seq: run.seq, state: 'awaiting_approval', time: run.updatedAt});
  }
  function existingReceipt(state: SpaceState, command: BusinessCommand, actor: Actor, payloadHash: string) {
    const receipt = state.receipts.find((item) => item.commandId === command.commandId && item.spaceId === command.spaceId);
    if (receipt && (receipt.payloadHash !== payloadHash || receipt.actorId !== actor.id || receipt.actorKind !== actor.kind)) throw new CommandError('command_conflict', 'Command identifier has already been used');
    return receipt;
  }
  function apply(state: SpaceState, command: BusinessCommand, actor: Actor, payloadHash: string): CommandReceipt {
    const previous = existingReceipt(state, command, actor, payloadHash);
    if (previous) return cloneValidated(commandReceiptSchema, previous);
    checkReferences(state, command);
    const timestamp = now();
    const refs: EntityRef[] = [];
    const base = () => ({id: allocateId(state), spaceId: command.spaceId, version: 1, createdAt: timestamp, updatedAt: timestamp});
    if (command.kind === 'plan.create') {
      const goal = {...base(), title: command.payload.title, ...(command.payload.rationale !== undefined ? {rationale: command.payload.rationale} : {}), status: 'active' as const};
      state.goals.push(goal); refs.push({kind: 'goal', id: goal.id, version: 1});
      const projectIds: string[] = [];
      for (const title of command.payload.projectTitles) {
        const project = {...base(), title, status: 'active' as const, goalId: goal.id};
        state.projects.push(project); projectIds.push(project.id); refs.push({kind: 'project', id: project.id, version: 1});
      }
      // The v1 flat plan associates tasks with its first project; without a project tasks stay independent.
      for (const title of command.payload.taskTitles) {
        const task = {...base(), title, status: 'open' as const, ...(projectIds[0] ? {projectId: projectIds[0]} : {})};
        state.tasks.push(task); refs.push({kind: 'task', id: task.id, version: 1});
      }
    } else if (command.kind === 'project.create') {
      const project = {...base(), ...command.payload, status: 'active' as const};
      state.projects.push(project); refs.push({kind: 'project', id: project.id, version: 1});
    } else if (command.kind === 'task.create') {
      const task = {...base(), ...command.payload, status: 'open' as const};
      state.tasks.push(task); refs.push({kind: 'task', id: task.id, version: 1});
    } else {
      const kind = command.kind === 'goal.update' ? 'goal' : command.kind === 'project.update' ? 'project' : 'task';
      const records = kind === 'goal' ? state.goals : kind === 'project' ? state.projects : state.tasks;
      const entity = records.find((item) => item.id === command.entityId)!;
      // Schema-validated patches only contain the allowed fields. null explicitly clears optional values.
      for (const [key, value] of Object.entries(command.patch)) {
        if (value === undefined) continue;
        if (value === null) Reflect.deleteProperty(entity, key); else Reflect.set(entity, key, value);
      }
      entity.version += 1; entity.updatedAt = timestamp;
      refs.push({kind, id: entity.id, version: entity.version});
    }
    const receipt: CommandReceipt = {schemaVersion: 1, commandId: command.commandId, spaceId: command.spaceId,
      actorId: actor.id, actorKind: actor.kind, payloadHash, status: 'applied', result: {entities: refs}, appliedAt: timestamp};
    state.events.push({eventId: allocateId(state), eventType: command.kind, schemaVersion: 1, spaceId: command.spaceId,
      commandId: command.commandId, actorId: actor.id, actorType: actor.kind, occurredAt: timestamp, entities: refs});
    state.receipts.push(receipt);
    return cloneValidated(commandReceiptSchema, receipt);
  }
  return {
    async execute(input: unknown, actor: Actor): Promise<CommandReceipt> {
      human(actor);
      const command = parseCommand(input);
      return store.transaction(command.spaceId, async (state) => {
        authorize(state, command.spaceId, actor);
        if (state.drafts.some((draft) => draft.command.commandId === command.commandId && draft.status !== 'applied'))
          throw new CommandError('approval_required', 'A saved draft must follow the approval path');
        return apply(state, command, actor, await fingerprint(command));
      });
    },
    async createDraft(input: unknown, actor: Actor, options: {source: 'ui' | 'ai'; expiresAt: string; runId?: string}): Promise<ActionDraft> {
      const command = parseCommand(input);
      return store.transaction(command.spaceId, async (state) => {
        authorize(state, command.spaceId, actor);
        const timestamp = now();
        if (!Number.isFinite(Date.parse(options.expiresAt)) || Date.parse(options.expiresAt) <= Date.parse(timestamp)) throw new CommandError('approval_expired', 'Draft must expire in the future');
        const payloadHash = await fingerprint(command);
        const existing = state.drafts.find((item) => item.command.commandId === command.commandId);
        if (existing) {
          if (existing.actorId !== actor.id || existing.actorKind !== actor.kind || existing.payloadHash !== payloadHash) throw new CommandError('command_conflict', 'Command identifier belongs to another draft');
          bindDraftRun(state, existing, actor, options.runId);
          return cloneValidated(actionDraftSchema, existing);
        }
        if (existingReceipt(state, command, actor, payloadHash)) throw new CommandError('invalid_state', 'Command was already applied');
        checkReferences(state, command);
        const draft: ActionDraft = {id: allocateId(state), schemaVersion: 1, spaceId: command.spaceId, actorId: actor.id, actorKind: actor.kind, source: options.source,
          command, payloadHash, version: 1, status: 'draft', expiresAt: options.expiresAt, createdAt: timestamp, updatedAt: timestamp};
        state.drafts.push(draft);
        bindDraftRun(state, draft, actor, options.runId);
        return cloneValidated(actionDraftSchema, draft);
      });
    },
    async editDraft(spaceId: string, actor: Actor, draftId: string, expectedVersion: number, input: unknown): Promise<ActionDraft> {
      human(actor); const command = parseCommand(input);
      return store.transaction(spaceId, async (state) => {
        authorize(state, spaceId, actor); const draft = draftFor(state, draftId, actor);
        assertVersion(draft.version, expectedVersion);
        if (draft.status !== 'draft' && draft.status !== 'approved') throw new CommandError('invalid_state', 'Draft cannot be edited');
        if (command.spaceId !== spaceId || command.commandId !== draft.command.commandId) throw new CommandError('command_conflict', 'Draft identity cannot change');
        if (Date.parse(draft.expiresAt) <= Date.parse(now())) throw new CommandError('approval_expired', 'Draft expired');
        checkReferences(state, command);
        draft.command = command; draft.payloadHash = await fingerprint(command); draft.version += 1;
        draft.status = 'draft'; draft.updatedAt = now(); revokeApprovals(state, draft.id);
        return cloneValidated(actionDraftSchema, draft);
      });
    },
    async approveDraft(spaceId: string, actor: Actor, draftId: string, expectedVersion: number): Promise<Approval> {
      human(actor);
      return store.transaction(spaceId, async (state) => {
        authorize(state, spaceId, actor); const draft = draftFor(state, draftId, actor); assertVersion(draft.version, expectedVersion);
        if (draft.status !== 'draft' && draft.status !== 'approved') throw new CommandError('invalid_state', 'Draft cannot be approved');
        const timestamp = now();
        if (Date.parse(draft.expiresAt) <= Date.parse(timestamp)) throw new CommandError('approval_expired', 'Draft expired');
        checkReferences(state, draft.command);
        if (await fingerprint(draft.command) !== draft.payloadHash) throw new CommandError('approval_invalid', 'Draft content changed');
        revokeApprovals(state, draft.id);
        const approval: Approval = {id: allocateId(state), draftId, spaceId, actorId: draft.actorId, actorKind: draft.actorKind, approvedBy: actor.id,
          commandId: draft.command.commandId, commandKind: draft.command.kind, payloadHash: draft.payloadHash,
          draftVersion: draft.version, baseVersions: relatedVersions(state, draft.command), status: 'active', expiresAt: draft.expiresAt, createdAt: timestamp};
        state.approvals.push(approval); draft.status = 'approved'; draft.updatedAt = timestamp;
        return cloneValidated(approvalSchema, approval);
      });
    },
    async rejectDraft(spaceId: string, actor: Actor, draftId: string, expectedVersion: number, status: 'rejected' | 'cancelled' = 'rejected'): Promise<ActionDraft> {
      human(actor);
      return store.transaction(spaceId, async (state) => {
        authorize(state, spaceId, actor); const draft = draftFor(state, draftId, actor); assertVersion(draft.version, expectedVersion);
        if (draft.status === 'applied') throw new CommandError('invalid_state', 'Applied records require a new edit command');
        revokeApprovals(state, draftId); draft.status = status; draft.updatedAt = now(); draft.version += 1;
        return cloneValidated(actionDraftSchema, draft);
      });
    },
    async applyApproved(spaceId: string, actor: Actor, draftId: string, approvalId: string): Promise<CommandReceipt> {
      return store.transaction(spaceId, async (state) => {
        authorize(state, spaceId, actor); const draft = draftFor(state, draftId, actor);
        if (draft.actorKind !== actor.kind) throw new CommandError('forbidden', 'Draft belongs to another executor');
        const payloadHash = await fingerprint(draft.command);
        const previous = existingReceipt(state, draft.command, actor, payloadHash);
        if (previous) return cloneValidated(commandReceiptSchema, previous);
        const approval = state.approvals.find((item) => item.id === approvalId && item.spaceId === spaceId);
        if (!approval || approval.status !== 'active' || draft.status !== 'approved' || approval.draftId !== draftId || approval.actorId !== actor.id || approval.actorKind !== actor.kind ||
          approval.commandId !== draft.command.commandId || approval.commandKind !== draft.command.kind || approval.draftVersion !== draft.version ||
          approval.payloadHash !== payloadHash || draft.payloadHash !== payloadHash) throw new CommandError('approval_invalid', 'Approval is missing, revoked or no longer matches');
        if (!state.members.some((member) => member.actorId === approval.approvedBy && member.canRead && member.canWrite)) throw new CommandError('forbidden', 'Approver authorization was revoked');
        if (Date.parse(approval.expiresAt) <= Date.parse(now()) || Date.parse(draft.expiresAt) <= Date.parse(now())) throw new CommandError('approval_expired', 'Approval expired');
        checkReferences(state, draft.command);
        if (canonicalize(approval.baseVersions) !== canonicalize(relatedVersions(state, draft.command))) throw new CommandError('version_conflict', 'Related records changed after confirmation');
        const receipt = apply(state, draft.command, actor, payloadHash);
        draft.status = 'applied'; draft.updatedAt = now(); approval.status = 'consumed';
        return receipt;
      });
    },
    async getReceipt(spaceId: string, actor: Actor, commandId: string): Promise<CommandReceipt | null> {
      return store.read(spaceId, (state) => {authorize(state, spaceId, actor, false);
        return cloneValidated(commandReceiptSchema.nullable(), state.receipts.find((item) => item.commandId === commandId && item.spaceId === spaceId && item.actorId === actor.id && item.actorKind === actor.kind) ?? null);});
    },
    async listPlan(spaceId: string, actor: Actor) {
      return store.read(spaceId, (state) => {authorize(state, spaceId, actor, false);
        return cloneValidated(planViewSchema, {goals: state.goals.filter((item) => item.spaceId === spaceId), projects: state.projects.filter((item) => item.spaceId === spaceId), tasks: state.tasks.filter((item) => item.spaceId === spaceId), drafts: state.drafts.filter((item) => item.spaceId === spaceId && item.actorId === actor.id)});});
    },
  };
}
export type CommandService = ReturnType<typeof createCommandService>;
