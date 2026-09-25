# 设备会话管理服务/API（2026-09-23）

## 范围与合同

在现有 SA-03 session 与 action-bound reauth 基础上，实现 SA-07 设备会话服务切片。`GET /v1/me/sessions` 按主体返回有效会话摘要，单页最多 25 条，使用同主体 session UUID 游标；不返回 access/refresh、完整 IP 或服务端秘密。`DELETE /v1/me/sessions/{sessionId}` 仅允许撤销自己的会话；当前会话可自行撤销，其他设备必须提供一次性 `revoke-session` grant。`POST /v1/me/sessions/revoke-all` 要求一次性 `revoke-all-sessions` grant。会话/refresh/reauth 撤销与最小安全审计同事务提交；重复撤销已失效的本人设备是无副作用的成功操作。

共享合同与 API client 已加入严格响应解析、游标与 session ID 校验、固定 API 路径和 bearer 传递。复用现有 `auth_sessions`、`reauth_grants` 与 `security_events`；后续补强追加 `0006_security_event_target.sql`，只给安全审计增加受限的目标元数据列。

## 验证

环境：本机 Fastify HTTP、每次运行新建的临时 PostgreSQL、Playwright Test runner；主体、会话与凭据均为合成数据。无生产 API、真实邮件或 Apple 服务。

- `corepack pnpm build:packages`：通过。
- `corepack pnpm --filter @siyue/server build` 与 `typecheck`：通过；`corepack pnpm --filter @siyue/server test`：35/35 通过。
- `corepack pnpm --filter @siyue/adapters typecheck` 与 `corepack pnpm --filter @siyue/adapters test`：通过，84/84。
- `corepack pnpm exec playwright test tests/e2e/session-management.spec.mjs --reporter=line`：真实 HTTP + 临时 PG 1/1 通过。
- `corepack pnpm exec playwright test tests/e2e/session-management.spec.mjs tests/e2e/email-auth.spec.mjs tests/e2e/account-ui.spec.mjs --reporter=line`：认证相关回归 7/7 通过。
- `corepack pnpm spec:check`：6/6；`corepack pnpm release:check`：通过；规划 JSON 解析与 `git diff --check`：通过。

Playwright 用例覆盖：25 条分页与游标续读、主体间列表隔离、摘要不含凭据/IP、未授权及错误动作 grant 拒绝、有效单设备撤销、同主体重复撤销不重复审计、跨主体撤销拒绝、全设备撤销需要匹配 grant、旧 access 失效而另一主体会话保持有效。

## 账号页与控制器增量

桌面 Electron 与移动 Expo 账号页已加入设备列表、刷新/分页、本设备和其他设备撤销、退出所有设备入口，中英文案、确认操作和操作结果状态。其他设备及所有设备走当前邮箱密码重新验证；Apple-only 账户仍缺对应重新验证方式，界面明确提示。共享控制器保留 token、grant 与设备操作在受控边界内，不把凭据交给渲染器；服务端确认撤销本设备/全部设备后才清理本机安全存储恢复记录。若本机清理写入失败，状态为安全存储不可用，旧字节保留，不虚报本机退出成功；网络结果不确定时提示刷新列表核实。

本轮执行：`corepack pnpm build:packages`、桌面构建和桌面/移动类型检查均通过。`corepack pnpm exec playwright test tests/e2e/auth-client.spec.mjs tests/e2e/account-ui.spec.mjs tests/e2e/session-management.spec.mjs --reporter=line` 20/20，通过桌面中英真实 Electron 账号页查看合成第二设备、邮箱密码二次验证和撤销，另验证本机/全部撤销后冷启动不恢复及安全存储故障保留原件。`corepack pnpm --filter @siyue/adapters test` 84/84；桌面主进程测试 23/23；`spec:check` 6/6、`release:check` 和 `git diff --check` 通过。桌面首轮 Playwright 因新增成功提示产生两个 `role=status` 而定位不唯一；改用可见内容限定后同一测试通过，产品操作正常。

独立 iPhone 17 Pro / iOS 26.5 模拟器 QA 使用正式 `AccountScreen`、原生 SecureStore、隔离回环 Fastify 和临时 PostgreSQL。首次 3 项中英文流程及损坏存储流程通过 2 项；中文流程输入邮箱时键盘过渡导致开头字符丢失，服务器按错误凭据拒绝。XCTest 改成等待键盘并核对完整邮箱；第二次重跑被前次损坏存储 QA 留下的隔离包状态阻断。卸载**仅 QA 包** `app.siyue.mobile.accountqa` 清除其合成测试数据后，中文明色 1/1、英文暗色 1/1 分别通过，均实际打开设备列表、看到本设备，并完成冷启动恢复与退出路径。随后扩充原生确认弹窗中的“在此设备退出”，再次验证中文 1/1、英文 1/1：服务端确认撤销后回到登录页，终止并重启不能恢复会话。英文扩充用例先因本设备/其他设备按钮同名定位到禁用项，改为选择可用按钮；第二次因 QA 包已创建账号空间而不满足干净安装前提，清理隔离 QA 包后通过。截图已逐张查看：[中文明色](backend-auth-device-sessions-2026-09-23-iphone17pro-zh.png)、[英文暗色](backend-auth-device-sessions-2026-09-23-iphone17pro-en.png)；最终撤销结果在 `artifacts/account-ui-native/device-sessions-revoke-20260923.xcresult`（中文）与 `device-sessions-revoke-en-clean-20260923.xcresult`（英文）。该 QA 构建不是正式发布包，也不代表 Android、iPad 或真机通过。

