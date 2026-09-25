# 后端与账号功能回归复核 · 2026-09-23

本记录仅汇总本轮在当前 `feature/dev` 工作树重跑的验证。工作树包含其他已授权但尚未提交的实现；本轮没有改动应用代码、安装依赖、读取根 `.env`、连接云端或更改服务器。

## 验证结果

| 验证 | 命令 | 结果 |
|---|---|---|
| Adapters 单元测试 | `corepack pnpm --filter @siyue/adapters test` | 82/82 通过 |
| 移动端 | `corepack pnpm --filter @siyue/mobile typecheck`；`corepack pnpm --filter @siyue/mobile test` | 类型检查通过；148/148 通过 |
| 桌面端 | `corepack pnpm --filter @siyue/desktop typecheck`；`corepack pnpm --filter @siyue/desktop test` | 类型检查通过；23/23 通过 |
| Electron 账号表单与邮箱 HTTP 流程 | `corepack pnpm exec playwright test tests/e2e/email-auth.spec.mjs tests/e2e/account-ui.spec.mjs --workers=1` | 6/6 通过：中英文账号 UI 2 项；注册 HTTP、错误/重发限制、错误码与改密 4 项 |
| OpenSpec | `corepack pnpm spec:check` | 6/6 通过 |
| Release 记录 | `corepack pnpm release:check` | 通过；脚本明确不替代人工验收核对 |
| 差异格式 | `git diff --check` | 通过 |

## 验收边界

- 6 项 Playwright 覆盖现有登录／找回 UI 与注册 HTTP API；**没有注册 UI 可供验证**，不能据 HTTP 测试称注册闭环通过。
- 仓库未提供正式用户协议、隐私政策正文及版本。服务端注册确认要求记录两个版本，因此依规格不得构造或提交假同意版本。SA-05 6.3 继续未完成；正式登录、找回与会话恢复不受此门槛影响。
- 本轮 Android 没有连接的模拟器。iPhone 17 Pro 主模拟器保持原运行状态，本轮未对其安装、启动或操作应用；iOS/Android 原生验收沿用各自已有证据，不计入本次执行。
- SA-05 6.2、6.4 与整体认证工作包均未提升状态。此前的白板命名空间、Android 笔迹和相册等验收范围见 [账号空间证据](backend-auth-account-space-2026-09-22.md)。

以上检查使用本地合成测试数据；不证明真实邮件投递、Apple 生产配置、家庭授权、五设备通话或生产部署。
