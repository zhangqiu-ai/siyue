# Apple 重新验证与新增邮箱登录方式 · 2026-09-24

## 实现范围

Apple-only 成人主体可以在服务端使用已绑定的 Apple 身份重新验证当前会话，取得 5 分钟有效、一次性且绑定 `link-identity` 动作的 grant。Apple reauth flow 持久绑定发起 session；完成时重验会话、Apple 身份所属主体和状态，只签发 grant，不新建主体、身份或会话。`0007_apple_reauth_purpose.sql` 为既有 flow 表追加 purpose/action/session 约束，旧登录 flow 保留原语义。

已登录主体持 grant 请求绑定首个邮箱时，服务端在同一事务中消费 grant、建立绑定到主体／会话／凭据版本的验证码挑战并写加密邮件 Outbox。验证邮件控制权后，同一事务创建已验证登录邮箱与 Argon2id 密码；邮箱已属于别的主体时返回冲突，不合并账号，也不使用 Apple 资料邮箱自动建凭据。已具备邮箱或密码的主体转由后续改邮箱流程处理。请求有邮箱、IP、全局及主体级发信预算；同一 session 的 access token 刷新后，60 秒内同幂等键仍能找回已受理的挑战，不重复发信。

共享 API client 已加入严格的 Apple reauth、邮箱绑定请求／确认方法和 `email_already_linked` 错误语义。共享认证控制器增加 Apple 重新验证并请求绑定、验证码确认两步：grant 只留在一次性操作闭包内，不进入 UI 状态或安全存储；同一会话内丢失 Apple complete 或绑定受理响应时保留原请求身份重试，退出／换号后清除待处理操作。**产品账号页及桌面受限 IPC 尚未接线**，所以本证据不证明用户已能在应用中完成绑定。

## 验证

环境为本机 loopback Fastify、每次测试新建的临时 PostgreSQL、合成 Apple 验签／换码适配器与本地注入收件适配器。未访问真实 Apple、SMTP 或生产 API。

- `corepack pnpm build:packages` 与 `corepack pnpm --filter @siyue/server build`：通过。
- `corepack pnpm exec playwright test tests/e2e/apple-email-link-journey.spec.mjs tests/e2e/apple-reauth.spec.mjs tests/e2e/link-email.spec.mjs tests/e2e/email-auth.spec.mjs tests/e2e/session-management.spec.mjs tests/e2e/auth-client.spec.mjs --reporter=line`：控制器加入后的完整定向重跑 36/36 通过。联合用例从合成 Apple 登录、同一 Apple 身份重新验证、邮箱验证码绑定走到 Android 平台邮箱密码登录，核对全过程只有同一 subject；换 Apple 身份不能取得 grant。
- `node --test apps/server/tests/integration/database.test.mjs apps/server/tests/integration/apple-reauth.test.mjs apps/server/tests/integration/email-link.test.mjs`：25/25 通过，含新迁移的空库／旧库升级、会话与动作绑定、并发、回滚、撤权、预算以及 access 刷新后找回 202 响应。服务端完整集成测试在实现后运行 100/100；本轮定向重跑覆盖这次改动的关键路径。
- `corepack pnpm --filter @siyue/contracts test`：32/32；共享控制器加入后 `corepack pnpm --filter @siyue/adapters test`：103/103；`corepack pnpm typecheck`：13/13 任务，通过。`tests/e2e/auth-client.spec.mjs` 的真实 HTTP／临时 PostgreSQL 路径验证控制器绑定、Apple complete 响应丢失、绑定受理响应丢失及 logout 代际取消。

## 验收边界

Apple provider 在应用配置中仍默认关闭；没有 Apple Developer 真实签名与授权、真实邮件送达、账号页绑定入口或 iPhone/iPad/Android 真机绑定操作。当前不能将 ACC-01／ACC-04、SA-06／SA-07 或整个账号工作包标为完成。后续需要完成中英 UI、受限宿主接线与设备验收，并实施安全解绑、注销与外部撤销。
