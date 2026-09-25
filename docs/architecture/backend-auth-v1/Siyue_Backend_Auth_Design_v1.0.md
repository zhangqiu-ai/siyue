# 思玥 Siyue：共享 API 域名、独立后端与账号体系设计

**文档版本：1.0 ｜ 编制日期：2026-09-21 ｜ 产品版本沿用仓库，不等同于本文版本**

**用途：开发基线、接口设计、任务拆分、代码审查与验收。**

**状态：方案交付；没有因此修改仓库、部署服务器、申请第三方应用或执行生产迁移。**

> 本方案的主线是：共用基础设施，不共用账号与业务数据；先实现 Apple 登录与邮箱注册/登录，再接入微信。认证建设服务于当前五设备家庭视频＋共享白板目标，不恢复旧 M1 初始化排期，不重做已经接入的 Excalidraw。

## 文档导航

| 章节 | 内容 |
|---|---|
| 1–4 | 仓库基线、范围、部署拓扑与 Nginx 路由 |
| 5–8 | 工程组织、数据库隔离、主体模型、数据字典 |
| 9–14 | 邮箱／Apple、会话刷新、绑定、注销、API 合同 |
| 15–18 | 客户端、家庭儿童与白板接线、安全、配置 |
| 19–21 | 开发工作包、发布回退、验收、微信扩展 |
| 22–23 | 可追溯来源与本次交付边界 |

## 阅读与执行说明

- **已确认约束**：来自本轮用户决定及当前仓库明确范围，不得由编程助手自行改变。
- **工程默认值**：本文为便于实施而选定的策略，例如令牌时长、重试窗口、表名、数据库连接数。它们不是已有生产实测结果；修改必须记录理由、风险和测试。
- **发布门禁**：需要真实环境、服务配置或产品授权才能关闭，不允许以 Mock 或文档存在代替通过。
- 本文给出正式目标契约；代码未实现的接口均不是现有可调用能力。样例中的域名/路径是目标配置，示例身份、UUID、密钥路径均不代表真实用户或秘密。
- 本文所说“账号统一”，仅指**同一个思玥用户可使用多种登录方式**，不指与秋哥助手统一账号。

---

## 1. 仓库核查与实施基线

### 1.1 固定本次核查快照

| 仓库／分支 | 核查提交 | 用途 |
|---|---|---|
| `zhangqiu-ai/qiuge-helper` / `main` | `86538d4230ac97be22839168d199bf625c69b7e4` | 既有国内 API、部署文档、Nginx 兼容边界 |
| `zhangqiu-ai/siyue` / `main` | `a22dfb4d2d93825dc0cbc1ad4a5020bf97621486` | 初始主线参考，不足以代表当前完整开发进度 |
| `zhangqiu-ai/siyue` / `feature/dev` | `8baacbc4c702f86576358d02e76e45536447334f` | 仓库约定日常开发起点 |
| `zhangqiu-ai/siyue` / `codex/video-whiteboard` | `fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1` | 当前视频白板与账号契约的重点核查快照 |

开始实现时必须重新检查本地分支、远端、未提交内容及上述提交关系。不能直接从旧 `main` 重建项目，也不能擅自合并或切换有未提交内容的工作区。原始依据见 [R1]–[R9]。

### 1.2 已有能力与缺口

**秋哥助手已有基础**：部署文档记录国内 Node API＋PostgreSQL 17 与 `api.qiugeapp.com`；Nginx 将既有请求代理到宿主机 `127.0.0.1:8081`，微信回调有精确匹配且关闭访问日志。本文未登录 ECS，不能把仓库记录等同于刚完成的生产探测。[R1][R2]

**思玥不是空项目**：视频白板分支已有 `createApp()`、`registerSessionRoute()`、`SessionVerifier` 注入边界、`VerifiedAccountSession`、家庭策略契约、Excalidraw 编辑层及本地存档相关实现。[R3]–[R9]

**仍需建设**：生产认证与持久化账号、邮箱发送闭环、Apple 服务端验证、正式数据库迁移、独立部署与网关路由；家庭关系／房间凭据／实时协作需要接入真实身份。白板任务表仍将五设备音视频与实时协作标为未完成，不能把单机编辑成功视为实时协作完成。[R8]

### 1.3 本次必须保留的代码边界

1. 保留 `apps/server/src/session.ts` 的“身份不等于家庭授权”语义。
2. 保留 `packages/contracts/src/account-session.ts` 的严格对象：`subjectId`、`subjectKind`、`sessionId`、`expiresAt`。不要向这个严格对象随意添加角色、家庭列表等字段。
3. 保留家庭 `owner/admin/member` 与 `adult/child` 的两个独立维度；快照解析不是身份认证。
4. 保留本地空间 `spaceId` 与云身份独立映射，禁止用邮箱作为记录主键。
5. 保留已接入的 Excalidraw，不再新选白板编辑器；账号 Token 不得进入编辑器 DOM。
6. 现有 `app.ts` 是本地 Mock 服务：当前全局拒绝带 `Origin` 请求、请求体上限 4096 字节。生产接入应替换为受控策略，不得直接把 Mock 服务暴露公网，也不能不检查大小就接入 Apple 请求。[R3]–[R7]

---

## 2. 已确定架构与范围

### 2.1 已确认的不可变边界

| 项目 | 方案 |
|---|---|
| 公共 API 域名 | 共用 `https://api.qiugeapp.com` |
| 秋哥助手前缀 | 保留 `/api/cloud/*`，所有现有合同保持不变 |
| 思玥前缀 | `/api/siyue/v1/*` |
| 后端 | 独立思玥 Node.js／TypeScript／Fastify 服务 |
| 数据库 | 独立 PostgreSQL database、运行账号、迁移账号 |
| 认证 | 思玥独立用户、会话、签名密钥、issuer、audience |
| 首期登录 | iPhone／iPad 原生 Apple 登录；全平台邮箱注册／密码登录 |
| 微信 | 暂不申请 AppID、暂不接 SDK、生产不显示入口 |
| 桌面 | Electron＋React，不引入 Tauri |
| 产品主线 | 当前五设备家庭视频＋共享白板，不把账号建设扩展为统一平台重构 |

### 2.2 分层范围，避免“完整方案”变成无限项目

**A：本次账号与后端交付必做。** 独立基础设施、生产会话、邮箱闭环、Apple 登录、主动绑定、找回密码、设备会话撤销、账号切换、注销、审计和验收。

**B：支撑当前视频白板的最小身份接线。** 服务端家庭成员关系、受控邀请、儿童受监护身份、房间设备凭据与对象权限衔接。复用现有领域策略；不要求先完成所有成长、资产和同步模块。

**C：仍由现有视频白板变更负责。** RTC 厂商与计费、五设备媒体联调、实时编辑同步、题图临时分发、录制同意和主存档接管。本文规定它们必须如何使用认证，不擅自宣称具体厂商、预算或 O01–O06 已获批准。

**明确不做**：两个产品统一 SSO、共享密码／Token、读取秋哥助手数据库、手机号短信登录、支付订阅改造、云端永久保存全部白板／录像、无授权数据迁移、完整儿童公开运营合规自动判定、为架构而引入 Kubernetes／消息中间件／微服务集群。

---

## 3. 总体部署与网络拓扑

```text
秋哥助手客户端                     思玥 iPhone / iPad / Android / Electron
      │                                         │
      └────────── HTTPS api.qiugeapp.com ────────┘
                              │
                    既有 Nginx / TLS 证书
                 ┌────────────┴─────────────┐
          /api/cloud/*                /api/siyue/*
                 │                           │ 去除 /api/siyue 前缀
        既有 127.0.0.1:8081         新增 127.0.0.1:8787
                 │                           │
         qiuge-helper API           Siyue Fastify API
                 │                           │
         既有 qiuge 数据库             新建 siyue 数据库
                 └──────── PostgreSQL 实例 ───┘
                    初期可以共用，权限分别配置

Apple / 邮件服务 ← 仅由 Siyue 服务端访问
RTC 媒体网络     ← 客户端使用受限房间凭据连接；不经过普通 REST 代理搬运媒体
本地白板 / 录像 ← 仍按既有明确权限保存于指定设备，不自动变成云存储
```

这是**同源不同路径、不同进程、不同数据库**，不是把两套项目代码合成同一个 API 服务。

### 3.1 部署责任与目录

建议新服务使用 `/srv/siyue/`，与既有 `/srv/qiuge/` 分离：

```text
/srv/siyue/
  compose.yaml
  config/siyue.env            # 非公开运行配置，访问权限受控
  secrets/                   # 数据库、JWT、Apple .p8、邮件凭据
  releases/                  # 发布元数据与镜像 digest，不存用户资料
  backups/                   # 加密备份暂存，仍需异机副本
  logs/                      # 如使用文件日志，单独轮转与容量限制
```

容器端监听 `0.0.0.0:8787`，宿主机仅映射 `127.0.0.1:8787:8787`。当前源码仅监听回环；因此需要新增 `SIYUE_SERVER_HOST`，开发默认 `127.0.0.1`，容器明确设 `0.0.0.0`。不能把宿主机回环设置误用于容器内部。直接以 systemd 部署时继续监听回环即可。

连接共享 PostgreSQL 时使用确认存在的私有网络／服务名；容器中的 `localhost` 不是另一台容器。思玥 Compose 不接管、不重新创建、不删除现有 PostgreSQL 数据卷。

### 3.2 共用实例不等于物理隔离

数据库账户隔离只处理逻辑权限；主机、磁盘、CPU、PostgreSQL 进程、Nginx 与域名仍有共同故障面。初期允许这个成本取舍，但不得写成“思玥故障绝不会影响秋哥助手”。

给思玥独立设置 CPU／内存／进程数／日志容量／连接池限额；容量不足时优先移走思玥服务或数据库，公共 URL 不必变化。生产实例规格未核查，本文不给未经测量的并发容量承诺。

---

## 4. URL、网关和兼容策略

### 4.1 前缀只拼接一次

| 环境／层 | 地址 |
|---|---|
| 客户端 `API_ORIGIN` | `https://api.qiugeapp.com` |
| 客户端产品前缀 | `/api/siyue` |
| 业务版本 | `/v1` |
| 外部正式会话校验 | `/api/siyue/v1/account/session` |
| Fastify 内部注册 | `/v1/account/session` |
| 外部健康检查 | `/api/siyue/health/live`、`/api/siyue/health/ready` |
| Fastify 内部健康检查 | `/health/live`、`/health/ready` |

原有 `/health` 可作为本地兼容别名，但部署健康检查必须迁到新定义。不能在客户端和服务器同时再添加一次 `/api/siyue`。

### 4.2 Nginx 仅增量增加思玥 location

下面是**嵌入既有 HTTPS server 块的片段，不是覆盖整个配置的脚本**：

```nginx
# 保留原来的 TLS 配置、/api/cloud/auth/wechat/callback 精确规则和 location /。
location = /api/siyue {
    return 404;
}

location ^~ /api/siyue/ {
    # 尾部 / 表示去掉 /api/siyue/，再把剩余路径传到 Fastify。
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-ID $request_id;
    client_max_body_size 64k;
    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
    proxy_send_timeout 30s;
    proxy_cache off;
    # 最小初始策略：认证与账号请求不进入包含查询串的旧访问日志。
    access_log off;
}
```

这里由作为第一可信公网入口的 Nginx 覆盖 X-Forwarded-For；如将来前面增加 CDN／负载均衡，必须另行配置可信代理链，不能照抄而丢失真实来源或信任伪造头。Fastify `trustProxy` 仅信任真实代理网络，不设无条件 `true`。

Nginx `proxy_pass` 是否带 URI 会影响路径替换，这是必须通过代理级集成测试确认的行为。[S12]

### 4.3 实时路由后续单独配置

