# M1 本地 Mock 验证记录

日期：2026-09-06。工作目录：`/Users/feature/code/siyue`；分支：`feature/dev`。

本轮按维护者选择实现本地 Mock 闭环。macOS 上的真实 Electron 已验证目标输入、草稿编辑、重启恢复、确认保存、任务完成、拒绝和手工创建。移动界面及 SQLite 宿主已实现。iOS 原生构建和模拟器完整 UI 用例已通过，覆盖草稿编辑/恢复、确认创建、任务完成与跨重启保留、拒绝草稿、手动创建；Android 已完成 JavaScript/Hermes 导出、SDK 安装与专用模拟器启动；独立 UI 宿主构建和两份 APK 安装通过，插桩目标已核验，主应用重试构建、APK 签名校验与安装通过；Android 模拟器 UI 闭环经测试宿主修复后通过：1 项、0 失败、336.319 秒，覆盖草稿编辑/恢复、确认创建、任务完成与跨 force-stop 重启保留、拒绝及手动创建。Android另一次独立用例在真实断网下验证手动改名/完成/归档及force-stop重启保留，1项0失败、325.679秒，网络已恢复；与336.319秒用例分别执行，不能写同次2/2。另有iOS/Android独立QA真实丢回执与跨进程恢复分别通过（43.191/12.053秒，各1项0失败），原回执对账execute=0且pending验证后清除，详见末尾独立QA记录；不代表正常用户UI错误交互或真机故障验收。真机验收与 M1 全平台验收未完成。

最新真机状态：iPhone 16 Pro Max（iOS 26.6.1 / 23G83）已恢复USB连接，两条核心UI路径分别有通过证据：草稿闭环142.692秒、改名/完成/归档重启125.001秒；首轮整套为1通过1失败，不能写同次2/2。 中间测试宿主失败及Android生成取消/重启QA见本文末尾；历史unavailable记录保留为当时状态。

## 实现与证据入口

| 范围 | 实现与验证 |
|---|---|
| 领域与契约 | [commands.ts](../../packages/domain/src/commands.ts)、[runs.ts](../../packages/domain/src/runs.ts)：审批绑定身份、空间、参数、版本和有效期；正式数据、活动与回执原子写入；运行状态依据真实回执恢复 |
| 本地存储 | [适配器说明](../../packages/adapters/README.md)：隔离 SQLite、事务回滚、拒绝损坏或未知版本、持久化与丢响应对账 |
| AI 与服务端 | [Mock 执行器](../../packages/ai/src/index.ts)、[开发服务](../../apps/server/src/app.ts)：本机确定性草稿、取消和超时；AI SDK 结构化输出及审批使用离线测试替身 |
| 桌面 | [主进程](../../apps/desktop/src/main/index.mjs)、[IPC](../../apps/desktop/src/main/ipc.mjs)、[客户端](../../apps/desktop/src/renderer/client.ts)、[界面](../../apps/desktop/src/renderer/App.tsx)：固定宿主身份，最小 IPC，稳定命令标识和回执对账 |
| 移动 | [宿主](../../apps/mobile/src/client.ts)、[界面](../../apps/mobile/app/index.tsx)：共享命令与 Mock，Expo SQLite 独占事务；iOS 模拟器完整闭环已验证，真机未验证 |
| 实际桌面闭环 | [desktop-smoke.mjs](../../scripts/desktop-smoke.mjs)：真实 Electron 多次完整进程重启，使用独立临时目录和合成目标 |

后端底座为 Node + Fastify，未引入 Hermes Agent。这里的 **Hermes 是 React Native 的 JavaScript 引擎**；导出的 `.hbc` 文件是移动端字节码。字节码编译通过不能证明原生模块、模拟器或真机行为通过。

## 实际执行

以下命令均从仓库根目录执行。shell 为 Node `22.22.3`，Corepack 使用项目 pnpm `11.25.0`。依赖版本与安装中修复的问题见 [BOOTSTRAP](../BOOTSTRAP.md)。

| 准确命令 | 结果与范围 |
|---|---|
| `corepack pnpm typecheck` | 通过；共享包和三个应用类型检查 |
| `corepack pnpm build` | 通过；共享包、服务端与桌面 Renderer 构建 |
| `corepack pnpm test` | 118/118 通过；领域 43、契约 6、适配器 40、AI 9、服务端 7、桌面 IPC/恢复 13；不包含移动设备测试 |
| `corepack pnpm test:storage-poc` | 11/11 通过；Node SQLite 隔离原型 |
| `corepack pnpm peers check` | 通过；依赖 peer 检查 |
| `corepack pnpm --filter @siyue/mobile exec expo install --check` | 通过；Expo 依赖版本对齐 |
| `corepack pnpm bundle:mobile` | 通过；iOS/Android 各导出一份 Hermes 字节码包 |
| `corepack pnpm test:desktop-smoke` | 通过；真实 macOS Electron 窗口与 SQLite 多次重启闭环 |

本地原始输出保存在被 Git 忽略的 `artifacts/m1/`：`typecheck.log`、`build.log`、`tests.log`、`mobile-bundle.log`、`desktop-smoke.log`、`desktop-smoke.json` 和 `desktop-goal-loop.png`。这些是当前工作区证据；其他机器需用上述命令重新生成。原型的环境与结果另见 [storage/results.md](../../experiments/storage/results.md)。

桌面实际运行时：macOS arm64、Electron `44.2.0`、Node `24.20.0`、Chromium `152.0.7977.76`、SQLite `3.53.4`。shell Node 的原型 SQLite 为 `3.51.3`，与 Electron 分别验证。

实际桌面测试还检查 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、Renderer 无 Node 访问、拒绝未列入白名单的 IPC 方法，以及 `file://` 生产 CSP 拒绝注入的内联脚本。

## 失败路径与修复

- 审批拒绝、过期、参数变化、版本冲突、跨空间及撤权有领域测试；同 ID 不同参数明确冲突，同请求重复投递仅产生一次正式写入。
- SQLite 回调异常和提交前故障验证事务回滚；损坏或较新版本数据库拒绝打开，保留原始数据。
- 桌面手工命令在发送前保存稳定标识，丢请求或丢响应后先查询回执，并验证完整命令 hash。真实 Electron 测试先复现 sessionStorage 在进程退出后丢标识，记录数 4≠3；改为 localStorage 后同一测试记录数维持 3，重复创建缺陷已修复。
- 草稿与运行的关联在同一事务内提交，覆盖提交后返回丢失时的恢复；正式执行成功以持久化回执为准。
- 运行记录保存 Mock/策略版本、数据截止时刻和递增事件；启动恢复中断状态，不自动重新调用模型。

## 未运行与剩余边界

