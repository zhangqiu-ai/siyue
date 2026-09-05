# 领域与数据模型基线

本文件描述逻辑对象，不是已执行 SQL，也不强制所有对象一开始各建一张表。

## 1. 最小共享内核

PersonalSpace 是数据隔离边界；localSpaceId 在未登录时生成。CloudIdentity 与空间通过独立映射连接，不用电子邮件充当记录主键。设备 ID 与账号 ID 是不同概念。

共享概念包括 EntityRef、AttachmentRef、Tag、MetricDefinition、ActivityEvent、CommandReceipt。核心里不放具体银行字段、单词复习算法或 Electron 代码。

## 2. 核心对象

| 对象 | 主要字段或关系 | 规则 |
|---|---|---|
| Goal | id、spaceId、title、status、targetDate、metricRefs | 进度来自可计算来源；AI 不能任意改成 100% |
| Project | id、spaceId、title、goalId?、status | 可独立存在，不强制上级目标 |
| Task | id、spaceId、projectId?、title、status、dueLocalDate?、dueAt? | 独立任务允许；日期和绝对时刻分开 |
| LearningPlan | id、spaceId、goalId?、targetLanguage、focus | 首版聚焦语言，但不将学习等同于待办 |
| LearningSession | id、planId?、startedAt、duration、contentRefs、status | 原始会话与 AI 评估结果分开 |
| LearningItem | id、language、text、kind、sourceRef、status | 模型提取先 candidate，确认后进入复习 |
| ReviewRecord | id、itemId、occurredAt、result、algorithmVersion | 追加记录；修改用修订，不覆盖历史 |
| JournalEntry | id、bodyRef、localDate、visibilityScope | 正文默认高敏感；不为复盘自动共享 |
| Reflection | id、period、coverage、sourceRefs、draftBody | 数字由查询生成；文本为可编辑建议 |
| MemoryItem | id、kind、sourceRef、scope、status、validity | 确认事实与推测分开；来源撤销即失效 |
| ActionDraft | id、operationSet、payloadHash、baseVersions、state | 修改后原审批失效 |
| AgentRun | id、state、executor、policyVersion、dataCutoff | 已完成需真实工具回执 |
| CommandReceipt | commandId、spaceId、result、appliedVersion | 相同命令不可重复产生副作用 |

## 3. 正式数据、活动与审计

正式业务表表达当前可编辑状态。ActivityEvent 用于用户时间线。AuditRecord 用于权限和执行追踪。MemoryItem 用于后续检索。禁止以聊天摘要或 ActivityEvent 替代所有正式业务数据。

业务写入、事件和 Outbox/等价待提交记录应同事务提交。使用同步引擎自带队列时复用其事务能力，不再创建第二条无协调的独立上传链路。

建议事件字段：eventId、eventType、schemaVersion、spaceId、aggregateId、commandId、occurredAt、recordedAt、actorType、sourceRef、最小 payload。不得将完整录音、密钥或敏感正文嵌入事件总线。

## 4. 数据一致性

记录使用客户端可离线生成的稳定 ID；实现阶段选定方案并进行碰撞/重复测试。时间戳不作为唯一版本号。同步版本由权威端分配；客户端保留 baseVersion 和临时操作状态。

查询对象时使用 spaceId 与权限上下文，不能只拿 id 查询。引用不同 space 的对象应拒绝。删除默认保留实现同步所需的最小删除标记；敏感正文与衍生数据按删除流程清理。

## 5. 资产模块后续基线

第一期只定义 AssetAccount 与 BalanceSnapshot：账户类型、币种、金额/数量、估值时间、数据来源及导入批次。金额采用明确精度的十进制表达；不同币种先分组，换算时保留汇率来源与时间。

BalanceSnapshot 不是交易流水。净资产变化不能直接等同于收入或收益。以后增加交易时，内部转账必须有关联，修订需要记录来源，禁止用最后写入覆盖解决财务冲突。

只设计手工记录与信息展示；自动交易、受监管服务或投资建议能力另行审查，不因“资产管理”四字默认包含。

## 6. 延后对象

里程碑、复杂循环规则、知识图谱、向量表、完整投资组合和第三方连接仅在用户故事需要时新增。不先创建大量空表和空模块。