准备 `/api/siyue/v1/realtime`，启用时新增更精确的 WebSocket location，设置 Upgrade／Connection 与合理心跳超时；不要指望通用 30 秒 REST 代理自动支持长期连接。浏览器型 WebSocket 使用先经 HTTPS 签发的短时一次性连接票据，或连接后的限时认证消息；不得把长期访问令牌或刷新令牌塞在查询参数中。

完整白板、图片、录像不通过这个 64 KB 账号接口上传；如视频白板方案批准临时题图传输，另设受控附件通道、大小限制、生命周期和权限，不扩大所有认证请求的 bodyLimit。

### 4.4 兼容回归

必须验证：旧 `/api/cloud/health`、`/api/cloud/ready`、登录、刷新、微信回调规则均未改变；新 `/api/siyue/v1/account/session` 只到思玥；未知思玥路径 404，不回退到秋哥助手服务。新增服务停止时，旧服务仍通过自己的探针。

---

## 5. 后端工程组织与技术选择

沿用 Node.js、TypeScript、Fastify、Zod；数据库适配层采用 `pg`＋显式参数化 SQL＋版本化 SQL migration。选这个组合是为了减少初期变更，不强迫客户端领域层依赖 ORM。不要复制秋哥助手的 D1 兼容层或整套云服务到思玥。

认证使用成熟库完成 JWT 和 Argon2id；建议 `jose` 与经过当前 Node／平台构建验证的 Argon2 实现。不得手写密码哈希、JWT 签名解析器或随机数算法。依赖版本必须在现有锁文件与构建组合上验证，不因文档提到某库而全仓升级。

```text
apps/server/src/
  index.ts                 # 装配配置、监听、优雅退出
  app.ts                   # createApp，可依赖注入，测试不真实监听
  config/                  # 启动校验与功能开关
  plugins/                 # 数据库、日志、错误、认证、限流
  modules/
    auth/                  # 邮箱、密码、会话、再次验证
    identities/apple/      # Apple 验签、换码、撤销、通知
    subjects/              # 身份与资料
    families/              # 复用领域策略，装配可信数据
    device-grants/         # 儿童设备授权，随 B 切片启用
    account-deletion/      # 注销编排、外部令牌撤销、清理
  adapters/
    postgres/              # Repository / UnitOfWork 实现
    email/                 # EmailProviderPort 及生产适配
    crypto/                # 密钥读取、JWT、加密、哈希
  jobs/                    # 同镜像 worker 入口、清理、邮件 outbox
  session.ts               # 保留／适配既有 session 校验入口
apps/server/migrations/
packages/contracts/src/
  account-session.ts       # 保留现有严格合同
  auth.ts                  # 新增正式请求／响应 schema
  family-policy.ts         # 保留现有角色与权限合同
```

上表是建议落位，不要求用新目录覆盖同名现有模块；先检查仓库，复用已有适配层。依赖方向保持 `apps/adapters → contracts/domain`。

首期不需要 Redis。验证码、限流计数、幂等记录、任务 outbox 使用 PostgreSQL 原子操作。worker 可与 API 同工程、同镜像但独立进程，以免每个副本各自跑一份无协调定时器。定时任务用数据库认领／租约防止重复执行。

---

## 6. 数据库隔离、迁移与备份

### 6.1 数据库账户

新建逻辑数据库 `siyue`；生产迁移仅连接此库：

- `siyue_owner`：NOLOGIN，持有 schema／表。
- `siyue_migrator`：受控部署身份，能在本库执行批准的 DDL；仅迁移任务可用。
- `siyue_app`：API 运行身份，仅必要 DML，不是 owner，无超级用户／建库／建角色权限。
- worker 使用单独连接池，初期可复用本库运行身份；能力扩大时拆角色。

新库撤销 `PUBLIC` 的不必要 CONNECT／TEMP／schema CREATE，明确授予本库运行所需权限，并为新表配置 default privileges。迁移工具校验 `current_database()`、当前角色和环境标记后才能执行。

**注意**：不同数据库名称并不会自动阻止角色连接其他库；PostgreSQL 的 CONNECT、schema 与对象权限需要分别配置。[S13] 既有秋哥助手角色是否为高权限账户尚未核查，不能声称它已经无法访问新库。权限核查发现存量超级用户时，记录风险，单独安排兼容性硬化，不擅自修改正在工作的旧服务凭据。

### 6.2 迁移纪律

文件按 `0001_identity_core.sql` 等编号追加，并在 `schema_migrations(version, checksum, applied_at)` 记账。已执行迁移不可改写。迁移启动取得 advisory lock；同一事务中的 DDL／数据回填遵守 PostgreSQL 实际支持范围。新建数据库与角色属于受控 provision 步骤，不混进普通应用迁移。

生产进程**不以超级用户启动且不自动执行所有迁移**。发布顺序是：备份→迁移任务→检查→新 API→流量启用。采用 expand／migrate／contract，回滚优先回滚应用镜像和路由，不默认 DROP 已产生数据的表。

### 6.3 初始运行默认值

API 连接池上限 5；worker 上限 2；迁移单连接。获取连接超时 3 秒；普通账号查询 statement timeout 5 秒；耗时邮件／Apple HTTP 请求不持有数据库行锁。

这些是保守初值，实施前须核对旧服务连接池与数据库总容量；不能把共享实例的 `max_connections` 全部留给思玥。

### 6.4 备份与恢复

工程初值：每 6 小时执行本库加密备份，异机保存，最长保留 35 天；每周在隔离空库执行恢复验证。目标 RPO≤6 小时、RTO≤4 小时，仅在演练测得结果后才能标记达成。

备份之外独立保护密钥材料，数据库备份与解密密钥不要保存在同一公开介质。恢复后重放最新注销／撤权清单，不能让旧备份使已删除账号复活。该最小删除清单独立加密留存到最长备份过期，仅记录恢复所需标识与删除时间，不保留用户正文。

同主机文件不算异机备份；保留期和删除流程必须与正式隐私说明一致。

---

## 7. 身份模型：subject 不是登录方式

### 7.1 对现有合同的准确映射

```text
Subject(subjectId, kind=adult|child)
    ├── 成人：邮箱登录凭据 / Apple 身份 / 将来微信身份
    ├── 儿童：监护关系与受限设备授权，不复制家长凭据
    ├── Session：这一次设备登录
    ├── PersonalSpace：个人数据隔离，沿用既有空间映射
    └── FamilyMembership：家庭中的角色，与登录方式无关
```

此前讨论中的通用 `user_id`，在思玥现有代码中应落为稳定 `subjectId`。不另外创造不映射的第二套 user ID。账号 ID、设备安装 ID、家庭成员 ID、房间设备 ID、白板 ID 都不能混用。

`GET /v1/account/session` 返回现有严格结构，不增加包裹：

```json
{
  "subjectId": "0a74d68d-fbbf-4f0b-a813-3796984055ba",
  "subjectKind": "adult",
  "sessionId": "9bc0f6b6-52c4-46e5-a996-97c1d01175d1",
  "expiresAt": "2026-09-21T10:15:00.000Z"
}
```

`subjectKind` 由数据库中已建立的主体决定，不能接受普通登录请求自行写 `adult` 或 `owner` 来提权。这是应用身份类型，不是完成现实年龄或法定监护资格核验的证明。

### 7.2 主体与本地空间

登录认证不自动上传匿名本地资料，不把历史本地试验白板无声归属到刚登录的账号。沿用现有空间绑定合同；不存在绑定时，由受控命令明确创建或选择账号空间。

新设备登录只恢复账号和已在服务端保存的关系；没有云归档就不能承诺恢复旧设备的白板或录像。本期保持指定设备本地存档，不以“账号同步”名义偷偷开启内容云备份。

---

## 8. 数据字典与一致性约束

以下是**目标逻辑表**。A 切片先建账号必要表，B 切片再建家庭／受限设备表，C 的房间表按已有视频白板变更落地；不在第一条 migration 建一百张未来空表。时间统一 `timestamptz`／UTC，标识新建优先 UUID，既有 ID 不无故重写。

### 8.1 A：账号基础表

| 表 | 核心字段 | 约束与说明 |
|---|---|---|
| `subjects` | `id, kind, status, display_name, locale, credential_version, created_at, updated_at, deleted_at` | `kind=adult/child`；状态 active/blocked/deletion_pending/deleted；自增 credential_version 用于批量失效 |
| `account_emails` | `id, subject_id, email_original, email_normalized, verified_at, login_enabled, is_primary, created_at` | 仅经过本产品邮箱控制权验证才允许 login_enabled；normalized 唯一；每主体最多一个 primary |
| `password_credentials` | `subject_id, password_hash, hash_version, updated_at` | 每主体至多一条，允许不存在；不为 Apple 用户生成假密码 |
| `external_identities` | `id, subject_id, provider, provider_namespace, provider_subject, client_id, issuer, provider_email, email_verified, private_email, status, created_at, last_login_at` | 唯一 `(provider, provider_namespace, provider_subject)`；邮箱只是资料，不用来跨账号自动合并 |
| `external_provider_credentials` | `id, identity_id, client_id, refresh_ciphertext, access_ciphertext?, identity_token_ciphertext?, key_version, status, last_validated_at, updated_at` | 与业务响应隔离；第三方长期凭据需可撤销，使用可轮换 AEAD 加密，不在客户端出现 |
| `auth_sessions` | `id, subject_id, installation_id, auth_method, identity_id?, device_grant_id?, credential_version, authenticated_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, revoke_reason` | 一次设备登录一条；installation_id 只是关联提示，不是认证凭据 |
| `refresh_tokens` | `id, session_id, secret_hash, issued_at, used_at, replaced_by?, rotation_request_hash?, retry_ciphertext?, retry_expires_at?, expires_at, revoked_at` | 高熵随机 secret 只存摘要；同令牌只能产生一条后继链；短期响应恢复例外见第 11 章 |
| `email_challenges` | `id, purpose, email_normalized, subject_id?, initiating_session_id?, credential_version?, code_mac, request_secret_hash, attempts, status, expires_at, consumed_at, created_at` | 绑定用途／邮箱／会话；尝试数原子递增；used/expired/superseded 不可重新消费 |
| `external_auth_flows` | `id, provider, purpose, target_subject_id?, initiating_session_id?, credential_version?, expected_client_id, nonce_digest, state_digest, transaction_secret_hash, status, result_ref?, expires_at, created_at` | login/link/reauth 分开；只能从合法状态转换；成功身份由服务端验证 |
| `reauth_grants` | `id, subject_id, session_id, action, credential_version, secret_hash, expires_at, consumed_at` | 单次敏感操作凭据，不能跨动作、账号、会话复用 |
| `idempotency_records` | `scope, key_hash, subject_id?, request_mac, status, resource_id?, response_ciphertext?, expires_at` | 同 key 不同请求必须 409；不存密码／验证码请求原文 |
| `outbox_jobs` | `id, kind, aggregate_id, payload_ciphertext?, status, attempts, available_at, lease_until, expires_at, created_at` | 邮件等外部副作用；短时必要验证码载荷加密，投递终结／过期即清除 |
| `security_events` | `id, event_type, subject_id?, session_id?, request_id, outcome, redacted_metadata, occurred_at, expires_at` | 不存请求体／Token／照片；敏感标识尽量最小化 |
| `rate_limit_buckets` | `bucket_key_hash, window_start, count, expires_at` | 原子 upsert；邮箱／IP 原值不作公开日志键 |
| `account_deletion_jobs` | `id, subject_id, state, requested_at, cleanup_progress, provider_revoke_state, receipt_secret_hash, receipt_expires_at, completed_at, last_error_code` | 不允许只把账号 hidden 就宣称已注销 |
| `provider_event_receipts` | `provider, event_id_hash, received_at, processed_at, status` | 第三方通知验签后幂等处理，避免重复撤销或清理 |

