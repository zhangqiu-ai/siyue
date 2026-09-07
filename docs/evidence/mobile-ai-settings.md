# 移动 AI 基础对话与设置验证

日期：2026-09-06。范围：SY-021，以及 SY-005 的移动个人密钥部分。维护者明确要求补齐基础对话、国内 AI 自定义密钥和基础设置，并选择通用 OpenAI 兼容接口。保留工作区已有黑白主题修改。

## 实现与边界

- 设置页：明暗主题、DeepSeek / 通义千问北京预设、可编辑 HTTPS 基础地址和模型、个人密钥保存/移除、可取消连接测试、本机数据说明和版本。预设不是供应商切换授权，保存前由用户核对地址和模型。
- 一份版本化 SecureStore 记录绑定地址、模型与密钥；不落入 SQLite、环境变量或日志。留空仅在相同标准化地址下保留原密钥；地址变化必须重新填写。读取失败、损坏、未知版本、写入失败均不降级到明文。iOS 使用 WHEN_UNLOCKED_THIS_DEVICE_ONLY；Android 排除 SecureStore 备份。
- 普通聊天由 assistant-ui runtime 消费 expo/fetch 的 OpenAI 兼容 SSE；只发送当前分支可见的用户/助手文字，无目标、任务、其他会话或工具。未配置时明确引导设置，不回退 Mock。请求禁止重定向、无自动重试、90 秒超时、最多 2048 输出 tokens；超过 60000 字符的会话要求新建，不静默截断历史。用量与金额未核算，不显示虚构的零费用。
- 流式回复可停止和重新生成，错误仅展示客户端固定文案。SSE 支持分片 UTF-8/CRLF；畸形、提前断流、达到长度上限、内容过滤及不支持的工具调用均不得当作正常完成。输入保持普通文字，未实现语音输入或 Markdown 富渲染。
- 保存/移除配置取消在途请求并替换会话列表 adapter，清除已有对话记录，保留根导航和业务页面；未发送的新会话输入可保留。后台取消聊天与连接测试，不自动恢复请求。
- 聊天仍仅本次运行内存保留；正式目标与行动继续使用原有 Mock 草稿及审批/SQLite 命令闭环。新增聊天不代表真实模型已接入正式行动生成，也不代表 M1 或全部安全验收完成。

## 实际执行

工作目录 `/Users/feature/code/siyue`；Node 22.22.3；根入口 corepack pnpm 11.25.0；Expo 57.0.20 / RN 0.86.3；Xcode 26.6 (17F113)；CocoaPods 1.17.0；模拟器 Siyue M1 QA，iPhone 17 Pro / iOS 26.5，UUID `7328BC59-6853-445B-A888-E99496AB2048`。

- 安装：在线 `expo install expo-secure-store` 初次 TLS 失败；`EXPO_OFFLINE=1 corepack pnpm --filter @siyue/mobile exec expo install expo-secure-store` 使用已安装 SDK 的 bundledNativeModules，安装 `~57.0.3` / 锁定 57.0.3 并增加插件。Expo 子进程安装日志为 pnpm 11.19.0；锁文件仅新增 SecureStore，根入口仍为 11.25.0。
- `corepack pnpm --filter @siyue/mobile test`：38 项通过（26 transport、6 credential store、6 原有测试），0 失败。日志 `/tmp/siyue-byok-tests.log`。使用合成密钥与注入 fetch，不访问供应商。
- `corepack pnpm --filter @siyue/mobile typecheck`：通过。日志 `/tmp/siyue-byok-typecheck.log`。
- `corepack pnpm --filter @siyue/mobile exec expo export --platform ios --platform android --output-dir dist`：双平台 Hermes 导出通过；日志 `/tmp/siyue-byok-export.log`。
- iOS Pod 安装：`LANG=en_US.UTF-8 SSL_CERT_FILE=/opt/homebrew/etc/ca-certificates/cert.pem pod install`，工作目录 `apps/mobile/ios`；首次 Maven HEAD 临时失败，相同命令重试通过，包含 ExpoSecureStore 57.0.3。日志 `/tmp/siyue-byok-pods-retry.log`。
- 首次 iOS Debug 构建通过，但关闭签名的旧命令产生无 application identifier 的模拟器产物，真实 SecureStore 读取失败。系统 securityd 确认 -34018 缺 entitlement。不能将该构建通过当作密钥存储通过；随后补充模拟器签名验证。
- Android 已生成工程的 Manifest 同步 SecureStore 插件要求的 `fullBackupContent` / `dataExtractionRules`；资源由库提供，XML 属性检查通过。没有本轮 Android 原生重建。

### iOS 模拟器签名与实际交互

仅设置 `CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-` 仍未生成 Keychain 权限。尝试直接 codesign 添加权限被宿主 AMFI 以 restricted entitlements 拒绝启动；修复为由 Xcode 生成模拟器专用 `Simulated.xcent`，而不是把设备权限写进宿主签名。最终构建、安装、启动通过，日志 `/tmp/siyue-byok-ios-sim-entitlements-build.log`。

当次使用 `/tmp/siyue-byok-simulator.entitlements`，其相同 plist 内容已保留于 `scripts/ios-simulator.entitlements`，只供本地正常 Siyue 模拟器 target 使用，不供 QA 其他 bundle、真机或发布签名使用。再次构建需保留该参数，避免覆盖可用产物的模拟器权限：

