# SA-05 Android 计划页离开确认与账号页接续 · 2026-09-23

## 场景与结果

Android API 36 QA Release 通过 UIAutomator 操作正式 `PlanCreateScreen` 的系统离开确认：中文和英文分别输入未提交目标，选择“继续编辑”后断言输入仍在；再次离开并明确选择“舍弃修改”后重新打开页面，断言输入为空。随后从产品 QA 首页打开正式 `AccountScreen`，以隔离 PostgreSQL fixture 中的合成英文成人账号登录，并使用账号页操作创建仅保存在本机的账号空间。

结果为 3/3：中英保留输入、中英舍弃并清空、英文账号真实 API 登录及本机账号空间创建。运行结果见 `artifacts/account-ui-android-1790138722648/result.json`；中英舍弃后页面截图为 `zh-draft-discard-cleared.png`、`en-draft-discard-cleared.png`，账号页截图为 `account-page-after-discard.png`，均在同一目录。

## 验证边界

APK 的 applicationId 为隔离 QA 标识 `app.siyue.mobile.accountqa`，API 仅使用本机回环和临时 PostgreSQL fixture，账号、密码和编辑文本均为合成数据；未访问根 `.env`、真实邮件、云端或正式应用数据。该结果证明显式舍弃和账号页基本登录/创建路径可运行，不证明正式空间切换时对正在编辑页面的提示与保护、离线未决命令、iOS/iPad、强杀恢复或 SA-05 整体验收。因此 6.4b 与 SA-05 仍未勾选。

相邻回归：`corepack pnpm --filter @siyue/mobile typecheck`、移动单测 143/143、`corepack pnpm build:packages`、桌面构建、定向 Playwright 4/4（`account-space`、`account-ui` 中英、`desktop-account-space`）、`corepack pnpm spec:check`（6 项）和 `corepack pnpm release:check` 通过；`git diff --check` 与 Android QA 脚本语法检查通过。桌面构建仍打印既有大型 renderer chunk 警告，不影响本次构建或定向用例。

## 6.4b 增量：保留输入并返回 · 2026-09-23

已将移动端计划编辑页的离开确认扩展为“继续编辑／保留输入并返回／舍弃修改”。按空间登记目标、项目和未决手动命令；空间切换完成后，如前一空间仍有未提交内容，显示可关闭的中英提示，说明内容留在本机原空间。成功提交或明确舍弃后，提示随 pending 内容清除。数据仅保存在当前进程内的空间隔离 buffer，不承诺强杀/崩溃恢复。空间 Provider 仍按原 scope key 重挂页面，未更改认证协调器或账号权限。

Android API 36 原生 UIAutomator 在正式 QA `PlanCreateScreen` 和 `AccountScreen` 运行中英各 1/1 通过：本机草稿保留；创建本机账号空间后显示切换提示且新空间草稿为空；退出账号后本机输入恢复；重新登录后账号空间输入恢复。证据位于 `artifacts/account-ui-android-draft-switch-1790140596855/`（中文）和 `artifacts/account-ui-android-draft-switch-1790140719947/`（英文），均包含结果 JSON 与切换/恢复截图。独立测试脚本为 `apps/mobile/e2e/account-auth/android-draft-switch.mjs`。

代码检查：移动类型检查通过，移动单测 148/148，`spec:check` 6 项、`release:check`、`git diff --check` 通过。此增量不覆盖服务端撤销/前台会话恢复时的提示、离线未决命令、iOS/iPad UI、系统强杀或桌面原生应用；6.4b 与 SA-05 继续未整体勾选。