- 本轮重新检查已具备 Xcode 26.6（17F113）与 iOS 26.5 模拟器运行时；已识别用户连接的 iPhone 16 Pro Max（iOS 26.6.1），已通过模拟器原生构建与 UI 闭环；当前 iPhone 连接状态为 unavailable，尚未标记真机验收通过。Android 已完成 prebuild、JDK 17.0.19 / sdkmanager 20.0 与 Gradle 9.3.1 启动验证；用户已授权 SDK 许可，平台/模拟器组件已安装，专用 Siyue_API_36 / emulator-5554 已启动完成。独立 UI 宿主构建通过（`artifacts/m1/android-uihost-build.log`，4 分 22 秒、61 tasks），两份宿主 APK 安装均返回 Success，`pm list instrumentation` 已核验 target 为 app.siyue.uihost；应用原生重试构建、APK 签名校验与安装通过；Android 模拟器 UI 最终通过（1 项、0 失败，336.319 秒）；Android另一次独立离线改名/归档用例通过（1项0失败、325.679秒）；正常用户UI错误交互、取消/升级故障及移动真机仍未验收。
- Windows、桌面发行安装包、签名和自动更新未验证。
- 真实模型、供应商预算、生产鉴权、个人密钥安全存储和账号登录未实现或未验证；本轮没有真实供应商调用。
- 存储为单设备整空间 JSON 快照。尚未验证大数据性能、断电恢复、数据库加密、生产迁移、删除同步或 PowerSync。
- 移动已接入独立 SQLite 待提交日志，发送前保存不含正文的命令标识和时间，重开对账有真实 Node SQLite 测试；iOS 模拟器的普通保存/任务完成跨重启保留已验证，iOS/Android独立QA分别验证待提交日志在丢回执后的原生恢复，正常用户UI错误交互仍待验证。桌面使用 localStorage，真实 Electron 全进程重启已验证不重复创建。日志不保存表单正文、不自动重新提交。
- AgentRun 事件已包含 schemaVersion/runId/seq，授权按游标补读、历史格式兼容及重复补读不执行均通过测试。网络事件传输和移动后台中断仍待验证。

工作包状态见 [backlog](../backlog.md)；24 项跨阶段验收场景在 [test-cases.json](../../planning/test-cases.json) 分别标记 `partial` 或 `not_run`，不以实现测试数量代替平台验收。未执行提交、推送或部署。

## iOS 推进中的现场状态

2026-09-06 已完成 iOS prebuild、100 个 Pods 安装与独立模拟器启动。用户已连接 iPhone、开启开发者模式、登录 Xcode，并明确授权开发证书与设备登记；已核实有效 Apple Development 证书和 Xcode Managed Profile。签名准备完成，不等于应用已经安装或真机验收通过。

首次模拟器构建停在 CreateBuildDescription 的 clang 探测阶段；保留日志、clang/SWBBuildService 进程采样。相同 clang 命令独立执行 0.131 秒成功，原构建在输出管道等待；正常退出 Xcode、终止仅本次构建后，串行重试仍复现，因此不能归因为并行构建冲突。可选 wrapper 对这类探测先写完并关闭 stdout，再写 stderr，其余真实编译调用直接透传；8 组逐流字节和退出码等价验证通过，实际主构建已跨过该阻塞。

Expo JSI 另起的构建未继承 CC/CXX，因此先按 [xcode-probe](../../scripts/xcode-probe/README.md) 单独预构建模拟器 slice，31 秒退出 0；再次运行确认缓存命中。初次预构建使用的 RN 路径字符串与 Xcode 不同，造成缓存未命中，修正为 `REACT_NATIVE_PATH` 后主构建也已确认跳过该依赖重建。准确应用测试命令采用 [e2e README](../../apps/mobile/e2e/README.md) 所列参数，加命令级 `CC="$PWD/scripts/xcode-probe/clang" CXX="$PWD/scripts/xcode-probe/clang++"`。本机日志：`ios-jsi-simulator-correct-root.log`、`ios-simulator-cached-jsi.log`；后者已完成应用构建和启动，UI 用例因滚动定位失败。后续四轮按实际可访问树修正测试定位，第五轮完整通过。未修改依赖源码、原始数据库或删除历史结果。


## iOS 模拟器闭环通过

2026-09-06 使用专用 `Siyue M1 QA` 模拟器：iPhone 17 Pro、iOS 26.5（23F77）、arm64；宿主 macOS 26.6.2、Xcode 26.6。完整用例 1/1 通过、0 失败，测试本体 167.126 秒，`xcodebuild` 退出 0。此结果与前述 118 个实现测试分别统计。

准确命令如下；前提是已按可选绕行文档预构建 Expo JSI，并用准备脚本创建 UITest target：

```sh
xcodebuild test \
  -workspace apps/mobile/ios/Siyue.xcworkspace \
  -scheme SiyueUITests -configuration Release \
  -destination 'platform=iOS Simulator,id=7328BC59-6853-445B-A888-E99496AB2048' \
  -derivedDataPath /tmp/siyue-ios-ui-derived \
  -resultBundlePath artifacts/m1/ios-simulator-anchor-fix.xcresult \
  -only-testing:SiyueUITests/SiyueUITests/testGoalDraftConfirmationPersistenceRejectionAndManualCreation \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  CODE_SIGNING_ALLOWED=NO \
  CC="$PWD/scripts/xcode-probe/clang" CXX="$PWD/scripts/xcode-probe/clang++"
```

验证：生成草稿不增加正式目标；编辑后旧确认不可用；保存草稿后终止进程、重开并显式继续；确认后产生目标/项目/任务；完成本轮唯一任务；再次重启后正式记录和完成状态保留且数量不变；拒绝另一草稿不增加目标；手动创建成功。全部使用合成标题，保留先前记录，未清空数据库。

前四轮失败均保留日志：误选键盘候选栏 ScrollView、testID 实际位于包装容器、React Native 同一 Text 的父子重复节点、离屏 UITextView 的 frame 为无穷值。修正使用明确主容器、只读文字去歧义、稳定记录 ID 的任务控件、字段标签作为滚动方向锚；所有实际控件仍须可触达，业务断言未删减。首轮失败后的系统诊断采集耗时较长，仅中止本次诊断子进程，保留失败结果；后续禁用系统级诊断采集，仍保存 XCTest 失败截图与可访问树。

通过证据：`artifacts/m1/ios-simulator-anchor-fix.log`、同名 `.xcresult`、`ios-simulator-summary.json`、`ios-simulator-passed-attachments/` 中两张关键截图。截图与汇总由 `xcrun xcresulttool` 导出。这不是 iPhone 或 Android 真机通过证据，也未验证移动丢回执故障注入、后台中断或升级迁移。


## iPhone 开发签名构建通过，设备待连接

