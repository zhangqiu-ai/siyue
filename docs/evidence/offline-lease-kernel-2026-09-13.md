# 家庭共享离线授权正式内核

日期：2026-09-13。目标版本：0.0.1。关联 `add-account-family-spaces` 的 V06、V07、V11。

## 范围与结果

- 将隔离实验提升为 `@siyue/contracts` 与 `@siyue/domain` 的正式内核。租约绑定账号、设备、家庭、原件空间、具体记录、读写权限、成员版本、授权版本和最长 24 小时服务端期限。
- 服务端时间只用于计算签发时的剩余期限；后续判断只接受宿主提供的 elapsed realtime 与 boot identity。boot identity 变化、计时倒退、非法时间或到期瞬间均失败关闭，不读取设备墙钟，也不因本地编辑续期。
- 已知撤权立即锁定；只读租约不能用于编辑。重连后必须由当前代次的复核结果解锁提交，A→B→A 的旧结果、旧授权版本、其他原件的结果、复核中的撤权均不能解锁。
- 提交门禁会重新检查具体编辑请求、权限版本和当前租约时间。协调器发布的内部租约为冻结对象，调用方不能修改其范围或权限。

严格 schema 只验证结构，不验证签名。调用方只能传入已经过服务端身份和签名边界核验的授权；本内核不接收共享正文、不删除待提交输入，也不代替服务端最终事务鉴权。

## 审查修正

独立代码审查发现：最初实现会在撤权后直接断网或复核途中再次断网时清除锁定；无参数的提交判断也没有复核只读权限和到期时间；读取状态暴露了可变租约对象。实现已改为只有当前可信复核成功才能清除锁定、按请求和时钟重新裁决、冻结内部租约，并补充对应回归测试。

## 实际验证

仓库根目录执行：

- `corepack pnpm --filter @siyue/contracts test`：20 项通过，0 失败；其中新增 3 项离线租约契约场景。
- `corepack pnpm --filter @siyue/contracts build`：通过。
- `corepack pnpm --filter @siyue/domain test`：63 项通过，0 失败；其中新增 14 项离线授权与重连门禁场景。
- `corepack pnpm --filter @siyue/domain typecheck` 与 `build`：通过。
- `corepack pnpm typecheck` 与 `corepack pnpm test`：最终复测均为 11/11 Turbo 任务通过；当前 domain 改动重新执行，其余未变化任务按依赖命中缓存。
- `corepack pnpm spec:check`：4 项通过；`corepack pnpm release:check` 与 `git diff --check` 通过。版本检查不代表 0.0.1 已达到发布门槛。

本切片为无界面的纯契约与领域逻辑，没有可由 Playwright 覆盖的浏览器/Electron 用户路径，因此未新增 Playwright 用例。真实上传队列、家庭正文缓存、租约签发/验签、受控输入恢复和服务端事务仍未接线。

## 未完成边界

任务 4.2 保持未完成：当前尚未证明 iOS、iPadOS、Android 与 Electron 的实际计时源是否在休眠期间持续、如何识别设备重启，以及安全存储中的 boot identity 生命周期。未完成原生验证前，不得把普通 JS 计时器或本内核测试解释为 V07 平台验收通过。
