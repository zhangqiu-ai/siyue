import type { LocalClient } from '@siyue/adapters';
import { generateCompatiblePlan, PLAN_PROMPT_VERSION, PlanGenerationError, type PlanGenerationDependencies } from './compatible-plan.ts';

/** Keep the captured settings session alive through both generation and draft persistence. */
export async function proposePlan(
  goal: string,
  getClient: () => Promise<LocalClient>,
  dependencies: PlanGenerationDependencies,
  signal?: AbortSignal,
) {
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
    const client = await new Promise<LocalClient>((resolve, reject) => {
      const cancel = () => reject(new PlanGenerationError('cancelled'));
      controller.signal.addEventListener('abort', cancel, {once: true});
      // Consume late storage results or errors after cancellation without starting a run.
      Promise.resolve().then(() => { check(); return getClient(); })
        .then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancel));
      if (controller.signal.aborted) cancel();
    });
    check();
    const credentials = await new Promise<Awaited<ReturnType<typeof dependencies.getCredentials>>>((resolve, reject) => {
      const cancel = () => reject(new PlanGenerationError('cancelled'));
      controller.signal.addEventListener('abort', cancel, {once: true});
      Promise.resolve().then(() => { check(); return dependencies.getCredentials(); })
        .then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancel));
      if (controller.signal.aborted) cancel();
    });
    check();
    const capturedCredentials = {...credentials};
    return await client.propose(goal, controller.signal, {
      execution: {executor: 'compatible', modelVersion: capturedCredentials.model, promptVersion: PLAN_PROMPT_VERSION},
      propose: (input, requestSignal) => generateCompatiblePlan(input, {
        ...dependencies, getCredentials: async () => capturedCredentials, getSessionSignal: () => session,
      }, requestSignal),
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    session.removeEventListener('abort', abort);
    controller.abort();
  }
}
