# 计划生成取消与配置错误恢复

范围：移动端 Compatible 计划生成传输及 AI 设置前置判断。此次不调用真实供应商，不改变提示词、供应商配置、输出上限或正式数据确认边界。

## 失败证据与修复

新增“fetcher 完全忽略 AbortSignal”的取消测试后，原实现超过 100ms 仍返回 `still waiting`，证明传输层只调用 `abort()` 不足以保证用户操作结束。90 秒超时在同类非合作请求上也会悬挂。修复后，传输层在等待 fetch 响应期间同时监听内部取消信号：请求取消、设置会话失效、应用后台化或截止时间均可立即结束等待；迟到的响应会取消 body，迟到失败被消费，不继续生成草稿。

安全存储读取失败此前会先命中 `config === null`，误显示成“尚未配置”。新增纯前置判断后，加载中或确实未配置仍返回 `configuration_required`；`storageError` 优先保留为 `SettingsError`，由既有受控错误映射显示配置读取故障，不发起模型请求，也不暴露底层错误。

## 验证

- 定向测试：Compatible 传输、计划解析、错误映射和设置状态共 45/45 通过。
- 移动包完整测试：`corepack pnpm --filter @siyue/mobile test`，116/116 通过。
- `corepack pnpm --filter @siyue/mobile typecheck` 通过。
- `git diff --check` 通过。

测试覆盖非合作 fetch 的请求取消、设置会话失效和 90 秒超时；原有固定单次 `max_tokens=2048`、无自动重试、单项目严格输出、SQLite 草稿确认边界继续通过。Node 仍打印既有 `MODULE_TYPELESS_PACKAGE_JSON` 与 MockTimers 实验性警告，本次未改包模块配置。

## 未完成边界

这些是合成网络与会话测试，不等于真实 AISettings Provider 的保存、移除、AppState 集成验收，也不等于真机网络故障验证。2048 是单次输出上限，不是累计 token、人民币费用或供应商额度控制；真实 usage 仍为 unknown/null，因此 5.3c 的财务预算与完整故障矩阵仍未完成。

## 续作：AI 设置会话替换

`AISettingsProvider` 改用独立的会话控制器。保存新配置或移除配置时，只有安全存储操作成功后才中止旧 signal 并生成新的 active signal；存储失败保留原会话。应用离开 active 状态调用同一个 replace 操作，Provider 卸载则 dispose 当前会话。计划生成继续捕获发起时的 signal，因此配置变更或后台化会取消旧请求，之后的新请求读取新 signal。

新增测试直接验证 replace/dispose、保存成功、移除成功，以及两类存储失败不会替换会话。AppState 分支也复用同一纯函数：`active` 保持当前 signal，`inactive`、`background`、`unknown`、`extension` 均终止旧 signal 并创建新的活动 signal。相关生成和 SQLite 竞态测试继续通过；移动包完整测试更新为120/120通过，类型检查和`git diff --check`通过。没有新增测试依赖。

本步证明 Provider 实际复用的会话、存储编排与 AppState 状态处理单元；尚未以原生事件和真实 SecureStore/供应商执行端到端故障注入，因此真机竞态仍列未完成。累计用量与费用控制也未实现。
