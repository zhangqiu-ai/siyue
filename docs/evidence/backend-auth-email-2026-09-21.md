# SA-04 邮箱服务本地验证

2026-09-21；`feature/dev`，基线 `fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1` 加当前未提交后端工作区。三份输入方案原件未修改。本记录仅证明下面执行过的后端范围，SA-04 的真实邮箱条件及完整 SA-01～10 目标未完成。

## 变更与环境

- `packages/contracts/src/auth-email.ts`：严格请求合同、15–128 Unicode 码点密码、不修改空格、挑战与设备元数据；不接受角色／主体自报。
- `apps/server/migrations/0002_email_auth.sql`：追加邮箱／密码／挑战／预算／幂等／Outbox／安全事件／条款版本；不改第一条历史迁移。
- `apps/server/src/modules/auth/`：验证码注册、密码登录、找回及修改密码、再次验证、HMAC、错误计数、幂等和全会话撤销。
- `apps/server/src/adapters/mail/`、`mail-worker.ts`：独立 SMTP worker、数据库认领租约、固定中英模板、有限重试与结果未知处理。API 只写队列。
- Node 22.22.3、pnpm 11.25.0、PostgreSQL 17.11。每次测试创建独立 `/tmp/siyue-pg-*` 集群，仅本机 Unix socket，结束后关闭；不读取项目 `.env` 或任何生产 URL。
- 新增 `argon2@0.45.1`、`nodemailer@10.0.10`、`@types/nodemailer@8.0.2`。pnpm 工作区允许 argon2 必需原生构建，未忽略 peerDependencies。冻结锁文件安装与编译通过。
- [node-argon2 官方接口](https://github.com/ranisalt/node-argon2)、[Nodemailer SMTP](https://nodemailer.com/smtp) 于本日核对；实际包类型与本机构建验证。弱密码表固定来源、hash 与 MIT 许可见 [resources](../../apps/server/resources/README.md)，不上传用户密码，不声称覆盖所有泄漏密码。

## 执行与结果

| 实际命令／执行边界 | 结果 |
| --- | --- |
| `corepack pnpm --filter @siyue/contracts build`、`corepack pnpm --filter @siyue/server build` | 通过 |
| 两包各自 `typecheck` | 通过 |
| `corepack pnpm --filter @siyue/contracts test` | 22/22 |
| `corepack pnpm --filter @siyue/server test` | 23/23，保留原 Mock／严格会话路由回归 |
| `node --test --test-reporter=spec apps/server/tests/integration/*.test.mjs` | 当时已有 43/43；随后新增用例及锁顺序修复按下面相关文件定向重跑 |
| `node --test --test-reporter=spec apps/server/tests/integration/database.test.mjs` | 当前 8/8；含旧第一条迁移保留数据升级及真实 SQL 唯一约束 |
| `node --test --test-reporter=spec apps/server/tests/integration/email.test.mjs` | 当前 21/21；与未变的 runtime 5、sessions 9、SMTP 3 合计现有 46 项均有执行通过证据，不声称又跑了一次全套 |
| `corepack pnpm exec playwright test tests/e2e/email-auth.spec.mjs tests/e2e/auth-foundation.spec.mjs tests/e2e/account-session.spec.mjs` | 10/10：真实 loopback HTTP＋PG，邮件收件箱为注入的合成收件适配；不是客户端页面或真实收件箱验收 |

源码最后锁顺序变动只涉及 request 的 subject 行锁，21 项邮箱定向复跑额外验证等待期间不替换挑战、解锁后取当前凭据版本。最终规格／版本／diff 检查结果另在本记录结尾登记。

### 已覆盖的失败和并发证据

- 同 key 八次并发确认仅一个主体、一条会话且返回同一组凭据；不同 key 并发只消费一次。已使用初始 refresh 后不能再恢复陈旧注册响应。
- 错码计数实际提交，第五次锁定；重复同幂等错误不重复计数。重发不能清除邮箱累计预算。过期、错误 requestSecret、跨用途、superseded 与已消费挑战均拒绝。
- 同一邮箱小时／日预算、跨邮箱 IP 预算、跨 IP 全局预算；失败登录累计预算及有界 Argon2 并发。未对目标 ECS 压测，不推断对旧产品负载的影响。
- 重置更新版本并撤销全部 access／refresh／reauth，不自动登录。两次并发重置只变更一次版本；密码已验证但在等待期间被重置的登录不能签发新会话。
- 权限故障注入使重置在撤销后无法写安全通知：事务完整回滚，原密码／会话／挑战／版本保留，解除故障后可重试。修改密码的授权与更新同事务。
- 私密 SMTP 配置缺失／权限过宽时拒绝启用；实际 API 子进程启动、提供 providers、写加密队列并退出，API 不发送邮件、不打印凭据。
- 独立本地 TLS SMTP 服务验证实际 Nodemailer 提交、前导零、稳定 Message-ID、明确拒收、末尾 ACK 丢失、拒绝不可信证书。所有地址均为 `example.test`，没有真实外发。
- 两 worker 同时认领只有一次发送；明确可重试失败最多三次，未知结果不重发；损坏载荷不发送；完成／失败／过期／未知清除载荷。通过持久化 stale sending 租约模拟发送进程中断，并重新构造 worker 恢复；未把它称为真实生产进程强杀验收。

### 本轮发现并修复

1. Outbox 更新中的 `CASE` 令 PG 将完成时间参数推断为 text，真实 PG 失败；显式 timestamptz 后原测试通过。
2. SMTP 在 DATA 后丢连接也可能标记 `command=CONN`，不能据此认为未提交。真实本地 SMTP 重现后，改为仅明确负面回复／DNS 失败可重试，其余不明状态不自动重发。
3. 发送预算改为全部原子预留，小时额度拒绝不再额外消耗日额度。错码及失败登录的累计计数仍提交。
4. request 对已知主体先锁主体再替换挑战，避免与密码修改的主体→挑战顺序相反；定向 PG 锁等待测试通过。

## 原验收清单映射与剩余边界

- MAIL-01～06、MAIL-08：后端合同、事务、并发及限流自动化通过。公开响应形态一致；没有做真实网络统计时间侧信道测试。
- MAIL-07：仅“排队／SMTP 接受／未知”状态及本地 TLS 测试通过；**真实邮箱到达未运行**，不能勾完整条目。
- MAIL-09：加密载荷和持久化租约恢复通过；真实部署 worker 启停／监控留待 SA-10。
- PASS-01：合同和服务端 Unicode/空格通过，客户端一致性留待 SA-05。
- PASS-02/03：本机参数、弱密码、dummy 与并发通过，目标 ECS 性能与旧产品共存压力未运行。
- PASS-04：后端与 HTTP 通过。PASS-05 仅拒绝未知／非登录邮箱，完整 Apple 资料隔离留待 SA-06/07。PASS-06 已实现密码修改，邮箱更换／真实通知及原生离线页面仍未完成。
- 没有新建家庭或改动白板内容；尚未接入客户端注册／密码／安全存储状态机、Apple、账号绑定／注销、家庭儿童真实权限、视频房间身份及五设备。原生验收仍未运行。
- 真实发件配置、发件域名与 SPF/DKIM、授权收件测试账号、ECS 容量和生产代理规则尚无验收证据。根 `.env` 中已有部署连接信息，不代表授权部署、已迁移云库或已发送真实邮件。
- worker 停止时物理清理会延迟，但 API 不接受过期挑战／缓存；生产清理和积压监控仍属 SA-10。当前不信任代理转发 IP，生产需明确可信代理后验收，不能用公网可伪造的 X-Forwarded-For 绕过预算。
- 路由到 `deepseek/deepseek-flash` 的独立测试子任务再次得到 429，未产出改动；本轮实现、审查与验证由主代理完成，不声称独立复核通过。

## 最终检查

`spec:check` 6/6、`release:check`、`git diff --check` 通过。最后的 HTTP 10/10 已在 request 锁顺序修复后重跑；邮件测试按挑战对应 job ID 等待合成收件，避免依赖随机 UUID 的队列次序。三份项目内原件与下载文件再次逐字节比对一致。未提交、推送或部署；工作包及完整目标保持进行中。
