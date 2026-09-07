Target release: 0.0.1

## Why
维护者明确要求中文与英文为必需界面语言，设置中提供切换入口。当前正式界面主要为中文硬编码。

## What Changes
- 当前移动聊天/侧栏/设置/AI配置，以及桌面目标工作台补齐简体中文和英文资源，包含提示、错误与无障碍名称。
- 设置提供简体中文/English；即时切换并本机持久化，不重挂业务provider或丢失输入。
- 初始保持当前简体中文；未知存储值或缺失翻译回退中文。两种资源键由类型/测试约束。
- 不翻译用户记录、模型ID、URL、供应商商标或AI返回正文；不改变学习语言/AI系统提示词/正式数据协议。

## Capabilities
### New Capabilities
- `interface-language`: 双语界面、设置入口及本机偏好。
### Modified Capabilities
无现行国际化能力规格；遵循development-workflow双语规则，承接polish-current-ui活动变更的当前UI。

## Impact
apps/mobile 与 apps/desktop UI及资源、针对性测试。使用现有React和本机存储能力，不新增第三语言、外部服务或翻译请求。关联SY-009/SY-021现有界面，不自动更新为完成。

## Authorization
2026-09-07维护者当前请求明确双语优先补齐、设置增加切换入口。简体中文/中文默认/本机持久化/中文回退作为延续现有界面的实施基线，不伪称此前已逐项批准；无重大外部或数据取舍。
