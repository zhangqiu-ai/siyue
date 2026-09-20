# Excalidraw 原生回归

正式入口为侧栏“白板”或 `siyue:///whiteboard`，无需 RTC、账号或公共协作服务。此目录验证单机编辑，不证明五设备授权/同步或录像。

先安装兼容依赖、构建共享包和本地字体：

```sh
corepack pnpm install
corepack pnpm build:packages
node scripts/prepare-whiteboard-assets.mjs
```

iOS 使用已编译的 Release `.app`，不要连接 Metro 或使用旧 Debug 壳声称离线通过。安装在专用 QA 设备，若存在旧 v1 开发记录，验证不会显示转换入口；相册只加入 `apps/mobile/assets/whiteboard/exercise.png` 合成图片。

```sh
EXPO_NO_BUNDLE_SPLITTING=1 xcodebuild -workspace apps/mobile/ios/Siyue.xcworkspace -scheme Siyue -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/siyue-excalidraw-ios CODE_SIGNING_ALLOWED=NO
GEM_HOME="$(brew --prefix cocoapods)/libexec" "$(brew --prefix ruby)/bin/ruby" scripts/prepare-whiteboard-ui-tests.rb /tmp/siyue-excalidraw-ui-tests apps/mobile/e2e/ExcalidrawUITests.swift
xcodebuild build-for-testing -project /tmp/siyue-excalidraw-ui-tests/WhiteboardTrial.xcodeproj -scheme WhiteboardTrialUITests -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/siyue-excalidraw-ui-derived CODE_SIGNING_ALLOWED=NO
xcrun simctl install "$SIYUE_QA_DEVICE" /tmp/siyue-excalidraw-ios/Build/Products/Release-iphonesimulator/Siyue.app
xcrun simctl install "$SIYUE_QA_DEVICE" /tmp/siyue-excalidraw-ui-derived/Build/Products/Debug-iphonesimulator/WhiteboardTrialUITests-Runner.app
xcodebuild test-without-building -project /tmp/siyue-excalidraw-ui-tests/WhiteboardTrial.xcodeproj -scheme WhiteboardTrialUITests -destination "platform=iOS Simulator,id=$SIYUE_QA_DEVICE" -derivedDataPath /tmp/siyue-excalidraw-ui-derived -only-testing:WhiteboardTrialUITests/ExcalidrawUITests -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO
```

英文暗色用例为 `WhiteboardTrialUITests/ExcalidrawEnglishUITests`，单独运行。先仅在隔离 QA 应用的已有 `storage` 偏好表设置 `siyue.locale=en`、`siyue.appearance=dark`；不要更改真实用户数据。结束恢复原偏好。图片导入测试须等待宿主按钮重新 enabled 及保存确认，不能只读取上一修订的 saved 文案。系统相册 AX 图片的 hit-test 在 iOS 26.5 可返回不可点击，用已定位图片自身的中心坐标点击，保留真实系统选择流程。

Android 使用 `:app:assembleRelease` 的内嵌资源 APK。`with-whiteboard-inputs.cjs` 为 Gradle 声明 workspace 编辑器构建输入，防止 JS/CSS 修改被错误判为 UP-TO-DATE。只使用专用可 root 的 Android 模拟器，安装升级保留数据：

```sh
adb -s emulator-5554 root
adb -s emulator-5554 install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
node apps/mobile/e2e/excalidraw/android.mjs
```

脚本通过 UIAutomator 语义标签找控件、原生 input 拖画、真实 SQLite 只读副本核对、force-stop 冷启；暂时禁用此 QA 模拟器 Wi-Fi/数据，等待无默认网络并记录，结束恢复。没有注入编辑器 API 或使用浏览器假冒原生操作。浏览器不能验证系统相册和原生宿主，所以原生测试补充 Playwright，而不替代 `tests/e2e/excalidraw.spec.mjs`。

截图和记录在 `artifacts/` 与 XCTest result bundle。真正的手指、Pencil/手掌误触、相机、真实设备后台边界需真机单独验收。

Xcode 可能复用已安装的旧 runner，出现 TEST SUCCEEDED 但执行 0 项；每次 runner 变更后显式安装，核对实际执行数量。iPad 横屏必须断言 WebView 实际 width > height，不能只设置 XCUIDevice.orientation 并检查按钮存在。
