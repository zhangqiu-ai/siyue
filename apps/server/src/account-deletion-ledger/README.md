# 删除防复活账本（存储适配原型）

对应设计 13.4：每次数据库恢复必须先重放独立保管的删除防复活账本，再开放登录与对外查询，避免旧备份
恢复出已注销账户。配置独立账本时，启动流程已调用本目录的恢复与逐次登录门禁；正式注销提交入口仍关闭。

## 结构

- `provision/deletion-ledger.sql`：一次性 provisioning。建立独立角色对（`siyue_deletion_ledger_owner` /
  `siyue_deletion_ledger_app`）与独立数据库（默认 `siyue_deletion_ledger`），建 `ledger.metadata` 与
  `ledger.entries`，以及三个转换函数。主库角色无法连接账本库，账本角色也无法连接主库。库名、环境或口令
  不符合约定时脚本在任何对象建立之前报错退出（非零），不会静默跳过。
- `ledger-store.ts`：`createDeletionLedgerStore(pool, {database, environment}, clock)`，先核对独立库、角色、格式与环境，提供 `prepare` / `markAccepted` / `cancel` /
  `lookup` / `listReplayable` / `highWater`。v2 元数据的实例 UUID、序号和条目数用于识别账本实例及检查缺失记录。
- `fence.ts`：主库 0018 的围栏读写与账本实例、序号比较；已由配置账本时的启动流程调用。
- `login-gate.ts`：`createDeletionLedgerGate(store)`，提供 `loginDecision(subjectId)` 与 `restoreGate({restored})`。
- `replay.ts`：隔离的主库恢复重放内核。对 `accepted` 撤销恢复出的凭据；有待清理作业时保持 `deletion_pending`，没有作业时写入阻断复活的墓碑且启动继续关闭。`prepared` 只保持阻断；重放不代替资料清理。
- `prepared-reconciler.ts`：用相同意图 UUID 的主库作业核对 `prepared`；只有作业确证已提交才推进为 `accepted`。主库无作业时仍保持阻断，不凭缺行推断回滚。
- `startup-recovery.ts`：先核对主库围栏和独立账本点，必要时重放，再校验账本未前进并提交围栏；启动流程在独立账本已配置时调用。删除中主体的冻结家庭关联只在 0022 待处理记录与作业、主体、家庭均匹配时保留；无记录的残留权限、儿童设备授权及孤立监护同意仍拒绝开放。相同检查用于运行中的就绪与外部 API 门禁。
- `runtime-config.ts`：可选的独立连接配置校验；完整配置必须使用账本运行角色、匹配库名及主库环境。

## 数据与状态

每个主体一行，只保存 `subject_id`（UUID）、`intent_id`（当前注销意图 UUID）、`status`
（`prepared` / `accepted` / `cancelled`）与阶段时间。没有邮箱、姓名、provider subject、设备、回执或任何正文；
账本回答的唯一问题是「恢复后这个主体还能不能登录」。

协议顺序：`prepare` 先持久化 → 主库事务（受理注销）→ `markAccepted` 后持久化。只有主库事务**确定**回滚，
才允许 `cancel` 该 prepared 行；结果不确定时保留 prepared，只阻断登录，不替它做任何删除。

不可变性由数据库保证，不由应用约定：运行角色只有 `SELECT` 与三个转换函数的 `EXECUTE`，没有
`INSERT/UPDATE/DELETE/TRUNCATE` 与任何 DDL；三个函数内部也不会把 `accepted` 改回其他状态，
`cancel` 对 accepted 返回 `accepted_immutable`。

## 决策语义

- `loginDecision`：无行 → 放行；`accepted` → 拒绝（不得复活）；`prepared` → 仅拒绝登录；账本不可读/不可用
  → 拒绝。失败一律关闭，不把「读不到」当成「没有标记」。
- `restoreGate({restored:true})`：账本可读且无待重放主体才 `openLogin: true`；有 `prepared`/`accepted` 时返回
  `replay_required` 及需重放的主体；账本不可读/不可用时不返回重放集合并保持关闭。

## 尚未完成（不得据此外推）

- 没有注销受理 HTTP 路由；内部受理内核尚未由运行时调用。
- 内部受理内核已使用上述 `prepare` → 主库提交 → `markAccepted` 顺序，支持逐家庭有效转交和冻结待处理记录，但没有正式路由或冻结后处理流程。
- v1 原型账本不自动升级；现有数据的逐次序号不能凭空补出。早期 v2 原型若缺 `entry_count`，也必须在停写并核对完整性后由明确的迁移流程补列和基数；当前没有自动迁移。账本与主库围栏同时回退需要独立的运维见证，当前尚无此机制。
- 有账本配置时，启动先对账和重放，逐次登录核对账本；`prepared` 未决、主体缺失、作业不一致或家庭权限残留会拒绝启动。运行中同类不一致使就绪和 `/v1/` 请求返回 503，并暂停删除维护。恢复不会重建丢失的删除作业、家庭转交或清除恢复出的个人资料。
- 配置账本时的资料清理与 Apple 撤销 worker 已接入运行时；冻结家庭会阻止资料清理报完成。正式注销提交路由、客户端完成流程及真实 Apple 撤销验收仍缺失。
- 补偿策略未闭环：运行角色可以 `cancel` 一个 `prepared` 行（用户撤回或确定回滚所需），因此账本角色被
  攻破仍可压住一个尚未受理的注销请求；`accepted` 不受影响。正式启用前需要区分「撤回」与「补偿」的授权来源。
- 运维侧：备份保留期、账本自身的备份与销毁、以及恢复演练流程仍未定义。

## 证据

`apps/server/tests/integration/account-deletion-ledger.test.mjs` 在隔离临时集群上用两个独立临时数据库
（主库 `siyue_test` 与账本库 `siyue_deletion_ledger`）覆盖：角色隔离与表形状、prepare 先持久化、
markAccepted 后持久化、accepted 不可篡改、需重放集合、主库回滚、旧备份恢复，以及账本损坏/不可用时的
fail closed。测试不连接任何真实数据库。
