# SA-05 原生安全存储缺项保护复验 · 2026-09-23

## 变更

Expo SecureStore 在 Android KeyStore key 缺失或永久失效时可能返回 `null` 并移除加密项；仅检查 `getItemAsync()` 会把安全存储损坏误认作首次安装。移动 vault 现使用 SQLite 保存非秘密的环境初始化标记：首次空安装仍允许继续；一旦曾写入过安全包，后来 SecureStore 返回 `null` 就报告 `storage_corrupt`，不写回空包。读取到既有安全包但尚无标记时会补标记，兼容已安装版本。账号页为损坏态显示中英文本地恢复指引。标记不含 token、账号或个人资料。

QA 专用原生入口加入“初始化并移除安全包”动作，只存在于独立 `app.siyue.mobile.accountqa` 测试 bundle。XCTest 由该 App 本身通过 Expo SecureStore 写入和移除模拟项，避免测试 Runner 越权访问宿主 App 的 Keychain。

## 验证

合成账号、临时 PostgreSQL 与独立 iOS Simulator；未访问生产服务或真实账号。

| 检查 | 结果 |
| --- | --- |
| `corepack pnpm --filter @siyue/mobile test` | 143/143 通过，含首次安装、标记后 SecureStore 项消失及读取拒绝的 vault 测试 |
| `corepack pnpm --filter @siyue/mobile typecheck` | 通过 |
| `xcodebuild build-for-testing`，AccountAuthUITests Release 源码构建 | 通过；由 `scripts/prepare-ios-native-qa.rb --account` 生成忽略的 QA target，正常 app target 未改动 |
| iPhone 17 Pro 专用模拟器 `AccountAuthUITests` | 3/3 通过：中文浅色恢复、英文深色恢复、安全项消失后提示保留原件并隐藏登录表单 |
| XCTest 结果 | `artifacts/backend-auth/ios-account-auth-2026-09-23T020600Z.xcresult` |
| Android API 36 AVD `Siyue_API_36` | QA Release APK 构建成功；包标识核对为 `app.siyue.mobile.accountqa`；`--vault-loss` 两种语言通过，两次中文冷启动均不出现邮箱输入框，英文损坏态文案通过 |
| Android UI 结果和截图 | `artifacts/account-ui-android-1790128172620/result.json`、`zh-vault-item-missing.png`、`en-vault-item-missing.png` |
| OpenSpec／release／diff | `spec:check` 6/6、`release:check`、`git diff --check` 通过 |

之前的基线用例结果另保留在 `artifacts/backend-auth/ios-account-auth-2026-09-23T010438Z.xcresult`；本轮完整 3/3 结果适用于当前改动。

## 边界

Android 及 iOS 的模拟器流程都证明应用层在“SecureStore 项返回 null”时不会把它重建为空记录；Android QA 使用 `deleteItemAsync` 删除测试项，未单独删除 Keystore alias，也未诱发 `BadPaddingException` 或 `KeyPermanentlyInvalidatedException`。锁定版 `expo-secure-store@57.0.3` 源码显示缺失 KeyStore entry、永久失效及 BadPadding 路径会删除/返回 null；这是源码核对加同观察值的模拟器验证，不是对真实加密故障的设备复现。真机、系统存储不可用/磁盘写失败、Windows/Linux 系统后端仍未验收，所以 SA-05 6.2 保持未勾选。QA 模拟器在测试前清空的是专用合成环境；用户正在使用的 iPhone 17 Pro 主模拟器未清理或重启。