**邮件唯一策略**：首期产品把邮箱登录名视为大小写不敏感，去除首尾空格后规范化；保留原始显示值。不删除 Gmail 点号、不去掉 `+tag`、不自行认定两个别名属于同一人。新增邮箱占用以数据库唯一约束为最终裁决。

**Apple 命名空间**：首期只启用经过配置验证的思玥原生应用命名空间。未来新增网页 Services ID 或 Apple 应用分组，必须明确主体标识映射；不能随意把 `aud` 不同的身份自动合并，也不能因为支持新端而复制一套用户。

### 8.2 B：家庭与受限设备的最小表

| 表 | 关键字段／约束 |
|---|---|
| `families` | `id, status, owner_subject_id, version, created_at`；唯一活跃 owner 通过事务和约束维护 |
| `family_memberships` | `family_id, subject_id, role, active, version`；唯一 family/subject；role 沿用 owner/admin/member |
| `guardian_relationships` | `guardian_subject_id, child_subject_id, family_id, active, version, consent_record_id`；家庭 admin 不自动成为所有儿童的监护人 |
| `family_invitations` | `id, family_id, inviter_id, intended_email?, token_hash, status, expires_at, accepted_by?, policy_version`；一次性受控邀请，不是公开房间码 |
| `device_pairing_requests` | `id, request_token_hash, poll_secret_hash, status, approved_by?, child_subject_id?, expires_at, consumed_at`；发起设备与批准动作双向绑定 |
| `device_grants` | `id, child_subject_id, guardian_id, family_id, installation_id, scopes, version, expires_at, revoked_at`；不是家长会话复制 |
| `family_share_grants` | 复用现有 family/sourceSpace/record/read-or-edit/active/version 合同，不自行扩大授权范围 |
| `consent_records` | `id, actor_subject_id, subject_id?, purpose, policy_version, recorded_at, withdrawn_at`；不收集多余身份证明作为默认字段 |

### 8.3 必须落在数据库事务内的操作

邮箱注册（挑战消费＋主体＋邮箱＋密码凭据＋会话）；Apple 新用户创建（外部身份唯一裁决＋主体＋会话）；绑定／解绑（再次验证＋唯一性＋最后登录方式检查＋审计）；刷新轮换；密码重置（密码更新＋版本增加＋会话撤销）；邀请接受（邀请消费＋成员关系）；监护设备授权与撤销；注销状态切换。

“先查存在、再无锁插入”不能替代唯一约束。并发绑定时锁定同一主体，才能避免两次解绑各自以为还剩一种登录方式，最终把用户锁在账号之外。


---

## 9. 邮箱注册、登录与找回密码

### 9.1 注册闭环

```text
输入邮箱 → 请求注册挑战 → 邮箱收取验证码
        → 输入验证码＋密码 → 服务端验证并原子创建账号
        → 签发思玥会话 → 进入个人空间／已有家庭邀请
```

`POST /auth/email/register/request` 接收 `email, locale`，成功受理统一返回 202，携带随机 `challengeId`、高熵 `requestSecret`、`expiresAt`、`resendAfterSeconds`。账号已存在时不通过状态码、正文或明显时间差向未验证调用者泄露注册状态；可发安全提示邮件，或使用同形态挑战完成邮箱控制权验证后再说明应登录。不得对所有公开请求直接返回 `EMAIL_ALREADY_EXISTS`。

`POST /auth/email/register/confirm` 接收 `challengeId, requestSecret, code, password, installationId, platform, deviceLabel?, displayName?, termsVersion, privacyVersion`；邮箱取自挑战，不以 confirm 请求中的新邮箱覆盖。锁定挑战、验证用途及有效期，检查邮箱唯一性，在一个事务中消费挑战、创建 adult 主体／邮箱／密码／会话与必要安全事件。已注册邮箱在完成邮箱控制权验证后返回明确冲突，**不覆盖原密码、不自动登录已有账号**。

注册成功不自动建立一个家庭、不自动上传本地数据，也不创建秋哥助手工作台。家庭创建／接受邀请是后续独立动作。

### 9.2 验证码与发送策略

以下为可配置的初始工程值：

| 项目 | 初始值／规则 |
|---|---|
| 验证码 | 加密安全随机 6 位数字，允许前导零 |
| 有效期 | 10 分钟 |
| 单挑战错误尝试 | 最多 5 次，原子计数；超过即失效 |
| 重发间隔 | 60 秒；新挑战使同用途旧挑战 superseded |
| 邮箱发送上限 | 5 次／小时、10 次／日，另外有 IP 与全局预算上限 |
| 邮箱挑战用途 | register、password-reset、link-email、change-email；严禁串用 |
| 请求证明 | 32 字节随机 requestSecret；仅保存摘要 |
| 验证码存储 | `HMAC(serverPepper, challengeId + purpose + code)`；不能只存可离线枚举的普通 SHA 摘要 |

发送限流不能只按挑战 ID：攻击者重新申请挑战后，邮箱／IP 层的累计错误次数仍然生效。过期、消费、错误尝试的判断使用服务端时间。校验采用恒定时间比较，不在错误信息里回显验证码。

邮件由事务 Outbox 执行，不能把“写入队列”说成“送达邮箱”。重试不超过挑战有效期；发送失败要有可见重发／更换邮箱路径。为了让邮件 worker 发送验证码，可以在 Outbox 中短时保存**加密**模板参数；这是仅保存验证码 MAC 的明确例外，发送终结或过期即销毁载荷，不能无限重试和长期留存。

邮件适配接口只负责 `sendVerification`／`sendSecurityNotice` 等明确模板。可先复用已有服务商的运营经验，但思玥使用自己的发件身份、凭据、模板、限额和审计；不能调用秋哥助手注册接口发送思玥验证码。正式发件域名与额度未核查，不能在代码中假定已配置成功。

### 9.3 密码规则与验证

采用邮箱＋密码登录，不在首期同时再加一套邮箱验证码免密登录。

本方案初始密码规则为 **15–128 个 Unicode 码点**，允许空格和 Unicode，不强迫“大写＋小写＋数字＋符号”组合，不静默 trim／截断／修改密码。注册与修改时拒绝已知常见、泄漏弱密码；密码确认框仅客户端比较，不重复提交服务端。规则参考 OWASP，具体长度是本方案选择。[S9]

密码采用 Argon2id，初始参数建议 `memory=64 MiB, iterations=3, parallelism=1`，部署前在目标 ECS 实测。OWASP 给出的最低推荐组合为 19 MiB、2 次迭代、并行度 1；本文更高参数不等于已测性能。[S8] 哈希记录带算法与参数，成功登录时可渐进重哈希；不批量请求用户明文密码。

密码验证并发初始限 2，设置有界等待与限流，防止攻击者用昂贵哈希耗尽与秋哥助手共用的服务器。不存在的邮箱也执行受控 dummy hash 验证，登录失败统一为 `AUTH_INVALID_CREDENTIALS`。限流超限明确 429，不无限排队。

### 9.4 密码重置与修改

找回密码是 request／confirm 两步挑战。仅对已启用的邮箱登录凭据生效，Apple 返回的资料邮箱不自动成为可重置密码的登录方式。confirm 验证成功后更新密码、增加 `credential_version`、撤销该主体全部会话及其未完成敏感授权，并发送安全通知；**不自动登录**，用户使用新密码重新登录。[S10]

已登录修改密码需要当前密码或有效的、绑定 `change-password` 动作的再次验证凭据。Apple-only 用户首次设置邮箱密码，应先完成“新增登录邮箱”流程，不能被要求填写根本不存在的旧密码。

找回密码失败、邮件服务异常和临时断网都不能删除本地目标、白板、照片或会话记录。

---

## 10. Sign in with Apple 完整闭环

### 10.1 平台与配置

首期 Apple 登录面向 iPhone／iPad。Android 和 Electron 首期使用邮箱登录；不因此删除 Android 支持。Expo 的原生 AppleAuthentication 当前不直接支持 Android／Web，相关平台的 Apple 网页授权属于后续独立接入。[S1]

保留当前 `app.siyue.mobile`，除非苹果开发者后台的真实标识冲突要求另行决策；不能把网站 Services ID 当成原生 bundle identifier。增加 `ios.usesAppleSignIn=true` 和 `expo-apple-authentication` plugin，保留已有 sqlite、secure-store、图片与白板插件。使用匹配现有 Expo 版本的依赖，重新构建含原生配置的应用；Expo Go 只能辅助测试，不能替代实际 bundle／签名／真机验收。[R10][S1]

服务端需要 Apple Team ID、Key ID、原生 Client ID、受控 `.p8` 私钥及固定允许的环境映射。它们与**微信 AppID** 无关；微信延期不代表可以省略 Apple 所需配置。`.p8` 不进客户端、不进仓库、不放 `EXPO_PUBLIC_*`。

### 10.2 登录事务与防重放

```text
App → POST /auth/apple/start
    ← flowId、transactionSecret、nonce、state、expiresAt
App → 系统 Apple 授权（nonce、state）
    ← identityToken、authorizationCode、state、可选姓名
App → POST /auth/apple/complete
Server → 验签＋交易绑定＋服务端授权码交换
Server → 外部身份查找／原子创建思玥主体 → 思玥会话
```

start 默认事务有效 5 分钟；服务端根据已登记客户端配置确定 `expected_client_id`，不接受用户任意填入 audience。分别产生随机 nonce、state 和 32 字节 transactionSecret，数据库保存摘要；link／reauth 流程另外绑定当前主体、会话、凭据版本及动作。

客户端把 start 返回的 nonce 作为 SDK `nonce` 参数，不能自行换值，也不能未经契约说明重复哈希。本方案的原生适配契约是：`nonce` 以同一文本传入 SDK，并比较经过验签的 claim 与服务端期望值的摘要；若锁定 SDK 在内部变换 nonce，必须用官方实现与真机证据明确适配一次，更新测试，不能同时接受多种模糊形式放宽验证。

complete 必须携带 `flowId, transactionSecret, state, identityToken, authorizationCode`，可附首次姓名资料；客户端传入的 `user`、邮箱、`subjectId` 或 `realUserStatus` 不是服务器登录依据。授权取消返回正常取消状态，不创建账号、不把取消记录成攻击。

### 10.3 验证与授权码交换

使用成熟 JOSE 库，从固定 Apple JWKS 地址读取公钥，按 `kid` 匹配并有界缓存／刷新；禁止从 Token 的 `jku/x5u` 任意地址下载密钥。当前 Apple 发布的身份公钥为 RSA／RS256，因此身份 Token 验证采用显式 RS256 白名单；不要与本服务 JWT 或 Apple client-secret 的 ES256 混淆。[S3][S18]

服务端核验签名、`iss=https://appleid.apple.com`、允许的 `aud`、`exp`、合理 `iat`、事务 nonce、state、一次性事务状态；时钟容差初始 60 秒。Apple 官方验证说明要求这些身份与交易检查。[S2] 不仅 decode JWT，也不在验签失败后“为了能登录”退回信任客户端。

使用 `.p8` 生成 Apple 要求的 ES256 client-secret JWT，服务端调用 `https://appleid.apple.com/auth/token` 交换授权码。服务端再验证返回的身份 Token，确认与本次已验证身份的 subject／client 一致；只接收事先允许的原生客户端。原生流程不虚构网页回调或随意添加 redirect_uri。

外部 HTTP 调用不占用长数据库事务。流程状态为 `pending → exchanging → verified → completed`，通过条件更新认领、短租约和唯一约束控制并发。Apple 已消费授权码但响应丢失时，不能宣称一定可以重放兑换；若服务器未能持久化可验证结果，明确要求重新发起 Apple 授权，不创建猜测身份。

完成后的同一 flow 仅可用相同 transactionSecret 与幂等请求在短期恢复原结果，不能再签发第二组会话；恢复响应的加密缓存最长 60 秒。超过窗口但账号已创建时，再次正规 Apple 登录会定位原主体，不创建重复用户。

### 10.4 身份、资料与后续撤销

