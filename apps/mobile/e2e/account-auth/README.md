# 独立原生账号 QA

使用真实 AccountScreen、SecureStore、HTTP API 与临时 PostgreSQL。独立应用标识 `app.siyue.mobile.accountqa`，不覆盖思玥正式应用或读取其数据。入口只供测试，正常 Expo/Gradle 构建不导入。合成邮箱及密码写在测试脚本，不是真实账号；不发邮件、不读取根 `.env`。

在仓库根目录先构建共享包和服务，再持续运行本机服务：

```sh
corepack pnpm build:packages
corepack pnpm --filter @siyue/server build
node tests/e2e/native-account-server.mjs
```

服务仅监听 `127.0.0.1:18787`，退出时清理自己创建的数据库。模拟时钟随墙钟推进，避免长时间运行后签发已过期会话。不要在其他测试仍使用时重启服务。

## iOS Simulator

需已有 Expo 原生工程及 Pods。准备脚本生成未纳入 Git 的独立 scheme；普通应用 target 不改变。模拟器权限文件仅用于 Xcode 模拟签名，不用于真机或发行。

```sh
GEM_HOME="$(brew --prefix cocoapods)/libexec" "$(brew --prefix ruby)/bin/ruby" scripts/prepare-ios-native-qa.rb --account
EXPO_NO_DOTENV=1 EXPO_NO_BUNDLE_SPLITTING=1 xcodebuild build-for-testing \
  -workspace apps/mobile/ios/Siyue.xcworkspace -scheme AccountAuthUITests \
  -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/siyue-account-ios \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
```

从 `xcrun simctl list devices booted` 选择明确的 QA 模拟器，将其标识设为 `SIYUE_QA_IOS_ID`。安装该构建目录的 `SiyueAccountQA.app` 和 `AccountAuthUITests-Runner.app`；运行：

```sh
xcodebuild test-without-building \
  -workspace apps/mobile/ios/Siyue.xcworkspace -scheme AccountAuthUITests \
  -configuration Release -destination "platform=iOS Simulator,id=$SIYUE_QA_IOS_ID" \
  -derivedDataPath /tmp/siyue-account-ios \
  -resultBundlePath "artifacts/account-ui-native/run-$(date +%s).xcresult" \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
```

AccountAuthUITests 覆盖中英／明暗、登录、终止后恢复、设备撤销后不恢复及初始化标记存在但 SecureStore 内容缺失。最后一项仅在独立 QA app 中初始化测试安全包、通过 Expo SecureStore 删除，再冷启动断言显示存储损坏提示而不是空登录记录。截图作为 XCTest 附件保存。文字输入成功不自动证明软件键盘显示、真机自动填充、iPad 已执行或设备安全性。

重复运行账号空间或损坏存储用例前，须保证隔离 QA 包处于干净安装状态；上轮用例可能已建立本机账号空间或故意留下损坏凭据。可先执行 `xcrun simctl uninstall "$SIYUE_QA_IOS_ID" app.siyue.mobile.accountqa`，只清除独立 QA 包的合成测试数据，不操作正式思玥应用。`testChineseLightRecovery` 与 `testEnglishDarkRecovery` 在账号页列出本设备，经原生确认撤销当前会话，并检查冷启动后不能恢复登录。`testOtherAndAllDeviceRevocation` 使用 QA 服务注册时生成的第二个合成设备，依次验证密码重新验证、撤销其他设备、撤销全部设备和冷启动不恢复；单独重复运行它时先重启独立 QA 服务，以生成新的未撤销测试会话。

独立用例 `testAccountSpaceWhiteboardIsolationAcrossAccounts` 验收本机账号空间的白板隔离：中文入口用 `native-zh@example.test` 登录并创建本机账号空间，经正式工具栏与真实触摸写入一笔并显式保存，再用 `QA Inspect saved board` 读取该空间的元素与摘要；冷启动后元素、摘要与命名空间必须一致；退出登录后 `local` 范围不得出现同一元素的 ID；英文入口用 `native-en@example.test` 创建另一账号空间并要求恰为空；重新登录中文账号要求元素、文件摘要与命名空间恢复且不含 B 的元素。QA 检查入口只读取存档元数据，不注入笔迹，也不读取正式应用数据。该用例与既有会话/撤销用例相互独立，须单独执行一次，不覆盖图片、相机、手写笔、非空访客白板或真机。

先按上文完成 `build-for-testing`，再干净安装并单独执行：