```sh
/usr/bin/xcodebuild build \
  -workspace apps/mobile/ios/Siyue.xcworkspace -scheme Siyue -configuration Debug \
  -destination 'platform=iOS Simulator,id=7328BC59-6853-445B-A888-E99496AB2048' \
  -derivedDataPath /tmp/siyue-ios-debug-derived \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  CODE_SIGN_ENTITLEMENTS="$PWD/scripts/ios-simulator.entitlements" \
  CC="$PWD/scripts/xcode-probe/clang" CXX="$PWD/scripts/xcode-probe/clang++"
xcrun simctl install 7328BC59-6853-445B-A888-E99496AB2048 /tmp/siyue-ios-debug-derived/Build/Products/Debug-iphonesimulator/Siyue.app
xcrun simctl launch 7328BC59-6853-445B-A888-E99496AB2048 app.siyue.mobile
```

原生 UI 手动检查使用合成 `example.invalid` 配置，无真实密钥：

- 缺密钥发送：保留用户输入，显示“请先在设置中配置 AI 服务和密钥”，可重新生成。
- 设置保存成功：密钥输入清空，显示已保存；设置页未重挂，成功提示保留。返回聊天显示空态，旧对话清除。
- 改为另一地址且密钥留空：保存拒绝，显示需要重新输入该服务密钥；未保存配置不可测试。
- 终止并重新启动正常 App：原地址/模型与“已保存”状态保留，密钥不回填；失败的地址变更未覆盖原记录。
- `.invalid` 地址连接失败：固定中文错误，表单恢复；再次测试可以取消并恢复按钮。
- 移除本机测试配置：确认后删除；不读取或清理目标数据。

聊天 SSE 的成功增长、断流、上限和取消由 26 项注入 fetch 测试验证；尚未在模拟器验证真实供应商的成功流式回复。未进行完整目标业务原生回归。

## 未验收

未使用真实用户密钥，未调用或付费测试 DeepSeek、通义或其他真实供应商。需维护者在 App 内填写自己的配置后执行连接测试和真实多轮对话；不要把密钥发到任务聊天里。未进行 iOS/Android 真机测试、Android 本轮原生安装、桌面设置开发、发布、提交或推送。此前 M1 业务原生验收不算本次变更后的完整回归。

## 官方资料与本地兼容证据

查阅日期 2026-09-06：

- [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/)：安全键值与平台限制；具体安装版本由 SDK57 bundledNativeModules 与实际构建核验。
- [Expo fetch](https://docs.expo.dev/versions/latest/sdk/expo/)：原生流式 fetch；本地 Expo57 iOS NativeResponse.swift 与 Android NativeRequest.kt 已核实实现 redirect:error。
- [DeepSeek API](https://api-docs.deepseek.com/)：OpenAI 兼容端点、deepseek-v4-flash 预设。
- [通义 OpenAI 兼容接口](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)：地域/业务空间与密钥绑定。预设提供北京旧通用地址，可按控制台改为业务空间专用地址；模型与接口可用性必须实际验证。


## 2026-09-07 · 模型获取与真实 DeepSeek 验证

本节补充并覆盖前文“模型可编辑”和“未调用真实供应商”的相应历史状态，不提升工作包完成状态。

- 模型输入改为供应商 `GET /models` 列表选择，支持搜索和刷新；不自动使用预设模型名。新密钥可在保存前获取列表；密钥留空时仅对相同标准化地址复用安全存储记录。地址变化清空输入密钥与模型，密钥变化清空列表与选择。成功刷新后失效模型需重选，失败保留原选择。
- 获取可取消，离页/后台取消，15 秒超时，无自动重试或重定向；返回列表运行时校验，错误使用固定中文文案。不支持此接口的服务会明确失败，不回退手填。列表不保证全部模型支持聊天，需连接测试。
- 移除设置页“官方文档”入口和聊天气泡上方“你 / AI”名称；保留消息内容、对齐及操作无障碍标签。
- 工作目录 `/Users/feature/code/siyue`，Node 22.22.3。`corepack pnpm --filter @siyue/mobile test`：61 项通过、0 失败（新增 23 项模型列表测试），日志 `/tmp/siyue-model-tests.log`。`corepack pnpm --filter @siyue/mobile typecheck`、`git diff --check` 通过。
- 正常 Debug 应用通过 `corepack pnpm --filter @siyue/mobile start --localhost` 加载最新 JavaScript；在 Siyue M1 QA / iOS 26.5 模拟器 `7328BC59-6853-445B-A888-E99496AB2048` 检查了页面截图、模型按钮和缺密钥提示。未重新构建原生二进制。
- 维护者明确授权保存测试密钥并实际调用 DeepSeek。通过应用安全输入框填写，真实获取返回 `deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`；选择 flash 后保存，界面显示“已安全保存”，输入框不回填。再用留空密钥刷新成功，保留所选模型。
- 应用连接测试显示“连接成功”；正常聊天发送“请只回复：连接正常”，实际收到“连接正常”，生成结束、发送按钮恢复。AX 树及截图确认没有“你 / AI”名称，配置保留供维护者继续测试。本文不记录密钥；未测试其余模型、Android、真机、重启配置恢复或本次完整业务回归，未核算实际费用。
- 官方协议依据（2026-09-07）：[DeepSeek List Models](https://api-docs.deepseek.com/api/list-models/)、[OpenAI List Models](https://developers.openai.com/api/reference/resources/models/methods/list)。真实成功证据仅覆盖上述 DeepSeek 地址与所选模型，不代表其他预设兼容。

本轮未提交、推送或部署。
