# 原生存储故障验收入口

此入口仅用于合成数据验收，不由正常 Expo Router 入口导入。Android 通过显式 Gradle init script 生成 `app.siyue.mobile.qa`，与 `app.siyue.mobile` 并存；namespace 与 Activity 类仍为 `app.siyue.mobile`。不替换正式应用、不读取正式数据库、不清除测试或正式数据。

当前验证目标是实际 Expo SQLite 提交成功后丢失响应、回执查询暂不可用，再跨进程重启以同一输入对账。测试会重新输入合成 case 标识，不代表自动恢复用户表单。共享原生客户端工厂、领域服务、SQLite 事务和 pending 日志均采用正常实现；故障与观测包装只由这个独立入口传入。

## 构建与身份检查

需要已完成主工程 Expo prebuild、Android SDK 与独立 UI 宿主准备。仓库根目录设置本机的 `JAVA_HOME`、`ANDROID_HOME` 后执行：

```sh
env -u ENTRY_FILE NODE_ENV=production apps/mobile/android/gradlew \
  -p apps/mobile/android \
  --init-script "$PWD/scripts/android-native-qa.init.gradle" \
  :app:assembleRelease -PreactNativeArchitectures=arm64-v8a \
  -Pandroid.cmakeVersion=3.30.5 --no-daemon --max-workers=4
```

