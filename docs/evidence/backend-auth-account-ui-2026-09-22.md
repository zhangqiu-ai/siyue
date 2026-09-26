# SA-05 登录与找回密码界面：本地验收

日期：2026-09-22。分支 `feature/dev`，基线 `fee1f4b` 加当前未提交工作。沿用原方案与 `add-shared-api-independent-auth`；本记录补充[会话基础证据](backend-auth-client-2026-09-22.md)，不改写历史结果，不将 SA-05 或 SA-01～10 整体标为完成。

## 实现与入口

- 桌面和移动正式入口均为 **设置 → 账号**。真实邮箱密码登录、退出、恢复状态和找回密码表单已接入既有认证服务。中英文本、Sage 明暗主题、输入校验、重试和安全存储不可用状态齐备。生产 API 尚未部署，正常应用不能因此完成线上登录。
- `packages/adapters/src/email-entry.ts` 统一管理内存中的表单意图。密码、验证码、挑战秘密不进入 UI 持久化；关闭、身份变化及完成后清理。重置成功只返回登录，不自动建立会话。
- 重置结果未知时冻结该次参数并复用幂等键。确认服务器提交但响应丢失时，同一操作重试可恢复结果。IPC 保留限流等待时间并隐藏未知异常详情。
- 复用已批准账号设计的单列结构及当前主题；确认方案使用密码登录，替代旧原型的直接验证码登录。没有新增 Figma 调用。账号空间显式映射尚未完成，登录不自动上传或认领本地白板等内容。
- 注册入口尚未实现／开放：仓库没有正式用户协议、隐私政策正文与版本，已向维护者索取，不伪造同意记录。Apple、微信不显示为可用。

本批未新增依赖，沿用 Expo 57.0.20、React 19.2.3、React Native 0.86.3、expo-secure-store ~57.0.3、expo-crypto ~57.0.2、Electron 44.2.0。主变更位于 `Account.tsx`、`account-screen.tsx`、双方设置入口、renderer auth bridge、共享 email-entry 与对应测试。

## 自动化证据

| 范围 | 命令／资产 | 实际结果与边界 |
| --- | --- | --- |
| 表单状态与适配器 | `corepack pnpm --filter @siyue/adapters test` | 66/66；包括格式、未知结果同键重试、参数冻结、限流、销毁后迟到响应。日志 `/tmp/siyue-email-entry-tests.log`。 |
| 实际 Electron 界面 | `corepack pnpm exec playwright test tests/e2e/account-ui.spec.mjs` | 中文通过；新增响应丢失注入后英文以 `--grep 'en actual'` 通过。校验、错密、重置、二次密码、无自动登录、重新登录、重启、退出与服务端会话撤销。英文最终产物 `artifacts/e2e/2026-09-21T16-51-09.189Z-47428`；中文适用结果在 `2026-09-21T16-49-40.151Z-43600`。 |
| 会话/IPC 回归 | `corepack pnpm exec playwright test tests/e2e/auth-client.spec.mjs tests/e2e/desktop-auth.spec.mjs` | 13/13，日志 `/tmp/siyue-account-foundation-regression.log`；真实临时 PG、HTTP 和 Electron，包括并发、代际与存储失败。 |
| 主进程单测 | `corepack pnpm --filter @siyue/desktop test` | 22/22，新增 IPC cooldown 与异常脱敏；日志 `/tmp/siyue-account-desktop-unit-final.log`。新增测试初次缺 payload 被契约正确拒绝，修正测试输入后通过。 |
| 类型 | mobile、desktop 的 `typecheck` | 均通过，日志 `/tmp/siyue-account-{mobile,desktop}-typecheck-final.log`。移动 `/account` 路由类型由 Expo 正常生成。 |
| iPhone 原生 | `AccountAuthUITests`，iOS 26.5 QA 模拟器 | 2/2；中文明色、英文暗色，原生 SecureStore 登录、终止后恢复、退出并再次启动为未登录。`artifacts/account-ui-native/iphone-02.xcresult`。 |
| iPad 原生 | 同一 `AccountAuthUITests`，隔离 iPad `42C82E31-F592-4C74-99BF-3579F5DD674F` | 最终 2/2；登录／恢复／退出与横屏窗口断言通过，完整屏幕截图已查看。`artifacts/account-ui-native/ipad-05.xcresult`，66.454 秒。第一台模拟器异常仍保留，见下文。 |
| Android 原生 | `node apps/mobile/e2e/account-auth/android.mjs`，API36 | 2/2；相同登录／冷启动／退出路径；`artifacts/account-ui-android-1790010293557/result.json`。已查看暗色软件键盘截图，当前窗口下主按钮可见。 |
| 原有本地编辑回归 | `corepack pnpm exec playwright test tests/e2e/desktop.spec.mjs --grep 'manual create, rename'` | 中英 2/2；创建、改名、完成、归档与重启，`/tmp/siyue-account-local-edit-regression.log`。 |
| 规格／版本／差异 | `corepack pnpm spec:check`、`corepack pnpm release:check`、`git diff --check` | 严格规格 6/6、版本和差异检查通过；不代替平台验收。 |

独立原生包使用实际产品 AccountScreen 和安全存储，但测试入口注入回环 API，应用标识 `app.siyue.mobile.accountqa`；它不是正式产品打包或真实服务验收。没有发送真实邮件。测试脚本与完整运行方法见[原生 QA 说明](../../apps/mobile/e2e/account-auth/README.md)。全部使用合成账号、临时 PG 与隔离用户目录，不加载根 `.env`，不操作云端。

