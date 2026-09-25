# 独立数据库与会话内核：首批本地证据

日期：2026-09-21。分支 `feature/dev`，基线 `fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1` 加本次未提交改动。原件在 [方案目录](../architecture/backend-auth-v1/README.md)，内容逐字节及 SHA-256 一致；后续结果不修改原始 102 项待执行清单。

## 实施范围

SA-01 基线与合同审查、SA-02 独立数据库和运行骨架、SA-03 服务端会话内核已实现首批本地切片。生产邮箱和 Apple 尚未接入，签发只能通过内部已验证身份适配接口；测试身份只在测试文件创建。主程序已装配数据库、密钥、自检、会话、清理和关闭，不是孤立库函数。

新增 PostgreSQL provision、首条身份迁移、受限连接池、事务、checksum/锁/环境校验；新增 ES256、refresh 唯一后继和加密恢复、退出、单次 reauth。后续实际敏感操作须在同一事务调用 reauth 消费。儿童设备授权属于 SA-08，不能通过当前成人签发接口创建儿童会话。

原 session 严格成功对象与旧客户端保持兼容。生产适配新增基础设施失败 503；旧客户端已将其解释为 unavailable，HTTP 回归验证不会误判成 unauthorized。既有本地 Mock 仅在 development、无数据库配置时启动，production/staging 无数据库直接失败。数据库运行实例没有公开 Mock 接口。

## 环境与依赖

Node 22.22.3，pnpm 11.25.0，PostgreSQL 17.11，pg 8.23.0、jose 6.2.12、@types/pg 8.23.1；Fastify 与其他应用技术栈未升级。

Homebrew PostgreSQL 安装后资源目录链接缺失，初次 initdb 失败。已补齐安装目录要求的 share/lib 链接，之后隔离集群实际启动。测试仅使用临时 Unix socket，禁用 TCP、不加载项目 `.env`，每组结束后关闭并移除临时实例。没有接触生产数据库。

## 执行结果

| 命令 | 实际结果与覆盖 |
| --- | --- |
| `corepack pnpm --filter @siyue/contracts build` | 通过，共享契约可编译 |
| `corepack pnpm --filter @siyue/contracts test` | 20/20 通过，原共享契约回归 |
| `corepack pnpm --filter @siyue/server build`、`typecheck` | 通过 |
| `corepack pnpm --filter @siyue/server test` | 23/23 通过，原服务与严格 session 边界回归 |
| `corepack pnpm --filter @siyue/server test:integration` | 20/20 通过：真实 PostgreSQL 迁移、角色/跨库拒绝、事务回滚、运行配置/启动、会话/恢复/撤销/reauth/加密 |
| `corepack pnpm exec playwright test tests/e2e/auth-foundation.spec.mjs tests/e2e/account-session.spec.mjs` | 6/6 通过：真实 loopback HTTP＋真实 PostgreSQL、旧客户端兼容、重放、非法参数、provider 关闭、实际断库返回503 |

Playwright 使用测试运行器的 HTTP 客户端，本批没有新 UI；不是手机、桌面 UI 或真机验收。子代理 deepseek/deepseek-flash 委派遇到 429，未产出独立审计，主代理继续实现与核查。

补充检查：adapters 类型检查通过；spec:check 6/6、release:check 与 git diff --check 通过。原始三文件再次逐字节核对未改变，根 .env 未跟踪且权限0600。

## 原验收表映射

- ISO-01：当前本地开发分支保留白板；ISO-04/05：仅独立 JWT 验证负面测试，不代表对秋哥助手生产 API 的双向验证。
- DB-01/02/04/05：隔离真实角色、跨库 CONNECT 拒绝、空库/重复/并发迁移和 checksum 保护通过；DB-07：池及查询等待有限配置，尚无共享服务器负载证据；DB-08：真实断库 HTTP fail closed 通过。
- SES-01/02/03/05/06/07/08/09/11：服务端切片通过。恢复缓存 AEAD、有界并到期清理；原 refresh 常态只存摘要。绝对到期不滚动，响应丢失不生成新链。
- ACC-03：grant 内核动作/主体/会话绑定、过期、单次并发消费和事务回滚通过；真实密码／Apple 重新验证入口属于后续工作包。
- OPS-01：生产缺配置拒绝启动，测试配置启动实际服务通过；不代表生产部署或真实提供方验收。

## 未完成与下一步

SA-04 邮箱注册、Argon2id、挑战、Outbox 和找回密码；SA-05 API 产品前缀、single-flight 和安全存储/换号/离线状态；SA-06 Apple；SA-07 绑定/设备管理/注销；SA-08/09 家庭儿童及真实房间；SA-10 部署、备份恢复与旧服务回归仍未完成。不能把本批测试算作账号总体 Done、家庭 Done 或五设备 Done。

邮件/Apple 默认禁用，真实邮件送达、Apple 真机、ECS 角色资源、备份恢复、真实五设备及录像均未验收。当前未提交、未推送、未部署。

维护者另行授权保存云服务器连接资料：从 qiuge-helper 根 `.env` 选择三项 ECS 变量复制到 Siyue 根 `.env`，逐值核对但不输出值；Git 忽略、权限0600。没有复制其他产品用户库或业务认证秘密，也没有因此获得部署授权。

## 技术依据

核对 [node-postgres 事务](https://node-postgres.com/features/transactions)、[jose 官方实现与接口](https://github.com/panva/jose)、[PostgreSQL SET ROLE](https://www.postgresql.org/docs/current/sql-set-role.html)。使用实际安装包类型和编译结果验证兼容；资料不替代以上运行证据。
