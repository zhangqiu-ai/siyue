# SQLite PoC 实测结果

日期：2026-09-05。工作目录：`/Users/feature/code/siyue`。分支：`feature/dev`。

## Node 本机：通过

准确命令：

```sh
node --test experiments/storage/sqlite-poc.test.mjs
```

退出码：0。测试运行器汇总：11 tests / 11 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo。

运行时由测试实际输出：

```json
{"node":"22.22.3","electron":null,"sqlite":"3.51.3","platform":"darwin","arch":"arm64"}
```

Node 输出 `ExperimentalWarning: SQLite is an experimental feature and might change at any time`，未关闭或过滤该警告。

| 场景 | 结果与断言 |
|---|---|
| SQLite 运行时 | 实际查询版本字符串 |
| 持久化 | 关闭并重开文件后，对象标题、事件、回执和 schemaVersion 保持 |
| 事务中对象写入后故障 | 当前连接及重开后，三张表均无数据 |
| 事务中事件写入后故障 | 当前连接及重开后，三张表均无数据 |
| 事务中回执写入后故障 | 当前连接及重开后，三张表均无数据 |
| 丢响应、重复命令与参数冲突 | 丢弃首次响应，重开后同请求返回原 ID；改参数拒绝，原数据与三表数量不变 |
| 双连接争用 | 持有 `BEGIN IMMEDIATE` 时另一连接收到 SQLite 错误码 5；释放锁后成功，再重试仍只有一组记录 |
| 账号/空间隔离 | 独立账号文件互不可见；相同对象/命令 ID 在两个空间具有独立键和值 |
| 跨空间引用 | 复合外键拒绝不存在于对应空间的对象引用；已保存数据不变 |
| 升级失败 | 模拟 ALTER、数据更新、版本升级后异常；重开后字段不存在、旧版本与原数据保留 |
| 较新 schema | 版本 99 拒绝由旧适配入口打开；只读检查确认未来字段、版本和原数据保留 |

## 未运行及证据边界

- Electron runtime：未运行。本轮读取 Electron npm 入口时触发二进制下载提示，已中止该进程，未据此认定安装成功。等待主代理完成安装后再验证实际二进制。
- iOS/Android：未运行；本机当前缺少完整 Xcode、Java Runtime、adb。详见 [工具研究记录](../../docs/evidence/m1-storage-research.md)。
- PowerSync：未安装、未接入，未验证同步、服务端拒绝、撤权或账号切换中的上传任务。当前账号测试只证明独立文件与复合键的 SQLite 行为。
- 没有验证 WAL、进程强杀、系统断电、磁盘耗尽、加密、真实 App 重启或旧产品数据库迁移。
- 此测试使用最小 SQL 夹具验证存储机制，不代替正式领域命令测试。测试中的固定参数序列化不是正式审批 hash 协议。
- `SY-003` 尚不具备 RN/Electron 全部验收证据，`ADR-004` 不能由此升级为最终采用结论。

后续需要在实际候选适配器上运行等价测试，并分别记录平台版本与结果。需要 PowerSync 服务时，由维护者确认服务、预算、地区与数据外发用途。
