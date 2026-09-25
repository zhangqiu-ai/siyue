# 独立账号服务开发

方案与状态：[原件](../../docs/architecture/backend-auth-v1/README.md)、[活动变更](../../openspec/changes/add-shared-api-independent-auth/tasks.md)、[首批证据](../../docs/evidence/backend-auth-foundation-2026-09-21.md)。

## 本地验收

```sh
corepack pnpm --filter @siyue/contracts build
corepack pnpm --filter @siyue/server test:integration
corepack pnpm exec playwright test tests/e2e/email-auth.spec.mjs tests/e2e/auth-foundation.spec.mjs tests/e2e/account-session.spec.mjs
```

需要 PostgreSQL 17 二进制。默认查找 `/opt/homebrew/opt/postgresql@17/bin`，其他位置用 `SIYUE_TEST_POSTGRES_BIN` 指定。测试每次创建临时 Unix socket 数据库，禁用 TCP 监听，生成合成凭据，完成后关闭并删除该临时实例。测试不读取项目 `.env`，不使用生产连接信息。

## 配置与运行

API 配置通过进程环境或单独、被 Git 忽略的 `.env.server.local` 注入；不要把部署 SSH 密码加载到 API。必需变量：

- `SIYUE_ENVIRONMENT`：development/test/staging/production。
- `SIYUE_DATABASE_URL`、`SIYUE_DATABASE_NAME`：Siyue 独立数据库，运行身份必须为 `siyue_app`；不是秋哥助手连接串。
- `SIYUE_JWT_ISSUER`、`SIYUE_JWT_AUDIENCE`、`SIYUE_JWT_KEY_ID`。
- `SIYUE_JWT_PRIVATE_KEY_FILE`：ES256 PKCS8 PEM，独立私钥。
- `SIYUE_JWT_VERIFY_KEYS_FILE`：公开 JWKS，仅包含允许的 EC/P-256、ES256、kid；支持至多五个轮换公钥。
- `SIYUE_SECRET_ENCRYPTION_KEY_FILE`：JSON `{ "activeVersion": "v1", "keys": { "v1": "<base64-encoded-32-byte-key>" } }`。值必须是真实随机密钥，不使用示例占位符。
- `SIYUE_CHALLENGE_PEPPER_FILE`：独立随机 32 字节的 Base64 文本，不与加密键共用。

秘密文件须仅所有者可读写。生产 issuer 固定 `https://api.qiugeapp.com/api/siyue`、audience 为 `siyue-api`；其他环境不得使用这个 issuer。默认运行地址为 `127.0.0.1:8787`，连接池上限 5。微信与 Mock 鉴权不能启用；邮箱默认关闭；只有 `SIYUE_EMAIL_ENABLED=true` 且独立 SMTP 私密配置有效才启用。Apple 当前仍未接入，启用会拒绝启动。providers 反映启用状态，不代表邮件已送达或 Apple 已验收。

```sh
corepack pnpm --filter @siyue/server build
node --env-file=.env.server.local apps/server/dist/index.js
```

没有数据库配置时，仅 development 可启动原有回环 Mock；production/staging 不会自动退回 Mock。启用邮箱后提供真实数据库注册／密码登录，不提供公开测试用户或返回验证码的接口。

## Provision 与迁移

`provision/independent-database.sql` 是显式、一次性建库与角色脚本，不由 API 执行。它读取 `SIYUE_PROVISION_DATABASE`、`SIYUE_ENVIRONMENT`、两个独立且至少 32 字符的 `SIYUE_PROVISION_APP_PASSWORD`／`SIYUE_PROVISION_MIGRATOR_PASSWORD`。角色或库已存在时失败，不覆盖已有账户。生产执行需要对应授权，管理员连接不要放到 API 环境。

迁移进程单独持有 `SIYUE_MIGRATION_DATABASE_URL`，角色为 `siyue_migrator`，加上 `SIYUE_DATABASE_NAME` 和 `SIYUE_ENVIRONMENT` 后执行 `node apps/server/dist/database-migrate.js`。API 若收到迁移连接变量会拒绝启动。迁移锁、历史 checksum、库名、角色与环境校验全部通过后才执行。

运行角色仅 DML，不能改 metadata、迁移历史、schema、角色或数据库。现有其他产品的超级用户风险并未因此消失；上线前需单独核验共享实例的角色权限和资源容量。

### 独立注销账本（内部内核）