## 失败与修正

- 首次 iOS QA 禁用签名后 Keychain 不可用，产品正确拒绝持久化登录。改为 Xcode 模拟签名及独立 QA keychain group 后 iPhone 用例通过。该 entitlements 只用于模拟器，不用于真机发行。
- Android Release 最初拒绝回环 HTTP，补充仅测试包的逐域网络配置；lint 要求显式 `includeSubdomains=false`，修正后完整 assembleRelease 通过。正式 app 的网络策略不变。
- Android 原始选择器命中“密码”文本标签，导致密码输进邮箱。改为优先匹配同标签的可点击原生控件；同一场景中英完整重跑通过。系统 UI ANR 留存截图并有限恢复，不忽略产品崩溃。
- 英文桌面故障注入初次在请求完成前断言请求数失败；使用 Playwright 条件等待后验证同幂等键、只完成一次。没有移除产品断言。
- iPad 初次 2/2 通过，但应用范围截图出现黑边／裁切；后续两次补验失败，第一台模拟器 `1E1F92B8…` 的 XCTest 窗口 frame 为 `{inf, inf, 0, 0}`。同构建／同用例在第二台隔离模拟器通过，故第一台异常暂归环境相关待查，不声称根因已解决。横屏改用 `XCUIScreen.main.screenshot()` 抓取完整显示面，保留窗口宽高断言并再次运行 2/2 通过；实际看图无黑边和裁切。失败产物 `ipad-02/03.xcresult`、裁切产物 `ipad-04.xcresult` 保留，不作为最终视觉证据。

## 界面审查及未完成项

已实际查看以下合成数据截图：

- [iPhone 中文明色](backend-auth-account-ui-2026-09-22/iphone-zh-light.png)、[英文暗色输入](backend-auth-account-ui-2026-09-22/iphone-en-dark.png)：单列对齐、输入可见；该 iOS 截图没有软件键盘，不能证明其避让。
- [Android 英文暗色与软件键盘](backend-auth-account-ui-2026-09-22/android-en-dark-keyboard.png)：密码遮蔽、主按钮可见，可关闭键盘后完成操作。
- [iPad 中文明色横屏](backend-auth-account-ui-2026-09-22/ipad-zh-light-landscape.png)、[英文暗色横屏](backend-auth-account-ui-2026-09-22/ipad-en-dark-landscape.png)：恢复登录后内容居中、列宽受限，退出可操作。仅证明此 QA 设备与当前状态，不代替窄窗口／键盘表单验收。
- [Electron 暗色错误状态](backend-auth-account-ui-2026-09-22/desktop-en-dark-error.png)：错误就近显示，900×640 窗口内弹层可滚动；暗色仅作用于本次设置弹层，未重做整个桌面主题。

L 级 UI 与整个 SA-05 未完成：注册、账号范围本地空间映射、紧凑与窄窗口、大字号、完整键盘矩阵、VoiceOver/TalkBack、真机凭据与自动填充、Linux/Windows 安全存储仍需继续。原生找回密码交互尚未自动化；共享状态和桌面通过不能代替原生路径。

SA-04 真实邮件、SA-06 Apple、SA-07 安全设置与注销、SA-08 家庭、SA-09 真实五设备、SA-10 预发布与部署仍按原计划推进；本批不是整体功能验收或发布。独立审查代理因 429 未能工作，不记录为审查通过。

## 同日补充：服务不可用与重试

桌面 Playwright 注入 `/auth/providers` 的503，首先可靠复现两条重复提示（`/tmp/siyue-account-unavailable-red.log`）。两端页面改为已有错误提示时不重复输出相同状态。恢复服务后点击重试，继续完成真实登录／密码重置／重启／退出流程；中文用例 1/1 通过（`/tmp/siyue-account-unavailable-green.log`）。桌面重新构建与 mobile/desktop 类型检查通过。

Android 以重新构建的独立 APK、`SIYUE_QA_PROVIDER_FAILURES=1` 隔离服务与 `android.mjs --provider-outage` 验证：一条错误、重试进入邮箱表单，再完成中英登录／重启／退出，2/2 通过。证据 `artifacts/account-ui-android-1790011245643/result.json`、`/tmp/siyue-account-outage-android-test-02.log`；[实际错误界面](backend-auth-account-ui-2026-09-22/android-provider-outage.png)已查看。首次启动测试时 APK 安装尚未确认结束，自动化停在 Launcher、未进入 QA 页面；等待安装成功后重跑通过，不将首次失败视作功能通过。操作说明明确要求安装完成后测试。

此处 iOS 同一提示分支已改源码并通过类型检查，但该故障路径尚未重新构建并运行 iOS 原生测试；前文 iPhone/iPad 结果适用于提示修正前的构建。不将 Android 证据替代 iOS 故障验收。QA Android 顶部系统状态栏未跟随浅色主题，产品入口已有主题 StatusBar；QA 宿主视觉差异仍待纠正，不能据此宣称完整 UI 验收。

空间接线核对见 [当前设计记录](../../openspec/changes/add-shared-api-independent-auth/design.md#sa-05-空间接线核对2026-09-22)：当前固定 local-owner 与固定白板 KEY 尚非账号映射。已明确正式宿主和代际边界，6.4 继续待实施，不更改原方案三份原件。
