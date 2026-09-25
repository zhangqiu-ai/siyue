# SA-04/SA-07 修改密码幂等重试修复 · 2026-09-23

分支 `feature/dev`，当前未提交工作树。此项修复同一已授权改密请求的响应丢失恢复，不代表真实邮件送达、账号安全 UI 或整个 SA-04/SA-07 已验收。

## 缺陷与修复

修复前，密码修改成功会递增 `credential_version` 并撤销该主体的全部会话；服务在进入幂等缓存查询前先验证 access token。因此，同一 token、幂等键和请求体重试会得到 `401 AUTH_SESSION_INVALID`，尽管首次操作已提交。

改密现在在调用方的数据库幂等事务内，以服务端 HMAC 派生的 access-token 摘要作为幂等作用域，并在事务中锁定／验证主体和会话后执行授权消费、密码更新、版本递增、会话撤销及安全邮件入列。已提交请求的同键同载荷重试命中加密结果缓存，不恢复或签发凭据；同键不同载荷拒绝为冲突。幂等缓存只保存既有终态，不会重新运行副作用。

## 验证证据

- 先将 Playwright 回归加到现有改密 HTTP 场景，在原代码上运行，确实复现第一次改密 `204`、同请求重试 `401`。
- `corepack pnpm --filter @siyue/server build`：通过。
- `node --test apps/server/tests/integration/email.test.mjs`：21/21 通过，使用临时 PostgreSQL；覆盖存储失败回滚、正确 action-bound grant、同键同载荷重试、不同载荷冲突、凭据版本仅递增一次、仅一条安全通知和一条 `password.change` 审计事件。
- `corepack pnpm exec playwright test tests/e2e/email-auth.spec.mjs --workers=1`：4/4 通过，真实 Fastify HTTP＋临时 PostgreSQL；覆盖成功后旧会话拒绝、同请求重试仍返回 204、不同载荷冲突、副作用仅一次及新密码登录。
- DeepSeek 只读审查独立确认了修复前的校验顺序缺陷与风险范围；审查期间未编辑文件。

未读取根 `.env`、未连接云端／真实邮箱、未部署、提交或推送；没有新增依赖。服务端复验使用合成账号、临时数据库与回环 HTTP。
