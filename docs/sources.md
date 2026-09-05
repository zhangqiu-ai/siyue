# 来源与核验边界

核验日期：2026-09-05。以下是技术事实来源，不是所有推荐架构都已被真机验证的证明。

## S01 · Expo — Work with monorepos

来源：https://docs.expo.dev/guides/monorepos/

用途与范围：支持 workspace 的 monorepo 路线；实际依赖组合仍需验证。

## S02 · Expo — Introduction to development builds

来源：https://docs.expo.dev/develop/development-builds/introduction/

用途与范围：原生依赖与发布型开发使用 Development Build 验证。

## S03 · Electron — Security

来源：https://electronjs.org/docs/latest/tutorial/security

用途与范围：渲染端权限、隔离、沙箱和不可信内容边界。

## S04 · Electron — utilityProcess

来源：https://electronjs.org/docs/latest/api/utility-process

用途与范围：Node 能力的独立工作进程；不等于完整安全沙箱。

## S05 · AI SDK — Tools and tool calling

来源：https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling

用途与范围：工具调用与审批；本次官方搜索索引可读，直接打开报错，不据此确认具体版本签名。

## S06 · AI SDK — Agents / Loop control

来源：https://ai-sdk.dev/docs/agents/loop-control

用途与范围：工具循环与停止条件；本次官方搜索索引可读，直接打开报错，编码前复核。

## S07 · Expo — BackgroundTask

来源：https://docs.expo.dev/versions/latest/sdk/background-task/

用途与范围：后台任务由系统按条件调度，不承诺精确常驻执行。

## S08 · PowerSync — React Native & Expo SDK

来源：https://docs.powersync.com/client-sdks/reference/react-native-and-expo

用途与范围：RN SQLite 原生依赖与客户端同步/写入链路。

## S09 · PowerSync — Node.js client SDK

来源：https://docs.powersync.com/client-sdks/reference/node

用途与范围：Node/Electron 原生驱动与构建注意事项。

## S10 · PowerSync — Open-source & Source-availability

来源：https://powersync.com/open-source

用途与范围：客户端与服务端/CLI 许可分开，不称为同一种许可。

## S11 · Apple — App Review Guidelines

来源：https://developer.apple.com/app-store/review/guidelines/

用途与范围：隐私、第三方 AI 数据共享、账号删除和数字购买等上线门槛。

## S12 · Expo — SecureStore

来源：https://docs.expo.dev/versions/latest/sdk/securestore/

用途与范围：敏感键值存储；不作为正式业务数据的唯一备份。

## S13 · Expo — SQLite

来源：https://docs.expo.dev/versions/latest/sdk/sqlite/

用途与范围：设备 SQLite 的候选方案，不能假设与所有同步驱动任意混用。

## 用户与连接资料

U01：当前对话中用户明确确定的名称、产品方向、平台和开源到商业化路线。个人背景不自动成为产品需求。

C01：通过 GitHub 连接读取 `zhangqiu-ai/qiuge-helper/docs/ai-architecture.md` 的开头内容，用于确认可借鉴的协议、执行器与审批分层。该文件是内部设计参考；本包未附其私有源码，亦未逐行审核其实现。

C02：当前连接查询 `zhangqiu-ai/siyue` 返回 404，可见仓库列表也未包含它。只说明当前授权范围内未找到，不证明该账号所有权限范围中的仓库总量。

## 证据边界

未做新的商标或域名可用性审查；没有注册或授权任何品牌权益。未执行 App Store 提审、应用构建、真实模型调用、同步压测或数据迁移。具体 SDK API 以编码阶段读取的官方文档及锁定版本为准。


## S14 · Expo SDK reference / npm package metadata

用途：工程初始化时确认 Expo SDK 57、React Native 0.86 与 React 19.2 系列基线。

## S15 · Electron Releases

来源：https://releases.electronjs.org/

用途：初始化时选择 Electron 44 稳定线。

## S16 · AI SDK npm package

来源：https://www.npmjs.com/package/ai

用途：初始化时固定 AI SDK 7 稳定版本；API 仍需编码阶段验证。