```sh
xcrun simctl uninstall "$SIYUE_QA_IOS_ID" app.siyue.mobile.accountqa
xcrun simctl install "$SIYUE_QA_IOS_ID" /tmp/siyue-account-ios/Build/Products/Release-iphonesimulator/SiyueAccountQA.app
xcrun simctl install "$SIYUE_QA_IOS_ID" /tmp/siyue-account-ios/Build/Products/Release-iphonesimulator/AccountAuthUITests-Runner.app
xcodebuild test-without-building \
  -workspace apps/mobile/ios/Siyue.xcworkspace -scheme AccountAuthUITests \
  -configuration Release -destination "platform=iOS Simulator,id=$SIYUE_QA_IOS_ID" \
  -derivedDataPath /tmp/siyue-account-ios \
  -resultBundlePath "artifacts/account-ui-native/whiteboard-isolation-$(date +%s).xcresult" \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  -only-testing:AccountAuthUITests/AccountWhiteboardIsolationUITests/testAccountSpaceWhiteboardIsolationAcrossAccounts
```

2026-09-24 首次执行通过：1 个测试、0 失败、0 跳过，128.524 秒，`TEST EXECUTE SUCCEEDED`。环境为 Xcode 27.0、已启动的 iPhone 17 Pro 模拟器（iOS 26.5、arm64、`FFFF2B61-63F7-4797-A7DF-53BE95CE3BF8`）、回环临时 PostgreSQL fixture，执行前卸载隔离 QA 包以保证 A 的账号空间为新建。检查结果：A 账号空间命名空间 `57e4254d-…` 绘制前 0 个元素、绘制后 1 个 `freedraw`，元素摘要由 `4f53cda1…` 变为 `b9ede870…`；冷启动与重新登录后元素、元素摘要和文件摘要均与该次保存一致；退出登录后范围为 `local` 且不含该元素；B 的账号空间命名空间 `44cb9dfa-…` 且元素为空。证据保存于本机 `artifacts/account-ui-native/ios-whiteboard-isolation-1790233412.xcresult`，可能不随 Git 分发。该结果只证明此模拟器与合成 fixture 下的账号白板隔离，不代表真机、图片/相机、手写笔或生产服务验收。

### iPad 同用例

iPadOS 在宿主机硬件键盘接入时不显示软键盘，只在输入助手栏提供 `Keyboard` 菜单。用例先请求该菜单里的系统 `Show Keyboard` 条目；只有当平台仍隐藏软键盘时，才改以输入框可点、`typeText` 后完整 value 与随后真实登录结果作为输入证据，iPhone 仍要求软键盘可见；账号空间与白板断言未修改。附件 `keyboard-email-*` 记录每次登录的 `software keyboard visible` 与 `idiom pad`。

iPad 上共 6 次执行，前 4 次都只在测试前置断言 `Native keyboard must be available for real typing` 失败，没有触发任何账号或白板断言：`ios-ipad-whiteboard-isolation-1790234305.xcresult` 与 `-1790234519.xcresult` 为原始断言（后者额外把该 iPad 的模拟器硬件键盘偏好设为 false，该偏好随后已还原），`-1790234791.xcresult` 仅点开输入助手栏 `Keyboard` 菜单，`-1790235067.xcresult` 已点选 `Show Keyboard` 但 15 秒内仍未出现软键盘。这些失败的可访问树显示邮箱输入框为 `Keyboard Focused, Focused`，但屏幕没有软键盘。

设备为已核实的专用模拟器 `Siyue Whiteboard Trial QA iPad`（iPad Pro 13-inch (M5)、iOS 26.5、arm64、`1E1F92B8-B29F-49E0-B137-22A997493073`）；`build-for-testing` 复用 `/tmp/siyue-account-ios`，执行前卸载隔离 QA 包。

```sh
xcrun simctl uninstall 1E1F92B8-B29F-49E0-B137-22A997493073 app.siyue.mobile.accountqa
xcrun simctl install 1E1F92B8-B29F-49E0-B137-22A997493073 /tmp/siyue-account-ios/Build/Products/Release-iphonesimulator/SiyueAccountQA.app
xcrun simctl install 1E1F92B8-B29F-49E0-B137-22A997493073 /tmp/siyue-account-ios/Build/Products/Release-iphonesimulator/AccountAuthUITests-Runner.app
xcodebuild test-without-building \
  -workspace apps/mobile/ios/Siyue.xcworkspace -scheme AccountAuthUITests \
  -configuration Release -destination "platform=iOS Simulator,id=1E1F92B8-B29F-49E0-B137-22A997493073" \
  -derivedDataPath /tmp/siyue-account-ios \
  -resultBundlePath "artifacts/account-ui-native/ios-ipad-whiteboard-isolation-$(date +%s).xcresult" \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  -only-testing:AccountAuthUITests/AccountWhiteboardIsolationUITests/testAccountSpaceWhiteboardIsolationAcrossAccounts
```

