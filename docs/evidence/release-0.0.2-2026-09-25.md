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

真实 Resend 与 Gmail 的注册、重启恢复、密码再登录、注销及注销后拒绝登录已在[线上账号生命周期证据](online-account-lifecycle-2026-09-25.md)通过。

## 0.0.2 服务端工件与生产复核

- 服务端工件从提交 `95565e1` 构建，release id 为 `0.0.2-95565e1`；tarball SHA-256 为 `c277394d1d52b7e40a3291eae358f5836bc86371dce0d364d552a4c94a64d48f`。工件含 3578 个文件、26 项迁移，本机及目标机缓存 Node 镜像内的 manifest、逐文件摘要、运行依赖与入口探针均通过。
- 生产目录切换到 `/opt/siyue/releases/20260925-002/0.0.2-95565e1`。API 与邮件 worker 均运行镜像 tag `siyue-server:0.0.2-95565e1`，镜像 ID `sha256:4ecd80111c27b882cb033912679ba0061c6100a3d5ce238feb85680f7b0a928c`；复核时二者 restart count 均为 0。
- 26 项迁移 checksum 与线上完全一致，因此没有重复运行建库或迁移。部署后 live、ready、协议及隐私页面均为 200；裸前缀与未知路径为 404，协议目录为 403；原秋哥 cloud health 仍为 200。
- 生产启动保留账号生命周期和注销所需家庭查询，但未发布的设备配对、儿童创建与家庭邀请接受路由均返回 404。
- 对该精确部署重新执行真实公网生命周期 Playwright：**1 passed，1.0 分钟**。它使用实际 Gmail 验证码，完成注册、重启恢复、退出后密码登录、注销、再次重启及旧密码拒绝登录；测试主体 `919a997d-db6a-4b54-8a05-1ed07c5a2dfe` 已在用例内完成注销。

此前 `0.0.1-fee1f4b-dirty` 工件只保留为历史部署证据，不作为 0.0.2 发布身份。最终 Git 标签还会包含本文与 preflight 兼容修正；服务端运行工件的源代码身份固定为 `95565e1`。
