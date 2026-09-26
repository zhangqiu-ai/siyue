# Siyue 独立部署包（Docker / ECS）

本目录只负责**构建可重复的部署工件**、目标机**只读 preflight**、**健康检查**与**回滚方法**。
它不远程登录、不推送、不改公网、不碰 qiuge 的 nginx 配置或数据库内容；远端动作由主代理执行。

## 1. 目标机事实与方案（2026-09-25 只读核查）

| 事实 | 结论 |
|---|---|
| Ubuntu 22.04 x86_64，1.6 GB RAM（可用约 984 MB），无 host Node / psql | 用现成 Docker；镜像构建只做 `COPY`，不在目标机编译 |
| nginx 是**宿主进程** `/usr/sbin/nginx`，站点 `/etc/nginx/sites-enabled/api.qiugeapp.com`，`sudo -n` 可用 | 只在该 server 块增量插入 `/api/siyue/` 与 `/api/siyue/legal/`；`nginx -t` 通过后 reload，旧 location 与 TLS 不动 |
| qiuge-cloud-api 监听 127.0.0.1:8081 | Siyue API 发布到 127.0.0.1:8787，nginx 直接在宿主回环访问，无需跨容器可达性假设 |
| qiuge-postgres（PG17，POSTGRES_USER=`qiuge_cloud`，数据在 `/srv/qiuge/data/postgres`），仅在 docker 网络 `qiuge-private` | Siyue 容器加入该网络；**不**重建 PG 容器、不动数据卷 |
| 8787 未占用；无 Siyue 目录 | 新建 `/opt/siyue/releases/<release>` 与 `current` 符号链接 |
| 本机已缓存 `docker.m.daocloud.io/library/node:22-bookworm-slim` | 镜像构建用该基础镜像（compose build arg `SIYUE_NODE_IMAGE` 默认值），无需拉取 Docker Hub |

两个 Siyue 容器：`siyue-api`（`node dist/index.js`，宿主回环 8787）与 `siyue-mail-worker`（`node dist/mail-worker.js`，无端口），
以 uid 1000 运行，内存上限 448m + 256m，`read_only` + tmpfs `/tmp`。邮件 transport 已落地的实现是 **Resend HTTP API**，
worker 需要出网访问 `https://api.resend.com`。

**数据库隔离口径**：Siyue 库、角色与注销账本库都建在**同一** PG 集群内。保留逻辑隔离与「按库恢复」语义
（恢复 `siyue` 主库不会带回账本），但共享主机、实例、磁盘与集群级备份——**不是独立故障域**，验收材料不得这样写。

## 2. 产物结构

`build-artifact.sh` 产出 `artifacts/server-deploy/<version>-<sha>[-dirty]/` 与同名 `.tar.gz` + `.sha256`：

```text
app/                  编译后的 server + workspace 依赖 + migrations + resources + provision SQL
legal/                双语用户协议与隐私政策（terms.html、privacy.html），供 host nginx alias 只读发布
Dockerfile            运行时镜像（只 COPY app/，legal/ 不进镜像）
docker-compose.yml    siyue-api、siyue-mail-worker
siyue.env.example     变量名与占位符（无真实值）
.dockerignore         让 env、tarball、manifest 不进镜像上下文
nginx/                仅 /api/siyue/ 与 /api/siyue/legal/ 的增量 location 片段
source/               本次构建使用的 pnpm-lock.yaml、pnpm-workspace.yaml
DEPLOY.md             本文件副本
DEPLOY-MANIFEST.json  git 版本、依赖锁哈希、migration checksum、legal 资产、逐文件 SHA-256
```

工件内**不含**：`.env`/`*.local`、测试文件与 `test/` 目录、密钥材料、`.git`、源码 `src/`、`.turbo`、
以及任何指向工件外的符号链接。**第三方归属文件保留**：`LICENSE`/`LICENCE`/`COPYING`/`NOTICE`/`COPYRIGHT`/
`AUTHORS`/`PATENTS` 系列（含 `.md` 形式）不被裁剪，manifest 的 `licenses` 列出并计数（本次 85 个）；
`resources/` 同样保留（含 SecLists 许可与来源说明）。只删除普通 `README.md` 等说明性 `*.md` 与 `*.map`。

