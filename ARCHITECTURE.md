# 架构基线

版本：0.1 | 日期：2026-09-05 | 状态：推荐实施基线；运行兼容性尚未测试

## 1. 总体选择

采用双客户端、共享纯 TypeScript 业务核心、模块化单体服务和可替换 AI 执行器。移动使用 React Native + Expo + Expo Router，桌面使用 Electron + React。Expo 官方提供 workspace monorepo 支持，但具体 React、Expo、Electron 与原生依赖组合仍须通过构建验证。[S01][S02]

```text
移动交互 (React Native)      桌面交互 (React)
          |                    | 受限 Preload / IPC
          +---- 应用命令 / 查询接口 ----+
                         |
       独立领域模块：目标、项目、学习、资产、日记
                         |
      Repository / UnitOfWork / SecretStore / Sync 接口
                         |
        平台适配：Mobile / Electron / Node Server
                         |
            本地 SQLite <-> 可选同步 <-> PostgreSQL

AI 调用入口 -> 授权上下文 -> Agent 执行器 -> 业务工具
                            |              |
                      模型供应商       草稿 / 审批 / 命令
```

此为逻辑分层，不表示每条线是网络请求，也不表示已有可运行服务。

## 2. 最小工程结构

```text
siyue/
  apps/
    mobile/                  # Expo App
    desktop/                 # main / preload / renderer
    server/                  # API 与 worker 的一个工程
  packages/
    domain/                  # 小内核、领域模块、命令/查询、仓储接口
    contracts/               # API、同步、Agent 事件的版本化协议
    ai/                      # 编排与能力接口；SDK 不泄漏到领域层
    adapters/                # local-db / server-db / platform / sync
    design-tokens/           # 共享视觉变量，不强求共用页面组件
  docs/
  planning/
```

先采用这些工程边界，再根据实际依赖和构建速度决定是否拆分为更多包。业务层不得导入 `electron`、`node:fs`、React Native、具体 ORM 或模型供应商类型。依赖方向为 apps/adapters → contracts/domain，禁止反向。

## 3. AI 运行位置

默认候选为 AI SDK Core + 自有薄 Agent 层。模型协议与工具循环尽量使用 SDK；业务权限、审批、记忆、执行状态和结果校验由 Siyue 实现。[S05][S06]

手机第一阶段通过明确配置并鉴权的 Node 服务执行 AI；只上传本次任务允许的上下文。服务可以自托管，不依赖桌面常开。开发环境凭据只放服务端；公开可访问服务不得使用共享静态测试 token。

Electron 可在工作进程内运行 Node AI 执行器；后期可适配 Hermes，但不将 Python/sidecar 作为手机基础依赖。移动直接 BYOK 与本地模型属于可选后续执行器，不因定义接口而声称已经兼容。

没有服务器或模型网络时，本地目标、任务与学习记录仍可使用，云端 AI 不可用要明确降级。Local-first 不等于离线大模型。

## 4. 命令权威与同步

本地模式：本机命令处理器是正式写入入口。云端模型只能返回草稿，不能自行修改未上传的本地数据。

同步模式：客户端可以乐观应用离线命令，但服务端是共享数据的最终权限与版本裁决方。客户端与云端 Agent 使用同一 `commandId` 和应用规则；重复上传返回已有回执，不能再次执行。云端下发结果不再次进入本地待上传队列。

每条业务变更必须说明执行位置、身份、作用域、数据版本和成功回执。参考 [docs/data-sync.md](docs/data-sync.md)。

## 5. Electron 安全边界

Renderer 不持有平台模型密钥、不直接打开数据库、不暴露通用 IPC 命令。开启上下文隔离与沙箱，限制导航、远端内容和 IPC 参数。重任务放独立工作进程；`utilityProcess` 是可用机制，但不等于完整不可信代码安全沙箱。[S03][S04]

AI 文本和检索内容按不可信数据渲染。下载或打开链接通过白名单策略处理。应用更新与签名在桌面分发阶段验证，不沿用旧工程的生产地址或凭据。

## 6. 数据与服务选型

设备保存 SQLite 逻辑数据，服务器使用 PostgreSQL；附件使用设备文件与可选对象存储。存储/同步 PoC 必须先于不可逆的驱动和 ORM 绑定。

PowerSync 是同步候选，不是已选定依赖。官方 React Native SDK 当前使用单独原生 SQLite 依赖，Node SDK 有 Electron 原生编译兼容问题需验；不要同时维护两套独立本地数据库。[S08][S09]

PowerSync 服务端与客户端许可不同，必须在决定自托管和商业路线时审查。[S10] 未决时可以继续做单设备纵向切片，但不得宣称已支持多端同步。

后端默认基线为 Node.js / TypeScript + Fastify，API、AI 网关和 worker 先同工程部署；是否拆进程由实际任务隔离需要决定。Supabase 为身份/数据库托管候选，业务层不能依赖它的前端直写模式。

## 7. 可扩展性契约

新业务模块注册：数据结构及升级策略、业务命令、查询接口、权限、AI 工具、活动事件和可检索投影。模块间通过对象引用或明确的公共接口关联，不跨模块直改内部表。

新模型注册：能力、允许的数据类型、认证、流协议适配、成本计量及错误类型；添加模型不能要求改所有页面。

新平台注册：存储、录音、通知、密钥与工具能力适配。平台缺少能力时返回 `unsupported`，不能伪造执行成功。

首版只实现内部编译时模块；动态插件、通用 MCP 市场和持久工作流框架后置。

## 8. 版本与发布

正式锁版本发生在三端构建成功后，记录 Node、pnpm、Expo、React Native、React、Electron、数据库驱动与 AI SDK 的兼容组合。不得把互不相关的最新大版本强行统一。

API、事件和命令带 schemaVersion；本地升级可恢复；服务端支持明确的旧客户端兼容窗口。兼容范围由测试结果填入，不在立项时捏造。