以 `(provider=apple, configuredNamespace, verifiedSub)` 查找身份，不按邮箱、姓名或头像合并。姓名视作可选、不可信的显示资料；缺失时用可编辑默认显示名，不能覆盖用户已设置的名称。Apple-only 账号没有假邮箱和假密码。

选择隐藏邮箱仍能正常进入产品，不能强制补“真实邮箱”或密码才能继续。用户需要跨平台邮箱登录时，可在设置中**主动新增**登录邮箱。[S16] 要向 Apple 中继邮箱发邮件，先完成发件来源和 SPF／DKIM 等对应配置，发送失败不能被处理为用户账号无效。[S6]

第三方授权码交换得到的 Apple refresh token，应以可轮换 AEAD 加密保存于独立凭据表，以支持授权撤销；它不是思玥自己的 refresh token，不能发给客户端。思玥 refresh token 的常态存储仍是摘要。这两类凭据不同，不能为了“所有 token 都只存 hash”而失去 Apple 注销撤销能力。[S4]

### 10.5 Apple 授权变化

准备验签的 `POST /auth/apple/notifications` 服务端通知入口；根据真正登记的 Apple 应用分组配置通知地址，同一分组配置限制必须核对，不能覆盖其他产品的配置。[S7]

接收方先验证签名、发行者、适用应用、时效与事件唯一性，再按事件类型处理。中继邮箱转发关闭只更新送达状态；授权撤销使该 Apple 身份及相关会话失效，不自动删除已经明确绑定邮箱的整个思玥账号。Apple 账号删除、应用授权撤销、思玥主动注销是不同事件，不能混为一谈。

客户端授权状态变化只触发安全重核验，不能凭客户端报告直接删除账号；网络异常不是授权撤销。初期以通知＋关键动作检查为主，必要的 Apple refresh 验证后台限频，遵守其服务限制；不能每个业务请求都访问 Apple。

---

## 11. 思玥会话、刷新和安全恢复

### 11.1 凭据定义与初始期限

| 凭据 | 建议初始期限 | 存储与用途 |
|---|---:|---|
| 思玥 Access Token | 15 分钟 | 客户端内存；只用于思玥 API |
| 思玥 Refresh Token | 闲置 30 天，单次会话绝对最长 180 天 | 客户端安全存储；服务端摘要；每次成功刷新轮换 |
| 再次验证凭据 | 5 分钟，一次操作 | 绑定会话、主体、动作、credential_version |
| Apple 登录事务 | 5 分钟 | 一次性授权流程，不作为思玥业务会话 |
| 刷新响应恢复缓存 | 60 秒 | 服务端短时 AEAD 加密，恢复同一响应，不延长原令牌链 |

上述期限是本方案默认，不沿用秋哥助手当前令牌时长。儿童派生会话的实际期限还必须被设备授权／监护授权到期时间截断。

### 11.2 Access Token 验证

思玥使用独立 ES256 签名密钥与明确 `kid`，服务端只允许预期算法。生产 issuer 建议固定为 `https://api.qiugeapp.com/api/siyue`，audience 固定 `siyue-api`。预发布另用 issuer／密钥／数据库；不能与生产相互接收凭据。

载荷只包含 `iss, aud, sub, sid, jti, iat, exp, cv, token_use=access`。角色、邮箱、家庭权限和儿童可访问对象不放进长期可信声明。对业务请求验签后仍查当前 subject/session 状态与 credential_version；初期不缓存权限或会话存活，确保服务端撤销可立即阻止后续请求。

现有 `SessionVerifier` 适配为：校验思玥 Token → 加载有效会话与主体 → 返回既有严格 `VerifiedAccountSession`。`expiresAt` 取本次 Access Token 与会话／派生授权有效期的最早值。账号存在不代表家庭或白板授权存在。[R4][R5]

旧秋哥助手 Token 必须因 issuer／audience／签名密钥不匹配被拒绝；即使邮箱相同也不能登录。JWT 验证只代表本服务会话验证，不复用秋哥助手 JWT Secret。

### 11.3 刷新轮换与重放防护

Refresh Token 由随机 32 字节 secret 和可定位的随机 token ID 组成；secret 使用加密安全随机源，数据库常态仅存 SHA-256 摘要。刷新时锁定 session 和 token，检查撤销／闲置／绝对期限、主体状态、凭据版本及设备授权，再原子消费旧 token、创建唯一后继、更新闲置期限；绝对期限永不滚动。

公共客户端刷新凭据需要重放防护；本方案采用轮换与使用历史检测，不把长期固定 refresh token 用半年。依据 OAuth 安全最佳实践，检测已轮换凭据被不合法复用时，应撤销相应令牌链。[S11]

并发同一会话的不同轮换请求不能各自成功生成后继。客户端必须 single-flight：十个请求同时遇到 access 过期，只进行一次 refresh，其他等待结果。重放事件撤销这一设备会话链，不默默撤销所有家庭成员账号；疑似全面入侵的全账号撤销由独立安全规则／用户动作处理。

### 11.4 解决“刷新已成功，但响应丢了”

不能把所有旧 refresh 重试都当攻击，也不能无限期接受旧 refresh。采用有限幂等恢复：

1. 客户端在发请求前，原子写入安全存储的同一个值：`{ refreshToken, pendingRotationId }`；同一次重试永远使用同一 UUID。
2. 服务器首次成功轮换时，保存旧 token 的 rotationId 摘要，以及**加密的同一份返回响应**，有效 60 秒。
3. 60 秒内，旧 token＋相同 rotationId 的重试，只能返回原响应；仍须确认 session 未撤销、主体有效、后继尚未被再次消费。不能创建另一后继，也不能刷新缓存期限。
4. 旧 token＋不同 rotationId 视为重放，撤销该 session 链；返回 `AUTH_REFRESH_REPLAYED`，关闭相应在线连接。
5. 同一请求超过恢复窗口时返回 `AUTH_REFRESH_RECOVERY_EXPIRED`，要求重新登录；不删除业务文件。
6. 客户端收到结果后，一次安全存储写入替换成新 refresh 并清空 pendingRotationId；只有写入成功才将新 access 发布给业务层。写入失败不得伪称已安全登录。

这是明确的风险取舍：恢复窗口内，同时窃取旧 refresh 与 rotationId 的攻击者可能获得同一后继，因此两者都必须保密，缓存严格短期、加密且不可日志输出。它不等于 sender-constrained token，也不承诺抵御已控制设备的恶意软件。

服务端摘要存储规则的两个例外只有：短时幂等恢复响应、需要外部撤销的第三方凭据，均加密、限权和定期清理；严禁普通日志或明文数据库保存。

### 11.5 退出与撤销

在线退出调用 `POST /auth/logout` 撤销当前 session／refresh 链并关闭派生连接；客户端随后清安全凭据、取消请求、退出个人化 UI。该接口可使用当前 access，或仅为撤销用途提交本设备 refresh 证明，解决 access 已过期时无法退出的问题；不能撤销任意自报 sessionId。

离线退出立即清理“活动登录态”，标注“本机已退出，远端会话尚未确认撤销”。可以将仅用于重试 logout 的证明放入隔离加密撤销队列，不得被续期逻辑读取或自动恢复登录；联网后优先完成撤销。不能把离线退出显示成服务器已撤销。

注销当前设备、注销其他设备、注销全部设备是不同动作。全部设备撤销及密码重置应撤销主体会话，并同步使相关儿童设备授权失效或进入重新批准状态；不得出现家长凭据已全部失效而被盗派生授权永远有效。

---

## 12. 多登录方式绑定、再次验证与账号冲突

### 12.1 绑定原则

登录、绑定、重新验证三种 Apple 流程共用 Provider 验证适配器，但目的和权限不同。login 可以在没有会话时发起；link 必须处于真实登录态并完成敏感操作再次验证；reauth 只能证明当前主体已有身份，不允许换成另一个 Apple 用户后给当前账号授权。

新增邮箱需要邮箱验证码控制权验证；绑定已经属于其他思玥账号的邮箱／Apple subject 返回冲突，首期**不提供账号合并**。不按同名、同手机号备注、相同 Apple email 或同一设备来自动合并。

### 12.2 再次验证合同

`reauthGrant` 是 32 字节随机单次证明，绑定 `subjectId, sessionId, credentialVersion, action, expiresAt`。动作包括 `link-identity`、`unlink-identity`、`change-email`、`change-password`、`revoke-session`、`revoke-all-sessions`、`delete-account`、`approve-child-device`。不能用同一 grant 跨动作使用，也不接受仅前端弹窗确认就视作重新认证。

有邮箱密码时可通过 `/auth/reauth/password` 验证；Apple-only 用户通过已绑定 Apple 的 nonce 流程验证。验证另一 Apple 用户不产生 grant。密码修改／会话撤销／账号状态变化后，旧 grant 与未完成绑定挑战立即失效。

### 12.3 安全解绑

用户必须保留至少一种当前真正可用的登录方式：已验证邮箱＋密码，或有效外部身份。仅有资料邮箱、不存在的密码、已被撤销的 Apple 身份均不算。

解绑在同一主体行锁内完成再次验证消费、剩余登录方式判断、外部身份停用、相关 session 撤销、撤销 Outbox 与通知，防止并发解绑清空所有方式。主动移除 Apple 还须撤销对应 Apple 授权；不能只删本地 UI 图标。

**普通退出不解绑 Apple；解绑 Apple 不自动删除思玥资料；注销思玥才执行账户删除流程。**

---

## 13. 账号注销、Apple 撤销与删除恢复

Apple 对支持账号创建的应用要求提供应用内发起删除的路径；使用 Sign in with Apple 时还需要妥善处理授权撤销，不能只隐藏用户。具体要求以发布时官方规则复核为准。[S5][S17]

### 13.1 用户流程

“设置 → 账号与安全 → 注销账号”展示将删除的数据、家庭／儿童关联影响、其他设备副本限制；用户完成 `delete-account` 再次验证并明确确认。正常提交返回 202 和受限删除回执，不能返回 200“全部删除成功”后才开始后台处理。

受理事务将主体置为 `deletion_pending`、增加 credential_version、撤销所有本人会话与受影响设备授权、停止新的邀请／上传／订阅任务，并创建删除作业。身份一旦进入删除态，普通登录不能静默恢复账号。

后续分阶段清理云端身份、恢复邮箱、个人资料、私有附件、衍生检索与缓存（实际存在才清理）、服务端推送注册、外部授权等；按目的保留最小删除防复活标记和删除进度，不保留完整个人资料当作“审计”。

### 13.2 家庭与儿童依赖

有其他有效家长的家庭：允许用户在注销前显式转移自己的管理职责；不转移时撤销本人权限，并按既有家庭规则保留其他人的合法数据。

唯一监护人／唯一 owner：必须先展示受影响家庭与儿童受限设备。允许用户选择“转交已验证合适成人”或明确确认“结束自己管理的家庭访问并撤销儿童设备”；不能默默提升任意普通成员为监护人，也不能因为没有接收人永远禁止账号删除。共同作品归属和未决存档策略不能由删除接口自行猜测，涉及他人数据时进入有记录、可完成的人工处理分支，不伪称全部自动完成。

维护者确认：同一账号涉及多个家庭时，**逐个家庭**选择上述处置方式，可为不同家庭选不同接收人或结束管理。提交请求按家庭 ID 携带一项明确选择；服务端在受理事务内重新读取当前影响范围，要求每个受影响家庭恰有一项、无重复或多余家庭。转交接收人必须已经是该家庭的有效成人成员，并先明确接受该家庭的管理责任及适用的儿童监护责任；单凭注销者填写接收人 ID 不生效。受理时须重新验证成员资格、接受记录与其所覆盖的当前儿童范围，变化后要求重新接受。无家庭／监护依赖时明确提交 `none`。影响范围或接收资格在预览后变化且原选择不再匹配时拒绝请求并要求重新查看；不能用一次总括选择或客户端自报的角色替代服务端核验。共同作品与主存档仍按各自未决规则处理。