`provision/deletion-ledger.sql` 是另一个显式、一次性建库脚本，建立 `siyue_deletion_ledger_app` 运行角色及不属于主库备份的账本数据库。运行配置使用独立的 `SIYUE_DELETION_LEDGER_URL`、`SIYUE_DELETION_LEDGER_DATABASE`、`SIYUE_DELETION_LEDGER_ENVIRONMENT`；三项必须同时存在，库名、角色和环境必须匹配。配置齐全时，API 启动先做 `prepared` 对账、恢复重放及围栏核验，失败则拒绝启动；会话签发、验证与刷新逐次查询账本。运行时每 30 秒检查账本水位，发生变化时先对账、重放并推进围栏，再扫描一批未完成的删除作业；清理前核对独立账本 `accepted` 意图与主库作业 ID，清理事务内再次核对 ID。没有账本配置时，原有认证仍可运行，但 `DELETE /v1/me/account` 保持关闭。存储边界与恢复测试见 [账本说明](src/account-deletion-ledger/README.md)及[证据](../../docs/evidence/backend-auth-deletion-groundwork-2026-09-24.md)。

同时配置独立账本和 Apple 服务端凭据时，同一维护周期会先运行受账本授权约束的 Apple 撤销队列，再清理服务端资料。每条队列领取后核对独立账本；未授权行保留封存凭据、延后五分钟重试，并计入拒绝数。0019 迁移增加独立的 `authorization_retry_at`，不改旧队列内容。正式注销提交接口仍关闭；隔离测试使用本地假供应商，不代表真实 Apple 撤销验收。

## 本机部署连接信息

维护者已授权从 qiuge-helper 的根 `.env` 复制 ECS 连接信息到本项目根 `.env`。变量名称为 `ALIYUN_HOST`、`ALIYUN_USERNAME`、`ALIYUN_PASSWORD`；该文件被 Git 忽略且权限为 0600。这里只登记名称，不记录值。没有复制秋哥助手数据库、JWT、微信或其他业务秘密。

这些连接信息供后续已授权的运维使用；保存连接信息不代表已创建思玥云数据库、完成迁移或部署。

## 客户端开发连接（SA-05 会话基础）

移动宿主和 Electron 主进程已接入注册、登录、认证恢复、账号空间映射及注销；设置 → 账号提供邮箱验证码注册、密码登录与找回密码。正常本地编辑不依赖账号服务器。生产地址固定为 `https://api.qiugeapp.com/api/siyue/v1`；2026-09-25 的真实邮件、公网注册、重启恢复、再登录和注销验收见[线上账号生命周期](../../docs/evidence/online-account-lifecycle-2026-09-25.md)。该证据只覆盖其中记录的部署工件与账号场景，不能替代当前版本的发布检查。

开发模式可通过 `EXPO_PUBLIC_SIYUE_AUTH_URL=http://127.0.0.1:8787/v1`（移动）或 `SIYUE_AUTH_URL=http://127.0.0.1:8787/v1`（Electron 主进程）选择本机独立 API。两者只接受回环地址；发布构建忽略覆盖。物理手机的回环指向手机本身，真机链路须另行配置受控环境，不把生产凭据改发任意局域网地址。没有确认 staging 地址时拒绝启动对应认证配置，不猜测域名。

先按前文启动独立数据库和 API，再使用既有移动／桌面开发命令。不要加载根 `.env` 到 Expo 或 renderer，不在 EXPO_PUBLIC 变量放入服务器连接或签名秘密。

可重复的隔离验收入口：构建 server/contracts/adapters 和 desktop 后，执行 `corepack pnpm exec playwright test tests/e2e/auth-client.spec.mjs tests/e2e/desktop-auth.spec.mjs`。测试自行启动临时 PostgreSQL 与回环 HTTP、创建合成账号并关闭隔离实例，不依赖真实发信或云端配置。覆盖与平台限制见 [SA-05 证据](../../docs/evidence/backend-auth-client-2026-09-22.md)。

实际设置界面的登录、密码重置和丢响应重试另运行 `corepack pnpm exec playwright test tests/e2e/account-ui.spec.mjs`。移动独立原生 QA 启动与构建见 [QA 说明](../mobile/e2e/account-auth/README.md)，结果和未完成矩阵见 [界面证据](../../docs/evidence/backend-auth-account-ui-2026-09-22.md)。

## 邮箱与独立邮件 worker（SA-04）

私密 SMTP JSON 用 `SIYUE_MAIL_CONFIG_FILE` 指定，权限 0600，结构如下（占位符不能直接运行）：

```json
{"host":"<smtp-host>","port":465,"secure":true,"user":"<siyue-user>","password":"<siyue-secret>","from":"<siyue-sender-email>"}
```

