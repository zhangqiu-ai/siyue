import test from 'node:test';
import assert from 'node:assert/strict';
import { goalProgress, taskEditState } from '../src/space/goal-progress.ts';

const record = (id, overrides = {}) => ({ id, spaceId: 'space-a', title: 'Same title', status: 'active', version: 1, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z', ...overrides });
const task = (id, projectId, status = 'open', overrides = {}) => record(id, { projectId, status, ...overrides });
const plan = (overrides = {}) => ({ goals: [record('goal-a'), record('goal-b')], projects: [record('project-a', { goalId: 'goal-a' }), record('project-b', { goalId: 'goal-b' })], tasks: [], drafts: [], runs: [], ...overrides });

test('same-titled goals and projects keep their own task counts by ID', () => {
  const snapshot = plan({ tasks: [task('a-open', 'project-a'), task('a-done', 'project-a', 'done'), task('b-done', 'project-b', 'done')] });
  assert.deepEqual(goalProgress(snapshot, 'goal-a'), { tasks: snapshot.tasks.slice(0, 2), completed: 1, total: 2 });
  assert.deepEqual(goalProgress(snapshot, 'goal-b'), { tasks: snapshot.tasks.slice(2), completed: 1, total: 1 });
});

test('independent tasks and archived tasks or projects do not contribute', () => {
  const snapshot = plan({ projects: [record('project-a', { goalId: 'goal-a' }), record('archived-project', { goalId: 'goal-a', status: 'archived' }), record('independent-project')], tasks: [task('kept', 'project-a'), task('archived', 'project-a', 'archived'), task('former', 'archived-project', 'done'), task('independent', undefined, 'done'), task('unlinked', 'independent-project', 'done')] });
  assert.deepEqual(goalProgress(snapshot, 'goal-a'), { tasks: [snapshot.tasks[0]], completed: 0, total: 1 });
});

test('foreign tasks and foreign projects cannot inflate a local goal', () => {
  const snapshot = plan({ projects: [record('project-a', { goalId: 'goal-a' }), record('foreign-project', { goalId: 'goal-a', spaceId: 'space-b' })], tasks: [task('kept', 'project-a', 'done'), task('foreign-task', 'project-a', 'done', { spaceId: 'space-b' }), task('foreign-parent', 'foreign-project', 'done'), task('foreign-both', 'foreign-project', 'done', { spaceId: 'space-b' })] });
  assert.deepEqual(goalProgress(snapshot, 'goal-a'), { tasks: [snapshot.tasks[0]], completed: 1, total: 1 });
});

test('missing or archived goals return no tasks even when projects refer to them', () => {
  const snapshot = plan({ goals: [record('goal-a', { status: 'archived' })], tasks: [task('a', 'project-a', 'done'), task('b', 'project-b', 'done')] });
  for (const id of ['goal-a', 'goal-b', 'unknown']) assert.deepEqual(goalProgress(snapshot, id), { tasks: [], completed: 0, total: 0 });
});

test('all nonarchived projects contribute, task state determines progress, and input stays unchanged', () => {
  const snapshot = plan({ goals: [record('goal-a', { status: 'completed' })], projects: [record('project-a', { goalId: 'goal-a', status: 'completed' }), record('project-extra', { goalId: 'goal-a' })], tasks: [task('open', 'project-a'), task('done', 'project-extra', 'done')] });
  const before = structuredClone(snapshot);
  const result = goalProgress(snapshot, 'goal-a');
  assert.equal(result.completed, 1);
  assert.equal(result.total, 2);
  assert.deepEqual(result.tasks.map((item) => item.id), ['open', 'done']);
  assert.deepEqual(snapshot, before);
  result.tasks.pop();
  assert.equal(snapshot.tasks.length, 2);
});

test('an edited task moved to another goal remains available for comparison without changing the edit version', () => {
  const snapshot = plan({ tasks: [task('moved', 'project-b', 'open', { version: 3, title: 'Latest title' })] });
  const edit = { id: 'moved', version: 1, title: 'Unsaved title' };
  assert.deepEqual(goalProgress(snapshot, 'goal-a').tasks, []);
  assert.deepEqual(taskEditState(snapshot, edit), { task: snapshot.tasks[0], canEdit: true, changed: true });
  assert.deepEqual(edit, { id: 'moved', version: 1, title: 'Unsaved title' });
});

test('archived, missing or unavailable tasks cannot be submitted by the editor', () => {
  const snapshot = plan({ tasks: [task('archived', 'project-a', 'archived', { version: 2 })] });
  assert.deepEqual(taskEditState(snapshot, { id: 'archived', version: 1 }), { task: snapshot.tasks[0], canEdit: false, changed: true });
  assert.deepEqual(taskEditState(snapshot, { id: 'missing', version: 1 }), { task: undefined, canEdit: false, changed: false });
  assert.deepEqual(taskEditState(null, { id: 'archived', version: 1 }), { task: undefined, canEdit: false, changed: false });
});

test('an unchanged version remains editable without reporting a conflict', () => {
  const snapshot = plan({ tasks: [task('current', undefined, 'done', { version: 4 })] });
  assert.deepEqual(taskEditState(snapshot, { id: 'current', version: 4 }), { task: snapshot.tasks[0], canEdit: true, changed: false });
});
