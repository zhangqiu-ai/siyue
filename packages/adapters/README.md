# 本地适配器（M1 验证实现）

默认入口只依赖共享领域/契约，提供 `createSqliteStore`、`createLocalClient` 及类型。`@siyue/adapters/node` 提供 `openNodeConnection` / `openNodeStore`，仅供 Node/Electron 宿主使用，不应导入 Renderer 或移动包。

## 数据库边界

`SqlConnection` 提供异步 `exec/get/run/transaction`，可选 `close`。每个连接由一个 store 独占，所有读写串行；事务仅使用 `transaction` callback 传入的连接。Node 使用 `BEGIN IMMEDIATE`；移动 wrapper 应使用 Expo 的 `withExclusiveTransactionAsync`，不能把事务外的 db 句柄混入 callback。

`initialize(ownerId, newSpaceId?)` 按 owner 重用已有空间；首次创建使用宿主提供的 UUID。应用必须传入 UUID 候选，避免不同设备使用同一空间 ID。`spaces` 保存 `id`、唯一 `owner_id` 和整个 `SpaceState` JSON；写入前后校验整份状态，业务对象、活动事件与回执在一个快照内原子提交。领域规则依然由共享 CommandService 执行。

版本 1 只可在空数据库创建；非空未版本化数据库、较新版本或损坏状态直接拒绝并保留原数据。当前没有把旧产品数据升级至此结构的迁移逻辑。账号映射只是本地身份，不代表生产账号认证或同步权限已实现。

## 宿主 facade

`createLocalClient` 接受已固定的 `spaceId`、`actor`、CommandService、可选 RunService、ID/时间函数和只返回 `GoalDraft` 的提议函数。提供 snapshot、propose、saveManual、editDraft、confirmDraft、discardDraft、update、receipt。`snapshot()` 返回目标、项目、任务、草稿和经过同一空间/身份授权的 `runs`；未配置 RunService 时 runs 为空数组。

`propose` 将校验后的 payload 存为 30 分钟有效草稿，actor 来自宿主。配置 RunService 时，先创建 running 记录，再通过 `createDraft({runId})` 在同一事务内保存草稿并将 run 绑定为 awaiting_approval。提交成功但返回丢失时，按 commandId 和已关联 run 对账；读状态失败则保留未知结果，不擅自标记 failed。取消已保存草稿时先拒绝草稿，再取消运行。取消检查仅依赖 `signal.aborted`，不要求 React Native 提供 `throwIfAborted` 方法。

编辑保留 commandId/issuedAt。确认走审批再执行，真实回执出现后 settleDraft 更新 run；同一 facade 的重复确认串行对账。宿主初始化必须显式调用 `runService.recover(spaceId,actor)`：未完成生成改为 interrupted，已应用草稿按真实回执恢复 succeeded，不自动重试模型。run 状态事件随 SpaceState 持久化，错误仅记录受限 errorCode，不保存供应商异常原文。

`saveManual(payload, request?)` 与 `update(kind,id,version,patch,request?)` 支持 `LocalRequest = {commandId,issuedAt}`。跨 IPC 调用的 Renderer 必须在发送前保存此元数据，回执确认前重试保持两字段不变。显式 request 沿用 Renderer 自己的持久化机制，不再访问可选 requestJournal。

移动宿主可注入 `requestJournal: {storage, hash}`。`storage` 为 `AsyncKeyValueStore`（异步 getItem/setItem/removeItem），`hash` 必须返回 SHA-256 小写十六进制摘要。`createSqliteRequestJournalStorage(connection)` 提供受限实现：使用单独数据库与独占连接，串行读写、事务内更新，只在空库建立版本 1；未来版本、非空未版本化数据库、已有版本但缺失表均拒绝并保留原库，不静默重建。不要复用 SpaceStore 文件。

journal 键由 spaceId、actor.id、actor.kind 和命令内容共同求摘要生成；值只保存版本、commandId、issuedAt，不保存明文 payload。发送前必须持久化成功。同内容并发调用共享一次执行，已确认完成后允许发起新的独立操作。未知失败保留元数据，重建 LocalClient 后用相同内容重试会先读取原回执，并核对命令、空间、身份及参数摘要，确认成功才清除；明确业务拒绝也可结束尝试。损坏或未知版本的元数据会阻止新执行，不生成新 ID 掩盖未知提交。此 journal 不自动重放命令，也不保存用户输入；宿主需单独保留可恢复输入。

每个宿主只创建一个 LocalClient/journal 写入拥有者；异步 KV API 不提供跨进程锁或多写入者 CAS。未配置 requestJournal 时仅有进程内 pending 缓存，不具备跨进程恢复保证。

## 2026-09-06 本机验证

在仓库根目录执行：

```sh
pnpm --filter @siyue/adapters typecheck
pnpm --filter @siyue/adapters test
pnpm --filter @siyue/adapters build
```

均通过，集成测试 40/40。运行时为本机 Node 22.22.3，内置 SQLite 为实验性功能。测试只创建 tmpdir 下独立数据库并清理。

覆盖正式领域命令重开持久化、回调/SQL 后故障回滚、损坏状态拒绝、并发串行和双连接争用、空间隔离、较新版本/非空旧库保留、初始建表失败恢复、callback tx 使用、草稿编辑与重复确认、取消/拒绝、提交后丢响应对账及稳定 request 跨 host instance 重试。

运行状态专项覆盖：SQLite 重开恢复 awaiting_approval、running→interrupted、命令已提交但 settle 丢失后按回执恢复 succeeded、取消/拒绝/供应商失败区分、snapshot.runs 授权隔离、草稿与 run 原子提交后丢响应恢复、丢响应同时取消及状态暂不可读后重启对账。

请求 journal 专项使用实际独立 SQLite 库验证：发送前持久化、丢回执后两库重开沿用原命令、update 重开不二次升级版本、首次持久化失败不执行、同内容并发去重、完成后允许新请求、空间/身份隔离、业务拒绝清理、回执不匹配保留、清理失败后重开对账、损坏元数据与缺表/未来/非空旧库拒绝，以及显式桌面 request 不受可选 journal 影响。

这不是 RN 真机、PowerSync、桌面安装包、断电恢复或加密验收。整空间 JSON 快照适合受限单设备切片，尚未做大数据性能验证。SY-003 的跨平台/同步选型验收仍未完成。
