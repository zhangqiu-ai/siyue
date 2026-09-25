# 当前登录方式摘要 · 2026-09-24

新增已认证只读 `GET /v1/me/identities`。服务端只用已验证会话中的 subject 查询现有身份表：已验证且启用、确有密码凭据的邮箱组成一项 `email_password`；active 且保有 provider 凭据的 Apple 身份组成一项 `apple`。返回既有行 UUID 加类型前缀的稳定方法 ID、固定 `active` 状态，邮箱只给脱敏显示值。Apple 资料邮箱在当前数据库尚未保存，因此不编造 Apple 邮箱或暴露外部 subject、namespace、client ID、provider 凭据。改变邮箱时若要保持方法 ID 稳定，后续实现须更新原邮箱行而非另建行；解绑的最后方式保护见独立证据。

验证使用本地临时 PostgreSQL、真实 Fastify 路由与合成 Apple 身份：server integration 107/107；`tests/e2e/identities.spec.mjs` 2/2，与邻近认证/会话用例合跑 24/24；contracts/server build、typecheck 和 contracts 32/32、server 单测 35/35 通过。覆盖 Apple-only、邮箱-only、两者并存、跨主体、撤权/停用、无密码资料邮箱、失效会话及响应无秘密。

共享 API client 与认证控制器已增加 `loginMethods()`，要求当前可用 access token，按严格合同解析响应并对账号代际做校验；Apple-only 绑定邮箱的真实 HTTP 回归在绑定前后分别读取方法列表。主代理完成该接线后构建 packages/server，并运行 `tests/e2e/auth-client.spec.mjs tests/e2e/identities.spec.mjs`，27/27 通过。

Electron 主进程增加唯一 `login-methods` 受限 IPC 操作；请求只允许空 payload、既有 requestId/generation，renderer 再用同一严格方法摘要合同解析，不开放凭据或任意 URL。contracts 33/33、desktop 单测 25/25、桌面构建与类型检查通过；真实 Electron + HTTP/PostgreSQL 的 `desktop-auth.spec.mjs` 1/1、renderer 合同 Playwright 3/3，邻近账号 UI/空间回归 3/3 通过。预加载层及沙箱配置未改。

增量核查发现原查询会把缺少 provider 凭据的 active Apple 行列为可用方式，现增加凭据存在校验，与解绑保护保持一致；同时补入缺失凭据的临时 PostgreSQL 回归。账号页和生产/真机均未验收；这只是显示真实登录方式所需的可信来源，不代表账号管理完成。