追加 iPhone 英文暗色 QA：独立服务给注册时的第二个合成会话标记 `QA registration device`；原生 XCTest 输入当前邮箱密码，撤销该设备后列表仅保留本设备，再次验证并撤销全部设备，冷启动保持未登录。`testOtherAndAllDeviceRevocation` 1/1 通过；重新取图的结果在 `artifacts/account-ui-native/device-sessions-other-all-screens-20260923.xcresult`。截图已查看：[撤销前](backend-auth-device-sessions-2026-09-23-iphone17pro-other-before.png)、[撤销后](backend-auth-device-sessions-2026-09-23-iphone17pro-other-after.png)。中文其他/全部设备操作、iPad 和真机未运行。

2026-09-24 Android API 36 隔离 Release APK（包 `app.siyue.mobile.accountqa`）在正式 `AccountScreen` 完成中英各 1/1：登录后列出本设备与注册时标记的另一设备；未输入当前邮箱密码时撤销按钮禁用；输入后经原生确认撤销另一设备，刷新服务端列表确认其消失而本设备仍在；再次输入密码并退出所有设备，冷启动后保持未登录。使用回环 Fastify、临时 PostgreSQL 和合成账号，测试脚本为 `apps/mobile/e2e/account-auth/android-device-sessions.mjs`，结果 `artifacts/account-ui-android-device-sessions-1790180239375/result.json`。已查看[中文撤销前](backend-auth-device-sessions-2026-09-24-android-zh-before.png)与[英文撤销后](backend-auth-device-sessions-2026-09-24-android-en-after.png)截图。首轮测试因脚本只向下搜索而漏掉页面上方的成功提示；实际提示存在，改为双向视口扫描后，从全新合成数据库和干净 QA 包重跑 2/2 通过。此结果不代替真机或 iPad 验收。

## 失败路径补强

只读并行审查用隔离 PostgreSQL 复现了三个缺口，本轮已按原设计修复：非法结构的 reauth grant 以前可能抛出非领域错误而被路由误报为可重试 503；现在请求合同先拒绝为 400，服务内部仍将无法解析的证明映射为 `AUTH_REAUTH_REQUIRED`。全设备撤销提交后若响应丢失，旧本机凭据以前可能长期停留；现在设备操作失败后只做一次 refresh 探测，只有得到明确的会话失效结果才清除本机恢复记录，探测仍有效时保留原件并要求重新验证。`0006_security_event_target.sql` 追加 `redacted_metadata` 列；新 `session.revoke` 审计的 `session_id` 表示行为者、元数据只记目标会话 UUID，既有审计行不回填或覆盖。

针对新增路径，真实 HTTP + PostgreSQL 测试覆盖非法 grant 的 400 响应、审计行为者与目标一致性；共享控制器测试覆盖撤销全部响应丢失后的收敛和伪 401 但 refresh 仍有效时不清除原件。追加迁移的空库、并发重复迁移、既有库升级与权限拒绝在 `database.test.mjs` 通过 8/8；受影响的 `auth-client` 与 `session-management` Playwright 20/20、服务单测 35/35 通过。旧历史审计没有行为者信息，不能据新列反推。

最终复核（2026-09-24）：最新共享包构建后的 iOS QA `testOtherAndAllDeviceRevocation` 1/1 通过，结果在 `artifacts/account-ui-native/device-sessions-final-20260923.xcresult`；桌面账号页、邮箱认证及会话基础 Playwright 回归 10/10 通过。`spec:check` 6/6、`release:check` 和 `git diff --check` 均通过。隔离 QA 服务已停止。

## 未完成

Apple-only 客户端重新验证、真实生产邮件、iPad 与真机的设备管理操作、iPhone 中文其他/全部设备原生操作、身份绑定与解绑、注销删除作业/受限回执、家庭派生授权失效和 Apple revoke 均未完成。当前邮箱与 Apple 登录尚未填充可识别的设备名称，列表只能显示平台和本/其他设备；添加可信设备标签前不把列表称为完整设备识别体验。SA-07、SA-05 及整体账号工作包保持未验收。
