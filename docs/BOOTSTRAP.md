# 工程初始化记录

日期：2026-09-05

## 本轮创建

- `apps/mobile`：Expo SDK 57 + Expo Router，iOS 优先、Android 同源支持。
- `apps/desktop`：Electron 44 + React + Vite，Renderer 与 Node 权限隔离。
- `apps/server`：Node + Fastify，首轮只提供健康检查和确定性 Mock AI 计划接口。
- `packages/domain`：纯 TypeScript 的 PersonalSpace / Goal / Project / Task / CommandReceipt。
- `packages/contracts`：Zod 运行时协议，首轮包含命令信封与 ActionDraft。
- `packages/ai`：AgentExecutor 接口 + MockAgentExecutor；AI SDK 作为底座依赖，但首轮不接真实模型。

## 当前固定版本

| 组件 | 版本 |
|---|---:|
| Node 最低版本 | 22.13.0 |
| pnpm | 11.25.0 |
| TypeScript | 7.0.2 |
| Expo | 57.0.20 |
| Expo Router | 57.0.19 |
| React | 19.2.3 |
| React Native | 0.86.3 |
| Electron | 44.2.0 |
| Vite | 8.2.2 |
| AI SDK (`ai`) | 7.0.92 |
| Fastify | 5.12.3 |
| Zod | 4.5.4 |

这些版本基于 2026-09-05 可查到的当前稳定版本建立初始化基线；真正的兼容性结论仍以 `pnpm install`、三端构建和真机结果为准。

## 首次安装

```bash
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install
```

Expo Router 的原生 peer dependency 应通过 Expo CLI 按 SDK 57 解析，而不是手工猜版本：

```bash
pnpm --filter @siyue/mobile exec expo install react-native-safe-area-context react-native-screens
```

安装完成后必须提交生成的 `pnpm-lock.yaml`，再把 CI 切换为 frozen lockfile。

## 开发入口

```bash
pnpm dev:mobile
pnpm dev:server

# 桌面当前用两个终端，避免为启动编排过早增加依赖：
pnpm dev:desktop:renderer
pnpm dev:desktop:electron
```

## 尚未验证

- 本环境未执行 `pnpm install`，因此没有依赖锁文件，也没有声称构建通过。
- iOS / Android 原生工程、Development Build 与真机尚未生成/验证。
- SQLite / PowerSync 尚未接入，遵循 SY-003 先做 PoC。
- 真实模型 Provider 尚未接入；Mock 路径是故意的安全基线。
