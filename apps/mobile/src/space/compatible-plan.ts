import { goalDraftSchema, type GoalDraft } from '@siyue/contracts';
import { streamCompatibleReply, type CompatibleConfig } from '../chat/compatible-transport.ts';

export class PlanGenerationError extends Error {
  readonly code: 'invalid_input' | 'invalid_output' | 'cancelled';
  constructor(code: 'invalid_input' | 'invalid_output' | 'cancelled') {
    super(code);
    this.code = code;
    this.name = 'PlanGenerationError';
  }
}

export interface PlanGenerationDependencies {
  getCredentials: () => Promise<CompatibleConfig>;
  getSessionSignal: () => AbortSignal;
  isActive: () => boolean;
  fetcher: typeof fetch;
}

export const PLAN_PROMPT_VERSION = 'compatible-single-project-v2';

const instruction = 'Return only a JSON object describing a draft plan, never execute actions. '
  + 'Use the language of the user goal. Fields: title (1-160 characters), rationale (optional, at most 1000 characters), '
  + 'projectTitles (an array containing exactly one string, 1-160 characters), taskTitles (an array of up to 24 strings, each 1-240 characters). '
  + 'All tasks belong to that project. No markdown fences, extra fields, tools, or approval claims.';

/** Explicit draft generation only. The caller owns presentation and subsequent approval. */
export async function generateCompatiblePlan(
  goal: string,
  dependencies: PlanGenerationDependencies,
  signal?: AbortSignal,
): Promise<GoalDraft> {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 160) throw new PlanGenerationError('invalid_input');
  const session = dependencies.getSessionSignal();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const check = () => {
    if (signal?.aborted || session.aborted || controller.signal.aborted || !dependencies.isActive()) {
      controller.abort();
      throw new PlanGenerationError('cancelled');
    }
  };
  signal?.addEventListener('abort', abort, { once: true });
  session.addEventListener('abort', abort, { once: true });
  try {
    check();
    const credentials = await new Promise<CompatibleConfig>((resolve, reject) => {
      const cancel = () => reject(new PlanGenerationError('cancelled'));
      controller.signal.addEventListener('abort', cancel, { once: true });
      // Consume late credential failures even when cancellation wins the race.
      Promise.resolve().then(() => {
        check();
        return dependencies.getCredentials();
      }).then(resolve, reject).finally(() => {
        controller.signal.removeEventListener('abort', cancel);
      });
      if (controller.signal.aborted) cancel();
    });
    check();
    let text = '';
    for await (const value of streamCompatibleReply(credentials, [
      { role: 'system', content: instruction },
      { role: 'user', content: goal.trim() },
    ], controller.signal, dependencies.fetcher)) {
      check();
      text = value;
    }
    // Transport cancellation may finish normally; partial JSON must never pass.
    check();
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw Object.assign(new PlanGenerationError('invalid_output'), {reason: 'json'}); }
    const parsed = goalDraftSchema.safeParse(raw);
    if (!parsed.success) throw Object.assign(new PlanGenerationError('invalid_output'), {reason: 'schema'});
    if (parsed.data.projectTitles.length !== 1) throw Object.assign(new PlanGenerationError('invalid_output'), {reason: 'project_count'});
    check();
    return parsed.data;
  } catch (error) {
    check();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    session.removeEventListener('abort', abort);
    controller.abort();
  }
}
