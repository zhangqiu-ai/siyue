# SA-05 账号切换时保留未提交桌面输入 · 2026-09-23

## 问题与改动

真实 Electron 回归加入本机、账号 A、账号 B 三套未提交目标/项目输入，并在退出、换号和重新进入后逐项核对隔离与恢复。场景暴露了账号切换虽然正确重挂空间和编辑器，但设置对话框也一起被销毁；登录成功后界面回到设置首页，无法自然继续创建或切换账号空间。

桌面设置模块现在将非敏感的对话框打开状态和“账号”子页导航状态保留在 renderer 进程内。工作区因登录/退出重挂后，如果用户原本在账号页，就恢复账号页。E2E 回归同时验证未提交输入：本机输入不进入 A/B，A 输入不泄露给 B，退出后本机输入仍在，重新登录 A/B 后分别恢复各自输入。测试随后继续验证正式目标数据、白板笔迹和图片隔离、进程重启及撤销会话路径。

未保存输入仍只保证当前进程内保留；不承诺进程崩溃/强退后的草稿恢复。

## 验证

| 命令／场景 | 结果 |
| --- | --- |
| `corepack pnpm --filter @siyue/desktop build` | 通过 |
| `corepack pnpm --filter @siyue/desktop typecheck` | 通过 |
| `corepack pnpm --filter @siyue/desktop test` | 23/23 通过 |
| `corepack pnpm exec playwright test tests/e2e/desktop-account-space.spec.mjs --workers=1` | 1/1 通过；真实 Electron renderer、主进程认证桥、隔离 PostgreSQL 与临时 userData |
| `corepack pnpm exec playwright test tests/e2e/desktop-auth.spec.mjs --workers=1` | 1/1 通过；真实 Electron 安全存储、登录、重启、退出回归 |

首轮用旧 renderer bundle 重跑仍失败，确认该 QA 命令不会自动编译桌面包；显式重建 renderer 后，测试通过。最终通过结果均来自重建后的实际 Electron bundle。

## 边界

本轮只关闭 SA-05 6.4b 中桌面设置导航和桌面未提交输入这一部分缺口。移动端空间切换时的未提交表单、离线未决命令与白板 DOM/图片原件切换仍需独立原生验收；所以 6.4b 与 6.4c/d 均保持未勾选。未使用生产账号、邮件或云服务。
