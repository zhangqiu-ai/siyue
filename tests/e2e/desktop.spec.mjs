import { test, expect } from './desktop-fixture.mjs';

const labels = {
  zh: { manual: '手动创建', title: '目标标题', tasks: '任务 · 每行一个，最多 24 个', save: '创建可编辑草稿', rename: '改名', saveName: '保存名称', complete: '完成任务', undo: '撤销完成', archive: '归档', generate: '生成示例计划', input: '我的目标', reject: '拒绝草稿', confirm: '确认并正式保存', saveDraft: '保存草稿修改', continue: '继续', error: '内容格式不符合要求。请检查标题、项目与任务数量后重试。' },
  en: { manual: 'Create manually', title: 'Goal title', tasks: 'Tasks · One per line, up to 24', save: 'Create an editable draft', rename: 'Rename', saveName: 'Save name', complete: 'Complete task', undo: 'Undo completion', archive: 'Archive', generate: 'Generate sample plan', input: 'My goal', reject: 'Reject draft', confirm: 'Confirm and save records', saveDraft: 'Save draft changes', continue: 'Continue', error: 'Check the title, project count and task count, then try again.' },
};
const button = (page, name) => page.getByRole('button', { name, exact: true });
const row = (page, title) => page.locator('.record').filter({ has: page.locator('.record-title').getByText(title, { exact: true }) });
async function english(page) {
  await button(page, '设置').click();
  await button(page, 'English').click();
  await button(page, 'Close').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}

