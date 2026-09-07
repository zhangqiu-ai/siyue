## ADDED Requirements

### Requirement: Consistent usable controls
当前正式界面 SHALL 遵循 DESIGN.md 与 UI 验收的图标、热区、文字/控件对比度和响应式基线。

#### Scenario: Mobile controls in either theme
- **WHEN** 用户在明色或暗色操作当前移动页面
- **THEN** 熟悉操作呈现平台符号及准确无障碍名称，共用触控范围至少48，必要文字可读，必要控件边界至少3:1

#### Scenario: Desktop constrained layout
- **WHEN** 用户在最小桌面窗口或200%缩放下编辑长标题和任务
- **THEN** 内容可换行/滚动，无页面级水平溢出，键盘焦点可见，主要操作可达

### Requirement: Protect unsaved AI configuration
AI 配置页面 SHALL 在返回或更换供应商将丢弃实际修改前提供明确选择，且 SHALL NOT 自动保存或外发草稿。

#### Scenario: Continue editing
- **WHEN** 用户已改动配置并请求返回或切换供应商，选择继续编辑
- **THEN** 留在当前页，服务地址、模型与已填密钥不变

#### Scenario: Discard changes
- **WHEN** 用户已改动配置并明确选择舍弃
- **THEN** 执行原返回或切换，仅丢弃当前未保存输入，不修改已保存配置

#### Scenario: Unchanged or busy form
- **WHEN** 用户未改动配置请求返回
- **THEN** 直接返回，不显示舍弃提示

#### Scenario: Save in progress
- **WHEN** 保存或移除配置尚未结束时用户请求离开
- **THEN** 阻止离开并说明等待完成，成功或失败后仍可继续操作

### Requirement: Adaptive tablet reading width
iPad 上当前页面 SHALL 限制内容阅读宽度，适应可用窗口尺寸，并在尺寸变化时保留编辑输入。

#### Scenario: Tablet resize
- **WHEN** 用户旋转或调整 iPad 窗口宽度
- **THEN** 聊天及设置内容宽度不超过760逻辑尺寸，窄窗口内不水平溢出，当前输入不丢失

### Requirement: Discoverable return to latest message
聊天 SHALL 在用户离开消息列表底部时提供回到最新消息的入口，且不因展示该入口强制改变阅读位置。

#### Scenario: Reading earlier messages
- **WHEN** 用户向上滚动到距离底部超过4逻辑尺寸（与聊天基础库停止自动跟随的阈值一致）
- **THEN** 显示带准确无障碍名称的回到底部按钮，点击后回到最新消息，不清空输入
