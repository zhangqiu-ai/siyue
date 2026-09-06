# iOS M1 界面验收

`SiyueUITests.swift` 驱动实际应用和本地数据库：Mock 生成不增加正式目标 → 编辑并保存草稿 → 重启后显式继续 → 确认产生目标／项目／任务 → 完成任务 → 终止并重新启动后记录与完成状态保留 → 拒绝另一份草稿不增加目标 → 手动创建。

第二条独立用例 `testManualRenameCompletionArchiveAndRelaunch` 验证手动创建目标/任务 → 两者改名且 ID 不变 → 完成任务 → 归档目标和任务 → 重启后同 ID、新名称、归档状态与数量保留，且归档记录不可继续编辑。两条用例均不主动切换模拟器网络，不能单凭本地路径通过声称断网注入已验收。

每次使用 `UITest-<随机值>-…` 合成标题，保留测试记录，不清空数据库、不重置模拟器、不访问云模型。任务操作先用本轮唯一合成标题的坐标匹配唯一对应 `kind` 的记录容器，再按该容器的稳定 `record.id` 定位对应按钮和状态；容器、按钮关联不唯一即失败，不点击全局第一个“完成任务”。主滚动区按标识容器的唯一直接 ScrollView 子节点定位；输入使用字段标签判断滚动方向，仍须实际输入框可点击才操作。重复执行会积累测试记录。应在专用模拟器执行；当前已存在 `Siyue M1 QA`（iPhone 17 Pro，iOS 26.5）。不得将模拟器结果记作真机验收。

## 准备测试 target

先完成项目正常的 Expo prebuild 和 `pod install`，不要与该脚本同时改生成工程。脚本只增加／更新 `SiyueUITests` target、对应源文件引用及专用共享 scheme；不更改 `Siyue` app 的配置或现有 scheme。重新 prebuild 后需重跑。

以下命令从仓库根目录执行。本机 CocoaPods 1.17.0 使用 Homebrew Ruby，系统 Ruby 没有 `xcodeproj`；版本变化时按实际 CocoaPods 环境调整路径，脚本本身不安装 gem。

```sh
GEM_HOME="$(brew --prefix cocoapods)/libexec" "$(brew --prefix ruby)/bin/ruby" scripts/prepare-ios-ui-tests.rb
```

## 模拟器执行

Release 配置内嵌 JS bundle，不依赖运行中的 Metro。目标限定为已核实的专用模拟器 UUID，避免误选已连接真机。若此模拟器不再存在，先用 `xcrun simctl list devices available` 核对新的专用模拟器。

下面是 2026-09-06 完整通过时的准确命令，从仓库根目录执行。本机因已复现的 clang 探测管道问题，使用命令级 `CC`／`CXX` wrapper，并提前完成 Expo JSI 模拟器 slice 构建，见[绕行工具及预构建说明](../../../scripts/xcode-probe/README.md)。其他环境不默认需要该绕行。复跑时必须将 `-resultBundlePath` 换为新的路径，不能覆盖已存在的结果。

```sh
xcodebuild test \
  -workspace apps/mobile/ios/Siyue.xcworkspace \
  -scheme SiyueUITests \
  -configuration Release \
  -destination 'platform=iOS Simulator,id=7328BC59-6853-445B-A888-E99496AB2048' \
  -derivedDataPath /tmp/siyue-ios-ui-derived \
  -resultBundlePath artifacts/m1/ios-simulator-anchor-fix.xcresult \
  -only-testing:SiyueUITests/SiyueUITests/testGoalDraftConfirmationPersistenceRejectionAndManualCreation \
  -parallel-testing-enabled NO \
  -collect-test-diagnostics never \
  CODE_SIGNING_ALLOWED=NO \
  CC="$PWD/scripts/xcode-probe/clang" \
  CXX="$PWD/scripts/xcode-probe/clang++"
```

第二条改名归档用例的实际执行命令如下，与前一用例为两次独立运行：

```sh
xcodebuild test \
  -workspace apps/mobile/ios/Siyue.xcworkspace \
  -scheme SiyueUITests \
  -configuration Release \
  -destination 'platform=iOS Simulator,id=7328BC59-6853-445B-A888-E99496AB2048' \
  -derivedDataPath /tmp/siyue-ios-ui-derived \
  -resultBundlePath artifacts/m1/ios-simulator-rename-archive.xcresult \
  -only-testing:SiyueUITests/SiyueUITests/testManualRenameCompletionArchiveAndRelaunch \
  -parallel-testing-enabled NO \
  -collect-test-diagnostics never \
  CODE_SIGNING_ALLOWED=NO \
  CC="$PWD/scripts/xcode-probe/clang" \
  CXX="$PWD/scripts/xcode-probe/clang++"
```

测试提供关键步骤截图，失败时附上可访问树和截图；保留 `.xcresult` 和完整构建日志。`-collect-test-diagnostics never` 不影响上述测试主动生成的附件。重新运行不删除已有 `.xcresult`。如果键盘编辑菜单、React Native 可访问树或滚动行为与预期不同，用例会报错，须根据实际截图修复定位，不能降低业务断言以取得通过。

