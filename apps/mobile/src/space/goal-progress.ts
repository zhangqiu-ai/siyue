import type { PlanSnapshot } from '@siyue/adapters';
import type { Task } from '@siyue/contracts';

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

/** Active task collections per goal, using the same project link as goalProgress. */
export function goalTaskIds(snapshot: PlanSnapshot): Map<string, Set<string>> {
  const projects = new Map<string, string>();
  for (const project of snapshot.projects) {
    if (project.status === 'archived' || !project.goalId) continue;
    projects.set(project.id, project.goalId);
  }
  const byGoal = new Map<string, Set<string>>();
  for (const task of snapshot.tasks) {
    if (task.status === 'archived' || !task.projectId) continue;
    const goalId = projects.get(task.projectId);
    if (!goalId) continue;
    const goal = snapshot.goals.find((item) => item.id === goalId);
    if (!goal || goal.status === 'archived' || goal.spaceId !== task.spaceId) continue;
    const ids = byGoal.get(goalId) ?? new Set<string>();
    ids.add(task.id);
    byGoal.set(goalId, ids);
  }
  return byGoal;
}

/** The first task that is still open, in the order the list shows them. */
export function nextOpenTask(tasks: Task[]): Task | undefined {
  return tasks.find((item) => item.status !== 'done');
}

/** Today's tasks across the space, with the goal each one belongs to.
 * Completed tasks stay in the list so a check made on the home screen remains visible. */
export function todayTasks(snapshot: PlanSnapshot, today: string): { task: Task; goal: PlanSnapshot['goals'][number] }[] {
  if (!today) return [];
  const byGoal = goalTaskIds(snapshot);
  const result: { task: Task; goal: PlanSnapshot['goals'][number] }[] = [];
  for (const goal of snapshot.goals) {
    if (goal.status === 'archived') continue;
    const ids = byGoal.get(goal.id);
    if (!ids) continue;
    for (const task of snapshot.tasks) {
      if (!ids.has(task.id) || task.dueLocalDate !== today) continue;
      result.push({ task, goal });
    }
  }
  return result;
}

/** Keep editor recovery independent of the currently displayed goal's task list. */
export function taskEditState(snapshot: PlanSnapshot | null, edit: { id: string; version: number }): { task: PlanSnapshot['tasks'][number] | undefined; canEdit: boolean; changed: boolean } {
  const task = snapshot?.tasks.find((item) => item.id === edit.id);
  return { task, canEdit: !!task && task.status !== 'archived', changed: !!task && task.version !== edit.version };
}
