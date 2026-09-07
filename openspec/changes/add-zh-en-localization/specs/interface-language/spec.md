## ADDED Requirements

### Requirement: Required interface languages
当前正式移动和桌面界面 SHALL 提供简体中文与英文资源，包含导航、按钮、表单、空态、运行/错误/恢复/后果说明及无障碍名称。

#### Scenario: English interface
- **WHEN** 用户选择English
- **THEN** 当前界面及状态以英文显示，用户原文、模型ID、地址和AI正文不被翻译

#### Scenario: Chinese interface
- **WHEN** 用户选择简体中文
- **THEN** 当前界面及状态以简体中文显示，已有编辑输入不丢失

### Requirement: Language settings and persistence
应用 SHALL 在设置提供语言切换，并即时应用选择且保存本机偏好；不得重建业务会话、清空草稿或触发模型请求。

#### Scenario: Restart
- **WHEN** 用户成功保存语言选择后重启应用
- **THEN** 恢复同一语言，设置以原生语言名称显示两个选项

#### Scenario: Invalid preference or storage failure
- **WHEN** 本机没有有效语言偏好
- **THEN** 默认简体中文，不崩溃且可更换语言

#### Scenario: Preference write failure
- **WHEN** 保存语言选择失败
- **THEN** 当前选择仍在本次运行生效，显示本地化保存失败提示，不宣称持久化成功

### Requirement: Language-safe presentation
应用 SHALL 在界面语言切换时保留用户内容、当前任务、原授权及正式数据，展示数字按选择locale格式化，未知错误展示可恢复本地化提示。

#### Scenario: Editing and switching
- **WHEN** 用户已输入草稿或消息后切换界面语言
- **THEN** 输入值不变，按钮及状态更新，不新增正式写入或AI请求

#### Scenario: Translation coverage
- **WHEN** 开发者增改界面资源
- **THEN** 类型或测试检查中英文键完整性，缺失值有中文回退而非空白控件
