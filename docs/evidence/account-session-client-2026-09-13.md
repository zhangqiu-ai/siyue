# 账号会话客户端与真实 HTTP 边界

日期：2026-09-13。目标版本：0.0.1。范围：`account-session` 的只读会话查询客户端、共享响应契约和本地真实 HTTP 联调；不代表邮箱验证码、真实身份供应商、个人空间授权或云同步已经接通。

## 实现结果

- 将验证后会话响应移动到 `@siyue/contracts`，服务端与客户端共同严格解析 `subjectId`、`subjectKind`、`sessionId` 和 `expiresAt`。响应不包含角色、空间或对象权限；额外权限字段会被拒绝。
- `@siyue/adapters` 新增会话客户端。服务地址必须为 HTTPS，开发环境仅允许 loopback HTTP；凭据只放在单一 `Authorization: Bearer` 请求头中，请求不带 body、query 或重定向，返回体有类型和大小限制。宿主必须显式注入已验证能提供响应流并拒绝重定向的 transport；后续移动接线应使用项目现有 `expo/fetch`，不能默默退回 React Native 全局 fetch。
- 客户端将 401、429、超时、取消、网络失败、畸形响应和已过期会话映射为固定错误码，不读取非成功响应正文，也不暴露令牌或服务端错误内容。
- 新增凭据代次协调器。账号凭据替换会取消旧请求；旧账号迟到的成功或 401 都被判为 stale，不能覆盖或清除当前账号会话。当前凭据收到 401 或过期响应时只清除已验证会话状态。

## 实际验证

仓库根目录执行：

- `corepack pnpm --filter @siyue/contracts test`：17 项通过，0 失败；新增 7 项会话契约场景。
- `corepack pnpm --filter @siyue/adapters test`：59 项通过，0 失败；新增 9 项会话传输与代次场景，包括响应头已到但正文不结束时的取消和超时。
- `corepack pnpm --filter @siyue/server test`：23 项通过，0 失败。
- contracts、adapters、server 的定向 typecheck 和构建均通过。
- `corepack pnpm exec playwright test tests/e2e/account-session.spec.mjs`：2 项通过，0 失败。Playwright 进程启动真实 loopback Fastify，实际经 HTTP 验证成功身份、默认拒绝和服务端验证超时的客户端映射。
- `corepack pnpm typecheck` 与 `corepack pnpm test`：最终复测均为 11/11 Turbo 任务通过；包含本次改动的 adapters 任务重新执行，7 项未变化任务命中缓存，覆盖 contracts、domain、AI、adapters、mobile、desktop、server 的当前工作树。
- `corepack pnpm spec:check`：4 项通过；`corepack pnpm release:check` 与 `git diff --check` 通过。版本检查只证明记录一致，不代表 0.0.1 已达到发布门槛。

测试只使用合成令牌和验证器，不连接外部服务、不发邮件、不写用户数据库。真实 Supabase/其他身份服务、邮箱验证码、刷新与撤销、跨设备登录仍归 8.3 与验证计划 V01，保持未完成。
