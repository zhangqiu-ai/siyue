# SY-003 存储研究与环境检查

日期：2026-09-05。执行者：编程子代理。工作目录：`/Users/feature/code/siyue`，分支：`feature/dev`。

状态：**资料与工具检查完成，原生存储 PoC 未完成，ADR-004 仍为 Validate。** 本记录不代表主代理随后运行的构建结果。本轮未安装包、未启动设备、未连接同步服务、未读取用户数据库。

## 1. 本机实测

| 命令 | 结果 | 能证明什么 |
|---|---|---|
| `node --version` | `v22.22.3` | 当前 shell Node 可用 |
| `pnpm --version` | `11.19.0` | 当前 PATH 的 pnpm 可用；当时根声明为 `pnpm@11.25.0`，复现环境需由依赖验证结果统一 |
| `xcodebuild -version` | 失败：active developer directory 为 `/Library/Developer/CommandLineTools`，要求完整 Xcode | 当前开发者目录无法执行 iOS 原生构建 |
| `xcrun --version` | `xcrun version 72.` | 工具入口存在；不证明 iOS SDK 或模拟器可用 |
| `java -version` | 失败：Unable to locate a Java Runtime | `/usr/bin/java` 只是可发现入口，JRE 不可用 |
| `adb version` | `command not found: adb` | 当前 PATH 无 adb |

另执行：

```sh
node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(":memory:"); console.log(JSON.stringify({node:process.version,sqlite:db.prepare("SELECT sqlite_version() AS version").get()})); db.close();'
```

退出码 0，输出 `{"node":"v22.22.3","sqlite":{"version":"3.51.3"}}`，并出现 `ExperimentalWarning`。只验证内存库可打开和查询；未验证文件持久化、事务故障恢复或 Electron 运行时。

## 2. 官方资料核对

### 移动 SQLite

Expo SDK 57 文档提供 `expo-sqlite` 的 iOS/Android API，并要求用 `expo install expo-sqlite` 安装匹配版本。提供异步查询、参数绑定和事务。`withTransactionAsync` 可能把回调外同时运行的查询纳入事务；M1 应使用 `withExclusiveTransactionAsync` 并仅使用其传入的事务对象，避免交叉写入。用户输入用绑定参数，不能拼接进 `execAsync`。这些是 API 依据，尚未构建验证。[Expo SDK 57 SQLite](https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/)

### Electron / Node SQLite