第 5 次执行通过：`ios-ipad-whiteboard-isolation-1790235356.xcresult`，1 个测试、0 失败、0 跳过，139.714 秒，`xcrun xcresulttool get test-results summary` 为 `Passed`。检查结果：A 账号空间命名空间 `5c0f90a3-…` 绘制前 0 个元素、绘制后 1 个 `freedraw`，元素摘要 `4f53cda1…`→`ad034856…`；冷启动与重新登录 A 后元素、元素摘要、文件摘要一致；退出登录后为 `local` 且不含该元素；B 命名空间 `06e9a1a7-…` 且为空；重新登录 A 恢复原元素与摘要。该用例只含笔迹，没有图片，`fileDigest` 全程为 `44136fa3…`（空 files 对象）。

同一 build 的第 6 次执行（确认复跑：把此前仅用于诊断的模拟器硬件键盘偏好还原为默认后）同样通过：`ios-ipad-whiteboard-isolation-1790235587.xcresult`，1 个测试、0 失败，141.126 秒，附件记录 `software keyboard visible: true; idiom pad: true`。因此该流程不依赖模拟器偏好改动。

同一 build 的 iPhone 17 Pro 回归（覆盖本文件新的键盘分支）通过：`ios-iphone-whiteboard-isolation-1790235780.xcresult`，1 个测试、0 失败，129.314 秒，附件记录 `software keyboard visible: true; idiom pad: false`，A 命名空间 `11f0ed21-…` 绘制前 0 个元素、绘制后 1 个 `freedraw`（摘要 `4f53cda1…`→`a0cd9e5d…`），B 命名空间 `9b9f3aba-…` 且为空。

以上结果只证明这两台模拟器与合成 fixture 下的账号白板隔离；仍不代表真机、Apple Pencil 压感、图片/相机、非空访客白板、共享房间或生产服务验收。

## Android Emulator

此机 JDK17 与 SDK 在下列路径；其他机器按实际安装修改。QA init script 只覆盖该次构建的应用标识、JS 入口与 release manifest。网络配置默认拒绝明文，仅为回环地址允许测试 HTTP，不修改正式应用网络规则。

```sh
cd apps/mobile/android
EXPO_NO_DOTENV=1 JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
./gradlew assembleRelease --init-script ../e2e/account-auth/android.init.gradle
```

回到根目录后，用 `aapt2 dump badging` 确认 APK 标识为 `app.siyue.mobile.accountqa`，再安装到已确认的模拟器。不要将此 APK 发布为产品。

```sh
/opt/homebrew/share/android-commandlinetools/platform-tools/adb -s emulator-5554 install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
SIYUE_QA_ANDROID=emulator-5554 node apps/mobile/e2e/account-auth/android.mjs
```

SecureStore 缺项恢复使用 `node apps/mobile/e2e/account-auth/android.mjs --vault-loss`。此模式先验证首次安装可打开登录表单，再由 QA 应用自身写入并删除测试 SecureStore 项，冷启动两次检查中文损坏提示不退化为空登录表单，之后验证英文提示。API fixture 必须运行，以供账号页 provider 查询能力；该模式不会创建或登录真实账号。它覆盖返回 null 的应用路径，不模拟 Android Keystore alias 丢失或解密异常。运行完成后 QA 包留在损坏测试状态，普通账号 QA 前须执行 `adb -s emulator-5554 shell pm clear app.siyue.mobile.accountqa`。

自动化通过 UIAutomator 语义标签寻找可点击控件，使用原生键盘输入；仅运行期间映射回环端口，最后移除映射。截图和结果位于 `artifacts/account-ui-android-*`。系统 UI/Launcher ANR 单独留图并有限恢复，应用错误不会自动忽略。

验证账号服务临时故障时，先确认没有其他测试使用上述服务，然后以 `SIYUE_QA_PROVIDER_FAILURES=1 node tests/e2e/native-account-server.mjs` 启动全新的隔离服务，再运行 `node apps/mobile/e2e/account-auth/android.mjs --provider-outage`。脚本确认只有一条服务不可用提示，点击重试后进入真实登录，再执行中英恢复流程。故障计数仅存在测试服务，正式 API 不支持此环境变量。务必等待 APK 安装完成后再启动测试。

这两种原生测试不能用浏览器 Playwright 验证 Keychain/Keystore；桌面表单、重置密码与故障重试由仓库 `tests/e2e/account-ui.spec.mjs` 的 Playwright 用例覆盖。原生测试不代表真实邮件、Apple 登录、生产部署或真机验收完成。

账号空间接入后，可运行 `node apps/mobile/e2e/account-auth/android.mjs --workspace`，在两种语言中通过真实账号页面显式创建账号空间，再验证冷启动与退出。该流程使用正式 WorkspaceProvider，但不包含白板笔迹、相机、原空间关联验收。

