import {agentRunSchema, runErrorCodeSchema, spaceStateSchema, runTransitions, runEventReplaySchema, type AgentRun, type RunStatus, type SpaceState, type RunEventReplay} from '@siyue/contracts';
import {CommandError, type Actor, type SpaceStore} from './commands.js';

export interface RunDependencies {store: SpaceStore; now: () => string; newId: () => string}
const terminal = (run: AgentRun) => ['succeeded', 'failed', 'cancelled'].includes(run.status);
const copy = (run: AgentRun): AgentRun => JSON.parse(JSON.stringify(agentRunSchema.parse(run))) as AgentRun;

export function createRunService({store, now, newId}: RunDependencies) {
  function authorize(state: SpaceState, spaceId: string, actor: Actor, write = true) {
    if (!spaceStateSchema.safeParse(state).success) throw new CommandError('invalid_input', 'Invalid versioned space state');
    if (state.space.id !== spaceId || !state.members.some((member) => member.actorId === actor.id && member.canRead && (!write || member.canWrite)))
      throw new CommandError('forbidden', 'Space access is unavailable');
  }
  function find(state: SpaceState, runId: string, actor: Actor) {
    const run = state.runs.find((item) => item.id === runId && item.spaceId === state.space.id && item.actorId === actor.id && item.actorKind === actor.kind);
    if (!run) throw new CommandError('not_found', 'Run is unavailable');
    return run;
  }
  function move(run: AgentRun, status: RunStatus) {
    if (run.status === status) return;
    if (!runTransitions[run.status].includes(status)) throw new CommandError('invalid_state', 'Run state transition is unavailable');
    run.status = status; run.updatedAt = now(); run.seq += 1;
    run.events.push({schemaVersion: 1, runId: run.id, seq: run.seq, state: status, time: run.updatedAt});
  }
  function settle(state: SpaceState, run: AgentRun) {
    if (terminal(run) || !run.draftId) return;
    const draft = state.drafts.find((item) => item.id === run.draftId && item.spaceId === run.spaceId && item.actorId === run.actorId && item.actorKind === run.actorKind);
    if (!draft) throw new CommandError('not_found', 'Run draft is unavailable');
    const receipt = state.receipts.find((item) => item.commandId === run.commandId && item.spaceId === run.spaceId && item.actorId === run.actorId && item.actorKind === run.actorKind && item.payloadHash === draft.payloadHash);
    if (draft.status === 'applied' && receipt) move(run, 'succeeded');
    else if (draft.status === 'rejected' || draft.status === 'cancelled') move(run, 'cancelled');
  }
  return {
    async start(spaceId: string, actor: Actor): Promise<AgentRun> {
      return store.transaction(spaceId, async (state) => {
        authorize(state, spaceId, actor);
        const id = newId();
        if (!id || [...state.goals, ...state.projects, ...state.tasks, ...state.drafts, ...state.approvals, ...state.runs].some((item) => item.id === id) || state.events.some((item) => item.eventId === id))
          throw new CommandError('id_collision', 'Generated identifier is already in use');
        const timestamp = now();
        const run: AgentRun = {id, spaceId, actorId: actor.id, actorKind: actor.kind, executor: 'mock', policyVersion: '1', schemaVersion: 1,
          modelVersion: 'deterministic-mock-v1', promptVersion: 'mock-plan-v1', dataCutoff: timestamp,
          status: 'running', createdAt: timestamp, updatedAt: timestamp, seq: 1, events: [{schemaVersion: 1, runId: id, seq: 1, state: 'running', time: timestamp}]};
        state.runs.push(run); return copy(run);
      });
    },
    async attachDraft(spaceId: string, actor: Actor, runId: string, draftId: string): Promise<AgentRun> {
      return store.transaction(spaceId, async (state) => {
        authorize(state, spaceId, actor); const run = find(state, runId, actor);
        if (run.draftId === draftId) return copy(run);
        if (run.status !== 'running' || run.draftId) throw new CommandError('invalid_state', 'Run is not awaiting a provider draft');
        const draft = state.drafts.find((item) => item.id === draftId && item.spaceId === spaceId && item.actorId === actor.id && item.actorKind === actor.kind);
        if (!draft) throw new CommandError('not_found', 'Draft is unavailable to this executor');
        if (draft.status !== 'draft' && draft.status !== 'approved') throw new CommandError('invalid_state', 'Draft is no longer pending');
        if (state.runs.some((item) => item.draftId === draftId)) throw new CommandError('invalid_state', 'Draft already belongs to a run');
        run.draftId = draftId; run.commandId = draft.command.commandId; move(run, 'awaiting_approval'); return copy(run);
      });
    },
    async settleDraft(spaceId: string, actor: Actor, draftId: string): Promise<AgentRun | null> {
      return store.transaction(spaceId, async (state) => {
        authorize(state, spaceId, actor);
        const run = state.runs.find((item) => item.draftId === draftId && item.spaceId === spaceId && item.actorId === actor.id && item.actorKind === actor.kind);
        if (!run) return null; settle(state, run); return copy(run);
      });
    },
    async cancel(spaceId: string, actor: Actor, runId: string): Promise<AgentRun> {
      return store.transaction(spaceId, async (state) => {
        authorize(state, spaceId, actor); const run = find(state, runId, actor);
        settle(state, run); if (terminal(run)) return copy(run);
        // Attached drafts must be rejected first through the shared command service.
        // This prevents a run-only cancellation from hiding a still-valid approval.
        if (run.draftId) throw new CommandError('invalid_state', 'Reject the pending draft before cancelling its run');
        move(run, 'cancelled'); return copy(run);
      });
    },
    async fail(spaceId: string, actor: Actor, runId: string, errorCode: string): Promise<AgentRun> {
      const parsed = runErrorCodeSchema.safeParse(errorCode);
      if (!parsed.success) throw new CommandError('invalid_input', 'Failure requires a bounded error code');
      return store.transaction(spaceId, async (state) => {
        authorize(state, spaceId, actor); const run = find(state, runId, actor);
        settle(state, run); if (terminal(run)) return copy(run);
        if (run.draftId) throw new CommandError('invalid_state', 'A pending draft must be resolved before recording a failure');
        run.errorCode = parsed.data; move(run, 'failed'); return copy(run);
      });
    },
    async recover(spaceId: string, actor: Actor): Promise<AgentRun[]> {
      return store.transaction(spaceId, async (state) => {
        authorize(state, spaceId, actor);
        const runs = state.runs.filter((run) => run.spaceId === spaceId && run.actorId === actor.id && run.actorKind === actor.kind);
        for (const run of runs) {
          if (run.status === 'queued' || run.status === 'running') move(run, 'interrupted');
          else if (run.status === 'awaiting_approval') settle(state, run);
        }
        return runs.map(copy);
      });
    },
    async replayEvents(spaceId: string, actor: Actor, runId: string, afterSeq = 0): Promise<RunEventReplay> {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new CommandError('invalid_input', 'Replay cursor must be a nonnegative integer');
      return store.read(spaceId, (state) => {
        authorize(state, spaceId, actor, false); const run = copy(find(state, runId, actor));
        if (afterSeq > run.seq) throw new CommandError('invalid_input', 'Replay cursor is ahead of this run');
        return runEventReplaySchema.parse({schemaVersion: 1, runId, afterSeq, nextSeq: run.seq, events: run.events.filter((event) => event.seq > afterSeq)});
      });
    },
    async list(spaceId: string, actor: Actor): Promise<AgentRun[]> {
      return store.read(spaceId, (state) => {authorize(state, spaceId, actor, false);
        return state.runs.filter((run) => run.spaceId === spaceId && run.actorId === actor.id && run.actorKind === actor.kind).map(copy);});
    },
  };
}
export type RunService = ReturnType<typeof createRunService>;