当前 manifest 声明 Electron `44.2.0`；官方该版本嵌入 Node `24.20.0`。不能用 shell Node 的测试代替 Electron 主进程测试。[Electron 44.2.0](https://releases.electronjs.org/release/v44.2.0)

裸 `node:sqlite` 可降低外部原生扩展数量；Node 22.13 起不需实验标志，但当前本机仍发出实验性警告。适合作为本轮隔离 PoC 的一个候选，需验证实际 Electron 二进制能导入模块和执行重启读写；不能把 API 在 Node 存在视为生产稳定性证明。[Node SQLite](https://nodejs.org/api/sqlite.html)

若采用 `better-sqlite3`，需针对 Electron ABI 验证预编译包或重建；系统 Node 能加载原生模块不代表 Electron 能加载。数据库位于主进程或受控工作进程，Renderer 仅能调用明确业务 IPC。[Electron 原生模块](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)

### PowerSync 兼容与边界

- React Native 当前文档使用 `@powersync/react-native` + 独立 `@op-engineering/op-sqlite`（最低 1.17.0）；原生驱动不能在 Expo Go 沙箱运行。不要默认将现有 `expo-sqlite` 数据库交给 PowerSync，也不要在业务中长期并行维护两套本地库。[RN/Expo SDK](https://docs.powersync.com/client-sdks/reference/react-native-and-expo)
- Node SDK `0.12.0` 起不再推荐旧 `@powersync/better-sqlite3` fork，推荐普通 `better-sqlite3`。其 `node:sqlite` 选项虽然存在，但官方明确提示稳定性问题，目前仅建议测试用途；需将裸 Node PoC 与 PowerSync 驱动通过区分。[Node SDK](https://docs.powersync.com/client-sdks/reference/node)
- 默认存储使用 JSON 数据和 SQLite views；raw tables 可自行管理，但需要同步触发器及迁移处理。不能假定外键、DDL、迁移版本和现有关系型 schema 可原样替换。[客户端结构](https://docs.powersync.com/architecture/client-architecture)、[Raw tables](https://docs.powersync.com/client-sdks/advanced/raw-tables)
- 上传仍需应用后端执行鉴权、参数校验及业务权限；默认冲突处理不能替代 Siyue 的版本校验、审批、命令回执和删除标记。永久拒绝要记录业务失败并保留输入，不能只靠 HTTP 状态或队列清除判断成功。[后端接入](https://docs.powersync.com/configuration/app-backend/setup)、[冲突](https://docs.powersync.com/handling-writes/handling-update-conflicts)、[写入错误](https://docs.powersync.com/handling-writes/handling-write-validation-errors)
- 退出与切换账号的设计不能只依赖 `disconnectAndClear()`：raw tables 默认不被该调用清理，需明确 `clear` 语句。账号隔离须测试数据库文件、待上传命令、订阅和可恢复草稿；不得未经选择清空未同步数据。[Raw tables 清理](https://docs.powersync.com/client-sdks/advanced/raw-tables)
- 本地模式可用 local-only tables 避免无限积累上传队列；将本地数据转为同步数据仍需用户授权与迁移流程。[本地模式](https://docs.powersync.com/client-sdks/advanced/local-only-usage)

### 许可与退出成本

官方将客户端 SDK 列为 Apache-2.0，服务端 Open Edition 列为 FSL source-available，商业版另有条款。FSL 限制竞争性用途，并为每个软件版本在发布两周年后授予 Apache-2.0 后续许可。不能把服务端称为无条件开源，也不在本轮决定 Siyue 自身许可证或商业部署方案。[许可总览](https://powersync.com/legal/licensing-terms)、[FSL 原文](https://powersync.com/legal/fsl)

工程推断：退出 PowerSync 应从版本化业务对象、未确认命令及回执导出到新的隔离数据库，再比对数量、ID、删除状态及关联；不能将 PowerSync 内部表直接当长期公共导出协议。退出演练应保留原始库，避免重建时丢掉本地未同步输入。

## 3. 受限 PoC 建议（尚未执行）

1. 只用合成个人空间、目标、项目、任务和回执。在隔离目录建立 SQLite fixture，不连接外部服务。
2. 共享一个行为验收套件，分别运行移动 `expo-sqlite` 与桌面候选。验证关闭/重新打开后可查询；数据、活动、回执同事务提交；中途故障全部回滚；同命令重放不新增对象；参数变化冲突；更新版本冲突；跨空间拒绝；未知 schemaVersion 拒绝打开；迁移失败原库可恢复。
3. 移动完成 iOS、Android 原生构建与实际运行；桌面从 Electron 主进程运行相同 fixture，并核对嵌入 Node/SQLite 版本。当前缺少 iOS/Android 工具，不能标通过。
4. PowerSync 独立验证时只用同一套合成行为：断线重连、重复投递、服务端拒绝、删除后旧端重放、账号 A→B 隔离、撤权、原库导出再恢复；需要真实服务时先由维护者决定自托管/托管环境与费用。没有该证据，保持同步未采用。

## 4. 最小 Repository / UnitOfWork 建议

领域只暴露 `UnitOfWork.run(transaction => ...)` 与按业务对象定义的 Repository；事务作用域内完成授权、版本和幂等检查，再写对象、事件、回执。所有查询带空间约束。平台适配器承接事务、参数绑定和行解码，不把 SQL、SQLite 句柄、Electron 或 Node 类型传回领域。

移动适配器把事务 callback 的 tx 封装成 repository；Node 同步驱动可由单一写入拥有者串行调度，并在 `BEGIN`/`COMMIT`/`ROLLBACK` 边界执行。事务内禁止网络/模型调用，禁止复用事务外句柄。回执唯一键为 `(spaceId, commandId)`，保存参数摘要及真实结果 ID。

本轮建议仅推进可替换的单设备实现，不加入 ORM 或同步框架；这是实施建议，不是 ADR-004 已完成的结论。原生验证缺失、PowerSync 兼容及退出演练未完成，均应作为 SY-003 的剩余工作。

维护者仍需决定：同步服务及数据地区、外发授权和预算、商业许可路线、真机环境和正式包标识。上述决定不阻止本地合成数据的低风险 PoC。