白板账号隔离验收使用 `node apps/mobile/e2e/account-auth/android.mjs --whiteboard`（包含 workspace 流程）。使用全新的隔离测试服务账号；通过正式白板工具栏与原生触摸写入笔迹，验证 A/B 各自冷启动及重新登录 A 的元素与文件摘要一致。QA 检查入口只读取存档元数据，不注入笔迹。该脚本不覆盖图片、相机、手写笔或非空访客白板。QA Gradle 输入包含共享包 src/dist，避免共享代码改动被旧 JS 构建缓存掩盖。

`--whiteboard` 另覆盖 HOME → 返回白板 → 第二笔书写，断言两笔落盘并在冷启动、A/B 切换后恢复。此项证明返回后可继续编辑与内容保留，不单独证明 DOM 实例或撤销历史未重建；相册返回仍是独立待验收场景。

相册图片模式使用 `node apps/mobile/e2e/account-auth/android.mjs --images`，包含 `--whiteboard` 的账号及后台返回场景。脚本将仓库合成题图复制到模拟器专用 Pictures/SiyueQA 目录并扫描媒体记录，按指定文件的媒体时间和设备时区生成系统选择器标签；要求恰好一条匹配，不以列表第一项代替目标。当前系统选择器测试要求 Android 系统语言为英语（应用仍测中英）。A 插图批注，B 不插图；比较落盘元素与完整 files 摘要，验证图片不串号及重新登录 A 恢复。保存的是产品重编码后的 JPEG，不以源 PNG 的哈希作相等断言。此模式还会在已有内容上重新打开相册并通过系统返回键取消，比较前后全部元素及图片摘要；仍不包含真实相机、权限拒绝或 iOS 验收。

计划草稿舍弃路径可运行 `node apps/mobile/e2e/account-auth/android.mjs --draft-discard`。它直接导入正式 `PlanCreateScreen`，在 Android 原生中文／英文界面输入未提交目标、触发离开确认并选择舍弃，再断言同一进程重新打开页面时输入已清空。此项仅验收明确舍弃行为，不代表跨账号草稿隔离、切换提示或强杀恢复通过。

计划草稿空间隔离可运行 `node apps/mobile/e2e/account-auth/android.mjs --draft-isolation`。QA-only `draft-scope` 页面直接挂载正式 `PlanCreateScreen`，用真实 AuthController 登录临时 PostgreSQL fixture 中的两个合成成人账号，并经 WorkspaceProvider 显式建立独立本机空间；验证 local→A→B→A→local 的字段隔离和进程内恢复。测试包内的 QA Scope 按钮只用于选择种子测试身份，不进入产品路由。它不代表跨空间切换 UI 已提供确认提示，也不覆盖强杀后恢复；UIAutomator 结果与截图保存在 `artifacts/account-ui-android-*`。

正式计划页的“保留输入并返回”及空间切换提示可运行 `node apps/mobile/e2e/account-auth/android-draft-switch.mjs`。该独立 UIAutomator 用例在中文和英文下通过正式 `PlanCreateScreen` 保留本机草稿，登录合成账号并创建本机账号空间，验证切换提示、新空间输入为空；再验证退出登录后本机输入恢复、重登录后账号空间输入恢复。可设 `SIYUE_QA_LOCALE=zh` 或 `en` 单独运行一种语言。只使用隔离 QA 包和回环临时 PostgreSQL fixture，不代表 iOS/iPad、强杀恢复或真实服务验收。测试截图和 `result.json` 保存在 `artifacts/account-ui-android-draft-switch-*`。

## 注销专项（2026-09-25）

新增 `testDeletionChinese` / `testDeletionEnglish`，只用于独立 QA 包和合成账号。启动 `node tests/e2e/native-deletion-server.mjs`（与原账号 fixture 使用相同 18787 端口，不能同时运行）；它建立临时主库和独立注销账本，注册正式提交路由并运行受保护清理。四个账号按 phone/pad 和 zh/en 区分，密码为 `siyue-native-test-password`。重新执行已删除账号的用例前，重启本 fixture 以创建新的合成账号；不要清理正式应用数据。

QA 控制器使用独立回执 SecureStore 槽。用例通过真实页面登录、预检、密码确认、提交，然后重启应用查看同一作业进度；不调用真实 Apple、不发邮件。只运行这两个测试时，在上述 `test-without-building` 命令追加 `-only-testing:AccountAuthUITests/AccountAuthUITests/testDeletionChinese -only-testing:AccountAuthUITests/AccountAuthUITests/testDeletionEnglish`。

注销用例开始时会点击仅 QA 包提供的 `QA Reset deletion fixture`，清除 `test` 与 `test.deletion-receipt` 两个测试安全槽及其初始化标记，然后重新启动。它不触及正式应用的 keychain service 或生产账号。最终断言要求冷启动后的回执实际读到服务端完成结果，并且页面不存在再次输入密码的控件；仅出现进度标题不算通过。