## 3. 构建依赖与耗时（主代理执行前确认）

`build-artifact.sh` **现在即可使用（2026-09-25 实测通过）**，依赖：Node ≥ 22.13、corepack/pnpm 11.25.0、git、tar，以及仓库现有的 `node_modules`。
同一 release 路径同时只允许一个构建者：脚本默认拒绝覆盖已有 bundle，重建需显式 `--force`；构建失败会打印警告，
指出原路径上留下的仍是更早的产物、不得发布。
不执行全仓 `pnpm install`：编译直接用 `node_modules/typescript/bin/tsc` 按依赖顺序跑四个包；
`pnpm-workspace.yaml` 的 `verifyDepsBeforeRun: error` 只会影响 `pnpm run`，因此这里用 `--config.verify-deps-before-run=false`
仅作用于 `pnpm deploy` 一步（依赖解析仍严格来自 lockfile）。本地实测：热 pnpm store 约 12 秒完成；
产物目录约 30 MB、tarball 约 5 MB、3571 个文件、26 个 migration。

```sh
scripts/server-deploy/build-artifact.sh --target-platform linux/amd64
scripts/server-deploy/verify-artifact.sh artifacts/server-deploy/<release>.tar.gz --probe-host-platform
```

`verify-artifact.sh` 校验：tarball 摘要、manifest 逐文件 SHA-256、禁止文件、符号链接不得指向工件外、
`@siyue/*` workspace 依赖可解析、migration checksum、`legal/` 资产齐备、目标平台原生预编译。
随后用**清空的环境**真正启动入口：API 与 mail worker 必须快速失败（不可能误连生产库），
`argon2`（原生）/`fastify`/`pg`/`nodemailer`/`jose`/`zod` 与 `migrations/` 必须从工件本身加载。

原生化说明：工件唯一的原生模块是 argon2，npm 包自带 `prebuilds/linux-x64/*.node`（glibc + musl，N-API），
且不存在本机编译的 `build/`；manifest 的 `nativeModules` 记录该事实，`verify` 会拒绝编译型原生二进制。

## 4. 部署顺序（主代理执行）

**现有线上环境的两条硬约束（2026-09-25 实测）**

- **compose 必须叠加外部网络覆盖**：`siyue-internal` 由宿主预先创建、没有 compose 标签，只用工件内的 `docker-compose.yml` 会被 compose 拒绝（本次拒绝未影响旧服务）。迁移、启动、回滚等会创建容器的 compose 操作都在基础文件后追加 `-f /etc/siyue/network-compose.yml`，由该覆盖文件把 `siyue-internal` 声明为 `external: true`；两个 `-f` 的顺序是基础文件在前、覆盖在后。
- **不重跑数据库初始化**：`siyue`、`siyue_deletion_ledger` 与最小权限角色已在该环境建好，下面的第 4 步只适用于全新环境，不得重复执行。

1. **传输与校验**：`<release>.tar.gz` 与 `.sha256` 传到目标机，校验后解压到 `/opt/siyue/releases/<release>`，
   目录保持 root:root 且 `o+rx`（nginx 需要读取 `legal/`），再 `ln -sfn` 更新 `/opt/siyue/current`。
2. **写配置**（都不入 bundle）：
   - `/etc/siyue/compose.env`：`SIYUE_VERSION`、`SIYUE_PG_NETWORK=qiuge-private`、`SIYUE_ENV_FILE`、`SIYUE_SECRETS_DIR`、`SIYUE_NODE_IMAGE`（默认即缓存镜像）；
   - `/etc/siyue/network-compose.yml`：把 `siyue-internal` 声明为 `external: true` 的网络覆盖文件；现有环境的预建网络没有 compose 标签，缺它无法执行容器创建类 compose 操作；
   - `/etc/siyue/siyue.env`（0600）：按 `siyue.env.example`；**不含** `SIYUE_MIGRATION_DATABASE_URL`；
   - `/etc/siyue/siyue-migrate.env`（0600）：迁移专用的 `SIYUE_MIGRATION_DATABASE_URL`（`siyue_migrator`）等三项；
   - `/etc/siyue/secrets/`（0700，属主 uid 1000）内 0600 文件：JWT 私钥、JWKS、加密键、challenge pepper、
     `mail-config.json`（Resend：`{"provider":"resend","apiKey":"…","from":"…"}`，严格字段；无 `provider` 键则仍按 SMTP 解析）、
     `registration-policy.json`（`enabled:true` + 两份法律文档的 https URL）。compose 只读挂载为 `/run/siyue-secrets`；
     不要用 compose `secrets:`（生成 0444，会被 API 的权限校验拒绝）。