## 验证边界

已执行：`ruby -c scripts/prepare-ios-ui-tests.rb`、`xcrun swiftc -frontend -parse apps/mobile/e2e/SiyueUITests.swift`。已只读核实：生成工程包含 `Siyue` app target、Debug／Release、最低 iOS 16.4；CocoaPods 的 xcodeproj 版本为 1.28.1。

2026-09-06 第五轮完整模拟器 UI 用例通过：**1 个测试，0 失败，0 跳过，167.126 秒**，日志结束为 `TEST SUCCEEDED`。环境：Xcode 26.6（17F113）、macOS 26.6.2，专用 iPhone 17 Pro 模拟器 iOS 26.5（23F77）、arm64。已验证本文件首段所列完整闭环，包括草稿重启恢复、明确确认、完成任务与重启持久化、拒绝和手动创建。

证据：[完整日志](../../../artifacts/m1/ios-simulator-anchor-fix.log)、[结构化结果摘要](../../../artifacts/m1/ios-simulator-summary.json)、[原始 XCTest 结果](../../../artifacts/m1/ios-simulator-anchor-fix.xcresult)。这些保存在本机 `artifacts/`，可能不随 Git 分发；跨环境复现需重新执行并保留独立结果。

随后新增的手动改名归档用例首次独立执行通过：**1 个测试，0 失败，0 跳过，151.684 秒**，`TEST SUCCEEDED`。目标与任务改名保持原 ID、完成任务后归档、重启后同 ID/归档状态/数量保留及归档后只读均有实际断言。证据：[执行日志](../../../artifacts/m1/ios-simulator-rename-archive.log)、[结果摘要](../../../artifacts/m1/ios-rename-archive-summary.json)、[XCTest 结果](../../../artifacts/m1/ios-simulator-rename-archive.xcresult)。两条独立用例分别执行通过，不能写成同一次运行的 2/2。

首条闭环用例的前四轮已构建并启动应用，但都因测试定位失败，**不能记作完整闭环通过**：

| 轮次 | 实际失败与修正依据 | 日志 |
|---|---|---|
| 1 | 误选键盘候选条 ScrollView，主内容未滚动 | [cached-jsi](../../../artifacts/m1/ios-simulator-cached-jsi.log) |
| 2 | React Native 将 testID 放在 Other 容器，需取其唯一直接 ScrollView 子节点 | [scroll-fix](../../../artifacts/m1/ios-simulator-scroll-fix.log) |
| 3 | 同一个 RN Text 暴露父子 StaticText，单元素查询歧义；同时证实记录的可访问树被扁平化 | [scroll-container](../../../artifacts/m1/ios-simulator-scroll-container.log) |
| 4 | 任务完成及重启已通过；返回顶部时，屏外 TextView 的零坐标导致方向错误，改用字段标签为滚动锚 | [record-fix](../../../artifacts/m1/ios-simulator-record-fix.log) |

第五轮沿用全部业务断言，以真实可访问树、截图和失败日志修正测试定位，未清空数据库。更完整的平台状态见 [M1 验证记录](../../../docs/evidence/m1-validation.md)。

用户已授权本次 iPhone 开发测试，签名证书与设备登记已完成；iPhone 16 Pro Max（iOS 26.6.1 / 23G83）已恢复USB连接，两条核心UI路径分别有通过证据：草稿闭环142.692秒、改名/完成/归档重启125.001秒；首轮整套为1通过1失败，不能写同次2/2。 模拟器通过以及 iphoneos 构建均不能替代真机安装、交互和持久化验收；Android 模拟器两条独立 UI 用例分别通过（每次 1 项、0 失败，336.319 秒与 325.679 秒），第二条已验证真实断网下手动改名、完成、归档与重启保留；Android 真机及正常用户UI错误交互、取消/升级故障仍未验收，见 [M1 验证记录](../../../docs/evidence/m1-validation.md)；以上命令始终限定 iOS 模拟器。

参考：[Apple UI 查询 API](https://developer.apple.com/documentation/xcuiautomation/xcuielementquery)、[Apple 添加测试 target](https://developer.apple.com/documentation/xcode/adding-tests-to-your-xcode-project)、[CocoaPods Xcodeproj 源码](https://github.com/CocoaPods/Xcodeproj)。

iOS与Android独立QA应用均复用正常原生客户端工厂，真实SQLite提交后丢响应/回执暂不可读、终止进程后对账分别通过（iOS 43.191秒、Android 12.053秒，各1项0失败）；恢复execute=0，同commandId/issuedAt/对象ID/完整快照hash不变，pending只在原回执验证后清除。每个平台两条正常用户UI用例与一条QA用例分别执行，不是同次3/3；不代表正常用户UI错误交互、真机、物理断电、生成取消/后台中断或升级通过，也不自动恢复表单。 证据见 [M1 验证记录](../../../docs/evidence/m1-validation.md)。
