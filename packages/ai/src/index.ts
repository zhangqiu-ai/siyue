import type { GoalDraft } from '@siyue/contracts';

export interface AgentRunContext {
  runId: string;
  spaceId: string;
  dataCutoff?: string;
}

export interface AgentExecutor {
  createGoalPlan(goal: string, context?: AgentRunContext): Promise<GoalDraft>;
}

/**
 * Deterministic first-slice executor. It proves the draft/approval boundary
 * before real provider credentials are introduced.
 */
export class MockAgentExecutor implements AgentExecutor {
  async createGoalPlan(goal: string): Promise<GoalDraft> {
    const title = goal.trim() || '建立一个可执行的成长目标';
    return {
      title,
      rationale: 'Mock plan: preview only. It does not write formal domain records.',
      projectTitles: ['拆解目标并建立执行节奏'],
      taskTitles: ['定义第一步行动', '完成一次执行记录', '基于真实记录复盘'],
    };
  }
}
