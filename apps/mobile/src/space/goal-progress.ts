import type { PlanSnapshot } from '@siyue/adapters';

/** Project relationships are the only link between persisted goals and tasks. */
export function goalProgress(snapshot: PlanSnapshot, goalId: string): { tasks: PlanSnapshot['tasks']; completed: number; total: number } {
  const goal = snapshot.goals.find((item) => item.id === goalId);
  if (!goal || goal.status === 'archived') return { tasks: [], completed: 0, total: 0 };
  const projectIds = new Set(snapshot.projects
    .filter((item) => item.goalId === goal.id && item.spaceId === goal.spaceId && item.status !== 'archived')
    .map((item) => item.id));
  const tasks = snapshot.tasks.filter((item) => item.spaceId === goal.spaceId && item.status !== 'archived' && item.projectId !== undefined && projectIds.has(item.projectId));
  return { tasks, completed: tasks.filter((item) => item.status === 'done').length, total: tasks.length };
}

/** Keep editor recovery independent of the currently displayed goal's task list. */
export function taskEditState(snapshot: PlanSnapshot | null, edit: { id: string; version: number }): { task: PlanSnapshot['tasks'][number] | undefined; canEdit: boolean; changed: boolean } {
  const task = snapshot?.tasks.find((item) => item.id === edit.id);
  return { task, canEdit: !!task && task.status !== 'archived', changed: !!task && task.version !== edit.version };
}