维护者确认：唯一管理者选择“结束管理”且家庭仍有其他成员时，家庭进入**冻结待处理**状态，不自动指定新管理者。受该管理者授权的儿童设备立即失效，冻结期间不得继续用旧家庭权限发放新设备授权或访问共享资源；其他成员与共同作品保留待核对，不能由注销作业直接归属或删除。冻结及授权撤销须与注销受理的主库事务一致；若依赖、关联资源或权限尚不能安全处理，整次受理拒绝，不能把“待处理”假报为清理完成。

这些是本方案的安全默认，公开家庭功能发布前必须与现有 O01／O03 规则核对，不擅自更改他人作品归属。

### 13.3 外部撤销与异常

删除范围包含该用户在本服务控制范围内上传或生成的内容，不能以“已经共享给家人”为由一概保留本人内容；独立属于其他人的原始数据与已合法导出的外部副本另行区分。常规注销不要求用户打电话、发邮件或找客服作为额外前置；复杂清理由内部作业处理并给出预计完成期限与结果通知。[S5]

对已保存的 Apple 凭据调用撤销接口；网络失败使用受控 Outbox 重试，作业只保留撤销必需的加密数据。第三方暂时不可用不能无限阻塞思玥自身的数据删除，也不能假装第三方撤销已完成。[S4]

建议默认：首次处理立即尝试，指数退避最多持续 7 天并报警；到期需人工确认或指导用户从 Apple 设置撤销，销毁已无合理用途的密钥载荷。删除状态区分 `local_data_deleted` 与 `provider_revocation_pending`，界面不得合并为“全部完成”。该期限是运营初值，正式隐私承诺必须一致。

删除回执 secret 只允许读取该作业的最小进度，不允许恢复登录或读取其他资料；仅保存摘要，建议 30 天过期。通过 `POST /account/deletion/status` 查询并传 body 中的回执，避免放 URL。

### 13.4 本地与备份

普通退出保留本地数据但断开云身份；已绑定账号的私有缓存继续要求合法本机解锁／原身份授权，不因变成 anonymous 就开放给其他人；账号注销在当前设备清理该账号认证、缓存和用户确认删除的数据。其他离线设备只能在再次受控联网时收到删除／撤权信号；已经由他人合法导出的离线副本不能保证远程擦除。UI 必须区分“本机删除”“服务端删除”“他人独立副本”。

每次数据库恢复先重放独立保管的删除防复活账本，再开启登录和对外查询，避免旧备份恢复出已注销账户。备份最长保留周期与销毁任务纳入运维；不能为了恢复测试把真实邮箱或家庭内容写入日志／测试报告。

---

## 14. HTTP API 契约

### 14.1 通用规则

下表路径均相对 **`/api/siyue/v1`**；Fastify 内部只注册 `/v1` 及以下路径。接口均为目标合同，不代表已经上线。

请求与响应使用 JSON，未列字段默认拒绝；日期为 UTC ISO 8601；错误码稳定、展示文案由客户端中英翻译。普通请求体最多 16 KiB，Apple complete 最多 64 KiB；个别接口上限可更小。所有凭据响应 `Cache-Control: no-store`，不允许 CDN 缓存。

成功默认 `{ data, meta: { requestId } }`。**唯一兼容例外**：现有 `/account/session` 返回严格的 `VerifiedAccountSession` 原对象，不加 envelope、不加字段。错误统一为 `{ error: { code, messageKey, retryable }, meta: { requestId } }`；已有 `/account/session` 的旧错误体转换必须同步更新调用方与测试，不能只改一端。

### 14.2 A 阶段接口清单

| 方法与路径 | 身份／前置 | 请求关键字段 | 结果／约束 |
|---|---|---|---|
| `GET /auth/providers` | 无 | `platform` 枚举 query 可选 | 当前可用登录方式，不回传配置秘密 |
| `POST /auth/email/register/request` | 无，限流 | email, locale | 202，挑战与受理状态；不枚举账号 |
| `POST /auth/email/register/confirm` | 挑战证明 | challengeId, requestSecret, code, password, installationId, platform, deviceLabel?, displayName?, termsVersion, privacyVersion | 201，创建账号＋会话；必须幂等 |
| `POST /auth/email/login` | 无，限流 | email, password, installationId, deviceLabel?, platform | 200，会话；设备描述只作显示 |
| `POST /auth/email/password/reset/request` | 无，限流 | email, locale | 202，同形态挑战 |
| `POST /auth/email/password/reset/confirm` | 挑战证明 | challengeId, requestSecret, code, newPassword | 204，撤销旧会话，不自动登录 |
| `POST /auth/apple/start` | login 无；link／reauth 要有效会话 | purpose, platform, installationId, deviceLabel?, action?, reauthGrant? | 一次性 flow；expected client 由服务器确定 |
| `POST /auth/apple/complete` | 交易证明；link／reauth 还检查发起会话 | flowId, transactionSecret, state, identityToken, authorizationCode, fullName? | purpose=login 返回会话；link 返回绑定结果；reauth 返回 grant |
| `POST /auth/apple/notifications` | Apple 通知验签 | 官方通知签名载荷 | 持久化接收后幂等确认，不接受普通自报事件 |
| `POST /auth/refresh` | refresh 证明 | refreshToken, rotationId | 轮换后的同形态会话；同请求短期恢复 |
| `POST /auth/logout` | 当前 access 或 refresh 证明（二选一） | refreshToken? | 204，幂等撤销当前会话 |
| `POST /auth/reauth/password` | 当前会话 | password, action | 单次 action-bound reauthGrant |
| `GET /account/session` | access | 不允许 query／body 凭据 | 既有严格身份对象 |
| `GET /me` | access | 无 | 自身资料＋登录方式摘要＋下一步提示 |
| `PATCH /me` | access | displayName?, locale? | 不能修改 kind、roles、owner 或 verified 标记 |
| `GET /me/identities` | access | 无 | 已绑定类型／脱敏资料，不返回 provider Token |
| `POST /me/email/link/request` | access＋reauth | email, reauthGrant | 202，新邮箱验证挑战 |
| `POST /me/email/link/confirm` | 发起会话仍有效 | challengeId, requestSecret, code, newPassword | 新登录邮箱＋密码；不合并已存在账号 |
| `POST /me/email/change/request` | access＋reauth | newEmail, reauthGrant | 202，绑定当前会话和凭据版本 |
| `POST /me/email/change/confirm` | 发起会话仍有效 | challengeId, requestSecret, code | 修改邮箱并通知原／新邮箱，增加凭据版本、撤销旧会话，冲突不覆盖 |
| `POST /me/password/change` | access＋reauth | newPassword, reauthGrant | 204，增加版本并撤销旧会话，重新登录 |
| `DELETE /me/identities/{identityId}` | access＋reauth | body: reauthGrant | 禁止删最后可用方式；提交外部撤销作业 |
| `GET /me/sessions` | access | 有界分页 | 自身设备会话摘要，不返回 Token／完整 IP |
| `DELETE /me/sessions/{sessionId}` | access；撤销其他设备还需 revoke-session reauth | reauthGrant? | 仅能撤销自己的会话；当前设备不另要求 reauth |
| `POST /me/sessions/revoke-all` | access＋reauth | reauthGrant | 204，全主体会话撤销，包含当前会话 |
| `GET /families/{familyId}/management-acceptance/preview` | 该家庭有效成人成员 access | 无 body/query | 本家庭管理转交预览：双方成员版本、家庭版本、儿童范围摘要及数量；不泄露儿童身份 |
| `POST /families/{familyId}/management-acceptance` | 该家庭有效成人成员 access | 预览版本／摘要，管理与适用监护责任均明确确认 | 201，记录本人 24 小时有效的接受；同状态重复返回同一记录，范围变化须重新接受；此操作本身不转交 |
| `DELETE /me/account` | access＋reauth＋显式确认 | reauthGrant, confirmation, dependencyDisposition | 202，删除作业＋受限查询回执 |
| `POST /account/deletion/status` | 删除回执证明 | deletionId, receiptSecret | 最小删除进度，不恢复身份 |

`DELETE /me/identities/{identityId}` 管理可列出的登录方式：API 层给 email/password 组合一个不含敏感信息的方式 ID，仓储层仍分开存储；不能因为它不在 external_identities 中就遗漏邮箱解绑的最后方式校验。无法保留其他有效登录方式时拒绝解绑。

### 14.3 关键请求／响应示例

邮箱注册挑战请求：

```json
{ "email": "parent@example.com", "locale": "zh-CN" }
```

挑战响应（没有真正邮件服务时不能返回这样的生产成功）：

```json
{
  "data": {
    "challengeId": "example-challenge-id",
    "requestSecret": "example-random-secret",
    "status": "accepted",
    "expiresAt": "2026-09-21T09:10:00Z",
    "resendAfterSeconds": 60
  },
  "meta": { "requestId": "example-request-id" }
}
```

登录／注册／刷新成功的共同会话结构：

```json
{
  "data": {
    "tokenType": "Bearer",
    "accessToken": "example-access-token",
    "accessExpiresAt": "2026-09-21T09:15:00Z",
    "refreshToken": "example-refresh-token",
    "refreshExpiresAt": "2026-10-21T09:00:00Z",
    "sessionAbsoluteExpiresAt": "2027-03-20T09:00:00Z",
    "session": {
      "subjectId": "example-subject-id",
      "subjectKind": "adult",
      "sessionId": "example-session-id",
      "expiresAt": "2026-09-21T09:15:00Z"
    }
  },
  "meta": { "requestId": "example-request-id" }
}
```

示例 ID／日期仅说明字段，真实实现使用约定 ID 格式和服务端计算。客户端不得根据响应时间推算刷新绝对期限而忽略服务器字段。

`GET /auth/providers` 建议响应：

```json
{
  "data": {
    "emailPassword": { "enabled": true },
    "apple": { "enabled": true, "platforms": ["ios"] }
  },
  "meta": { "requestId": "example-request-id" }
}
```

微信暂不列入 enabled providers。Apple 未完成配置时返回 enabled=false；配置合法但临时网络失败应返回可恢复故障，而不是静默删除用户的 Apple 登录方式。客户端同时检查本机系统能力，不仅信任 platform query。

### 14.4 错误与客户端行为

| HTTP／错误码 | 含义 | 客户端动作 |
|---|---|---|
| 400 `INPUT_INVALID` | Schema 不符 | 提示修正，不自动重试 |
| 401 `AUTH_INVALID_CREDENTIALS` | 邮箱登录凭据无效 | 通用提示，不暴露邮箱是否存在 |
| 401 `AUTH_ACCESS_EXPIRED` | access 到期，refresh 未判无效 | 单飞刷新一次，再重试可安全重放请求 |
| 401 `AUTH_SESSION_REVOKED` | 会话明确撤销 | 清活动凭据，保留本地业务数据 |
| 401 `AUTH_REFRESH_REPLAYED` | 不合法复用旧 refresh | 重新登录，显示安全提示 |
| 401 `AUTH_REFRESH_RECOVERY_EXPIRED` | 丢失响应恢复窗口已过 | 重新登录，不删除文件 |
| 403 `AUTH_SCOPE_DENIED` | 当前身份权限不足 | 不通过无限刷新解决 |
| 409 `IDENTITY_ALREADY_LINKED` | 身份属于另一个账号 | 不自动合并，说明冲突 |
| 409 `AUTH_LAST_METHOD_REQUIRED` | 正删除最后登录方式 | 先新增有效方式 |
| 409 `VERSION_CONFLICT` | 成员／对象版本变化 | 重新读权限后由用户确认 |
| 409 `IDEMPOTENCY_CONFLICT` | 同 key 不同请求 | 停止重试并记录客户端错误 |
| 413 `BODY_TOO_LARGE` | 超过路由体积限制 | 缩小请求；不直接放宽所有接口 |
| 429 `RATE_LIMITED` | 达到频率／成本上限 | 按 Retry-After 倒计时 |
| 503 `DEPENDENCY_UNAVAILABLE` | DB／邮件／Apple 等暂不可用 | 保留安全凭据，提示稍后重试 |

