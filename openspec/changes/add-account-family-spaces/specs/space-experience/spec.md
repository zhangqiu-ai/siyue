## Purpose

定义账号、个人及家庭空间的可理解操作入口与验收要求，确保用户明确当前空间、共享对象和同步结果，并在手机、平板和其他支持客户端得到一致的业务结果。

## ADDED Requirements

### Requirement: Figma before implementation
团队 MUST 在提案关键取舍确认后用 Figma 建立流程与低保真草稿，经维护者确认后细化视觉并实施正式 UI；原型不当作业务交付证据。

#### Scenario: Permission ambiguity in prototype
- **WHEN** 原型暴露共享、邀请或撤权规则歧义
- **THEN** 回写 OpenSpec 并确认相关取舍，再更新 Figma；不以界面按钮代替权限定义。

### Requirement: Space navigation and records
系统 SHALL 明确显示当前个人/家庭空间，提供空间切换、对话、正式目标任务和设置入口；切换不把未提交内容自动转移到其他空间。

#### Scenario: Switch with unsaved edits
- **WHEN** 用户编辑内容期间切换空间
- **THEN** 保留原空间输入或提供明确保存/取消选择；迟到响应不能写入新空间。

#### Scenario: Manage task without AI
- **WHEN** 用户进入具有编辑权限的正式目标或任务
- **THEN** 可直接查看、编辑、完成/撤销完成和归档，并看到真实同步状态；不必重新与 AI 对话。

#### Scenario: Read-only member
- **WHEN** 成员只有目标或任务的查看权限
- **THEN** 可查看允许内容和状态，但不出现可用的修改操作；即使绕过 UI 发起写请求，服务端仍拒绝编辑、完成和归档。

### Requirement: Bilingual adaptive delivery
界面 MUST 支持中文和英文及无障碍名称、格式化日期/数字；保留用户原文。iPhone 紧凑屏、iPad 横竖屏与窄窗口均属于必验收范围；Android 与 Electron 分别验证业务和平台交互。

#### Scenario: Long translated labels and keyboard
- **WHEN** 英文长文案或辅助大字号下打开邀请、权限或冲突表单及键盘
- **THEN** 在 iPhone 与 iPad 中均能阅读必要后果说明、编辑和确认/取消，无裁切或不可达操作。

#### Scenario: Failure and recovery
- **WHEN** 登录过期、邀请无效、断网、存储失败、同步拒绝或权限撤销
- **THEN** 当前语言显示准确状态和恢复入口，不展示密钥，不用成功动画代替服务端回执。

### Requirement: Explicit local plan draft and project
新目标计划 SHALL 显示一个可改名的项目及其任务；生成只返回结构化草稿，明确确认前不得创建正式目标、项目或任务。既有独立任务不得被自动重新归属。

#### Scenario: Review project and tasks
- **WHEN** 用户生成或手动编辑新目标计划
- **THEN** 草稿显示目标、一个可改名项目和任务；用户可修改后预览，确认提交的参数必须与预览一致。

#### Scenario: Real provider response remains untrusted
- **WHEN** 用户明确请求使用已配置模型生成计划
- **THEN** 仅发送本次明确目标及固定结构说明；完整响应通过严格GoalDraft校验且包含一个项目后才作为草稿返回，不自动执行模型指令、调用工具、回退供应商或正式写入。

#### Scenario: Generation invalidated
- **WHEN** 生成被取消、应用进入后台、配置会话失效、响应截断或结构不合法
- **THEN** 不接受部分响应为成功草稿，保留用户输入，返回当前语言可映射的受控错误；重新生成需用户再次触发。

#### Scenario: Manual draft without model access
- **WHEN** 用户手工创建目标计划草稿
- **THEN** 不访问模型，仅保存包含一个项目的ui来源草稿；确认前无正式目标、项目或任务。调用保留原commandId与issuedAt，同身份重试只恢复同一草稿，同ID不同内容拒绝。

#### Scenario: Manual draft response lost
- **WHEN** 草稿已保存但响应丢失
- **THEN** 按原commandId查询并核对来源、身份和完整参数，不分配替代ID；查询失败保持结果未知，不能宣称未保存或创建另一份计划。