模拟器通过后，已单独预构建 Expo JSI 的 `iphoneos` slice（8 秒，退出 0），然后执行 `xcodebuild build-for-testing`，工作区和 scheme 同上，配置 Release，destination 为 `generic/platform=iOS`，derived data 为 `/tmp/siyue-ios-device-derived`，result bundle 为 `artifacts/m1/ios-device-build.xcresult`，启用 `-allowProvisioningUpdates`，命令级 `DEVELOPMENT_TEAM` 使用用户已确认的本机开发团队，并传入相同 CC/CXX wrapper。实际命令完整保存在本机 `artifacts/m1/ios-device-build.log`，不将个人签名团队配置写入跟踪工程。

结果：`TEST BUILD SUCCEEDED`，退出 0。`Siyue.app` 和 `SiyueUITests-Runner.app` 均通过以下签名完整性检查：

```sh
codesign --verify --deep --strict --verbose=2 /tmp/siyue-ios-device-derived/Build/Products/Release-iphoneos/Siyue.app
codesign --verify --deep --strict --verbose=2 /tmp/siyue-ios-device-derived/Build/Products/Release-iphoneos/SiyueUITests-Runner.app
```

应用为 arm64、bundle ID `app.siyue.mobile`，已使用用户授权创建的 Apple Development 证书签名。生成的测试描述为 `/tmp/siyue-ios-device-derived/Build/Products/SiyueUITests_iphoneos26.5-arm64.xctestrun`，可在设备重新可用后继续 `test-without-building`。这些 `/tmp` 产物仅为本机开发测试准备，不是发布工件或长期保存位置。

构建后的 `xcrun devicectl list devices` 仍报告已配对 iPhone 16 Pro Max 为 `unavailable`。因此未执行设备安装、启动或真机测试；已请求用户重新连接并解锁，等待设备可用后继续。没有执行提交、推送、部署或商店发布。


## 补充：正式记录改名与归档

2026-09-06 新增独立 `testManualRenameCompletionArchiveAndRelaunch`，首次执行通过：1 项、0 失败，151.684 秒，`TEST SUCCEEDED` / 退出 0。与上一条完整闭环分别执行，共两个独立 UI 用例取得通过证据，不冒充单次 2/2 结果。

沿用上述模拟器命令，将 `-only-testing` 替换为 `SiyueUITests/SiyueUITests/testManualRenameCompletionArchiveAndRelaunch`，`-resultBundlePath` 替换为 `artifacts/m1/ios-simulator-rename-archive.xcresult`；其余参数相同。完整日志为 `artifacts/m1/ios-simulator-rename-archive.log`，结构化摘要为 `ios-rename-archive-summary.json`，截图为 `ios-rename-archive-attachments/`。

用例以唯一合成标题手动创建目标和任务，分别改名并核对 ID 不变，完成任务后归档任务与目标；重启后核对相同 ID、新名称、已归档状态和目标总量仅增加 1，并确认归档后无改名/归档/任务切换按钮。未清空旧数据。此用例走本地手动路径，但没有切换系统飞行模式，不能声称执行过物理断网测试。

为测试提供的 UI 改动仅增加改名、保存、取消和归档按钮的稳定记录 ID 标识；没有改变业务命令语义。Swift 语法检查、移动端类型检查和 diff 检查通过。随后以相同参数重新执行 iPhone `build-for-testing`，结果路径改为 `artifacts/m1/ios-device-build-rename-archive.xcresult`，退出 0，原 `/tmp/siyue-ios-device-derived` 产物已更新包含本次用例，`ios-device-signature-rename-archive.log` 中应用与 Runner 的签名完整性检查均通过。该产物对应此次改名/归档版本，不包含随后为 Android 验收新增的页面/计数/空态 testID；不能据此宣称后续全部源码已重新完成 iPhone 构建。真机仍未安装或运行。

### Android 首轮构建下载失败（2026-09-06）

`artifacts/m1/android-app-build.log` 最终退出 1，`BUILD FAILED in 18m 30s`（121 tasks）。`react-native-screens` 配置失败的底层原因是从 Google Maven 下载 `androidx.appcompat:appcompat:1.7.1` AAR 时 `Remote host terminated the handshake`，不是已证实的 CMake 源码问题。同一官方 URL 随后经代理与直连 HEAD 均返回 200。保留缓存、沿用原命令重试，日志为 `artifacts/m1/android-app-build-retry.log`，已退出 0、`BUILD SUCCESSFUL in 10m 56s`，495 tasks（380 executed、115 up-to-date）；未禁用 TLS 校验或修改依赖版本。构建还自动安装了所需 Build Tools 35.0.0，沿用已获授权的 Android SDK 许可。


### Android 应用构建安装与 UI 修复历史

原命令重试构建的 APK 已核验包名 `app.siyue.mobile`、versionName `0.1.0` / versionCode `1`、minSdk `24` / targetSdk `36`，仅包含本次 ARM64 目标，内置 `assets/index.android.bundle`，不依赖 Metro。`apksigner verify` 退出 0，APK 的 SHA-256 记录于 `artifacts/m1/android-app-apk-sha256.log`；`artifacts/m1/android-app-install.log` 返回 `Success`。本地 debug 签名的 Release APK 仅用于本机测试，不是生产发布工件。

在专用 `Siyue_API_36 / emulator-5554` 上首次执行 UIAutomator：`artifacts/m1/android-ui-test.log` 记录 1 项、失败 1 项、29.049 秒，失败点是草稿标题定位（当时 `GoalFlowTest.java:80`）。思玥已实际启动并生成草稿；定位失败不证明后续确认、任务完成、拒绝或重启持久化通过。保留此次失败证据，不清库、不把本次失败改写为未运行或已通过；后续修复和通过结果单独记录如下。


### Android 模拟器 UI 闭环通过

第二轮 `artifacts/m1/android-ui-heading-fix.log` 执行 1 项、失败 1 项，25.675 秒，停在 `@Before`：应用继承了前次停留的页面底部，启动检查找不到页首本机空间标记。第一轮的标题定位问题来自把 RN 文本限定为 `android.widget.TextView`。修复仅涉及独立测试宿主：文本查询保留包名和文字约束但不限定 TextView 类；启动后先等待主滚动区、回到页首再检查本机空间；`@Before` 仅对 `app.siyue.mobile` force-stop，并核验 PID 为空后冷启动。中途两次 force-stop、进程消失和重启持久化断言保留，不清库、不卸载思玥、不重置设备、不修改业务写入语义。

最终宿主构建 `artifacts/m1/android-uihost-cold-start-fix-20260906-0210.log` 通过：27 秒，61 tasks（4 executed、57 up-to-date），并完成安装。实际执行的测试 APK SHA-256 为 `1931d267da44f8a63285106203db5de668b1659b3d8b90f83cd67473a7a19d9e`，记录见 `artifacts/m1/android-tested-host-sha256.log`；应用 APK 使用前述通过构建、校验和安装的版本。

