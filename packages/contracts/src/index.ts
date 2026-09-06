import { z } from 'zod';

export const schemaVersion = 1 as const;
const id = z.string().min(1).max(200);
const title = z.string().trim().min(1).max(160);
const taskTitle = z.string().trim().min(1).max(240);
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
const instant = z.string().datetime();
const version = z.number().int().positive();
export const commandEnvelopeSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  commandId: z.string().min(8).max(200),
  spaceId: id,
  issuedAt: instant,
}).strict();

export const goalDraftSchema = z.object({
  title,
  rationale: z.string().trim().max(1000).optional(),
  projectTitles: z.array(title).max(8).default([]),
  taskTitles: z.array(taskTitle).max(24).default([]),
}).strict();

const entityBase = { id, spaceId: id, version, createdAt: instant, updatedAt: instant };
export const personalSpaceSchema = z.object({ id, name: title }).strict();
export const goalSchema = z.object({ ...entityBase, title,
  status: z.enum(['active', 'completed', 'archived']), rationale: z.string().trim().max(1000).optional(), targetDate: localDateSchema.optional(),
}).strict();
export const projectSchema = z.object({ ...entityBase, title, goalId: id.optional(),
  status: z.enum(['active', 'completed', 'archived']),
}).strict();
export const taskSchema = z.object({ ...entityBase, title: taskTitle, projectId: id.optional(),
  status: z.enum(['open', 'done', 'archived']), dueLocalDate: localDateSchema.optional(), dueAt: instant.optional(),
}).strict();

const goalPatch = z.object({title: title.optional(), rationale: z.string().trim().max(1000).nullable().optional(), status: goalSchema.shape.status.optional(), targetDate: localDateSchema.nullable().optional()}).strict();
const projectPatch = z.object({title: title.optional(), status: projectSchema.shape.status.optional(), goalId: id.nullable().optional()}).strict();
const taskPatch = z.object({title: taskTitle.optional(), status: taskSchema.shape.status.optional(), projectId: id.nullable().optional(), dueLocalDate: localDateSchema.nullable().optional(), dueAt: instant.nullable().optional()}).strict();
const nonempty = (patch: object) => Object.values(patch).some((value) => value !== undefined);
const base = commandEnvelopeSchema.shape;
export const businessCommandSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('plan.create'), payload: goalDraftSchema }).strict(),
  z.object({ ...base, kind: z.literal('project.create'), payload: z.object({title, goalId: id.optional()}).strict() }).strict(),
  z.object({ ...base, kind: z.literal('task.create'), payload: z.object({title: taskTitle, projectId: id.optional(), dueLocalDate: localDateSchema.optional(), dueAt: instant.optional()}).strict() }).strict(),
  z.object({ ...base, kind: z.literal('goal.update'), entityId: id, expectedVersion: version, patch: goalPatch.refine(nonempty, 'Empty patch') }).strict(),
  z.object({ ...base, kind: z.literal('project.update'), entityId: id, expectedVersion: version, patch: projectPatch.refine(nonempty, 'Empty patch') }).strict(),
  z.object({ ...base, kind: z.literal('task.update'), entityId: id, expectedVersion: version, patch: taskPatch.refine(nonempty, 'Empty patch') }).strict(),
]);

export const actionDraftSchema = z.object({
  id, schemaVersion: z.literal(schemaVersion), spaceId: id, actorId: id, actorKind: z.enum(['user', 'ai']),
  source: z.enum(['ui', 'ai']), command: businessCommandSchema,
  payloadHash: z.string().min(1), version,
  status: z.enum(['draft', 'approved', 'rejected', 'expired', 'applied', 'cancelled']),
  expiresAt: instant, createdAt: instant, updatedAt: instant,
}).strict().refine((draft) => draft.command.spaceId === draft.spaceId, 'Cross-space draft');

