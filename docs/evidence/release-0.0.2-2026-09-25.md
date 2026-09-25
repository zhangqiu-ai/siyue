# 0.0.2 发布收口证据 · 2026-09-25

## 候选版本

- 根工程、桌面、移动、服务端及共享包版本均为 `0.0.2`。
- Expo iOS `buildNumber` 为 `2`，Android `versionCode` 为 `2`。
- `corepack pnpm bundle:mobile` 成功导出 iOS、Android 与白板 DOM bundle。

## 自动化验证

- `corepack pnpm test`：13/13 Turbo 任务通过；其中 adapters 274/274、server 58/58、desktop 32/32、mobile 150/150。
- `corepack pnpm typecheck`：13/13 Turbo 任务通过。
- `corepack pnpm build`：7/7 Turbo 任务通过。
- `corepack pnpm test:e2e`：169 passed、1 skipped，耗时 7.5 分钟。跳过项是必须显式提供真实邮箱输入的公网生命周期用例；它不以普通全量回归重复发送邮件。
- `corepack pnpm spec:check`：6/6 通过；`corepack pnpm release:check` 与 `git diff --check` 通过。

## 已连接 iPhone

在维护者已连接且启用开发者模式的 iPhone 16 Pro Max（iOS 26.6.2）上完成：

1. 从 0.0.2 源码生成 iOS 工程并安装 Pods。
2. 使用 Release 配置、Apple Development 证书和已登记该设备的开发描述文件编译成功。
3. 构建产物 `Siyue.app` 的 bundle id 为 `app.siyue.mobile`，版本为 `0.0.2`，build 为 `2`；`codesign --verify --deep --strict` 通过。
4. 通过 `devicectl` 安装并启动；设备回读版本 `0.0.2`、build `2`，应用进程持续运行。
5. 启动后主页正常渲染，截图见[真机启动结果](siyue-0.0.2-iphone-device-2026-09-25.png)。

本机只有通配开发描述文件，未包含 Sign in with Apple entitlement。因此这次真机烟测在生成且被 Git 忽略的 iOS 工程中移除了该 entitlement；源码配置仍保留 Apple 能力声明。该产物只用于本机开发安装与邮箱账号路径烟测，不是 App Store、TestFlight 或真实 Apple 登录验收产物。

## 公网边界

真实 Resend 与 Gmail 的注册、重启恢复、密码再登录、注销及注销后拒绝登录已在[线上账号生命周期证据](online-account-lifecycle-2026-09-25.md)通过。0.0.2 精确提交对应的服务端工件、部署摘要和再次公网验收在发布操作完成后追加；此前 `0.0.1-fee1f4b-dirty` 工件不作为 0.0.2 发布身份。