在 `Siyue_API_36 / emulator-5554`（Pixel 8、API 36、ARM64）执行 `goalDraftConfirmationPersistenceRejectionAndManualCreation`，最终日志 `artifacts/m1/android-ui-cold-start.log` 为 `Time: 336.319`、`OK (1 test)`，进程退出 0，即 1 个用例、0 失败。其终端 `INSTRUMENTATION_CODE: -1` 与成功结果并存，不能脱离 `OK (1 test)` 和完整测试输出将其误判为 shell 失败。

通过范围：生成草稿不增正式目标；编辑草稿后旧确认不可用；保存后 force-stop 并核验进程消失，重启须显式继续和确认；创建目标、项目和任务；完成任务后再次 force-stop，重启核对相同记录 ID、完成状态和数量；拒绝另一草稿不增正式记录；手动创建目标和任务。所有操作使用本轮唯一合成标题，保留已有数据。

从仓库根目录复现（先核对专用模拟器与 APK hash；不复用原日志路径覆盖证据）：

```sh
adb -s emulator-5554 install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
adb -s emulator-5554 install -r apps/mobile/e2e/android/host/build/outputs/apk/debug/host-debug.apk
adb -s emulator-5554 install -r apps/mobile/e2e/android/host/build/outputs/apk/androidTest/debug/host-debug-androidTest.apk
adb -s emulator-5554 shell pm list instrumentation
adb -s emulator-5554 shell am instrument -w -r \
  -e class app.siyue.uihost.GoalFlowTest#goalDraftConfirmationPersistenceRejectionAndManualCreation \
  app.siyue.uihost.test/androidx.test.runner.AndroidJUnitRunner
```

安装已核验 `Success`，插桩目标必须为 `app.siyue.uihost`。本次证据目录为 `/storage/emulated/0/Android/data/app.siyue.uihost/files/m1-f4bda402-8b07-45a4-96d4-a4ff413038af`，已读取到 `artifacts/m1/android-ui-passed/`，包含三阶段各一张 PNG 和一份 XML：`confirmed-and-completed`、`relaunch-preserved-records`、`manual-saved-rejected-absent`。复跑应使用新输出目录保留各次结果。

本节第一条Android用例未覆盖改名/归档或主动断网；第二条独立离线用例补充如下。iOS/Android独立QA丢回执恢复另见末尾独立QA记录；正常用户UI错误交互、生成中的后台中断及升级故障仍未验证；不得将 iOS 第二条用例的覆盖移植为 Android 证据。iPhone 刚复查仍为 `unavailable`，尚未安装或真机测试；Android 真机也未验收。M1 真机及全平台完成状态不提升。


### Android 真实断网下手动改名、完成、归档与重启通过

独立用例 `manualRenameCompletionArchiveAndRelaunch` 的日志 `artifacts/m1/android-ui-offline-rename.log` 退出0，`Time: 325.679`、`OK (1 test)`，即1项0失败。与此前336.319秒草稿闭环为两次独立执行，不是同次2/2。应用APK沿用前述已构建/校验/安装的版本，没有改动；独立宿主 `android-uihost-rename-archive-build-20260906.log` 构建29秒通过，61 tasks（5 executed、56 up-to-date），安装日志 `android-host-rename-install.log` 为Success。该测试APK hash记录于 `android-offline-rename-host-sha256.log`。

用例创建唯一合成目标/任务，分别改名并核对ID不变、旧名称在完整页面不存在；完成任务后归档目标与任务；force-stop核验进程消失再启动，核对相同ID、新名称、归档状态及数量不变，并断言归档记录的全部编辑/任务切换按钮均不存在。没有清库、删除历史记录或依赖真实模型。

离线证据：操作前 `wifi_on=1`、`mobile_data=1`、`airplane_mode_on=0`；执行 `svc wifi disable` 与 `svc data disable` 后为0/0。`android-offline-connectivity-before.log`、`android-offline-connectivity-during.log`、`android-offline-connectivity-after.log` 均为 `Active default network: none`，`android-offline-probe.log` 返回 `connect: Network is unreachable`。因此证据支持这条手动路径在真实无网络条件下可完成；操作前已无默认网络，不宣称验证了从可用网络到断开的在途请求转换。

当时实际网络探测命令如下（复跑应另选新日志路径）：

```sh
/opt/homebrew/share/android-commandlinetools/platform-tools/adb -s emulator-5554 shell ping -c 1 -W 2 1.1.1.1 > artifacts/m1/android-offline-probe.log 2>&1
```

记录结论仅为探测输出 `Network is unreachable` 与系统无默认网络。随后读取日志的工具退出0不代表ping成功；未单独确认的ping退出码不作推断。


测试结束后执行 `svc wifi enable`、`svc data enable`，已核验恢复 `wifi_on=1`、`mobile_data=1`，与原值相同；`android-offline-connectivity-restored.log` 为 `Active default network: 104`。飞行模式没有更改。网络关闭、测试失败或中断后均须执行恢复步骤并核对原设置，不能将命令已发出当作恢复成功。

本机复现命令如下，固定专用 `emulator-5554`，运行前记录实际原值并核对测试APK hash；日志输出应使用新文件名。本轮原Wi-Fi/移动数据都为1，故恢复动作是enable；其他环境应恢复各自记录的原值。

```sh
adb -s emulator-5554 install -r apps/mobile/e2e/android/host/build/outputs/apk/debug/host-debug.apk
adb -s emulator-5554 install -r apps/mobile/e2e/android/host/build/outputs/apk/androidTest/debug/host-debug-androidTest.apk
adb -s emulator-5554 shell settings get global wifi_on
adb -s emulator-5554 shell settings get global mobile_data
adb -s emulator-5554 shell settings get global airplane_mode_on
adb -s emulator-5554 shell svc wifi disable
adb -s emulator-5554 shell svc data disable
adb -s emulator-5554 shell settings get global wifi_on
adb -s emulator-5554 shell settings get global mobile_data
adb -s emulator-5554 shell dumpsys connectivity
adb -s emulator-5554 shell am instrument -w -r \
  -e class app.siyue.uihost.GoalFlowTest#manualRenameCompletionArchiveAndRelaunch \
  app.siyue.uihost.test/androidx.test.runner.AndroidJUnitRunner
adb -s emulator-5554 shell dumpsys connectivity
```

无论测试成功、失败或中断，执行独立恢复步骤（不能仅放在成功分支）：

```sh
adb -s emulator-5554 shell svc wifi enable
adb -s emulator-5554 shell svc data enable
adb -s emulator-5554 shell settings get global wifi_on
adb -s emulator-5554 shell settings get global mobile_data
adb -s emulator-5554 shell dumpsys connectivity
```