令牌签名错误／未知发行者统一拒绝，不对攻击者返回详细密钥信息。`AUTH_ACCESS_EXPIRED` 仅用于确实来自本服务的过期 access，不因任意自报 exp 就触发高成本刷新。

### 14.5 幂等、重试与时间

创建账号、发验证码、绑定确认、注销、家庭邀请接受等产生副作用的接口要求 `Idempotency-Key`，范围绑定 route＋session/flow/challenge；公开邮件 request 同时受邮箱限流。默认保留 24 小时的操作元数据，但凭据响应只加密保留 60 秒；操作已提交而凭据无法恢复时返回明确“操作已完成，请登录”，不能重放创建新用户。

所有开始登录流程均记录 installationId／platform 作为设备会话上下文，描述字段只供显示；它们不是可绕过认证的硬件身份证明。

同一 key 不同规范化请求返回 409；请求摘要使用服务端 HMAC，不保存密码等可离线验证的裸摘要。自然唯一键与数据库事务仍是最终防线，不能只靠客户端 UUID。

GET 可有限重试；POST 只有具备幂等合同才自动重试。429 遵循 Retry-After，网络／5xx 指数退避最多 2 次，账户冻结／撤销／Schema 错误不自动重试。刷新使用第 11 章独立规则。

---

## 15. 移动端、Electron 与本地数据隔离

### 15.1 统一状态机，不以有无 token 字符串判断登录

```text
bootstrapping
 ├─ 无安全凭据 ───────────────→ anonymous
 ├─ 在线且凭据有效 ───────────→ authenticated
 ├─ access 过期 ─────────────→ refreshing → authenticated
 ├─ 暂时离线／服务不可用 ─────→ offline-available / service-unavailable
 ├─ refresh 明确失效 ────────→ reauth-required
 └─ 安全存储不可读取 ────────→ secure-storage-unavailable

authenticated → logging-out → anonymous
authenticated → deletion-pending → signed-out-with-deletion-receipt
```

`offline-available` 只表示可使用本设备已有且仍获授权的数据，不表示云身份已经在线验证，不允许据此加入远程通话、邀请家庭成员、绑定邮箱或获取新房间凭据。已有家庭离线租约继续遵守原合同，不由 access Token 时长代替。

启动先初始化本地空间与安全存储，再恢复会话，最后开启依赖真实身份的请求。不得先启动白板网络协作／家庭订阅，再等待登录恢复；本地编辑器可独立打开，但不得混入上一账号网络数据。

### 15.2 安全存储

移动使用现有 `expo-secure-store` 保存小体积会话恢复包，access 仅存内存；不保存于 AsyncStorage、普通 SQLite、日志或持久化状态管理快照。SecureStore 的卸载／重装、备份和生物识别变化行为具有平台差异，必须测试，不能把卸载等同于服务端退出。[S14]

首期前台凭据访问建议采用设备解锁后可用且不随备份迁往新设备的配置，并针对锁屏来电／未来后台 RTC 单独评估；不能为后台方便选择无保护的 ALWAYS。刷新包只包含 refresh、pendingRotationId、会话引用等必要字段，不塞整份用户资料。保存失败要回滚 UI 状态，必要时撤销刚创建的云会话，禁止明文兜底。

Electron 的 refresh 只在主进程／专用凭据服务中，以 `safeStorage` 保护后落盘。先检查加密是否可用；Linux 出现 `basic_text` 等不满足要求的后端时拒绝持久保存，而不是提示“已安全保存”。OS 级密钥保护不承诺抵御同一用户上下文中的恶意进程。[S15]

Renderer 通过白名单 IPC 完成登录／刷新／账号 API；不提供通用任意 URL 带凭据 fetch。验证 IPC sender、frame、参数及当前账号上下文。Excalidraw DOM／WebView 仅接收编辑数据与最小操作桥接，不能取得 access／refresh，也不能发起任意原生命令。

### 15.3 API 客户端与账号切换

新增／复用平台无关的 typed API client，集中处理版本前缀、超时、错误与幂等；平台凭据存储通过接口注入。不让每个页面各写一套刷新机制。请求只能发向经过配置确认的思玥 origin，禁止把生产 Token 发送到任意用户输入服务器。

账号切换需要同时：增加 `authGeneration`；中止旧请求和上传／同步任务；关闭旧实时连接；清理账号范围缓存；切换 subject/space 映射；再启用新会话。每个异步回包检查启动时的 subject/session/generation，一旦不匹配就丢弃，防止迟到响应污染新账号。

缓存键至少带 `environment + subjectId + spaceId + resourceId`，不使用全局 `currentUserData` 混存。注销、撤权、换号不能自动删除其他本地空间；但未授权账号不得浏览上一账号的缓存。

对于原有未登录个人空间，绑定云账号应是独立、可见、可撤销或可恢复的本地映射步骤；默认不迁移所有文件，不将本地记录 owner 一次性改写为新账号，不承诺“登录就云端同步”。

### 15.4 页面与交互验收

首期页面包括：登录、邮箱注册／验证码、忘记密码／设置新密码、Apple 授权取消／失败、账号与安全、登录方式、邮箱绑定／更换、设备会话、注销确认／进度。沿用当前设计系统，不重做主题。必须覆盖中文／英文、iPhone／iPad、Android 和实际支持的 Electron 尺寸。

首次 Apple 登录不强制“补完个人资料”；可以提示可选绑定邮箱以便 Android／Windows 使用，并允许跳过。扫码邀请／账号切换中断时保留受控待处理意图，但邀请 token 不进公开日志或剪贴板历史。

生物识别可用于本机解锁，不自动等同服务器再次验证；儿童退出受限模式／进入家长安全设置必须由有效成人认证批准，不能仅改本地布尔值。

---

## 16. 家庭、儿童设备与视频白板接线

### 16.1 四层校验顺序

```text
思玥会话有效
    ↓
主体与家庭成员关系有效
    ↓
本次房间邀请／设备席位有效
    ↓
白板对象、图片、编辑、另存、录像的具体授权有效
```

家庭角色不是所有对象的万能权限。家长登录不能自动读取孩子未共享的个人记录；加入房间也不能自动获得永久另存或录像权。沿用现有 `familyPolicySnapshot`／`familyShareGrant`，由可信仓储事务装配快照并调用现有领域策略，不能把客户端提交的 snapshot 直接当权威。[R6][R11]

### 16.2 成人与儿童身份

成人通过邮箱／Apple 登录形成成人会话；儿童通过家长创建的受监护主体及批准设备形成受限会话，首期不要求儿童拥有邮箱、Apple 账号或家长密码。

family owner/admin/member 与监护人关系分开建模。某家庭 admin 不自动获得所有儿童的监护权；客户端也不能提交 `subjectKind=adult` 升权。产品内声明的成人身份、监护同意记录不等于已完成法定年龄或监护资格验证，公开运营前另做适用政策与合规核查。

### 16.3 儿童设备配对默认方案

孩子设备发起待配对请求，获得两个不同秘密：供家长识别批准请求的 requestToken，和只保留在发起设备的 pollSecret。QR 中不能包含 pollSecret 或家长凭据。家长在已登录设备扫描、查看请求设备描述及拟授权儿童，完成 `approve-child-device` 再次验证后批准。

孩子设备用自己的 pollSecret 领取一次性结果；服务器原子消费配对请求并创建 child session／deviceGrant，不向儿童设备返回家长的 access／refresh。配对码只是申请标识，不能由知道短码的人直接获得儿童会话。

初始配对有效期 5 分钟，轮询间隔至少 3 秒；一次性批准／消费，重复领取使用受控幂等恢复。deviceGrant 建议 30 天有效，刷新不得超过该授权到期时间；到期由家长重新批准。设备 scope 限于受邀房间、已授权白板与必要个人操作，不包括邀请其他人、修改成人身份、管理监护关系或读取家长账号安全信息。

家长可随时查看和撤销儿童设备授权；监护关系失效、家庭解散、相关账号安全重置时联动失效。即使已有 child access 尚未过期，服务端下次请求仍应拒绝被撤销的 grant。

### 16.4 B 阶段最小 API

| 接口 | 权限与重点 |
|---|---|
| `GET /families`、`GET /families/{id}` | 返回当前主体可访问的家庭最小信息 |
| `POST /families` | 有效成人会话；原子创建 owner；不在注册时自动调用 |
| `POST /families/{id}/invitations` | 现有 invite 策略＋membershipVersion；受控一次性邀请 |
| `POST /family-invitations/accept` | 已登录成人；邀请 token＋幂等键；有目标邮箱时验证匹配；无自动管理员提升 |
| `POST /families/{id}/children` | 合法家庭权限＋明确监护同意；创建受监护主体 |
| `POST /device-pairings` | 无成人会话；严格限流，只能创建 pending 请求 |
| `POST /device-pairings/{id}/approve` | 成人会话＋guardian 校验＋reauthGrant＋requestToken |
| `POST /device-pairings/{id}/status` | pollSecret，最小状态，不返回成人资料 |
| `POST /device-pairings/{id}/complete` | pollSecret，一次消费，签发 child 会话 |
| `GET /children/{id}/devices`、`DELETE /children/{id}/devices/{grantId}` | 实际监护关系验证，撤销立即影响后续认证 |

邀请默认 24 小时到期，是**家庭成员邀请**，不是公开房间码。邀请权限依据现有领域规则，不在这份账号方案中重新授权普通成员邀请他人。角色转移、移除、解散等沿用已有策略，后端接线必须保留版本检查和负面权限测试。

### 16.5 房间凭据与五设备席位

当前既有视频方案要求最多五台设备，同一账号两台设备占两个席位；初始只有家长发起、受邀成员加入，无公开房间码。发起者离开不自动结束全场，明确结束由有权家长执行。[R11]

建议房间 join 服务依次验证真实 session／family／invitation，事务中锁房间并分配 deviceSession，再调用已批准 RTC Adapter 签发**短期、单房间、单设备**凭据。RTC 服务 App Secret 永不在客户端。

席位使用服务端生成并验证的 deviceSession，不相信客户端自报相同 installationId 逃避五台限制。认领可先建有期限 reservation，外部凭据签发失败释放／过期回收；不在数据库锁内等待外部网络。第六台明确拒绝，不静默踢掉已在场设备。重连令牌、旧连接 fencing／版本和席位保留窗口由 RTC 验证后冻结，未冻结不启用正式并发接入。

**账号 access 不是 RTC token，也不是白板编辑 token。** 服务端撤销会话／移除成员时，还需关闭实时连接、停止续签并调用供应商踢出／撤权能力；仅让 JWT 到期不能声称房间即时撤权。所选供应商不支持时，需要明确可接受的撤权延迟并阻止相关生产承诺。

### 16.6 白板与本地存档

Excalidraw 负责编辑层，不自动提供本项目的生产鉴权、房间管理、协作服务和备份。复用当前编辑层，仅新增受控操作通道：每个写操作绑定 boardId、subject/deviceSession、operationId、权限版本和修订，服务器／权威协作端检查授权后转发。晚加入获取被授权快照＋增量，图片缺失明确失败。

资产归属、临时缓存、指定主存档、另存和录像授权遵守既有设计；账号数据库先保存身份／权限／房间元数据，不因为“上了后端”就上传所有家庭原图、完整白板或录制内容。主存档断网、录制同意、其他设备接管等仍按现有 O02/O03 门禁处理，不被本方案默认授权。[R8][R11]

---

## 17. 安全、隐私与故障处理

### 17.1 边界威胁与控制