for (const locale of ['zh', 'en']) {
  const l = labels[locale];
  test.describe(locale, () => {
    test.beforeEach(async ({ desktop }) => { if (locale === 'en') await english(desktop.page); });

    test('manual create, rename, complete and archive survive restart', async ({ desktop }) => {
      let page = desktop.page;
      await button(page, l.manual).click();
      await page.getByLabel(l.title, { exact: true }).fill('E2E goal');
      await page.locator('#projects').fill('E2E project');
      await page.getByLabel(l.tasks, { exact: true }).fill('E2E task');
      await button(page, l.save).click();
      expect((await desktop.snapshot()).goals).toHaveLength(0);
      await button(page, l.confirm).click();
      await expect(row(page, 'E2E goal')).toBeVisible();
      const original = await desktop.snapshot();
      expect(original.goals).toHaveLength(1);
      expect(original.tasks).toHaveLength(1);
      await row(page, 'E2E goal').getByRole('button', { name: l.rename, exact: true }).click();
      await page.locator('.rename input').fill('E2E renamed goal');
      await button(page, l.saveName).click();
      await expect(row(page, 'E2E renamed goal')).toBeVisible();
      await row(page, 'E2E task').getByRole('button', { name: l.complete, exact: true }).click();
      await expect(button(page, l.undo)).toBeVisible();
      await desktop.restart(); page = desktop.page;
      await expect(row(page, 'E2E renamed goal')).toBeVisible();
      const saved = await desktop.snapshot();
      expect(saved.goals[0].id).toBe(original.goals[0].id);
      expect(saved.tasks[0]).toMatchObject({ id: original.tasks[0].id, status: 'done' });
      await row(page, 'E2E task').getByRole('button', { name: l.archive, exact: true }).click();
      await expect(row(page, 'E2E task')).toBeVisible();
      await expect(row(page, 'E2E task').locator('.record-status')).toHaveText(locale === 'zh' ? '已归档' : 'Archived');
      await expect(row(page, 'E2E task').getByRole('button')).toHaveCount(0);
      await desktop.restart(); page = desktop.page;
      await expect(row(page, 'E2E task')).toBeVisible();
      await expect(row(page, 'E2E task').locator('.record-status')).toHaveText(locale === 'zh' ? '已归档' : 'Archived');
      await expect(row(page, 'E2E task').getByRole('button')).toHaveCount(0);
      expect((await desktop.snapshot()).tasks[0]).toMatchObject({ id: original.tasks[0].id, status: 'archived' });
    });

    test('draft edits require saving; restart and rejection create no records', async ({ desktop }) => {
      let page = desktop.page;
      await page.getByLabel(l.input, { exact: true }).fill('E2E draft');
      await button(page, l.generate).click();
      await expect(button(page, l.confirm)).toBeEnabled();
      expect((await desktop.snapshot()).goals).toHaveLength(0);
      await page.getByLabel(l.title, { exact: true }).fill('E2E edited draft');
      await expect(button(page, l.confirm)).toBeDisabled();
      await button(page, l.saveDraft).click();
      await expect(button(page, l.confirm)).toBeEnabled();
      await desktop.restart(); page = desktop.page;
      await page.locator('.draft-item').filter({ hasText: 'E2E edited draft' }).click();
      await expect(page.getByLabel(l.title, { exact: true })).toHaveValue('E2E edited draft');
      await button(page, l.reject).click();
      await expect(button(page, l.confirm)).toHaveCount(0);
      const state = await desktop.snapshot();
      expect(state.drafts[0].status).toBe('rejected');
      expect(state.goals).toHaveLength(0);
      expect(state.projects).toHaveLength(0);
      expect(state.tasks).toHaveLength(0);
      await desktop.restart();
      expect((await desktop.snapshot()).goals).toHaveLength(0);
    });

    test('manual project is required and remains one editable name', async ({ desktop }) => {
      const page = desktop.page;
      await button(page, l.manual).click();
      await page.getByLabel(l.title, { exact: true }).fill('E2E required project');
      await page.getByLabel(l.tasks, { exact: true }).fill('E2E task');
      await expect(button(page, l.save)).toBeDisabled();
      await expect(page.locator('input#projects')).toBeVisible();
      await page.locator('#projects').fill('   ');
      await expect(button(page, l.save)).toBeDisabled();
      expect((await desktop.snapshot()).goals).toHaveLength(0);
      await page.locator('#projects').fill('E2E chosen project');
      await button(page, l.save).click();
      expect((await desktop.snapshot()).goals).toHaveLength(0);
      await button(page, l.confirm).click();
      await expect(row(page, 'E2E chosen project')).toBeVisible();
      const state = await desktop.snapshot();
      expect(state.projects).toHaveLength(1);
      expect(state.tasks[0].projectId).toBe(state.projects[0].id);
      expect(state.projects[0].goalId).toBe(state.goals[0].id);
    });

    test('manual draft survives restart and rejection writes no formal records', async ({ desktop }) => {
      let page = desktop.page;
      await button(page, l.manual).click();
      await page.getByLabel(l.title, { exact: true }).fill('E2E manual review');
      await page.locator('#projects').fill('E2E review project');
      await page.getByLabel(l.tasks, { exact: true }).fill('E2E review task');
      await button(page, l.save).click();
      await expect(button(page, l.confirm)).toBeEnabled();
      const created = await desktop.snapshot();
      expect(created.drafts).toHaveLength(1);
      expect(created.drafts[0].source).toBe('ui');
      expect(created.goals).toHaveLength(0);
      expect(created.projects).toHaveLength(0);
      expect(created.tasks).toHaveLength(0);
      await desktop.restart(); page = desktop.page;
      await page.locator('.draft-item').filter({ hasText: 'E2E manual review' }).click();
      await expect(page.locator('#projects')).toHaveValue('E2E review project');
      expect((await desktop.snapshot()).drafts[0].id).toBe(created.drafts[0].id);
      await button(page, l.reject).click();
      const rejected = await desktop.snapshot();
      expect(rejected.drafts[0].status).toBe('rejected');
      expect(rejected.goals).toHaveLength(0);
      expect(rejected.projects).toHaveLength(0);
      expect(rejected.tasks).toHaveLength(0);
    });

    test('older multi-project draft remains intact and cannot be confirmed', async ({ desktop }) => {
      let page = desktop.page;
      await page.getByLabel(l.input, { exact: true }).fill('E2E legacy draft');
      await button(page, l.generate).click();
      const original = (await desktop.snapshot()).drafts[0];
      // Seed an older-format draft only in this test's disposable SQLite via the real IPC.
      const reply = await page.evaluate(async ({ id, version, payload }) => window.siyueDesktop.invoke({
        requestId: crypto.randomUUID(), method: 'editDraft', args: [id, version, payload],
      }), { id: original.id, version: original.version, payload: { ...original.command.payload, projectTitles: ['Old first project', 'Old second project'] } });
      expect(reply.ok).toBe(true);
      await desktop.restart(); page = desktop.page;
      await page.locator('.draft-item').first().click();
      await expect(page.locator('#projects')).toHaveValue('Old first project\nOld second project');
      await expect(page.locator('#projects')).toHaveJSProperty('readOnly', true);
      await expect(button(page, l.confirm)).toBeDisabled();
      await expect(button(page, l.saveDraft)).toBeDisabled();
      const preserved = await desktop.snapshot();
      expect(preserved.drafts[0].command.payload.projectTitles).toEqual(['Old first project', 'Old second project']);
      expect(preserved.goals).toHaveLength(0);
      expect(preserved.projects).toHaveLength(0);
      expect(preserved.tasks).toHaveLength(0);
      await button(page, l.reject).click();
      expect((await desktop.snapshot()).drafts[0].status).toBe('rejected');
    });

    test('confirmed edited project owns tasks and survives restart', async ({ desktop }) => {
      let page = desktop.page;
      await page.getByLabel(l.input, { exact: true }).fill('E2E linked plan');
      await button(page, l.generate).click();
      await page.getByLabel(l.title, { exact: true }).fill('E2E confirmed goal');
      await page.locator('#projects').fill('');
      await expect(button(page, l.saveDraft)).toBeDisabled();
      await expect(button(page, l.confirm)).toBeDisabled();
      await page.locator('#projects').fill('E2E renamed project');
      await page.getByLabel(l.tasks, { exact: true }).fill('E2E first task\nE2E second task');
      await expect(button(page, l.confirm)).toBeDisabled();
      await button(page, l.saveDraft).click();
      const draftOnly = await desktop.snapshot();
      expect(draftOnly.goals).toHaveLength(0);
      expect(draftOnly.projects).toHaveLength(0);
      expect(draftOnly.tasks).toHaveLength(0);
      await button(page, l.confirm).click();
      await expect(row(page, 'E2E renamed project')).toBeVisible();
      const confirmed = await desktop.snapshot();
      expect(confirmed.goals).toHaveLength(1);
      expect(confirmed.projects).toHaveLength(1);
      expect(confirmed.tasks).toHaveLength(2);
      expect(confirmed.projects[0]).toMatchObject({ title: 'E2E renamed project', goalId: confirmed.goals[0].id });
      expect(confirmed.tasks.map(task => task.title).sort()).toEqual(['E2E first task', 'E2E second task']);
      for (const task of confirmed.tasks) expect(task.projectId).toBe(confirmed.projects[0].id);
      expect(confirmed.drafts[0].status).toBe('applied');
      await desktop.restart(); page = desktop.page;
      await expect(row(page, 'E2E renamed project')).toBeVisible();
      const restored = await desktop.snapshot();
      expect(restored.goals).toEqual(confirmed.goals);
      expect(restored.projects).toEqual(confirmed.projects);
      expect(restored.tasks).toEqual(confirmed.tasks);
      await expect(button(page, l.confirm)).toHaveCount(0);
    });

    test('invalid plan preserves input and can be corrected without duplicate writes', async ({ desktop }) => {
      const page = desktop.page;
      await button(page, l.manual).click();
      await page.getByLabel(l.title, { exact: true }).fill('E2E recover input');
      await page.locator('#projects').fill('E2E recovery project');
      await page.getByLabel(l.tasks, { exact: true }).fill(Array.from({ length: 25 }, (_, i) => `Task ${i}`).join('\n'));
      await button(page, l.save).click();
      await expect(page.getByRole('alert')).toContainText(l.error);
      await expect(page.getByLabel(l.title, { exact: true })).toHaveValue('E2E recover input');
      expect((await desktop.snapshot()).goals).toHaveLength(0);
      await page.getByLabel(l.tasks, { exact: true }).fill('One valid task');
      await button(page, l.save).click();
      expect((await desktop.snapshot()).goals).toHaveLength(0);
      await button(page, l.confirm).click();
      await expect(row(page, 'E2E recover input')).toBeVisible();
      expect((await desktop.snapshot()).goals).toHaveLength(1);
      expect((await desktop.snapshot()).tasks).toHaveLength(1);
    });
  });
}

test('language preference survives restart; Escape returns focus', async ({ desktop }) => {
  await english(desktop.page);
  await button(desktop.page, 'Settings').click();
  await desktop.page.keyboard.press('Escape');
  await expect(desktop.page.getByRole('dialog')).not.toBeVisible();
  await expect(button(desktop.page, 'Settings')).toBeFocused();
  await desktop.restart();
  await expect(desktop.page.getByRole('heading', { name: 'Goals and actions', exact: true })).toBeVisible();
  await expect(desktop.page.locator('html')).toHaveAttribute('lang', 'en');
});