测试进行中也读取 `dumpsys connectivity` 保留during记录；网络探测日志与三次连接状态共同确认离线，不能单看设置值。通过证据已读取到 `artifacts/m1/android-offline-rename-passed/`：`manual-renamed-and-completed`、`manual-renamed-and-archived`、`archived-records-retained-after-relaunch`，各一张PNG和一份XML。设备原证据目录为 `/storage/emulated/0/Android/data/app.siyue.uihost/files/m1-6115a5ea-5be8-4860-bf28-cbf1fd6f2464`。

本次仅补充离线手动业务路径，不覆盖原生丢回执、生成取消/后台中断、升级恢复、真实模型或同步故障。iPhone仍unavailable，两平台真机和M1全平台验收均未完成；工作包/跨阶段AT状态不提升。

### Android 独立 QA 原生丢回执与跨进程恢复通过

2026-09-06 在同一专用 `Siyue_API_36 / emulator-5554`（API 36、ARM64）运行 `NativeRecoveryTest#lostReceiptRecoversAcrossForceStop`，`artifacts/m1/android-native-recovery.log` 退出 0，`Time: 12.053`、`OK (1 test)`：1 项、0 失败。这是独立 QA 应用的故障实测，与前述 336.319 秒和 325.679 秒的两条正常用户 UI 用例分别执行，不能写为同次 3/3。

正常 `src/client.ts` 的默认宿主逻辑抽到 `src/native-client.ts` 工厂，仍默认使用 `siyue-m1.db` 与 `siyue-m1-pending.db`。独立 QA entry 显式传入故障/观测包装与每 case 三个 SQLite 文件（业务、pending、合成 fixture）；复用正常工厂、领域服务、真实 Expo SQLite 事务及 journal 实现。QA 包 `app.siyue.mobile.qa` 与正常包并存，不读取正式数据库；测试重新输入相同 case 标识恢复原输入，不代表自动恢复用户表单。

QA 构建日志 `android-native-qa-build.log` 为 `BUILD SUCCESSFUL in 2m 4s`，495 tasks（41 executed、454 up-to-date）。`android-native-qa-badging.log`、`android-native-qa-signature.log` 核验包名、Activity `app.siyue.mobile.MainActivity` 与签名；QA 与测试 APK 安装日志 `android-native-qa-install.log`、`android-native-qa-host-install.log` 均为 `Success`。APK 和宿主测试 APK 的 SHA-256 见 `android-native-qa-apk-sha256.log`。正常旧 APK 已保留为 `android-normal-before-native-qa.apk`，hash 与前述正常应用一致。随后原入口正常 APK 重建也独立通过：`android-normal-after-native-qa-build.log` 退出 0，`BUILD SUCCESSFUL in 2m 4s`，495 tasks（41 executed、454 up-to-date）。`android-normal-after-qa-badging.log` 核验包名 `app.siyue.mobile` 与 Activity `app.siyue.mobile.MainActivity`，`android-normal-after-qa-signature.log` 签名校验通过，新工件 SHA-256 见 `android-normal-after-qa-apk-sha256.log`。`android-normal-after-qa-source-check.json` 确认当前正常包不含 QA entry，且 native factory 与当前源码一致；`android-normal-after-qa-install.log` 为 `Success`，`android-normal-after-qa-launch.log` 为 `Status: ok` / `LaunchState: COLD`。`android-normal-after-qa.xml` 与同名 PNG 核验显示“本机空间 · 离线可用”且无 QA 控件。这仅验证正常入口启动和加载本机快照，没有重新执行完整 UI 闭环；正常包与 QA 包并存并保留数据。

独立 SQL 连接先读到只有命令 ID/时间/版本的 pending，再调用真实 `execute`；实际提交后的对象、事件与回执被 SQL 回读确认，然后才抛出丢响应错误并使回执暂不可读。Java 核对 QA PID 存在、force-stop 后 PID 消失，重启后两个 `processSession` 不同。恢复阶段只查询并验证原回执，真实 pending 删除前后也通过 SQL 回读核对。fixture 元数据另由 SQL 回读验证 `metadataPersisted=true`，不是仅返回成功标签。

证据为 `artifacts/m1/android-native-recovery-passed/injected.json` 与 `recovered.json`，另有两个阶段各一份 PNG/XML。两阶段的 commandId `2e0bb63e-7564-415c-9e39-901613c8abd8`、issuedAt `2026-09-05T19:09:56.081Z`、spaceId 和目标/项目/任务 ID 均相同，完整状态 SHA-256 均为 `c988f40b7cc378b6cc05fbbce217f7f032c096cc4cc04102f13f3a7935eb3151`；goals/projects/tasks/events/receipts 各为 1。`executeCalls` 为 1 → 0，`receiptCalls` 为 1 → 1，`cleanupCalls` 为 0 → 1，`pendingCount` 为 1 → 0；只有原回执身份与 payload hash 验证后才清除 pending。

复现构建（仓库根目录；保留旧工件，确认本机 `JAVA_HOME`、`ANDROID_HOME` 与专用模拟器）：

```sh
env -u ENTRY_FILE NODE_ENV=production apps/mobile/android/gradlew \
  -p apps/mobile/android --init-script "$PWD/scripts/android-native-qa.init.gradle" \
  :app:assembleRelease -PreactNativeArchitectures=arm64-v8a \
  -Pandroid.cmakeVersion=3.30.5 --no-daemon --max-workers=4
apps/mobile/android/gradlew -p apps/mobile/e2e/android \
  :host:assembleDebug :host:assembleDebugAndroidTest --no-daemon --max-workers=4
```

init script 仅显式 QA 构建使用；构建输出会更新生成目录内的 `app-release.apk`，必须另存工件并检查身份，不能把这个路径永久当作正常应用 APK。本次已保存的 QA 工件可按以下命令核验与复跑；复跑日志及 pull 目标应使用新目录保留本次证据：

```sh
"$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging artifacts/m1/android-native-qa.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify artifacts/m1/android-native-qa.apk
"$ANDROID_HOME/platform-tools/adb" -s emulator-5554 install -r artifacts/m1/android-native-qa.apk
"$ANDROID_HOME/platform-tools/adb" -s emulator-5554 install -r apps/mobile/e2e/android/host/build/outputs/apk/androidTest/debug/host-debug-androidTest.apk
"$ANDROID_HOME/platform-tools/adb" -s emulator-5554 shell pm list instrumentation
"$ANDROID_HOME/platform-tools/adb" -s emulator-5554 shell am instrument -w -r \
  -e class app.siyue.uihost.NativeRecoveryTest#lostReceiptRecoversAcrossForceStop \
  app.siyue.uihost.test/androidx.test.runner.AndroidJUnitRunner
```

宿主 APK 已安装，插桩 target 必须仍为 `app.siyue.uihost`。测试启动固定组件 `app.siyue.mobile.qa/app.siyue.mobile.MainActivity`，只 force-stop QA 包，不清数据。本次 pull 源为 `/sdcard/Android/data/app.siyue.uihost/files/native-recovery-2a97587e-58b3-40d2-be4d-31918416cb77/`，命令为 `adb -s emulator-5554 pull <本次输出目录> artifacts/m1/android-native-recovery-passed/`；复跑应以新日志报告的输出目录替换。