仅配置思玥专用发件身份与凭据，不读取秋哥助手业务秘密。465 默认直接 TLS；其他端口默认强制 STARTTLS，可显式设置 `secure`。证书验证不可关闭，禁止 URL／文件附件读取。SMTP 配置需要服务商、发件域名、SPF/DKIM 和额度的独立核验；本地测试不证明真实送达。

API 只在数据库事务中写入加密队列；同一构建另开进程发送：

```sh
node --env-file=.env.server.local apps/server/dist/mail-worker.js
```

worker 用数据库租约认领，最多三次明确可重试失败；SMTP 明确接受只记为 `sent`（不是终端收件箱已送达）。断线且无法判断是否提交、或发送进程中断，记为 `uncertain` 并清除载荷，不自动重发；用户可在间隔后重新请求挑战。已经在传输中的邮件无法撤回，旧挑战仍会拒绝验证。终结或过期销毁加密载荷；worker 每 30 秒清理过期幂等缓存、限流窗口与到期安全事件。worker 停止时不承诺队列及时发送或缓存及时物理清理，API 仍按期限拒绝使用。

内部接口前缀 `/v1`：

- `POST /auth/email/register/request`、`/confirm`：请求返回 202；验证后创建成人主体和会话，201。请求／确认都要求 UUID `Idempotency-Key`。
- `POST /auth/email/login`：密码登录，200。邮箱 trim/lowercase；密码保持原字符及空格。
- `POST /auth/email/password/reset/request`、`/confirm`：确认成功 204，无自动登录，撤销全主体会话。
- `POST /auth/reauth/password`：当前 Bearer 会话与密码验证后签发单次动作授权。
- `POST /me/password/change`：Bearer + `change-password` 授权 + 幂等键；204 后重新登录。

验证码 6 位／10 分钟／每挑战最多 5 次错误，重发间隔 60 秒。初始发送预算：邮箱每固定小时 5 次、每天 10 次，IP 每小时 20 次、全局每小时 100 次；所有预算原子预留。验证码验证累计预算：邮箱每小时 20 次、IP 每小时 100 次，重发不清零。登录／密码再次验证预算分别按身份键每小时 10 次、IP 30 次、全局 300 次计数；失败亦累计。服务默认不信任 `X-Forwarded-For`；生产代理真实 IP 与边缘限流需在 SA-10 明确配置并验收。