| 风险 | 必须控制 |
|---|---|
| 两产品凭据互用 | 独立 issuer/audience/key，服务端负面用例 |
| 同域不同路径被误当安全沙箱 | 不共享 Cookie／浏览器存储；每服务独立认证；路径只是分流，不是浏览器安全边界 |
| OAuth 登录／绑定混淆 | purpose、nonce、state、发起 session、credential_version 绑定 |
| 验证码枚举／撞库 | HMAC、单次短期挑战、账号／IP／全局限流、有界哈希并发 |
| refresh 重放或并发失联 | 原子轮换、single-flight、60 秒同请求恢复、令牌链撤销 |
| 账号切换串数据 | subject/space 缓存键、authGeneration、终止旧请求／连接 |
| 家庭／白板 ID 猜测 | 服务端对象权限查询与版本检查；不能只按 id 读取 |
| child 伪造 adult | subjectKind 由服务端库确定；派生设备权限限制 |
| 日志泄漏 | 路径模板日志＋字段白名单，禁正文／Token／验证码／Cookie／私钥 |
| SSRF／凭据外发 | 固定 Provider endpoint；不接受任意 JWKS／回调／API URL |
| 共享主机资源耗尽 | CPU／内存／连接／密码哈希／队列／日志大小限额 |
| 备份恢复已删除用户 | 删除账本重放、恢复环境封闭验证 |

### 17.2 CORS 与客户端来源

移动原生请求可无 Origin，必须以凭据验证，不能把无 Origin 当可信身份。带 Origin 请求使用**精确白名单**；默认不接受 `*`、任意 localhost、`null` 或任意自报开发地址。开发 Origin 只在开发配置中开放。

Electron 首期优先主进程代理账号请求；如确有 renderer 直连需求，明确受控 scheme/origin 与 IPC 边界，不照搬当前全局 Origin 拒绝逻辑，也不为调通直接禁用 CORS 安全策略。

首期客户端认证使用 Authorization Bearer，不使用跨产品通用登录 Cookie。未来增加正式 Web 登录时另设计 HttpOnly／Secure／SameSite Cookie、CSRF 和独立 Web origin；不要将 `/api/cloud` 与 `/api/siyue` 路径差异视为能隔离同源 XSS。

### 17.3 可观测性与留存默认

日志仅保留 requestId、服务版本、路由模板、状态码、耗时、稳定错误码和必要事件 ID。不记录 email 原文、完整 IP、Authorization、密码、code、nonce／state 秘密、请求体、Apple 返回体或数据库连接串。异常对象不能整包序列化；生产禁止 debug OAuth 日志。

建议默认：普通脱敏运行日志 14 天；最小安全事件 90 天；挑战／一次性 flow 终态元数据 24 小时；短期响应缓存 60 秒；Outbox 敏感载荷在完成／过期即清除；备份上限 35 天。这些是待与隐私说明确认的运营默认，不是普遍法律期限；未确定公开地区前不能声称已完整合规。

指标包括登录成功／失败率、验证码受理／发送／送达可获知状态、Apple 错误分类、refresh 轮换／恢复／重放、DB 连接池等待、Outbox 积压、删除作业滞留、CPU／内存／磁盘。统计不把真实家庭内容上传分析服务。

live 仅说明进程存活；ready 必须验证数据库可达且 schema 兼容。Apple／邮件短期故障不把整个本地编辑功能清空，应在受影响接口返回503。失去数据库权威时，账号／授权接口 fail closed，不伪造成功身份。

### 17.4 运维权限与儿童隐私

不复制秋哥助手的静态 admin token 当思玥管理权限。首期没有公开后台可先提供受控运维命令与审计，不能增加一个知道固定字符串就能任意改所有用户的接口。

公开运营前核查适用上架／备案、年龄与监护同意、数据处理地域、SDK 清单、隐私声明、注销路径和真实数据流。本文提供工程隔离与删除设计，不替代法律审查；不默认采集儿童证件、精确生日或联系人通讯录来“完善注册”。

---

## 18. 配置与 Secret 管理

### 18.1 服务端配置清单

| 名称 | 是否敏感 | 规则 |
|---|---|---|
| `NODE_ENV`、`SIYUE_ENVIRONMENT` | 否 | development/test/staging/production 严格枚举 |
| `SIYUE_SERVER_HOST`、`SIYUE_SERVER_PORT` | 否 | 容器内部 0.0.0.0:8787；宿主机仅回环映射 |
| `SIYUE_PUBLIC_ORIGIN`、`SIYUE_PUBLIC_PREFIX` | 否 | 生产 api.qiugeapp.com 与 /api/siyue |
| `SIYUE_DATABASE_URL` | 是 | 仅运行 DML 角色；不打印 |
| `SIYUE_MIGRATION_DATABASE_URL` | 是 | 仅迁移任务注入，运行 API 不获得 |
| `SIYUE_POSTGRES_MAX_CONNECTIONS` | 否 | API 初始 5；worker 另控 |
| `SIYUE_JWT_ISSUER`、`SIYUE_JWT_AUDIENCE` | 否 | 产品／环境绑定 |
| `SIYUE_JWT_PRIVATE_KEY_FILE`、`SIYUE_JWT_KEY_ID` | 路径否／内容是 | 独立签名密钥与 kid；旧公钥兼容窗口受控 |
| `SIYUE_JWT_VERIFY_KEYS_FILE` | 公钥非秘密 | 验证集合只包含合法思玥当前／轮换密钥 |
| `SIYUE_SECRET_ENCRYPTION_KEY_FILE` | 内容是 | AEAD 加密 Provider／Outbox／恢复缓存；包含 keyVersion |
| `SIYUE_CHALLENGE_PEPPER_FILE` | 内容是 | 验证码与敏感请求摘要 HMAC，独立于 JWT 密钥 |
| `SIYUE_EMAIL_ENABLED` | 否 | 公开注册要求真实发件配置；测试环境可替身 |
| `SIYUE_MAIL_PROVIDER`、`SIYUE_MAIL_FROM` | 否 | 受控枚举／已验证发件人 |
| `SIYUE_MAIL_API_KEY_FILE` | 内容是 | 思玥独立凭据和限额 |
| `SIYUE_APPLE_ENABLED` | 否 | 首期代码可完成但配置前关闭；发布 Apple 功能前必须启用验收 |
| `SIYUE_APPLE_TEAM_ID`、`SIYUE_APPLE_KEY_ID`、`SIYUE_APPLE_CLIENT_ID` | 标识非秘密 | 只来自服务端配置；原生客户端与实际 bundle 匹配 |
| `SIYUE_APPLE_PRIVATE_KEY_FILE` | 内容是 | Apple .p8，绝不公开 |
| `SIYUE_WECHAT_ENABLED` | 否 | 默认且本期固定 false；缺微信配置不阻止启动 |
| `SIYUE_MOCK_AUTH_ENABLED` | 否 | production/staging 严禁启用 |
| `SIYUE_CORS_ALLOWED_ORIGINS` | 否 | 精确来源，不含通配符 |
| `SIYUE_TRUSTED_PROXY_CIDRS` | 否 | 仅真实 Nginx／受控网段 |

`_FILE` 表示从只读受控文件读取秘密内容，不是把文件路径当秘密值。容器用户需有精确读权限但不得能改写。现有部署方式无法使用文件时，可选受控 Secret 注入，但不得把值加入镜像层、构建参数、命令行历史或仓库 `.env.example`。

JWT 私钥、数据加密键、HMAC pepper、Apple .p8 是不同用途，不能一个字符串通用。数据加密键轮换应先支持读取旧 keyVersion、再重加密、最后退役；丢失旧密钥会影响外部撤销与短期任务，不是换新环境变量即可自动恢复。

### 18.2 客户端公开配置

仅允许 `EXPO_PUBLIC_API_ORIGIN`、`EXPO_PUBLIC_API_PREFIX`、环境名与不含秘密的功能标识。实际 Apple 可用性结合服务器 providers 和本机系统判断。生产构建不允许指向本地开发地址或旧 qiuge API 前缀。

微信将来启用时，通过独立 `WechatIdentityProvider` 适配器增加配置和身份解析；不修改 subjectId／家庭主键，不让未配置微信影响邮箱／Apple。不得提前提交假 AppID、示例 AppSecret 或永远失败的按钮。

### 18.3 配置失败策略

生产缺数据库、签名密钥、加密键、HMAC pepper，直接拒绝启动。Apple_ENABLED=true 但 `.p8`／client ID 缺失也拒绝启动；false 时仅关闭 Apple 登录，不用假用户替代。公开注册可用但邮件未配置时不得对用户宣称邮件已发送；内部开发明确显示测试模式且不能访问真实公网用户。

启动检查验证必需值存在、Secret 不是占位符、环境组合合法、schema 版本兼容。健康接口不回显变量值；配置错误只输出变量名称和安全错误码。

---

## 19. 实施拆分、迁移与发布顺序

下面编号是本方案工作包 ID，**不是 GitHub Issue 编号，也不替换现有 SY 编号**。

| 工作包 | 交付内容 | 依赖与完成条件 |
|---|---|---|
| `SA-01` 基线与契约 | 核对最新工作分支；登记 OpenSpec 变更、架构决策和三层范围；定义严格 session 适配 | 不改已完成白板；差异清单可审查 |
| `SA-02` 独立数据库与运行骨架 | 运行／迁移角色、版本迁移、pg adapter、配置校验、live/ready、日志与错误 | 空库升级＋重复迁移＋权限负面测试 |
| `SA-03` 会话内核 | subject/session/JWT、refresh 链、撤销、单次再次验证、幂等缓存 | 真 PostgreSQL 并发／响应丢失测试；仅测试 adapter 发身份 |
| `SA-04` 邮箱闭环 | 注册、密码、验证码、限流、发件 Outbox、找回／修改 | 真邮箱送达测试＋恶意枚举与并发失败测试 |
| `SA-05` 客户端接线 | 移动 SecureStore、Electron 主进程、统一状态机、错误／换号／离线 | 启动恢复和双账号隔离；保留本地数据 |
| `SA-06` Apple 接入 | 原生配置、nonce flow、服务端验签／交换、资料兼容、外部凭据保护 | 真 bundle／真机；隐藏邮箱、再次登录、取消／撤销 |
| `SA-07` 账号安全闭环 | 多方式绑定、最后方式保护、设备会话、注销、Apple 撤销、删除账本 | 全流程 E2E＋不可用依赖恢复，不是只有页面 |
| `SA-08` 家庭与儿童真实接线 | 复用 family policy，受控邀请、监护关系、儿童受限设备 | 成人／儿童／成员越权负面用例通过 |
| `SA-09` 视频白板身份衔接 | 单房间设备授权、5 席位原子占用、撤权／重连接口；接现有白板 | 仅在已批准 RTC／权限规则内实施；真实五设备另验收 |
| `SA-10` 预发布与上线门禁 | Nginx 增量、独立镜像、备份恢复、旧产品回归、运营与删除检查 | 有证据的预发布验收，生产操作另按授权 |

推荐推进：SA-01→SA-02→SA-03；SA-04 与 SA-06 可在接口冻结后并行，SA-05 随邮箱闭环接入；SA-07 完成安全功能；SA-08/09 只实现当前视频目标必需部分。**没有 Apple 配置时继续邮箱／数据库／会话实现，不能用这个理由停工；但不能把 Apple 标为完成。微信不在任何前置依赖链。**

### 19.1 仓库内文档落点

建议创建 `openspec/changes/add-shared-api-independent-auth/`，下设 proposal／design／tasks 与相应 capability delta；使用现有 OpenSpec 结构，不创建另一套冲突流程。建议将本主文档作为 `docs/architecture/backend-auth-v1.md` 的内容基线，任务和证据入口登记到当前版本计划与 START_HERE，编号按仓库规则处理。

本轮只交付文件，以上路径是开发时建议，不表示已经推送。任何提交、PR、合并、部署、付费申请必须遵守当次用户授权。