正常 Android 导出及 source map 核验见 `mobile-normal-qa-boundary.log` 与 `mobile-normal-qa-boundary-check.json`：正常 native factory 存在、QA entry 不在正常 bundle 中。`android-native-qa-source-check.json` 确认 QA 包源码与当前 entry 一致并包含元数据持久化检查。

本次不覆盖正常用户界面的错误交互、iOS 原生丢回执、两平台真机、物理断电、生成取消/系统后台中断或升级恢复。iPhone 仍 unavailable，M1 真机/全平台及工作包、跨阶段 AT 状态不提升。前述下载和 UI 定位失败记录保留。

### iOS 独立 QA 原生丢回执与跨进程恢复通过

2026-09-06 在 `Siyue M1 QA`（iPhone 17 Pro、iOS 26.5 / 23F77、arm64，模拟器 ID `7328BC59-6853-445B-A888-E99496AB2048`）执行独立 `NativeRecoveryUITests/testLostReceiptRecoversAcrossTermination`。`artifacts/m1/ios-native-recovery-compile-fix.log` 退出 0、`TEST SUCCEEDED`，测试本体 43.191 秒、1 项通过、0 失败；同名 `.xcresult` 与 `ios-native-recovery-summary.json` 一致。这与 iOS 的两条正常 UI 用例（167.126/151.684秒）分别执行；Android 的两条正常 UI 用例和一条 QA 用例也各自独立统计，不能拼成某次完整 suite 通过。

首轮 `ios-native-recovery.log` / `ios-native-recovery.xcresult` 因 `NativeRecoveryUITests.swift:193` 将 `isEmpty` 属性误写为 `isEmpty()` 而编译失败，退出 65（`cannot call value of non-function type 'Bool'`）；只修该属性调用后重新运行通过。这是 Swift 测试源码编译问题，不是 SQLite 或恢复流程运行失败；原日志保留。

`scripts/prepare-ios-native-qa.rb` 为被忽略的原生工程新增独立 `SiyueNativeQA` 应用及 `NativeRecoveryUITests` 测试 target，沿用已安装的 Release Pods xcconfig，复制独立 build phases/product/Info.plist 并移除 URL schemes。脚本内断言正常应用 target 的配置和 phase 内容保持不变。QA bundle ID 为 `app.siyue.mobile.qa`，与 `app.siyue.mobile` 分包分库；每 case 的业务/pending/fixture 三库仅含合成数据。QA 和正常 target 仍共享 Pods 生成文件，因此串行构建，不把独立 target 误写为完全独立的 Pods 工程。本轮仅模拟器构建，未创建新的真机签名；iPhone 起始复查仍为 unavailable。

Swift XCTest 显式定位 QA bundle，确认正在前台后 terminate，等待 `.notRunning`，重新 launch 后重新输入相同 case。复用与 Android 相同的正常 native factory、真实 execute/receipt/journal 路径及独立 SQL 观测。`ios-native-recovery-json-check.json` 独立复核两阶段 commandId、issuedAt、spaceId、三个对象 ID、完整 stateDigest 均相同；goals/projects/tasks/events/receipts 各为 1，`processSession` 改变，`executeCalls` 为 1 → 0、pending 为 1 → 0且仅在原回执验证后清除，`metadataPersisted=true`。

`artifacts/m1/ios-native-recovery-attachments/` 包含六个证据附件：注入/恢复各一份 JSON、各一张 PNG、各一份真实辅助功能树 `.txt`，另有导出 `manifest.json`；这些辅助功能树文本不是 XML。两份 JSON 与截图/树都来自本次 XCTest 附件，不能用成功标签代替数据库和身份断言。

准确测试命令如下（仓库根目录；先执行准备脚本，复跑使用新的 result bundle 路径，保留本次失败与通过证据）：

```sh
xcodebuild test \
  -workspace apps/mobile/ios/Siyue.xcworkspace \
  -scheme NativeRecoveryUITests -configuration Release \
  -destination 'platform=iOS Simulator,id=7328BC59-6853-445B-A888-E99496AB2048' \
  -derivedDataPath /tmp/siyue-ios-ui-derived \
  -resultBundlePath artifacts/m1/ios-native-recovery-compile-fix.xcresult \
  -only-testing:NativeRecoveryUITests/NativeRecoveryUITests/testLostReceiptRecoversAcrossTermination \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  CODE_SIGNING_ALLOWED=NO \
  CC="$PWD/scripts/xcode-probe/clang" CXX="$PWD/scripts/xcode-probe/clang++"
```

正常 iOS `Siyue` target 的 Release `xcodebuild build` 已独立完成：`artifacts/m1/ios-normal-after-native-qa-build.log` 退出 0、`BUILD SUCCEEDED`，bundle ID 为 `app.siyue.mobile`。随后 `simctl install` 与 `launch` 成功，`ios-normal-after-qa-launch.log` 记录 PID 43821；`ios-normal-after-qa.png` 已查看为正常界面，显示“本机空间 · 离线可用”，无 QA 控件。`ios-normal-after-qa-bundle-check.json` 核验正常 bundle 含 `siyue-main-scroll`、不含 `siyue-qa-result`，QA bundle 含 QA 标记；这只是 bundle 标记检查，不是 source map 证据。本次仅验证正常入口安装/启动，没有重新执行完整正常 UI 链路。两平台独立 QA 只证明共享原生客户端工厂的本项故障恢复，不代表正常用户 UI 错误交互、表单自动恢复、物理断电、生成取消/系统后台中断、升级或真机完成。M1/工作包/跨阶段 AT 状态不提升。

### iOS / Android 独立原生存储故障 QA 通过

本轮在既有专用模拟器与独立 `app.siyue.mobile.qa` 包中各运行一条存储故障用例：Android `android-native-storage.log` 退出 0、`Time: 2.891`、`OK (1 test)`；iOS `ios-native-storage-input-fix.log` 退出 0、`TEST SUCCEEDED`，61.387秒、1项通过、0失败，同名 `.xcresult` 和 `ios-native-storage-summary.json` 保留。这两条是各自独立运行，与旧正常 UI 用例、丢回执 QA 均分开统计。

三个 case 使用不同合成数据库。事务回滚 case 先有目标/项目/任务/事件/回执各1条，在真实SQL写入后、提交前注入异常：事务内各2条，独立观察连接仍见基线各1条；回滚及关闭重开后各1条，原始状态与digest保持不变。再以原commandId重试提交，各2条；重复投递仍各2条且返回同一回执。损坏JSON case 和未来schema版本 case 调用正常 `createNativeClient`，分别拒绝为 `corrupt_data` / `unsupported_schema`；原schema、rows和user_version在拒绝及关闭重开后均保留，没有用空库覆盖。这里的关闭重开是连接生命周期测试，不是跨进程、物理断电或生产迁移验收。

