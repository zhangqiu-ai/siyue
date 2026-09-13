# 账号切换迟到请求隔离模型 · 2026-09-09

状态：隔离竞态模型10项测试通过；未接入应用、真实认证、数据库或云同步。目标版本0.0.1，关联[验证计划V11](../../openspec/changes/add-account-family-spaces/validation-plan.md)、account-session Account isolation 与space-sync账号隔离要求。

## 现有实现核对

- `apps/mobile/src/native-client.ts:49`仍以`local-owner`初始化，尚无真实账号切换链路。
- `apps/mobile/src/settings/ai-settings.tsx:32`的AbortController用于AI设置/应用生命周期，并非账号身份会话；`chat/compatible-adapter.ts`在等凭据后检查取消。
- `packages/adapters/src/local-client.ts:20`固定捕获空间、复制actor；请求journal的hash含空间和actor，回执核对命令与身份。已有这些保护，不需要在本实验中重写命令处理器。但它没有账号会话generation，不能单凭固定空间和abort证明旧结果不会进入新UI。
- 只读审查已有测试定义；本轮没有重新运行既有应用测试，不把源码中的测试断言计为本轮通过。

## 本轮模型与观察

[模型](../../experiments/account-family/session-fence.mjs)使用每次登录/切换递增的generation与不可变subject/space工作项。执行前、异步权限检查后、响应返回后分别确认工作仍属当前会话；同时发出abort作为资源取消提示。界面/缓存发布回调必须受信任、同步且不重入switchTo；该契约没有运行时强制，不能把异步写入藏在commit里并声称仍受门禁保护。独立只读审查确认这是模型结论的必要前提，任意异步回调不在已验证范围。

[测试](../../experiments/account-family/session-fence.test.mjs)用可人工释放的Promise确定竞态顺序，不靠sleep或真实账号：

1. 当前会话正确回执可以发布。
2. A工作切至B后不发送，原scope和输入保持A。
3. 等权限时切换，即使权限随后允许仍不发送。
4. 退出后不合作的transport返回成功，UI/cache仍无写入，旧signal已中止。
5. A→B→A不能复活上一轮A工作；新A工作可正常执行。
6. 同账号换空间也使旧工作失效。
7. 权限拒绝、错账号/空间或错命令回执不发布。
8. 旧会话错误被丢弃，当前会话错误仍可观察。
9. 伪造工作项及调用者修改scope无法冒充已登记的工作。
10. 服务端已提交后切换，客户端丢弃旧响应不等于服务端回滚；保留原命令回执供原账号后续对账。

## 边界与后续验收

这不是持久化队列、认证框架或生产授权边界。generation与工作登记仅在当前JS进程有效；重启后的队列恢复、授权复核和对账尚未实现。已开始的网络请求可能已产生远端副作用，必须由服务端校验actor/space/当前权限，并按原commandId对账，不能因客户端取消而新建重复命令。

模型没有覆盖流式每个chunk、React状态、线程/检索缓存、平台凭据存储、跨进程IPC、原生后台恢复或真实服务撤权。正式实现时每个异步UI/缓存发布点以及外发点均需对应检查；不能只接入AbortController就标记V11通过。旧账号待提交输入的加密隔离与本人恢复仍按原规格处理，不删除或改属。

## 执行证据

工作目录`/Users/feature/code/siyue`，Node`v22.22.3`，未提交工作区。

`node --test experiments/account-family/session-fence.test.mjs`：10 passed，0 failed。

本轮只新增上述模型、测试和证据，更新活动任务/验证计划；不修改生产业务代码、协议、schema或依赖，不执行账号登录、发信、购买、部署、迁移、提交或推送。