export const entityRefSchema = z.object({kind: z.enum(['goal', 'project', 'task']), id, version}).strict();
export const commandReceiptSchema = z.object({
  schemaVersion: z.literal(schemaVersion), commandId: id, spaceId: id, actorId: id, actorKind: z.enum(['user', 'ai']),
  payloadHash: z.string().min(1), status: z.literal('applied'),
  result: z.object({entities: z.array(entityRefSchema).min(1)}).strict(), appliedAt: instant,
}).strict();
export const approvalSchema = z.object({
  id, draftId: id, spaceId: id, actorId: id, actorKind: z.enum(['user', 'ai']), approvedBy: id,
  commandId: id, commandKind: z.enum(['plan.create', 'project.create', 'task.create', 'goal.update', 'project.update', 'task.update']),
  payloadHash: z.string().min(1), draftVersion: version, baseVersions: z.array(entityRefSchema),
  status: z.enum(['active', 'revoked', 'consumed']), expiresAt: instant, createdAt: instant,
}).strict();
export const activityEventSchema = z.object({
  eventId: id, eventType: z.string().min(1), schemaVersion: z.literal(schemaVersion), spaceId: id,
  commandId: id, actorId: id, actorType: z.enum(['user', 'ai']), occurredAt: instant,
  entities: z.array(entityRefSchema),
}).strict();
export const runStatusSchema = z.enum(['queued', 'running', 'awaiting_approval', 'interrupted', 'succeeded', 'failed', 'cancelled']);
export const runErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const runTransitions: Record<z.infer<typeof runStatusSchema>, readonly z.infer<typeof runStatusSchema>[]> = {
  queued: ['running', 'interrupted', 'cancelled', 'failed'], running: ['awaiting_approval', 'interrupted', 'cancelled', 'failed'],
  awaiting_approval: ['succeeded', 'cancelled'], interrupted: ['cancelled'], succeeded: [], failed: [], cancelled: [],
};
export const agentRunEventSchema = z.object({
  schemaVersion: z.literal(schemaVersion), runId: id,
  seq: z.number().int().positive(), state: runStatusSchema, time: instant,
}).strict();
// Compatibility is scoped to a persisted parent run. Standalone events always
// require explicit version and run identity; supplied invalid values never default.
const persistedRunEventSchema = agentRunEventSchema.extend({
  schemaVersion: z.literal(schemaVersion).default(schemaVersion), runId: id.optional(),
});
export const agentRunSchema = z.object({
  id, spaceId: id, actorId: id, actorKind: z.enum(['user', 'ai']),
  executor: z.literal('mock'), policyVersion: z.literal('1'), schemaVersion: z.literal(schemaVersion),
  modelVersion: z.literal('deterministic-mock-v1').default('deterministic-mock-v1'),
  promptVersion: z.literal('mock-plan-v1').default('mock-plan-v1'),
  dataCutoff: instant.nullable().default(null),
  status: runStatusSchema, createdAt: instant, updatedAt: instant,
  seq: z.number().int().positive(),
  events: z.array(persistedRunEventSchema).min(1),
  draftId: id.optional(), commandId: id.optional(), errorCode: runErrorCodeSchema.optional(),
}).strict().superRefine((run, ctx) => {
  if (run.events.some((event) => event.runId !== undefined && event.runId !== run.id))
    ctx.addIssue({code: 'custom', message: 'Run event belongs to another run'});
  const first = run.events[0];
  if (!first || !['queued', 'running'].includes(first.state) || first.time !== run.createdAt || run.events.some((event, index) => index > 0 && !runTransitions[run.events[index - 1]!.state].includes(event.state)))
    ctx.addIssue({code: 'custom', message: 'Run event history contains an invalid transition'});
  if (run.seq !== run.events.length || run.events.some((event, index) => event.seq !== index + 1) || run.events.at(-1)?.state !== run.status || run.events.at(-1)?.time !== run.updatedAt)
    ctx.addIssue({code: 'custom', message: 'Run events must be contiguous and match current state'});
  if ((run.draftId === undefined) !== (run.commandId === undefined)) ctx.addIssue({code: 'custom', message: 'Run draft and command references must be paired'});
  if ((run.status === 'awaiting_approval' || run.status === 'succeeded') && !run.draftId) ctx.addIssue({code: 'custom', message: 'Run state requires a draft'});
  if (run.status === 'failed' && !run.errorCode) ctx.addIssue({code: 'custom', message: 'Failed run requires an error code'});
}).transform((run) => ({...run, events: run.events.map((event) => ({...event, runId: event.runId ?? run.id}))}));
export const runEventReplaySchema = z.object({
  schemaVersion: z.literal(schemaVersion), runId: id,
  afterSeq: z.number().int().nonnegative(), nextSeq: z.number().int().nonnegative(),
  events: z.array(agentRunEventSchema),
}).strict().superRefine((replay, ctx) => {
  if (replay.events.some((event, index) => event.runId !== replay.runId || event.seq !== replay.afterSeq + index + 1) || replay.nextSeq !== replay.afterSeq + replay.events.length)
    ctx.addIssue({code: 'custom', message: 'Replay events must match the run and cursor sequence'});
});
export const planViewSchema = z.object({
  goals: z.array(goalSchema), projects: z.array(projectSchema), tasks: z.array(taskSchema), drafts: z.array(actionDraftSchema),
}).strict();
export const spaceStateSchema = z.object({
  schemaVersion: z.literal(schemaVersion), space: personalSpaceSchema,
  members: z.array(z.object({actorId: id, canWrite: z.boolean(), canRead: z.boolean()}).strict()),
  goals: z.array(goalSchema), projects: z.array(projectSchema), tasks: z.array(taskSchema),
  drafts: z.array(actionDraftSchema), approvals: z.array(approvalSchema),
  receipts: z.array(commandReceiptSchema), events: z.array(activityEventSchema), runs: z.array(agentRunSchema).default([]),
}).strict().superRefine((state, ctx) => {
  const issue = (message: string) => ctx.addIssue({code: 'custom', message});
  if (new Set(state.members.map((member) => member.actorId)).size !== state.members.length) issue('Duplicate space member');
  if (new Set(state.drafts.map((draft) => draft.command.commandId)).size !== state.drafts.length) issue('Duplicate draft command');
  const records = [...state.goals, ...state.projects, ...state.tasks, ...state.drafts, ...state.approvals, ...state.runs];
  const allScoped = [...records, ...state.receipts, ...state.events];
  if (allScoped.some((item) => item.spaceId !== state.space.id)) ctx.addIssue({code: 'custom', message: 'Cross-space persisted record'});
  const ids = [...records.map((item) => item.id), ...state.events.map((item) => item.eventId)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({code: 'custom', message: 'Duplicate object identifier'});
  if (new Set(state.receipts.map((item) => item.commandId)).size !== state.receipts.length) ctx.addIssue({code: 'custom', message: 'Duplicate command receipt'});
  if (state.projects.some((project) => project.goalId && !state.goals.some((goal) => goal.id === project.goalId)) ||
      state.tasks.some((task) => task.projectId && !state.projects.some((project) => project.id === task.projectId)))
    ctx.addIssue({code: 'custom', message: 'Missing referenced record'});
  for (const approval of state.approvals) {
    const draft = state.drafts.find((item) => item.id === approval.draftId);
    if (!draft || approval.actorId !== draft.actorId || approval.actorKind !== draft.actorKind || approval.commandId !== draft.command.commandId) {
      issue('Approval references a missing or different draft'); continue;
    }
    if (approval.status === 'active' && (draft.status !== 'approved' || approval.draftVersion !== draft.version || approval.payloadHash !== draft.payloadHash || approval.commandKind !== draft.command.kind)) issue('Active approval does not match draft');
    if (approval.status === 'consumed' && draft.status !== 'applied') issue('Consumed approval has no applied draft');
  }
  for (const draft of state.drafts) {
    const active = state.approvals.filter((approval) => approval.draftId === draft.id && approval.status === 'active');
    if ((draft.status === 'approved' && active.length !== 1) || (draft.status !== 'approved' && active.length !== 0)) issue('Draft has inconsistent active approvals');
    const receipt = state.receipts.find((item) => item.commandId === draft.command.commandId);
    if (draft.status === 'applied' && (!receipt || receipt.actorId !== draft.actorId || receipt.actorKind !== draft.actorKind || receipt.payloadHash !== draft.payloadHash)) issue('Applied draft has no matching receipt');
  }
  const refsEqual = (left: {kind: string; id: string; version: number}[], right: {kind: string; id: string; version: number}[]) => left.length === right.length && left.every((ref, index) => {
    const other = right[index]; return other?.kind === ref.kind && other.id === ref.id && other.version === ref.version;
  });
  for (const receipt of state.receipts) {
    const events = state.events.filter((event) => event.commandId === receipt.commandId);
    if (events.length !== 1 || events[0]?.actorId !== receipt.actorId || events[0]?.actorType !== receipt.actorKind || !refsEqual(events[0]?.entities ?? [], receipt.result.entities)) issue('Receipt must have exactly one matching activity event');
    for (const ref of receipt.result.entities) {
      const records = ref.kind === 'goal' ? state.goals : ref.kind === 'project' ? state.projects : state.tasks;
      if (!records.some((record) => record.id === ref.id && record.version >= ref.version)) issue('Receipt references a missing record or impossible version');
    }
  }
  if (state.events.some((event) => !state.receipts.some((receipt) => receipt.commandId === event.commandId))) issue('Activity event has no command receipt');
  const runDraftIds = state.runs.flatMap((run) => run.draftId ? [run.draftId] : []);
  if (new Set(runDraftIds).size !== runDraftIds.length) issue('Draft belongs to more than one run');
  for (const run of state.runs) {
    if (!run.draftId) continue;
    const draft = state.drafts.find((item) => item.id === run.draftId);
    if (!draft || draft.actorId !== run.actorId || draft.actorKind !== run.actorKind || draft.command.commandId !== run.commandId) {
      issue('Run references a missing or different draft'); continue;
    }
    if (run.status === 'succeeded') {
      const receipt = state.receipts.find((item) => item.commandId === run.commandId && item.actorId === run.actorId && item.actorKind === run.actorKind && item.payloadHash === draft.payloadHash);
      if (draft.status !== 'applied' || !receipt) issue('Successful run requires an applied draft and formal receipt');
    }
  }

});

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type GoalDraft = z.infer<typeof goalDraftSchema>;
export type BusinessCommand = z.infer<typeof businessCommandSchema>;
export type PersonalSpace = z.infer<typeof personalSpaceSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export type ActionDraft = z.infer<typeof actionDraftSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type SpaceState = z.infer<typeof spaceStateSchema>;
export type EntityRef = z.infer<typeof entityRefSchema>;

export type AgentRun = z.infer<typeof agentRunSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;

export type AgentRunEvent = z.infer<typeof agentRunEventSchema>;
export type RunEventReplay = z.infer<typeof runEventReplaySchema>;