Android `android-native-storage-passed/storage.json` 已独立复核，结果见 `android-native-storage-json-check.json`；同目录有 `storage-rollback-and-rejected-data-preserved.png` 与 `.xml`。`android-native-storage-source-check.json` 确认被测试的 `storage-faults.ts` 与当前源码匹配。QA构建 `android-storage-qa-build.log` 为35秒、495 tasks（41 executed）；宿主构建 `android-storage-uihost-build.log` 为5秒、46 tasks（4 executed）。沿用独立QA包和宿主，不操作正常数据库。

Android复跑测试命令（仓库根目录，已核对专用模拟器及独立宿主/QA包）：

```sh
adb -s emulator-5554 shell am instrument -w -r \
  -e class app.siyue.uihost.NativeRecoveryTest#storageFaultsPreserveData \
  app.siyue.uihost.test/androidx.test.runner.AndroidJUnitRunner
```

iOS首轮 `ios-native-storage.log` / `.xcresult` 在10.205秒失败：`typeText` 漏掉两个字符，case输入校验未通过，因此尚未进入SQL故障测试。原失败日志、result bundle及 `ios-native-storage-attachments/` 保留。仅修Swift输入等待并逐字符核对最终值后重新运行通过，未修改存储语义。

iOS通过附件位于 `ios-native-storage-passed/`：`CAA95C46-D535-498C-8BA2-A9BC86E19729.json` 为storage结果，另有PNG及真实辅助功能树TXT各1份，附导出manifest；TXT不是XML。独立JSON复核记录为 `ios-native-storage-json-check.json`，确认回滚/重开/重试计数和digest、拒绝错误码及原数据保留。准确复跑命令如下，复跑应使用新的日志/result bundle目录保留证据：

```sh
xcodebuild test \
  -workspace apps/mobile/ios/Siyue.xcworkspace \
  -scheme NativeRecoveryUITests -configuration Release \
  -destination 'platform=iOS Simulator,id=7328BC59-6853-445B-A888-E99496AB2048' \
  -derivedDataPath /tmp/siyue-ios-ui-derived \
  -resultBundlePath artifacts/m1/ios-native-storage-input-fix.xcresult \
  -only-testing:NativeRecoveryUITests/NativeRecoveryUITests/testStorageFaultsPreserveData \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  CODE_SIGNING_ALLOWED=NO \
  CC="$PWD/scripts/xcode-probe/clang" CXX="$PWD/scripts/xcode-probe/clang++"
```

正常Android随后独立重建33秒通过（`android-normal-after-storage-build.log`），包名为 `app.siyue.mobile`，签名校验通过；`android-normal-after-storage-source-check.json` 确认正常factory源码匹配且QA入口排除。正常安装日志 `android-normal-after-storage-install.log` 为Success，启动日志 `android-normal-after-storage-launch.log` 为Status: ok / COLD；`android-normal-after-storage.xml` 已确认本机空间加载且无QA控件，同名PNG保留。正常iOS按共享Pods边界串行重建也已通过：`ios-normal-after-storage-build.log` 退出0、BUILD SUCCEEDED，bundle为 `app.siyue.mobile`；simctl安装退出0，`ios-normal-after-storage-launch.log` 记录启动PID97721。`ios-normal-after-storage.png` 已查看为正常本机空间离线可用界面；`ios-normal-after-storage-bundle-check.json` 的四项布尔检查均通过，正常包含正常控件、不含storage QA控件或故障标记，QA包含故障标记。这只是bundle marker检查，不是source map证据；两平台正常启动都不等于完整UI闭环重跑。

本轮仅补SY-003/004及AT-020的受限原生存储证据。正常用户UI错误恢复、生产迁移、断电、生成取消/系统后台中断、真机和同步仍不由这三项case证明；整体工作包及跨阶段验收状态保持不变。

### iPhone 真机两条核心 UI 路径分别通过

USB连接恢复后，iPhone 16 Pro Max（iOS 26.6.1 / 23G83、arm64，UDID `00008140-001059910C2A801C`）处于 wired、tunnel connected、DDI ready 状态。此前 unavailable 是历史环境状态。正常 `app.siyue.mobile` 已在该真机实际安装与执行，不再仅有模拟器或开发签名构建证据。

首轮 `ios-device-live-core.log` / `.xcresult` / `ios-device-live-core-summary.json` 运行两项：草稿编辑保存、重启显式继续确认、目标/项目/任务、完成重启保留、拒绝不增记录及手动创建的核心用例通过（142.692秒）；改名用例失败（47.995秒），Select All菜单未出现，尚未执行改名保存。因此首轮整个suite是1通过1失败，不能写成2/2通过。原附件在 `ios-device-live-core-attachments/`。

改名第二次单独运行 `ios-device-rename-menu-fix.log` / `.xcresult` 失败（93.860秒）：目标改名已成功，任务输入框卡在 `positionForEditMenu` 的位置阈值；`ios-device-rename-menu-fix-attachments/` 保留。这是测试滚动/菜单定位失败，既不证明任务改名业务失败，也不算整条用例通过。

第三次仅修测试helper：先检查菜单，再关闭键盘和适当滚动，以单次focus进入输入；没有修改键盘设置、业务命令或清库。`ios-device-rename-focus-fix.log` 退出0、TEST SUCCEEDED，单项125.001秒通过；同名 `.xcresult` 与 `ios-device-rename-focus-fix-summary.json` 一致。`ios-device-rename-passed/` 保留2张PNG及manifest，核验目标/任务改名同ID、完成后归档、重启保留和归档只读。应用与Runner的 `codesign` 验证均通过，见 `ios-device-current-signature.log`。因此两条核心路径各自有通过证据，不能据此改写前两次失败或宣称同次完整suite通过。

复现命令（仓库根目录；开发团队仅用维护者已确认的命令局部值，复跑使用新result目录）：

```sh
xcodebuild test \
  -workspace apps/mobile/ios/Siyue.xcworkspace \
  -scheme SiyueUITests -configuration Release \
  -destination 'platform=iOS,id=00008140-001059910C2A801C' \
  -derivedDataPath /tmp/siyue-ios-device-derived \
  -resultBundlePath artifacts/m1/ios-device-rename-focus-fix.xcresult \
  -only-testing:SiyueUITests/SiyueUITests/testManualRenameCompletionArchiveAndRelaunch \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$SIYUE_DEVELOPMENT_TEAM" \
  CC="$PWD/scripts/xcode-probe/clang" CXX="$PWD/scripts/xcode-probe/clang++"
```

首轮准确命令见 `ios-device-live-core.log`，使用相同设备/配置/命令级签名设置，未限定only-testing，故运行两条核心用例。当前测试helper位于 [SiyueUITests.swift](../../apps/mobile/e2e/SiyueUITests.swift)。iPhone故障注入、生成取消/后台中断及Android真机仍未验收，M1/工作包状态不提升。