init script 在 `androidComponents.finalizeDsl` 阶段设置 QA applicationId 和 React Native entryFile，晚于生成工程的默认入口赋值、早于 variant/task 创建。`ENTRY_FILE` 会优先于 React Native entryFile，因此必须移除；脚本遇到该变量或意外应用身份会拒绝构建。[AGP 回调说明](https://developer.android.com/reference/tools/gradle-api/8.9/com/android/build/api/variant/AndroidComponentsExtension)

构建会更新生成目录的 `app-release.apk`；运行前另存明确名称并记录 SHA-256，不能把这个路径永久当作正常应用工件。构建结果不是测试通过，必须检查 APK 身份、签名和实际插桩输出：

```sh
"$ANDROID_HOME/build-tools/36.0.0/aapt" dump badging apps/mobile/android/app/build/outputs/apk/release/app-release.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

仅当包名是 `app.siyue.mobile.qa` 且启动 Activity 是 `app.siyue.mobile.MainActivity` 时安装到已核验的专用模拟器。正常应用的入口构建不使用此 init script，恢复普通构建无需更改源码或删除缓存。

## 验证范围

Java UIAutomator 在独立 `app.siyue.uihost` 进程中操作 QA 包；真实 force-stop 后核对 QA 进程消失，再执行恢复阶段。结构化结果必须来源于真实数据库和调用观测，校验命令身份、对象 ID、回执与活动数量、pending 内容和清除顺序；只显示成功文字不够。

本入口不证明正常用户界面的错误交互通过，也不覆盖 iPhone/Android 真机、物理断电、同步、生产迁移或表单自动恢复。实际构建与执行结果由主流程取得后补入 M1 验证记录。

## 2026-09-06 Android 模拟器结果

独立运行 `NativeRecoveryTest#lostReceiptRecoversAcrossForceStop` 通过：**1 项、0 失败，12.053 秒**。设备为专用 `Siyue_API_36 / emulator-5554`，Android 16 / API 36 / ARM64。QA APK 构建 2 分 4 秒通过；独立测试宿主最终构建 39 秒通过。APK 包名、完整 Activity 名与签名检查通过，两份 APK 安装均为 `Success`。

从仓库根目录安装并执行（先按上文检查身份）：

```sh
adb -s emulator-5554 install -r artifacts/m1/android-native-qa.apk
adb -s emulator-5554 install -r apps/mobile/e2e/android/host/build/outputs/apk/androidTest/debug/host-debug-androidTest.apk
adb -s emulator-5554 shell am instrument -w -r \
  -e class app.siyue.uihost.NativeRecoveryTest#lostReceiptRecoversAcrossForceStop \
  app.siyue.uihost.test/androidx.test.runner.AndroidJUnitRunner
```

原始结果位于 [执行日志](../../../../artifacts/m1/android-native-recovery.log)；两阶段 [injected.json](../../../../artifacts/m1/android-native-recovery-passed/injected.json) / [recovered.json](../../../../artifacts/m1/android-native-recovery-passed/recovered.json) 与各自 PNG/XML 保存完整观测。实际比较结果：

| 检查 | 注入后 | 真实重启后对账 |
|---|---|---|
| execute 调用 | 1 | 0 |
| 目标/项目/任务/活动/回执数量 | 各 1 | 各 1 |
| pending 数量 | 1 | 0，仅原回执验证后清除 |
| commandId、issuedAt、空间及对象 ID、完整状态摘要 | 已持久化 | 与原值完全相同 |
| 进程会话标识 | 第一个标识 | 新标识；Java 另核验原 PID 消失 |

fixture 元数据也从独立 SQLite 回读核验；pending 仅包含 schemaVersion、commandId、issuedAt，不含表单正文。重试重新提供原 case ID 来确定相同合成输入，不宣称自动找回丢失表单。

[正常入口模块检查](../../../../artifacts/m1/mobile-normal-qa-boundary-check.json) 确认正常导出包含共享原生工厂且不含 QA 入口；[QA 源码映射核验](../../../../artifacts/m1/android-native-qa-source-check.json) 确认实际 QA 包含本次测试源码。正常用户 UI、iOS 原生和真机的对应故障路径仍需分别验证。

测试后已不带 init script 重新执行同一 `:app:assembleRelease`，2 分 4 秒通过；正常包名恢复为 `app.siyue.mobile`，签名校验、安装与冷启动通过。正常页面可访问树已核对本机空间加载成功且不存在 QA 控件；这只是启动检查，不冒充再次执行完整业务 UI 用例。[构建日志](../../../../artifacts/m1/android-normal-after-native-qa-build.log)、[正常包源码检查](../../../../artifacts/m1/android-normal-after-qa-source-check.json)、[启动日志](../../../../artifacts/m1/android-normal-after-qa-launch.log)、[页面 XML](../../../../artifacts/m1/android-normal-after-qa.xml)。QA 进程已结束，两个应用及各自数据库保留。

## iOS 模拟器

同一 QA 入口另有独立 `SiyueNativeQA` application target 与 `NativeRecoveryUITests` XCTest target，均使用原有 Release 配置及已安装 Pods，不改正常 `Siyue` target 的配置或签名。准备脚本复制独立 build phases/product reference，QA Info.plist 显示名明确且移除正常 URL scheme；入口通过 QA 专属 build setting 指向 `$(SRCROOT)/../e2e/native-recovery/entry.tsx`。

在已完成 iOS prebuild/Pods 安装的仓库根目录执行，使用能加载 CocoaPods `xcodeproj` 的 Ruby：

```sh
GEM_HOME=/opt/homebrew/opt/cocoapods/libexec /opt/homebrew/opt/ruby/bin/ruby scripts/prepare-ios-native-qa.rb
xcodebuild test -workspace apps/mobile/ios/Siyue.xcworkspace \
  -scheme NativeRecoveryUITests -configuration Release \
  -destination 'platform=iOS Simulator,id=7328BC59-6853-445B-A888-E99496AB2048' \
  -derivedDataPath /tmp/siyue-ios-ui-derived \
  -resultBundlePath artifacts/m1/ios-native-recovery-compile-fix.xcresult \
  -only-testing:NativeRecoveryUITests/NativeRecoveryUITests/testLostReceiptRecoversAcrossTermination \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  CODE_SIGNING_ALLOWED=NO \
  CC="$PWD/scripts/xcode-probe/clang" CXX="$PWD/scripts/xcode-probe/clang++"
```

复跑使用新的 resultBundlePath，保留历史结果。本机 CC/CXX 参数针对已复现的探测管道问题，其他机器按 [可选绕行说明](../../../../scripts/xcode-probe/README.md) 判断。QA 与正常 target 仍共享 Pods 生成的 ExpoModulesProvider.swift 及 bundling 中间目录，因此**串行构建**，不能把 target 分开理解为所有构建输出完全隔离。不要把正常 app 加入 QA scheme 的构建依赖；重新 prebuild 后再次运行准备脚本。

2026-09-06 在 `Siyue M1 QA`（iPhone 17 Pro / iOS 26.5 / 23F77）取得 **1 项、0 失败、43.191 秒**，xcodebuild 退出 0 / `TEST SUCCEEDED`。[日志](../../../../artifacts/m1/ios-native-recovery-compile-fix.log)、[结果摘要](../../../../artifacts/m1/ios-native-recovery-summary.json)、[JSON 复核](../../../../artifacts/m1/ios-native-recovery-json-check.json)。与 Android 独立执行，不能合并声称同次运行通过。

两阶段 JSON、截图和真实 XCTest accessibility debugDescription 在 [附件目录](../../../../artifacts/m1/ios-native-recovery-attachments/)；iOS 没有 UIAutomator XML，不伪造 XML。实际比较同样证明命令/时间/空间/对象 ID、全部计数和完整状态摘要不变，新进程恢复 execute=0，pending 仅在验证回执后清除。首轮 [编译失败日志](../../../../artifacts/m1/ios-native-recovery.log) 保留：Swift `isEmpty` 属性被误写为函数调用，修正测试一行后通过；语法解析不能代替类型编译。

测试后正常 `Siyue` Release 已串行重新构建通过，确认包名 `app.siyue.mobile`，安装并启动到本机空间页面。[构建日志](../../../../artifacts/m1/ios-normal-after-native-qa-build.log)、[启动日志](../../../../artifacts/m1/ios-normal-after-qa-launch.log)、[截图](../../../../artifacts/m1/ios-normal-after-qa.png)。[bundle 标记检查](../../../../artifacts/m1/ios-normal-after-qa-bundle-check.json) 确认正常包含正常界面标记且不含 QA 控件标记；这是标记检查，不是完整源码映射验证。此次仅检查正常启动，未重跑全部业务 UI 测试。

此项仍是共享工厂的独立 QA 故障验证，不是普通用户界面、iPhone 真机或物理断电验证。

## 事务回滚与拒绝损坏数据

`storage-faults.ts` 新增独立合成库验证，正常入口不导入它。复用正常应用的 `wrapNativeConnection` 与共享 SQLite store；事务内实际写入目标、项目、任务、活动和回执后抛错，核对事务内新值、另一连接仍看到的旧值，以及回滚和关闭重开后的完整原始快照。同一命令随后重试、重复投递，验证成功且不重复创建。

另两份独立库分别注入损坏 JSON 和未知 `user_version`，调用正常原生客户端工厂，要求明确拒绝；比较拒绝前后及重开后的 SQL schema、版本与行内容，不把 WAL 文件字节变化当作业务数据损坏。所有合成数据库保留，不操作正常数据库。

2026-09-06 两平台独立运行通过：iOS `testStorageFaultsPreserveData` **1 项、0 失败、61.387 秒**；Android `storageFaultsPreserveData` **1 项、0 失败、2.891 秒**。每条用例内部覆盖三种存储场景，不记成三条独立测试。iOS [日志](../../../../artifacts/m1/ios-native-storage-input-fix.log)、[摘要](../../../../artifacts/m1/ios-native-storage-summary.json)、[附件](../../../../artifacts/m1/ios-native-storage-passed/)、[JSON 复核](../../../../artifacts/m1/ios-native-storage-json-check.json)；Android [日志](../../../../artifacts/m1/android-native-storage.log)、[JSON/PNG/XML](../../../../artifacts/m1/android-native-storage-passed/)、[JSON 复核](../../../../artifacts/m1/android-native-storage-json-check.json)。

两端观测均为：基线各 1，故障事务内各 2，回滚及关闭连接重开后各 1，原命令重试与重复投递后均各 2。回滚和重开后的完整 SQL 快照摘要与基线一致；损坏 JSON 返回 `corrupt_data`，未来版本返回 `unsupported_schema`，拒绝前后及重开摘要均一致。iOS 首次运行因键盘输入漏字符在 case ID 校验处失败，尚未触发 SQL；[原失败日志](../../../../artifacts/m1/ios-native-storage.log) 和结果保留。仅将 XCTest 输入改为等待键盘、逐字符核验后复跑通过。

Android 使用上文构建命令生成新 [QA APK](../../../../artifacts/m1/android-storage-qa.apk)；构建 35 秒、宿主构建 5 秒通过。检查包身份、签名并安装后执行：

```sh
adb -s emulator-5554 shell am instrument -w -r \
  -e class app.siyue.uihost.NativeRecoveryTest#storageFaultsPreserveData \
  app.siyue.uihost.test/androidx.test.runner.AndroidJUnitRunner
```

iOS 使用上文同一 `xcodebuild test` 命令，将 `-only-testing` 改为 `NativeRecoveryUITests/NativeRecoveryUITests/testStorageFaultsPreserveData`，`-resultBundlePath` 使用新的路径；本次通过结果为 `artifacts/m1/ios-native-storage-input-fix.xcresult`。

测试后两平台正常应用已分别重新构建、确认 `app.siyue.mobile` 并安装启动。Android [构建](../../../../artifacts/m1/android-normal-after-storage-build.log)、[源码映射检查](../../../../artifacts/m1/android-normal-after-storage-source-check.json)、[启动](../../../../artifacts/m1/android-normal-after-storage-launch.log)；iOS [构建](../../../../artifacts/m1/ios-normal-after-storage-build.log)、[bundle 标记检查](../../../../artifacts/m1/ios-normal-after-storage-bundle-check.json)、[启动](../../../../artifacts/m1/ios-normal-after-storage-launch.log)。此处只验证正常启动，不是完整业务 UI 重跑；iOS 标记检查不是源码映射检查。

这些检查中的重开是关闭 SQLite 连接后重新打开，不是终止应用进程；不等同于生产迁移、物理断电或正常用户界面的错误处理验收。

## 正常界面的生成取消与进程中断

`run-screen.tsx` 在独立 QA 包内复用正常 `HomeScreen`，仅注入独立数据库及 20 秒 Mock 延迟、30 秒超时；正常应用仍为 250 毫秒延迟、10 秒超时。观察面板切换不会卸载业务界面，不会因此触发取消。它用独立连接读取真实 SQLite，并校验版本和空间结构；每个进程、每个 case 只初始化一次客户端，观察操作不调用恢复。

Android `NativeRecoveryTest#normalUiCancellationAndGenerationRestart` 于 2026-09-06 通过：**1 项、0 失败、47.61 秒**。在 SQL 已确认 running 后点击正常“取消生成”，核对输入保留、取消提示和手动入口恢复可用；再等 21 秒确认没有迟到写入。第二次生成确认 running 后真实 force-stop，两次重启均重新输入原 case，核对新进程、同 run 变 interrupted、序号只增加一次、不自动重试。六阶段正式对象、活动、回执、草稿、审批和 pending 均为 0。

[执行日志](../../../../artifacts/m1/android-native-run-ui.log)、[六阶段 JSON/PNG/XML](../../../../artifacts/m1/android-native-run-ui-passed/)、[独立 JSON 复核](../../../../artifacts/m1/android-native-run-ui-json-check.json)、[实际 QA 包源码检查](../../../../artifacts/m1/android-native-run-ui-source-check.json)。QA APK 构建 31 秒通过，最终宿主构建 8 秒通过；安装前确认独立包名与签名。复现命令：

```sh
adb -s emulator-5554 shell am instrument -w -r \
  -e class app.siyue.uihost.NativeRecoveryTest#normalUiCancellationAndGenerationRestart \
  app.siyue.uihost.test/androidx.test.runner.AndroidJUnitRunner
```

测试后正常 Android 构建 39 秒通过，恢复 `app.siyue.mobile`，签名、安装和冷启动通过；[正常源码映射检查](../../../../artifacts/m1/android-normal-after-run-ui-source-check.json) 确认当前正常页面/工厂匹配且 QA 排除，[启动日志](../../../../artifacts/m1/android-normal-after-run-ui-launch.log) 为 `Status: ok / COLD`。

iOS 对应 `testNormalUiCancellationAndGenerationRestart` 在专用模拟器上独立运行通过：**1 项、0 失败、269.349 秒**。[日志](../../../../artifacts/m1/ios-native-run-ui.log)、[摘要](../../../../artifacts/m1/ios-native-run-ui-summary.json)、[六阶段 JSON/PNG/AX TXT](../../../../artifacts/m1/ios-native-run-ui-passed/)、[独立 JSON 复核](../../../../artifacts/m1/ios-native-run-ui-json-check.json)。使用上文 `xcodebuild test` 命令，`-only-testing` 为 `NativeRecoveryUITests/NativeRecoveryUITests/testNormalUiCancellationAndGenerationRestart`，结果路径为新的 `artifacts/m1/ios-native-run-ui.xcresult`。两平台各自运行，不能写同次 2/2；iOS 观察附件是 XCTest accessibility debugDescription，不是 XML。

测试后正常 iOS 模拟器应用已串行[重新构建](../../../../artifacts/m1/ios-normal-after-run-ui-build.log)、安装并[启动](../../../../artifacts/m1/ios-normal-after-run-ui-launch.log)，包名 `app.siyue.mobile`。[截图](../../../../artifacts/m1/ios-normal-after-run-ui.png) 已检查为正常本机空间页面；[bundle 标记检查](../../../../artifacts/m1/ios-normal-after-run-ui-bundle-check.json) 确认正常控件存在且 QA 控件排除，此为标记检查，不是源码映射或完整 UI 重跑。

上述证据不覆盖同进程切后台后返回、所有错误恢复、iPhone/Android 真机取消，或默认 250 毫秒窗口的点击时序。快速重复调用可能覆盖取消控制器的问题已用入口锁及控制器身份检查修复；本条原生用例不直接模拟那次极短竞态。