### 19.2 预发布流程

先构建独立镜像并在空的思玥预发布库迁移。预发布用不同角色／Secret／issuer，不接生产数据库；域名未批准时经 SSH 隧道或受控预发布入口测试，不假设 staging 域名已经存在。真实手机联调必须是可达且受控 HTTPS，不能让手机请求它自己的 localhost。

完成邮箱、会话、Apple、绑定／删除、客户端隔离及回归后，记录提交 SHA、镜像 digest、migration checksums、配置名称、测试设备和未解决门禁。不能仅看到 `200 health` 就发布。

### 19.3 生产增量部署

1. 只读核对宿主机端口、网络、PostgreSQL 角色／资源余量、证书及现有 Nginx；备份旧配置与数据库，并确认恢复过程可用。
2. 使用受控迁移角色创建／升级思玥数据库；不修改秋哥助手表或复制生产数据到新库。
3. 先在回环启动思玥 API／worker；用 live/ready 和受控 smoke 验证，检查日志无秘密。
4. 仅加入思玥 Nginx location，执行 `nginx -t` 后 reload，不改旧精确微信回调、不替换整个 server 块。
5. 公网验证思玥路由与未知路径，再运行旧秋哥助手授权范围内的 health／ready／登录／刷新／微信回调兼容检查。
6. 分开打开公开注册、Apple、家庭和 RTC 功能开关；未完成的功能保持关闭，不能把测试替身暴露给用户。
7. 保留发布记录、异常阈值、前一版本镜像及回退步骤。不得在交付报告泄露账号、密码、真实 Token 或二维码。

### 19.4 回滚与数据纪律

API 代码回滚到与当前 schema 兼容的前一镜像；采用 expand/contract 演进，先新增再兼容切换，不能以降级为由执行 destructive down migration。必要时只关闭思玥路由／功能，保留库和已生成数据。前一版本不兼容时进入受控维护，而不是直接恢复旧备份覆盖新写入。

秋哥助手现有 Cloudflare 回退入口不属于思玥回滚方案；不能把思玥流量指向秋哥助手旧 Worker，也不能假定两个库自动双写。

---

## 20. 测试策略、验收矩阵与完成定义

### 20.1 测试层次

单元测试验证状态机、策略与校验；真实 PostgreSQL 集成测试验证事务、唯一约束、角色、幂等与并发；HTTP 合同测试覆盖请求／响应和代理前缀；原生端测试覆盖安全存储、Apple、账号切换；生产 smoke 仅在获授权环境使用专门测试账号。

第三方 Apple 验签单测可以用测试密钥与合成 Token，但必须通过测试专用依赖注入，production 配置不能切到任意 issuer/JWKS。测试成功不意味着真实 Apple 应用配置成功。

### 20.2 必测矩阵

| 类别 | 必须通过的场景 |
|---|---|
| 服务隔离 | qiuge Token 请求思玥失败；思玥 Token 请求 qiuge 失败；预发布／生产互拒；新服务停止旧接口仍正常 |
| 数据库隔离 | siyue_app 不能建表／读旧业务库；跨库 CONNECT 与旧角色高权限审计；迁移用户不进入运行进程 |
| 邮箱 | 未验证不注册；错误／过期／重放验证码；多次重发累计限流；同邮箱并发只一个账号；发件失败不假成功 |
| 密码 | 边界长度／Unicode；弱密码；哈希参数升级；重置不自动登录；旧会话立即失效；不能重置未绑定 Apple 资料邮箱 |
| Apple | 正常／隐藏邮箱／首次后姓名为空／取消；伪造签名／错误 aud/iss/nonce/state；授权码重放；JWKS 轮换；两次首次登录只一个主体 |
| 刷新 | 同一 token 并发；single-flight；服务器已提交但丢回复；60 秒内同 rotationId 恢复；超时窗口重新登录；不同 rotationId 重放撤销；绝对期限不滚动 |
| 绑定 | 同邮箱／外部身份冲突；发起 session 撤销后旧 flow 失败；凭据版本变化；并发删最后两种方式；Apple-only 可重新验证 |
| 客户端 | 安全存储失败无明文降级；离线不删 refresh／业务文件；换号时旧请求迟到不污染；RT 不进入 Renderer／DOM；重装行为 |
| 家庭与儿童 | 自报 adult 无效；member 越权邀请；非监护人批准失败；被撤销 child grant 不能刷新／加入房间；家庭成员不等于可读所有记录 |
| 房间与白板 | 第六设备拒绝；相同账号两设备计两席；伪造 installationId 不能逃限；撤销影响在线连接；白板编辑与另存分权 |
| 注销 | 受理后即时禁用；本人云端内容清理；外部撤销失败重试不假完成；最后监护依赖有可完成处理；备份恢复不复活 |
| 兼容 | 当前本地白板编辑／多页／图片保存重开、严格 session 合同、已有离线权限及中英文界面不退化 |
| 运维 | 缺 Secret／生产 Mock 拒绝启动；代理 bodyLimit／路径；旧微信精确规则；ready 数据库故障；备份恢复；CPU／哈希限额 |

完整可勾选用例见随附 `Siyue_Acceptance_Checklist.md`，初始全部未勾选，避免把设计文档当测试报告。

### 20.3 三个互不替代的 Done

**账号后端 Done**：邮箱＋Apple 真闭环、持久化身份、跨设备同账号、刷新恢复、绑定／撤销／注销与隔离验收全部具备证据。Apple 缺配置时只能称“邮箱子切片完成”。

**家庭身份 Done**：真实家庭成员与儿童受限设备、监护批准、权限撤销及版本冲突都可验收，不靠 fixture 注入身份。

**五设备视频白板 Done**：真正五台目标设备、已批准 RTC、多人音视频＋共同编辑＋本地可编辑保存＋撤权／失败恢复通过；三台测试、五个浏览器标签或单机 Excalidraw 不替代。录制与主存档能力按既有独立范围验收，不能偷换成登录成功。[R8][R11]

### 20.4 尚未由这份文档验证的发布门禁

Apple 开发者配置／签名／真机；正式邮件域名与实际送达；ECS 资源与旧数据库角色；生产迁移恢复；具体 RTC 厂商、预算、数据地域与撤权能力；录制同意／主存档接管等既有未决规则；公开儿童产品的适用隐私与上架要求。

这些门禁阻止对应功能**发布**，不阻止独立数据库、邮箱、会话、契约与测试开发。编程助手不得为了消除门禁而自行采购、申请 AppID、扩大权限或改变已确认范围。

---

## 21. 后续微信接入边界

当用户明确启动微信接入，再新增：移动应用配置、客户端原生授权适配、服务端 code 交换、`WechatIdentityProvider`、受控绑定／解绑与验证测试。保持 subjectId／session／family／space 的既有主键与权限不变。

微信登录依然签发**思玥会话**，不接收秋哥助手会话作为捷径。登录唯一性需要 provider 命名空间和应用级身份；未来 UnionID 的跨应用关联必须另行验证所属开放平台命名空间与用户主动意图，不能自动合并两个产品数据库。

本期只保留 Provider 接口、身份表扩展性与关闭开关，不创建没有用途的微信事务代码，不展示微信按钮，不提前配置虚假微信 Secret。

---

## 22. 依据、引用与复核说明

代码依据固定于第 1 章提交，官方资料查阅日期为 2026-09-21。库版本、Apple 平台规则与外部接口上线前需复核；本文中的表名、超时、限流、令牌期限和拆包方案属于工程设计，不是从来源抄出的已实现状态。

### 22.1 仓库依据

- [R1] 秋哥助手国内云端部署与兼容说明：
  https://github.com/zhangqiu-ai/qiuge-helper/blob/86538d4230ac97be22839168d199bf625c69b7e4/docs/cloud-server.md
- [R2] 秋哥助手既有 Nginx：
  https://github.com/zhangqiu-ai/qiuge-helper/blob/86538d4230ac97be22839168d199bf625c69b7e4/deploy/aliyun-cloud/qiuge-api.conf
- [R3] 思玥当前服务装配：
  https://github.com/zhangqiu-ai/siyue/blob/fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1/apps/server/src/app.ts
- [R4] 思玥既有 SessionVerifier 与会话路由：
  https://github.com/zhangqiu-ai/siyue/blob/fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1/apps/server/src/session.ts
- [R5] 严格会话契约：
  https://github.com/zhangqiu-ai/siyue/blob/fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1/packages/contracts/src/account-session.ts
- [R6] 家庭权限契约：
  https://github.com/zhangqiu-ai/siyue/blob/fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1/packages/contracts/src/family-policy.ts
- [R7] 本地空间与云身份模型：
  https://github.com/zhangqiu-ai/siyue/blob/fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1/docs/domain-model.md
- [R8] 视频白板与 Excalidraw 当前任务状态：
  https://github.com/zhangqiu-ai/siyue/blob/fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1/openspec/changes/add-family-video-whiteboard/tasks.md
- [R9] 当前首要目标与开发纪律：
  https://github.com/zhangqiu-ai/siyue/blob/fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1/START_HERE.md
- [R10] 当前移动应用配置：
  https://github.com/zhangqiu-ai/siyue/blob/fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1/apps/mobile/app.json
- [R11] 视频白板房间、存档、权限与未决门禁：
  https://github.com/zhangqiu-ai/siyue/blob/fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1/openspec/changes/add-family-video-whiteboard/design.md

### 22.2 官方技术与安全依据

- [S1] Expo AppleAuthentication：
  https://docs.expo.dev/versions/latest/sdk/apple-authentication/
- [S2] Apple：Verifying a user：
  https://developer.apple.com/documentation/signinwithapple/verifying-a-user
- [S3] Apple：获取身份 Token 验签公钥：
  https://developer.apple.com/documentation/signinwithapplerestapi/fetch-apple%27s-public-key-for-verifying-token-signature
- [S4] Apple TN3194：账号删除与授权撤销：
  https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple
- [S5] Apple：应用内发起账号删除：
  https://developer.apple.com/support/offering-account-deletion-in-your-app/
- [S6] Apple：Private Email Relay 配置：
  https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service
- [S7] Apple：服务端通知配置：
  https://developer.apple.com/help/account/capabilities/enabling-server-to-server-notifications
- [S8] OWASP Password Storage Cheat Sheet：
  https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- [S9] OWASP Authentication Cheat Sheet：
  https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- [S10] OWASP Forgot Password Cheat Sheet：
  https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
- [S11] IETF RFC 9700：OAuth 2.0 Security Best Current Practice：
  https://www.rfc-editor.org/rfc/rfc9700.html
- [S12] Nginx HTTP proxy module：
  https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- [S13] PostgreSQL 权限模型（概念参考；不要求升级既有 PostgreSQL 17）：
  https://www.postgresql.org/docs/current/ddl-priv.html
- [S14] Expo SecureStore：
  https://docs.expo.dev/versions/latest/sdk/securestore/
- [S15] Electron safeStorage：
  https://www.electronjs.org/docs/latest/api/safe-storage
- [S16] Apple Human Interface Guidelines：Sign in with Apple：
  https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple/
- [S17] Apple App Review Guidelines：
  https://developer.apple.com/app-store/review/guidelines/
- [S18] Apple 当前公开 JWKS（用于确认验签密钥类型，不固定某个 kid）：
  https://appleid.apple.com/auth/keys

---

## 23. 交付边界

本方案提供开发目标、接口合同、数据模型、状态机、安全策略、操作顺序与验收定义；没有运行目标仓库代码、没有验证真实邮件送达／Apple 真机授权、没有访问 ECS 或更改生产数据库，也没有向 GitHub 提交文件。

实施时必须以真实测试结果填写证据，不把本文件的完整程度当作功能已经完成。最终应能明确回答：这次完成了账号后端、家庭身份，还是五设备互动中的哪一层，以及尚未通过哪个发布门禁。
