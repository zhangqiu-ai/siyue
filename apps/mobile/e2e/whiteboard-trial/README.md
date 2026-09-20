# 独立本机白板原生回归

`WhiteboardTrialUITests.swift` 通过 `XCUIApplication(bundleIdentifier:)` 操作专用模拟器中已安装的 Debug Siyue，使用当前 Metro 页面。独立 runner 不依赖应用 target，不修改生成的 Expo 工程，不重建应用，不清除用户数据。

1. 在仓库根运行 Metro：`corepack pnpm --filter @siyue/mobile exec expo start --localhost --port 8081`。
2. 创建专用 iPhone / iPad QA 模拟器，安装当前兼容的 Siyue Debug `.app`。不要使用用户正在交互的设备。
3. 生成独立工程（输出目录必须尚无工程）：

```sh
GEM_HOME="$(brew --prefix cocoapods)/libexec" "$(brew --prefix ruby)/bin/ruby" scripts/prepare-whiteboard-ui-tests.rb /tmp/siyue-whiteboard-ui-tests
xcodebuild build-for-testing -project /tmp/siyue-whiteboard-ui-tests/WhiteboardTrial.xcodeproj -scheme WhiteboardTrialUITests -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/siyue-whiteboard-ui-derived CODE_SIGNING_ALLOWED=NO
xcodebuild test-without-building -project /tmp/siyue-whiteboard-ui-tests/WhiteboardTrial.xcodeproj -scheme WhiteboardTrialUITests -destination "platform=iOS Simulator,id=$QA_DEVICE_ID" -derivedDataPath /tmp/siyue-whiteboard-ui-derived -resultBundlePath /tmp/siyue-whiteboard-ui-result -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO
```

每次测试使用新建的隔离 QA 安装，避免旧试用页数/内容影响断言。用例实际拖画、擦除、撤销/重做、保存、终止重启、题图页继续写画，并附最终截图。独立 runner 本身构建成功不等于用例通过；检查 test 日志与 xcresult。只证明本机模拟器交互，不代表 Pencil 压感、真机、RTC、五设备或正式存档权限。

存储失败/损坏回归另运行 `corepack pnpm exec playwright test tests/e2e/whiteboard-trial-storage.spec.mjs`；它使用真实 Node SQLite，不能替代 Expo 原生故障测试。