### Android 正常页面生成取消与进程强杀恢复 QA 通过

独立QA中的 `normalUiCancellationAndGenerationRestart` 通过，`android-native-run-ui.log` 退出0、Time:47.61、OK(1 test)。QA复用 [正常HomeScreen](../../apps/mobile/app/index.tsx) 并通过 `loadClient` 注入独立合成库，实际点击正常生成/取消按钮；QA Mock延迟20秒、超时30秒，正常工厂仍保持默认250毫秒/10秒。QA入口与SQL观察见 [run-screen.tsx](../../apps/mobile/e2e/native-recovery/run-screen.tsx)。正常页面同时修复重复propose可能抢占AbortController的问题：入口先查lock，finally仅清除属于本次的controller；另增加7个稳定testID和loadClient注入点。

生成后先由SQL读到running；正常取消按钮触发后，输入保留、错误状态可见、手动创建重新可用。等待21秒超过Mock期限后，仍无迟到草稿或正式写入。第二次生成先读到running，然后force-stop；新进程恢复原runId为interrupted、seq2；再次force-stop/relaunch使用另一新processSession，runId/状态/seq和事件不再增加。所有阶段目标/项目/任务/活动/回执/草稿/审批及pending均0。取消runId为 `7db4d7e3-702a-4fb2-8ee8-f1077f58e60a`，中断runId为 `56f7216f-ac87-4a40-acd4-bd445105ae4f`。

`android-native-run-ui-passed/` 有六阶段各一份JSON/PNG/XML，共18附件：running-before-cancel、cancelled、cancelled-after-provider-deadline、running-before-kill、interrupted-after-kill、interrupted-second-restart。独立SQL JSON复核见 `android-native-run-ui-json-check.json`；`android-native-run-ui-source-check.json` 确認测试包的run-screen、正常HomeScreen与native factory匹配当前源码。

```sh
adb -s emulator-5554 shell am instrument -w -r \
  -e class app.siyue.uihost.NativeRecoveryTest#normalUiCancellationAndGenerationRestart \
  app.siyue.uihost.test/androidx.test.runner.AndroidJUnitRunner
```

随后正常Android独立重建通过（`android-normal-after-run-ui-build.log`，39秒、495 tasks/41 executed），正常包安装Success、COLD启动Status:ok，日志为 `android-normal-after-run-ui-install.log` / `-launch.log`；`android-normal-after-run-ui-source-check.json` 确认正常页面和工厂匹配、QA排除，`android-normal-after-run-ui.xml` 确认本机空间加载且无QA控件。正常包启动检查不是重跑完整UI链路。iOS同QA测试也独立通过，详见下节；正常iOS模拟器应用也已独立重建/安装/启动通过，详见下节。

本项是独立QA中复用正常页面的取消与进程终止恢复路径，不覆盖同进程后台挂起、所有正常UI错误、真机故障或生产后台任务；它与此前用例分别运行，不能拼接为同次suite。相关SY-007/009、AT-012/024只补覆盖注记，整体状态保持。

### iOS 正常页面生成取消与进程终止恢复 QA 通过

同一独立QA场景在iOS模拟器分别执行通过：`ios-native-run-ui.log` 退出0、TEST SUCCEEDED，269.349秒、1项通过0失败，同名 `.xcresult` 与 `ios-native-run-ui-summary.json` 保留。它与Android的47.61秒是两次独立运行，不能写为同次2/2。测试复用正常HomeScreen，采用独立QA包/合成库及20秒Mock/30秒超时，正常默认工厂保持250毫秒/10秒。

`ios-native-run-ui-passed/` 有六阶段JSON/PNG/真实辅助功能树TXT各6份，共18附件，另有manifest；TXT不是XML。`ios-native-run-ui-json-check.json` 独立复核：取消前SQL为running，正常取消按钮触发后run为cancelled，超过Mock期限后无迟到写；第二次生成在SQL running后终止进程，恢复同runId为interrupted seq2，第二次终止重启仍同状态/seq且不追加事件，两次processSession均变化；所有阶段正式对象/活动/回执/草稿/审批/pending为0。对应交互同时检查输入保留、错误可见、手动创建可用。

```sh
xcodebuild test \
  -workspace apps/mobile/ios/Siyue.xcworkspace \
  -scheme NativeRecoveryUITests -configuration Release \
  -destination 'platform=iOS Simulator,id=7328BC59-6853-445B-A888-E99496AB2048' \
  -derivedDataPath /tmp/siyue-ios-ui-derived \
  -resultBundlePath artifacts/m1/ios-native-run-ui.xcresult \
  -only-testing:NativeRecoveryUITests/NativeRecoveryUITests/testNormalUiCancellationAndGenerationRestart \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  CODE_SIGNING_ALLOWED=NO \
  CC="$PWD/scripts/xcode-probe/clang" CXX="$PWD/scripts/xcode-probe/clang++"
```

QA与正常iOS继续串行构建：正常模拟器应用 `ios-normal-after-run-ui-build.log` 已退出0、BUILD SUCCEEDED，Plist包名为 `app.siyue.mobile`；`ios-normal-after-run-ui-bundle-check.json` 三项marker检查均通过，正常控件存在、QA run与storage故障标记不存在，仅是marker检查，不是source map证据。simctl安装退出0，`ios-normal-after-run-ui-launch.log` 记录PID83791；`ios-normal-after-run-ui.png` 已查看为正常本机空间离线可用界面。正常启动检查不等于重跑完整UI链路。iPhone正常应用已通过devicectl重新启动，日志为 `ios-device-normal-launch.log`；这只是正常启动检查，不是新一轮全UI验收。本轮没有增加后台运行策略，同进程后台挂起/恢复仍待测；真机故障、Android真机和M1其余未完成项保持原状态。

### 本地Mock安全审查与移动错误脱敏

本轮默认本地Mock安全源码审查与73项指定测试通过（mobile4/desktop13/server7/adapters40/ai9，不含未重跑domain/contracts）。修复移动未知error.code回显、原型键命中和对象String副作用，未知错误改固定提示；RED1通过3失败、GREEN4通过0失败，typecheck通过。默认无BYOK/真实Provider，平台秘密存储与生产鉴权对当前分支不适用且未实现；pending hash非加密。移动双平台Hermes JS导出通过，脱敏改动尚无原生UI故障注入回归，先前原生通过属于修改前构建；其余正常UI错误恢复、完整包体/网络审计仍待验收。详见docs/evidence/m1-security-review.md。 源码边界、准确命令及证据详见 [安全审查记录](m1-security-review.md)。本轮没有运行完整渗透测试、生产鉴权或平台秘密存储验收，不把此前原生结果外推至当前修改。
