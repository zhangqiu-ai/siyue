# 邮箱登录方式安全解绑 · 2026-09-24

代码范围：`DELETE /v1/me/identities/{identityId}` 只接收当前账号可用邮箱方式的 `email:<uuid>` 标识、当前访问令牌和一次性 `unlink-identity` 授权。Apple 方式的主动解绑未开放。路由只在邮件 Outbox 可用时注册，以免解绑后无法排入安全通知。

解绑服务在主体行锁和单个 PostgreSQL 事务内校验剩余 Apple 身份及其 provider 凭据、消费授权、删除邮箱和适用的密码凭据、增加凭据版本、撤销该主体的全部会话及未完成授权、作废相关邮箱挑战、向原地址排入 `email-unlinked` 安全通知并记录脱敏审计。最后方式、错误动作、他人方式和失效授权均拒绝；失败事务回滚，包括授权消费和通知。通知仅入本地加密 Outbox，未证明真实邮箱送达。

子任务已运行：服务端集成 118/118，认证相关 Playwright HTTP 48/48，contracts 35/35、server 单测 35/35、adapters 113/113，13 个包类型检查及 `spec:check` 6/6 通过。主任务复核发现登录方式摘要与解绑对 Apple provider 凭据的可用性判断不一致，已统一；又增加资料邮箱不能通过登录方式端点删除的回归。主任务重建 server 并运行 `node --test apps/server/tests/integration/identities.test.mjs apps/server/tests/integration/identity-unlink.test.mjs`，14/14 通过；两条对应的 Playwright HTTP 文件 6/6 通过。

共享 API client 增加严格 `unlinkIdentity` DELETE 和最后方式/方式不存在错误码，认证控制器用当前会话密码取得动作授权、确认成功后清理本地会话，对丢响应只探测会话失效而不重发 DELETE。移动和桌面的中英错误文案已加对应映射，正式调用按钮尚未接入。子任务验证 adapters 119/119，移动/桌面类型检查通过。主任务用真实 Fastify、临时 PostgreSQL 和合成 Apple 身份增加共享客户端联合 Playwright：成功解绑后本地登出并用 Apple 重新进入同一主体；丢失成功响应时 DELETE 只发一次、服务端只写一次成功审计。`tests/e2e/auth-client.spec.mjs` 27/27 通过。

通知文案复核发现多邮箱账号仍可使用另一个邮箱，因此去掉“只能用 Apple 登录”的不准确表述，改为提示用其余已绑定方式登录。重建 server 后 SMTP 模板与本地 TLS 回归 4/4 通过。

Electron 增加严格 `unlink-identity` IPC 合同，仅传 `email:<uuid>` 方法标识与当前密码，沿用 requestId/generation 和可信 sender 校验；主进程调用同一共享控制器，renderer 只接收并校验公共账号状态。contracts 37/37、桌面主进程单测 27/27、13 个包类型检查与桌面构建通过。Playwright renderer 合同及真实 Electron→HTTP→临时 PostgreSQL 解绑旅程合跑 9/9，后者覆盖成功移除、通知入队、旧邮箱密码失效和最后方式拒绝。正式桌面账号 UI 尚未调用该 IPC。

边界：这里没有向真实 Apple 供应商验证长期 refresh 凭据是否仍有效；数据库中 active 身份与非空加密凭据只是本地可用性门槛。没有真实邮件送达、正式移动/桌面解绑界面、Apple 解绑、账号注销或生产数据验收。邮箱解绑释放该地址；其后可以重新注册成另一个账号，不会自动合并历史主体。SA-07 8.5 仍未完成。
