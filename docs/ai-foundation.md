# AI 底座规格

## 1. 边界

AI SDK Core 为默认验证候选；自有代码负责业务语义、信任边界与状态持久化。当前官网检索能确认工具调用、工具审批与循环控制能力；具体版本 API 在编码时按锁文件核验，不照抄会变化的函数签名。[S05][S06]

不把聊天、记忆、工作流、工具和业务数据合并为一套黑箱。首版一个协调 Agent 即可，学习和项目采用领域上下文与受限工具集合，不默认采用多 Agent 群体。

## 2. 组件职责

| 组件 | 职责 | 首版边界 |
|---|---|---|
| ProviderAdapter | 模型能力、认证、流事件、错误、用量 | 最少验证一个文本/工具模型，准备一个兼容测试替身 |
| ContextAssembler | 按目的和授权装配最少上下文 | 不默认发送整个数据库 |
| AgentExecutor | 有限工具循环、取消、超时、预算 | 短回合；不假装天然支持跨进程恢复 |
| ToolRegistry | schema、权限、执行位置、风险、回执 | 业务工具，不开放任意 SQL 或 Shell |
| ApprovalService | 绑定参数和对象版本的明确批准 | 内容变化、过期或撤销须重新确认 |
| RunStore | 会话、回合、工具、状态、错误、运行版本 | 磁盘可恢复状态，不保存无必要的大量敏感内容 |
| MemoryService | 用户事实、学习状态、活动检索、来源撤销 | 首版结构化记录与按需检索 |
| VoiceAdapter | 录音、ASR、TTS、可选实时语音/专门评分 | 先按键录音及回放；ASR 不等于发音评分 |
| UsageLedger | 用量、预算预留、成本配置、失败追踪 | 未知用量标 unknown，不填 0 |
| EvalHarness | 固定输入、工具结果和安全/正确性断言 | 先离线契约测试，再经批准的小样本模型测试 |

## 3. 工具与写入路径

读工具：`goals.list`、`projects.get`、`learning.sessions.list`、`reviews.calculate`。只读不代表可以访问任意模块；仍检查身份、目的和范围。

草稿工具：`plans.propose`、`learning.extractCandidates`。只生成可编辑候选，不修改正式业务对象或确认事实。

正式写工具：`commands.applyApproved`。处理器验证审批、当前版本、参数 hash、幂等键和权限，再在事务中修改业务表并写事件与命令回执。

命令 ID 在应用创建草稿时确定，不让模型随重试随机重建。相同 ID、相同参数返回原回执；相同 ID、不同参数报冲突。取消后已发生的写入如需撤销，必须走可解释的补偿命令，不声称取消自动回滚一切。

## 4. 状态与恢复

建议运行状态：queued → running → awaiting_approval / interrupted / succeeded / failed / cancelled。工具还有 planned / dispatched / completed / denied / unknown 状态。

运行记录至少含 runId、conversationId、turnId、executorId、provider/model、promptVersion、policyVersion、dataCutoff、时间与结果摘要。事件带 seq，客户端断线按序补读，重复事件不重复渲染。

执行后回执丢失时，先按 commandId 查询真实状态，再决定重试；不能把“没收到响应”当作“没有执行”。手机切后台或进程退出时记录 interrupted，恢复需用户确认或满足预先授权范围。

不要求模型提供隐藏思维过程。只保存供用户解释的简短计划、工具活动和结果依据。

## 5. 三种模式

本地数据 + 远程模型：用户选定的上下文被发送到指定服务。必须披露；本地保存不等于没有外发。

桌面本地执行器 + 远程模型：执行逻辑在桌面，模型仍在远程。BYOK 指密钥归属，不代表数据完全离线。

可选托管模式：平台模型密钥仅在服务端，用户凭证与额度校验由服务端承担；不沿用把平台密钥租给客户端的方案。

完整本地推理、Hermes sidecar 与长期工作流属于将来可插拔执行器，不是本次已实现能力。

## 6. 记忆规则

Confirmed facts 来自用户明确资料或确认；Derived insights 来自模型，必须标注来源和建议状态。Working context 为当前任务临时数据；活动经历来自正式记录。

每条记忆记录 scope、purpose、sourceRef、status、createdAt、validFrom/validTo、用户纠正和撤销信息。不凭模型自评的 confidence 将建议变成事实。

目标进度、学习时长、资产汇总由查询服务计算。检索结果用于提供背景，不是当前数字的权威来源。

删除来源时同步失效摘要、缓存、检索投影和将来可能增加的向量；保留法律或安全所必需的最小审计元数据，不保留已删正文。

## 7. 模型与成本的约束

显式能力矩阵至少包含 text、tools、structuredOutput、vision、ASR、TTS、realtime。不同能力使用不同适配器，不因 OpenAI-compatible 标签就视为全兼容。

预算、最大工具步数、超时、附件大小和最大上下文必须配置；不能无限循环。供应商故障不自动把个人数据转发给未经授权的替代供应商。

首版只要求可追踪和硬上限，不提前构建复杂模型竞价或智能路由平台。

## 8. 主动能力

可靠定时分析依赖可选服务端 worker 和明确授权的数据。手机后台调度受系统控制，不能保证任意指定时间执行。[S07]

首版采用用户触发复盘与可关闭提醒。通知推送只带必要信息，不在锁屏默认显示日记、学习错误或资产详情。数据不完整时注明可见记录范围。
