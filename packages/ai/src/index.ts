import { goalDraftSchema, type GoalDraft } from '@siyue/contracts';

export interface AgentRunContext {
  runId: string;
  spaceId: string;
  dataCutoff?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AgentExecutor {
  createGoalPlan(goal: string, context?: AgentRunContext): Promise<GoalDraft>;
}

export type AgentErrorCode = 'invalid_input' | 'cancelled' | 'timeout' | 'failed' | 'unsupported';

export class AgentExecutionError extends Error {
  constructor(readonly code: AgentErrorCode) {
    // Never include provider responses, prompts, or credentials in error messages.
    super(code);
    this.name = 'AgentExecutionError';
  }
}

export const mockCapabilities = Object.freeze({
  text: true,
  tools: false,
  structuredOutput: true,
  vision: false,
  ASR: false,
  TTS: false,
  realtime: false,
});

export function validateGoalInput(goal: unknown): string {
  if (typeof goal !== 'string' || goal.length > 160 || goal.trim().length === 0) {
    throw new AgentExecutionError('invalid_input');
  }
  return goal.trim();
}

/** Bound a draft-only operation, including adapters that ignore AbortSignal. */
export async function executeGoalPlan(
  executor: AgentExecutor,
  goal: string,
  context: AgentRunContext,
): Promise<GoalDraft> {
  const title = validateGoalInput(goal);
  const timeoutMs = context.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new AgentExecutionError('invalid_input');
  }
  if (context.signal?.aborted) throw new AgentExecutionError('cancelled');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  try {
    const stop = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(new AgentExecutionError('cancelled'));
        controller.abort();
      };
      context.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        reject(new AgentExecutionError('timeout'));
        controller.abort();
      }, timeoutMs);
    });
    const result = await Promise.race([
      stop,
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new AgentExecutionError('cancelled');
        return executor.createGoalPlan(title, { ...context, signal: controller.signal });
      }),
    ]);
    if (controller.signal.aborted) throw new AgentExecutionError('cancelled');
    const parsed = goalDraftSchema.safeParse(result);
    if (!parsed.success) throw new AgentExecutionError('failed');
    return parsed.data;
  } catch (error) {
    if (error instanceof AgentExecutionError) throw error;
    throw new AgentExecutionError('failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    context.signal?.removeEventListener('abort', onAbort);
  }
}

export interface MockExecutorOptions {
  delayMs?: number;
  failure?: 'failed' | 'unsupported';
}

/** Deterministic local drafts only: no network, credentials, or formal writes. */
export class MockAgentExecutor implements AgentExecutor {
  constructor(private readonly options: MockExecutorOptions = {}) {
    if (!Number.isInteger(options.delayMs ?? 0) || (options.delayMs ?? 0) < 0 || (options.delayMs ?? 0) > 30_000) {
      throw new AgentExecutionError('invalid_input');
    }
  }

  async createGoalPlan(goal: string, context?: AgentRunContext): Promise<GoalDraft> {
    return executeGoalPlan({
      createGoalPlan: async (title, boundedContext) => {
        if (this.options.delayMs) {
          await new Promise<void>((resolve, reject) => {
            const signal = boundedContext?.signal;
            const onAbort = () => {
              clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              reject(new AgentExecutionError('cancelled'));
            };
            const timer = setTimeout(() => {
              signal?.removeEventListener('abort', onAbort);
              resolve();
            }, this.options.delayMs);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
          });
        }
        if (this.options.failure) throw new AgentExecutionError(this.options.failure);
        return {
          title,
          rationale: 'Mock plan: preview only. It does not write formal domain records.',
          projectTitles: ['拆解目标并建立执行节奏'],
          taskTitles: ['定义第一步行动', '完成一次执行记录', '基于真实记录复盘'],
        };
      },
    }, goal, context ?? { runId: 'local-mock', spaceId: 'local' });
  }
}
