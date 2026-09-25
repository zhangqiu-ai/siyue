# 邮箱改密客户端闭环（2026-09-23）

## 范围

在现有邮箱账号流程中接入已实现的 `reauth/password` 与 `/me/password/change`：当前密码再次验证、动作绑定 grant、新密码确认、幂等改密、服务器确认后清除本机当前恢复凭据，并要求使用新密码重新登录。实现位于共享认证控制器、严格合同、Electron 受限 IPC、桌面账号页和移动账号页；没有改变账号、家庭、视频或白板数据范围。

改密访问令牌不传入 Electron renderer。当前密码、新密码、grant、访问令牌和幂等 key 不写入磁盘；结果未知时仅在共享控制器内存保持原请求，输入锁定，并通过不含秘密的状态标记恢复同进程重开账号面板的重试入口。服务器确认改密后才从安全 vault 清除本机 active recovery。应用重启会清除未确认请求的临时秘密；服务端为防止重复改密提供幂等终态，用户可用新密码重新登录确认状态，不承诺跨重启恢复原请求秘密。

## 验证

环境为本机 macOS Electron + 临时 PostgreSQL；测试使用合成邮箱、密码和邮件 outbox，不访问真实 SMTP、生产 API 或真实用户数据。

- `corepack pnpm build:packages`：通过。
- `corepack pnpm --filter @siyue/adapters test`：83/83 通过，含严格改密 HTTP 合同测试。
- `corepack pnpm --filter @siyue/desktop typecheck`：通过。
- `corepack pnpm --filter @siyue/mobile typecheck`：通过。
- `corepack pnpm --filter @siyue/desktop build`：通过；打包器报告现有大 chunk 警告，不影响本次构建成功。
- `corepack pnpm exec playwright test tests/e2e/account-ui.spec.mjs`：2/2 通过（简体中文、英文，真实 Electron 界面与临时 PostgreSQL 服务）。

Playwright 覆盖错当前密码、两次新密码不符、成功再次验证、英文场景在服务器完成改密后故意把 HTTP 响应改为 503、以同一幂等 key 重试、确认所有旧会话已撤销、凭据版本只增加一次、只产生一条 `password.change` 安全事件，并以新密码重新登录。两种语言均验证了改密及重新登录。

## 未覆盖与工作包状态

移动端仅完成共享控制器和账号页代码接入；本轮没有运行 iPhone、iPad、Android 原生改密 UI/手势验收。未验证 app 被系统强杀时内存请求恢复，也未验证真实邮件送达或生产服务。注册仍因正式服务条款与隐私文案/版本缺失而门控。SA-05 的其他客户端、注册、空间隔离与平台验收仍未完成；不得据此标记 SA-05/SA-04 或整个账号工作完成。