3. **preflight（只读）**：
   ```sh
   scripts/server-deploy/preflight.sh --bundle /opt/siyue/releases/<release> \
     --version <release> --pg-network qiuge-private
   ```
   校验工件完整性、内存/磁盘余量、8787 占用、env 名与取值（非秘密项）、秘密文件权限与属主、
   `registration-policy.json` 内容与法律 URL、`legal/` 是否随发布、`qiuge-private` 存在与 `qiuge-postgres:5432` 可 TCP 连通、
   缓存基础镜像、`sudo -n` 可用性、`docker compose config -q`、以及宿主 nginx 的站点文件/`nginx -t`。
   它不写状态、不重载 nginx、不碰数据库。
4. **建库与角色**（一次性；失败即退出，绝不覆盖已有角色/库；**现有线上环境已于 2026-09-25 完成建库、账本库与角色，不再重跑**），在 `qiuge-postgres` 内以现有管理员 `qiuge_cloud` 执行：
   ```sh
   set -a; . /root/siyue-provision.env; set +a   # 只读 root 文件，两个 32+ 位随机密码
   docker exec -i --env SIYUE_PROVISION_DATABASE --env SIYUE_ENVIRONMENT \
     --env SIYUE_PROVISION_APP_PASSWORD --env SIYUE_PROVISION_MIGRATOR_PASSWORD \
     qiuge-postgres psql -U qiuge_cloud -d qiuge_cloud -v ON_ERROR_STOP=1 -f - \
     < app/provision/independent-database.sql
   docker exec -i --env SIYUE_DELETION_LEDGER_DATABASE --env SIYUE_DELETION_LEDGER_ENVIRONMENT \
     --env SIYUE_DELETION_LEDGER_APP_PASSWORD \
     qiuge-postgres psql -U qiuge_cloud -d qiuge_cloud -v ON_ERROR_STOP=1 -f - \
     < app/provision/deletion-ledger.sql
   ```
   密码用 `--env 名称`（不带值）从已 source 的环境转发，避免出现在进程列表。脚本只 `CREATE ROLE`/`CREATE DATABASE` 新对象。
以下 compose 命令在 `/opt/siyue/current` 中以有 Docker 权限的账号运行，固定项目名为 `siyue`。

5. **迁移**：`SIYUE_ENV_FILE=/etc/siyue/siyue-migrate.env docker compose --env-file /etc/siyue/compose.env -p siyue -f docker-compose.yml -f /etc/siyue/network-compose.yml run --rm siyue-api node dist/database-migrate.js`
   （advisory lock + checksum 历史；重复执行不重复改结构；API 持迁移凭据会拒绝启动）。
6. **启动**：`docker compose --env-file /etc/siyue/compose.env -p siyue -f docker-compose.yml -f /etc/siyue/network-compose.yml build`（只 COPY，秒级）、同参数 `up -d`、同参数 `ps`。
7. **健康检查**：`scripts/server-deploy/healthcheck.sh --public https://api.qiugeapp.com/api/siyue`
   （优先宿主 `curl`，目标机已确认可用；无 curl 时回退容器内 `node fetch`。回环 live/ready 需 200；
   公网走真实 nginx+TLS：裸前缀 `/api/siyue` 与未知路径必须 404，`legal/terms.html` 与 `legal/privacy.html` 必须 200，
   `legal/` 不可列目录，且文档响应带 `X-Content-Type-Options: nosniff`）。
