# SA-05 Android 账号空间未提交计划输入隔离 · 2026-09-23

## 场景与结果

QA-only `draft-scope` 页面挂载正式 `PlanCreateScreen`，通过生产 `AuthController` 和 `WorkspaceProvider` 切换由本机临时 PostgreSQL fixture 预置的成人账号 A/B，并通过空间协调器为两者创建独立本机空间。UIAutomator 在同一个 Android 应用进程中执行：

`local → A → B → A → local`

每个空间均输入不同的未提交目标。Android API 36 模拟器验证 local 文本未进入 A/B，A 文本未进入 B，切回 A 和 local 时分别恢复各自输入；4 项断言全部通过。QA 入口只用于选取两个合成身份，不属于产品路由或面向用户的空间选择功能。

此结果证明 Android 当前进程内 `workspace-scratch` 的 namespace 隔离与 Provider 重挂后恢复。它不承诺应用强杀／崩溃后恢复未提交输入。QA 控件直接驱动认证状态，因此本结果也不证明正式账号页切换时的提示交互；当前账号页没有把 plan-create 的 beforeRemove 确认转换为空间切换确认，这个产品交互仍待单独设计和验收。

## 验证

| 检查 | 结果 |
| --- | --- |
| Android API 36 QA Release 构建 | 通过；独立包 `app.siyue.mobile.accountqa` |
| `SIYUE_QA_ANDROID=emulator-5554 node apps/mobile/e2e/account-auth/android.mjs --draft-isolation` | 4/4 通过；真实 AuthController、WorkspaceProvider、正式计划页与隔离 PostgreSQL 测试 API |
| 结果 | `artifacts/account-ui-android-1790138411775/result.json` |
| 截图 | `local-draft.png`、`account-a-draft.png`、`account-b-draft.png`、`account-a-restored.png`、`local-restored.png`，均位于上述结果目录 |
| 本轮相邻检查 | `corepack pnpm --filter @siyue/mobile typecheck`、移动单测143/143、`node --check apps/mobile/e2e/account-auth/android.mjs` 均通过；整体 `spec:check`、`release:check`、`git diff --check` 通过 |

测试数据只含两个合成成人账号和 ASCII 占位输入；不读根 `.env`，不访问真实账号、邮件或云端。Release APK 经 AAPT 确认为 QA 专用 applicationId 后才安装。

## 剩余验收

6.4b 仍未整体完成：产品账号界面发起切换时的未提交编辑告知／保护、离线未决命令及 iOS/iPad 原生空间切换仍待验收。此项也不覆盖相机原件和白板图片切换，因此 6.4c/d 与 SA-05 不勾选。
