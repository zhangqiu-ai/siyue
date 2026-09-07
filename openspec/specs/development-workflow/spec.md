# Development Workflow

## Purpose

统一思玥从需求、设计到验证和归档的开发规则。维护者于 2026-09-07 批准；操作指南见 openspec/README.md。本规格描述开发约定，不代表已有业务功能全部验收。

## Requirements

### Requirement: Classify and trace changes

开发者 MUST 为新功能或行为、数据、权限、AI 外发及接口变化建立 OpenSpec 变更；不改变语义的小修改可说明豁免。PR MUST 引用可找到的活动或归档提案，或提供具体豁免理由。

#### Scenario: Behavior change
- **WHEN** 开发者增加聊天历史保存等用户行为
- **THEN** 实施前建立提案、规格差量、设计与任务，并关联适用的工作包

#### Scenario: Small non-semantic change
- **WHEN** 修改仅删除重复文案且不改变交互或数据行为
- **THEN** 可以不建变更，但 MUST 说明豁免理由和实际验证结果

### Requirement: Respect authorization boundaries

开发者 MUST 记录已有维护者授权；未解决的关键产品、数据或外部服务决策不得由代理自行批准。已授权范围内的可逆工作 SHALL 直接推进。

#### Scenario: Unresolved data decision
- **WHEN** 提案包含尚未确认的数据删除或外发行为
- **THEN** 记录待决问题并在实施该行为前取得维护者确认，其他独立调查可以继续

### Requirement: Verify before publishing current specifications

开发者 MUST 对照需求场景记录实际证据；任务勾选、格式校验或构建成功不能替代业务验收。未完成关键验收的变更 MUST 保持活动状态。

#### Scenario: Incomplete verification
- **WHEN** 关键场景未运行、失败或受阻
- **THEN** 如实记录并保留未完成任务，不将拟议行为归档为已验收现行规格

#### Scenario: Completed change
- **WHEN** 已授权范围的实现、审查及验收完成
- **THEN** 同步现行规格、归档变更并更新相关规划与证据，提交及发布仍遵循当次授权


### Requirement: Plan and verify both Apple device classes

涉及移动页面或布局的变更 MUST 同时规划 iPhone 与 iPad 的设计及验收，按 docs/design/ui-acceptance.md 的设备矩阵分别保留证据。iPad 是未来主力，不能以此省略手机体验；本规则不表示应用已经适配。

#### Scenario: New mobile layout
- **WHEN** 开发者为移动端增加页面或改变布局
- **THEN** 规格和任务包含 iPhone 与 iPad 的适用窗口、方向和输入场景，缺少任一设备证据时不得宣称双设备适配完成


### Requirement: Include Chinese and English in delivery planning

涉及产品文案的变更 MUST 同时规划中文和英文资源及适用验证，包含状态、错误和无障碍名称。界面语言 MUST 与用户内容、学习语种及 AI 回复语言区分；未确认的语言选择策略不得自行当作已批准。

#### Scenario: User-facing copy changes
- **WHEN** 开发者新增或修改产品界面文案
- **THEN** 同时覆盖中文与英文，并按变更风险验证资源完整性、可理解性和布局；缺少证据不宣称双语支持完成