8. **nginx 增量**：把 `nginx/api.qiugeapp.com.siyue-location.conf` 的两段 location 插入
   `/etc/nginx/sites-enabled/api.qiugeapp.com` 的现有 server 块，然后
   `sudo -n /usr/sbin/nginx -t && sudo -n systemctl reload nginx`；不得替换整块、不得改微信回调精确匹配。
   `/api/siyue/legal/` 用 `alias /opt/siyue/current/legal/`＋`autoindex off`＋`nosniff` 只读发布两份文档。
9. **回归**：旧 `/api/cloud/*`、微信回调与证书不变；`/api/siyue/v1/*` 只进 Siyue；`/api/siyue/legal/*.html` 可匿名读取且无目录列表；
   `docker compose logs` 无秘密与真实用户数据。

## 5. 本轮暴露面与开启条件

- 对外只有 `/api/siyue/`（含 `location = /api/siyue` 404）与静态 `/api/siyue/legal/`。
- 注册要真正开放，需要同时满足：`SIYUE_EMAIL_ENABLED=true` + 有效 Resend 私密配置、`SIYUE_REGISTRATION_POLICY_FILE` 指向
  合法 policy JSON、两份法律文档随发布并可经 nginx 读取；缺少 policy 文件时注册接口返回不可用（登录仍可用）。
- 注销要可用，需要三个 `SIYUE_DELETION_LEDGER_*` 齐全；否则 `DELETE /v1/me/account` 不注册，
  `preflight.sh` 默认据此报错，只有显式 `--allow-no-ledger` 才能带着「注销关闭」部署。
- 保持关闭：`SIYUE_APPLE_ENABLED=false`、`SIYUE_MOCK_AUTH_ENABLED=false`、`SIYUE_WECHAT_ENABLED=false`。
- 真实边界：`createRuntimeApp` 在配置会话时会注册家庭/设备等内部路由（无开关）；最小化在边缘层，
  若要裁剪内部路由属于 `apps/server` 代码改动，不在本部署包范围。

## 6. 回滚

1. **代码**：保留上一版镜像 tag 与 release 目录，`SIYUE_VERSION=<上一版> docker compose --env-file /etc/siyue/compose.env -p siyue -f docker-compose.yml -f /etc/siyue/network-compose.yml up -d siyue-api siyue-mail-worker`；
   schema 走 expand/contract，旧镜像与当前 schema 兼容，**不执行 down migration**。
2. **停用**：`docker compose --env-file /etc/siyue/compose.env -p siyue -f docker-compose.yml -f /etc/siyue/network-compose.yml stop siyue-api siyue-mail-worker` 只影响 `/api/siyue/`；qiuge 各路径不受影响。
3. **完全撤下**：移除两段 location 后 `sudo -n /usr/sbin/nginx -t && sudo -n systemctl reload nginx`；
   数据库与已生成数据保留，不删库、不恢复旧备份覆盖新写入。
4. 恢复 `siyue` 主库后必须先重放账本再开放登录（API 启动时自动对账，失败拒绝启动）。

## 7. 待确认/可迭代项

- **`SIYUE_TRUSTED_PROXY_CIDRS`**：当前只信任实际到达 API 的两个 Docker 网关 `/32`；从 `docker network inspect` 核对网关，不能信任整个子网。nginx 必须覆盖转发头。取值不对会让所有客户端共用限流桶。
- **法律文档内容**：`legal/*.html` 为 2026-09-25 双语版本，可按维护者要求迭代；改版后需重新构建工件并更新 policy 版本号。
- **PG 侧**：`max_connections` 余量、`/srv/qiuge/data/postgres` 空间、按库备份与异机副本、恢复演练（主库回滚 + 账本重放）。
- **邮件**：Resend 发件域名/SPF-DKIM/额度与真实送达需单独验收；worker 出网 HTTPS 必须放通。
- **镜像分发**：本机已缓存基础镜像；若改用其他基础镜像或目标机缓存被清理，需要可拉取或 `docker save/load`。

## 8. 明确不做

脚本不登录远端、不执行 ssh/scp、不重启或改写 nginx、不重载服务、不申请证书、不购买服务、不写生产数据；
远程步骤由主代理在获得授权后执行。本目录不含真实密钥或连接串。
