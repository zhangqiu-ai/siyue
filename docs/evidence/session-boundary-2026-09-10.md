# 服务端会话验证边界

目标版本 0.0.1，活动变更 add-account-family-spaces，任务 8.1/8.2。对应 Verified identity 的服务端基础，不表示邮箱验证码或实际身份供应商已接入。

`GET /v1/account/session` 仅从 Authorization Bearer 读取凭据。未配置服务端验证器时拒绝；严格校验已验证主体ID、adult/child 类型、会话ID、到期时间，等待验证结束后按当前时间检查过期。query/body、重复或不合法 Authorization 不用于声明身份；不返回角色、空间列表、访问令牌或验证器异常。

响应设置 Cache-Control:no-store。验证器调用有界等待，超时或断开触发 AbortSignal；晚到的返回值不会变为成功。真实身份供应商将负责签名/签发方/受众与撤销校验，本接口不会自行伪造这些证明。原有 Mock AI 路由保持本地开发标识，整个服务仍非生产认证服务。

主代理实际读取 session.ts 与接线/测试，核对凭据来源、后置过期检查、异常脱敏及取消竞争。测试结果完成后补记。未发送验证码、未读取真实凭据、未部署。

## 验证结果

先红10个失败，再实现通过。`corepack pnpm --filter @siyue/server test` 20/20，主代理复跑结果 `/tmp/siyue-session-boundary-final.log`；server build 通过。测试包括 Fastify inject 的格式/过期/异常/超时场景，以及绑定127.0.0.1临时端口的真实HTTP重复大小写Authorization、客户端断开取消。等待期间过期会被拒绝。测试验证器均为合成实现，未触及真实账号。

主代理读取最终 app.ts 接线及 session.ts，确认旧Mock路径未被误标为生产鉴权。后续仍须接真实验证器、全局限流、身份撤销与原子对象权限检查；本步没有提供可用于生产的完整账号服务。

## 会话验证并发保护补充

默认每个app实例同时最多4个验证器调用，可配置1–16；超额429/busy/no-store，不排队、不调用验证器。独立审查指出名额必须绑定底层Promise而非HTTP等待，否则忽略abort的验证器可在连续超时后无限累积；实现保留名额到实际resolve/reject，同步异常也释放。永久不结束的验证器会导致有限名额持续占用，生产适配器仍需真实网络超时。这不等于跨实例限流、用户/IP速率限制或费用上限。

先红：新增超时后容量测试实际返回200而预期429（`/tmp/siyue-session-cap-red.log`），证明旧实现没有该保护。修复及补测后 `corepack pnpm --filter @siyue/server test` 23/23（`/tmp/siyue-session-cap-final.log`），覆盖超额不调用、迟到成功/失败后恢复、同步异常释放、非法请求不占位。没有使用真实身份服务或发送邮件。