Argon2id 参数 64 MiB／3／1，进程并发 2、等待队列 4、最长等待 3 秒。弱密码表随构建携带，来源与范围见 [resources](resources/README.md)。该表不代表已覆盖所有泄漏密码，不上传用户密码。新依赖：argon2 0.45.1、nodemailer 10.0.10、@types/nodemailer 8.0.2；官方接口依据：[node-argon2](https://github.com/ranisalt/node-argon2)、[SMTP transport](https://nodemailer.com/smtp)。

本地邮件／并发／错误路径证据见 [SA-04 验证](../../docs/evidence/backend-auth-email-2026-09-21.md)。客户端页面、真实邮件、Apple、家庭接线和部署仍分别跟踪，不以本批后端通过代替整体验收。

### Apple 原生登录后端

默认 `SIYUE_APPLE_ENABLED=false`。启用需设置为 `true`，并提供 `SIYUE_APPLE_CONFIG_FILE` 指向权限600的JSON：`teamId`、`keyId`（各10位大写字母/数字）、`clientId`（登记的原生bundle）、`namespace`（稳定的Apple身份分组命名空间）、`privateKeyFile`（权限600的PKCS8 ES256私钥绝对路径）。示例配置不代表真实Apple登记；不要复用思玥JWT签名私钥。字段缺失、未知字段、文件类型/大小/权限或私钥格式不符拒绝启动。启用不依赖SMTP。

注册 `/v1/auth/apple/start`、`/v1/auth/apple/complete`；当前仅支持ios/login，complete必需UUID `Idempotency-Key`。start传输上限8KiB，complete传输上限64KiB；严格字段本身有更小上限（JWT16KiB等），64KiB不是放宽字段限制。不接受Authorization、查询参数或客户端指定身份。成功与失败沿用认证envelope及no-store。providers无platform时返回已配置能力和ios平台列表；显式Android/desktop时Apple不可用。

独立数据库预算：start每IP10/分钟、全局100/分钟；complete每IP60/分钟、全局300/分钟、每flow30/分钟。桶键使用服务端HMAC，跨进程共享；进程另有4个在途上限，超出返回429并可按Retry-After重试。仍默认不信任X-Forwarded-For；反向代理的精确信任网段接线和部署验收尚待完成，不能据此直接上线。

每次准入写attempt或rate_limited，失败写固定分类；成功审计与账号/会话同事务，审计失败回滚登录。Apple最小安全事件按方案建议90天自动到期；正式隐私留存承诺仍需确认。API启动及30秒定时清理Apple流程、过期限流桶和安全事件，即使邮件关闭也执行。检查缓存期限在每次恢复时完成，定时器不影响60秒授权边界。

真实Apple配置、原生SDK、通知/撤销、绑定与重新验证、客户端错误文案以及正式供应商验收仍未完成。当前自动化使用隔离数据库和合成身份，未连接真实Apple授权端点。

### 可信反向代理

`SIYUE_TRUSTED_PROXY_CIDRS` 接受最多16个逗号分隔的显式IPv4/IPv6 CIDR；默认空，忽略转发头。拒绝通配、裸IP、别名、跳数、/0、前缀前导零、zone及越界。若Nginx和API同机且通过IPv4回环连接，配置 `127.0.0.1/32`；不要直接照抄整个私有网段。信任列表必须与实际代理来源一致。

Nginx按设计用 `proxy_set_header X-Forwarded-For $remote_addr;` 覆盖客户端值；API按显式信任链识别IP，遇到第一个不可信节点停止，非法最终IP返回400。此设置也影响Fastify对转发host/protocol的解释；认证issuer/audience继续来自固定配置，不从转发头生成。当前本地Playwright覆盖真实TCP与持久限流；实际Nginx配置、公网来源和TLS部署尚未验收。

### 账号注销入口与客户端

配置独立注销账本并通过恢复围栏检查后，运行时注册 `DELETE /v1/me/account`。请求须提供唯一 Bearer、UUID `Idempotency-Key` 和严格注销请求（`delete-account` 再验证 grant、明确确认、逐家庭处置）；202 仅表示受理。同一请求的短时回执恢复沿用原 bearer／正文／请求键，账本必须证明已受理同一作业。未配置账本时不注册该路由。此配置行为不授权直接操作生产数据。

成人接收人在 `GET /v1/me/family-responsibilities` 查看本人家庭责任；原管理者在 `GET /v1/families/:familyId/deletion-recipients` 查看当前有效成人及接受状态。冻结家庭的 `GET .../frozen-review/preview` 和 `POST .../frozen-review/acceptance` 只允许本人有效成人成员确认责任，不解除冻结。运营复核使用独立数据库身份的 `dist/frozen-family-review-cli.js`，没有客户端解冻接口。

#### 冻结家庭复核（指定运维）

先在受控环境由数据库管理员执行 `provision/frozen-family-review-operator.sql`。脚本要求 `SIYUE_FROZEN_FAMILY_REVIEW_DATABASE`、`SIYUE_FROZEN_FAMILY_REVIEW_ENVIRONMENT`、`SIYUE_FROZEN_FAMILY_REVIEW_OPERATOR_ROLE` 和 `SIYUE_FROZEN_FAMILY_REVIEW_OPERATOR_PASSWORD`；密码至少32字符，角色不得为 `siyue_app`，已存在角色拒绝覆盖。创建和权限自检在同一事务内，失败回滚。此操作不随 API 启动自动执行。

CLI 使用该独立登录，配置 `SIYUE_FROZEN_FAMILY_REVIEW_DATABASE_URL`、`SIYUE_DATABASE_NAME`、`SIYUE_ENVIRONMENT` 和逗号分隔精确角色白名单 `SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS`。连接数据库、环境标记和实际登录角色必须一致。完整参数运行 `node apps/server/dist/frozen-family-review-cli.js --help` 查看；不把连接密码放在命令参数或工单中。

1. `list` 查看待复核项；`show --review <uuid>` 查看当前范围与有效接受声明。
2. 核对共同作品。只有 `no_shared_work` 或已完成安全分离的 `separated` 可以结束复核；仍待核对保持冻结。
3. `resolve` 必须带对应 review、recipient、acceptance、三个版本、child-scope-digest、shared-work、reason、idempotency-key、shared-work-checked-at。reason 使用不含个人资料的工单编号；检查时间必须显式指定。接收人声明超过24小时须本人重新接受。
4. 响应丢失时重复**全部原参数和原请求键**；不得通过换键绕过范围变化。再次 `show` 确认状态。原儿童设备授权仍撤销，不能因解冻恢复。

清理不会改写运维复核凭证。如果待注销者曾是已完成复核的接收人，或资料仍与他人共享且无法安全分离，回执保持待处理（如 `retained_review_closure` / `inseparable_shared_work`），不强删他人证据、不宣称资料已全部清理。当前没有覆盖这些记录的自动到期处置；须按后续明确的数据规则处理，不能手工强置删除完成。
