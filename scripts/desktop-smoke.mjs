import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'apps/desktop/package.json'));
const executablePath = require('electron');
const dataDir = await mkdtemp(path.join(tmpdir(), 'siyue-desktop-smoke-'));
const output = path.join(root, 'artifacts/m1');
await mkdir(output, { recursive: true });
const checks = [];
const errors = [];
let runtime;
let application;
async function start() {
  application = await _electron.launch({
    executablePath, args: [path.join(root, 'apps/desktop')], cwd: root,
    env: { ...process.env, SIYUE_DATA_DIR: dataDir, SIYUE_RENDERER_URL: '' },
    chromiumSandbox: true, timeout: 30_000,
  });
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByText('本机空间 · 离线可用', { exact: true }).waitFor();
  return page;
}
async function read(page) {
  const reply = await page.evaluate(() => window.siyueDesktop.invoke({ requestId: crypto.randomUUID(), method: 'snapshot', args: [] }));
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}
try {
  let page = await start();
  runtime = await application.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { versions: process.versions, platform: process.platform, arch: process.arch,
      security: { contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration } };
  });
  assert.deepEqual(runtime.security, { contextIsolation: true, sandbox: true, nodeIntegration: false });
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  checks.push('real Electron main/preload/renderer with sandbox and no renderer Node access');

  await page.getByLabel('我的目标', { exact: true }).fill('每天阅读二十分钟');
  await page.getByRole('button', { name: '生成示例计划', exact: true }).click();
  await page.getByRole('button', { name: '确认并正式保存', exact: true }).waitFor();
  assert.equal((await read(page)).goals.length, 0);
  assert.equal((await read(page)).runs.at(-1).status, 'awaiting_approval');
  checks.push('unconfirmed draft persists without formal objects');
  await page.getByLabel('目标标题', { exact: true }).fill('每天阅读十五分钟');
  await page.getByLabel('为什么想做（选填）', { exact: true }).fill('用小步建立阅读习惯');
  await page.getByLabel('任务 · 每行一个，最多 24 个', { exact: true }).fill('挑选一本书\n完成十五分钟阅读');
  assert.equal(await page.getByRole('button', { name: '确认并正式保存', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '保存草稿修改', exact: true }).click();
  await page.getByText('草稿修改已保存。请检查后明确确认。', { exact: true }).waitFor();
  // Close before approval: recovery must come from SQLite rather than React state.
  await application.close(); application = undefined;
  page = await start();
  await page.getByRole('button', { name: '每天阅读十五分钟 继续 →' }).click();
  await page.getByRole('button', { name: '确认并正式保存', exact: true }).click();
  await page.getByText('已保存到本机 · 4 条正式记录。', { exact: true }).waitFor();
  let state = await read(page);
  assert.equal(state.goals.length, 1); assert.equal(state.projects.length, 1); assert.equal(state.tasks.length, 2);
  assert.equal(state.goals[0].rationale, '用小步建立阅读习惯');
  assert.equal(state.runs.at(-1).status, 'succeeded');
  assert.equal(state.tasks[0].projectId, state.projects[0].id);
  checks.push('edited draft survives full process restart and confirms actual related records');

  await page.getByRole('button', { name: '完成任务', exact: true }).first().click();
  await page.getByRole('button', { name: '撤销完成', exact: true }).waitFor();
  const firstId = (await read(page)).tasks.find((item) => item.status === 'done').id;
  await page.screenshot({ path: path.join(output, 'desktop-goal-loop.png'), fullPage: true });
  await application.close(); application = undefined;
  page = await start();
  state = await read(page);
  assert.equal(state.goals.length, 1);
  assert.equal(state.tasks.find((item) => item.id === firstId).status, 'done');
  checks.push('formal records and completed task survive full process restart');

  await page.getByLabel('我的目标', { exact: true }).fill('这份计划需要拒绝');
  await page.getByRole('button', { name: '生成示例计划', exact: true }).click();
  await page.getByRole('button', { name: '拒绝草稿', exact: true }).click();
  await page.getByText('草稿已拒绝，没有创建正式目标。编辑内容保留，可手动保存。', { exact: true }).waitFor();
  assert.equal((await read(page)).goals.length, 1);
  checks.push('UI rejection creates no formal records');
  await page.getByRole('button', { name: '收起编辑（保留输入）', exact: true }).click();
  await page.getByRole('button', { name: '手动创建', exact: true }).click();
  await page.getByLabel('目标标题', { exact: true }).fill('离线手动目标');
  await page.getByRole('button', { name: '确认保存手动计划', exact: true }).click();
  await page.getByText('已保存到本机 · 1 条正式记录。', { exact: true }).waitFor();
  assert.equal((await read(page)).goals.length, 2);
  checks.push('manual creation works with no provider or server');

  // Model a stop after the formal commit but before removing its pending identity.
  // Exercise the real renderer journal and IPC, then restart the entire application.
  await page.getByRole('button', { name: '手动创建', exact: true }).click();
  await page.getByLabel('目标标题', { exact: true }).fill('恢复测试目标');
  await page.evaluate(() => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith('siyue.pending-command.v1.')) throw new Error('simulated interruption after commit');
      return remove.call(this, key);
    };
  });
  await page.getByRole('button', { name: '确认保存手动计划', exact: true }).click();
  await page.getByText('操作未能确认完成', { exact: false }).waitFor();
  assert.equal((await read(page)).goals.length, 3);
  const recoveredGoalId = (await read(page)).goals.find((item) => item.title === '恢复测试目标').id;
  await application.close(); application = undefined;
  page = await start();
  await page.getByRole('button', { name: '手动创建', exact: true }).click();
  await page.getByLabel('目标标题', { exact: true }).fill('恢复测试目标');
  await page.getByRole('button', { name: '确认保存手动计划', exact: true }).click();
  await page.getByText('已保存到本机 · 1 条正式记录。', { exact: true }).waitFor();
  state = await read(page);
  assert.equal(state.goals.length, 3, 'full restart must reconcile the pending identity without a second creation');
  assert.equal(state.goals.filter((item) => item.title === '恢复测试目标').length, 1);
  assert.equal(state.goals.find((item) => item.title === '恢复测试目标').id, recoveredGoalId);
  checks.push('pending manual command survives full process restart and reconciles without duplicate creation');
  const denied = await page.evaluate(() => window.siyueDesktop.invoke({requestId: crypto.randomUUID(), method: 'shell', args: ['echo unsafe']}));
  assert.deepEqual(denied, {ok:false,error:{code:'invalid_input'}});
  checks.push('actual preload/IPC rejects non-allowlisted method');
  assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(), 1);
  const inlineExecuted = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__unsafeInline = true';
    document.head.appendChild(script);
    return window.__unsafeInline === true;
  });
  assert.equal(inlineExecuted, false);
  checks.push('file:// production CSP rejects dynamically injected inline script');
  assert.deepEqual(errors, []);
  const report = { status: 'passed', runtime, checks, dataDir, screenshot: 'desktop-goal-loop.png' };
  await writeFile(path.join(output, 'desktop-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (application) {
    const page = application.windows()[0];
    if (page) {
      await page.screenshot({path:path.join(output,'desktop-failure.png'),fullPage:true}).catch(()=>{});
      console.error(await page.locator('body').innerText().catch(()=>''));
    }
  }
  throw error;
} finally {
  if (application) await application.close();
}
