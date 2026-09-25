# 思玥 · Siyue

AI-first 个人成长应用 / An AI-first personal growth app.

思玥帮助用户将目标转化为行动，并通过正式记录积累成长证据。语言学习、目标与项目管理、个人资产管理是长期核心域；当前交付范围以维护者已批准的版本计划为准。

当前开发版本由 [package.json](package.json) 的 `version` 指定，对应 [0.0.2 计划](planning/releases/0.0.2.md)；发布状态与工件见该计划，已验收变化见 [CHANGELOG](CHANGELOG.md)。

## 开始使用与开发

- [开发入口](START_HERE.md)：确认本轮范围、选择所需文档与验证路径。
- [工程运行](docs/BOOTSTRAP.md)：环境、安装与运行记录；实际脚本以各包 `package.json` 为准。
- [协作规则](AGENTS.md)：授权、代码与数据保护、按需阅读和完成标准。

## 按任务查阅

| 需要了解 | 文档 |
|---|---|
| 产品范围与已确认约束 | [项目章程](PROJECT_CHARTER.md)、[产品定义](PRODUCT.md) |
| 当前工作与版本归属 | [版本计划](planning/releases/0.0.2.md)、[工作包](docs/backlog.md) |
| 决策依据与待决事项 | [决策登记](docs/decisions.md) |
| 功能规格与变更 | [OpenSpec](openspec/README.md) |
| 界面方向与验收 | [设计规范](DESIGN.md)、[UI 验收](docs/design/ui-acceptance.md) |
| 工程与领域边界 | [架构](ARCHITECTURE.md)、[领域模型](docs/domain-model.md) |
| AI、存储与安全 | [AI 基础](docs/ai-foundation.md)、[数据同步](docs/data-sync.md)、[隐私安全](docs/privacy-security.md) |
| 完成条件与证据 | [验收定义](docs/acceptance.md)、对应版本计划中的证据链接 |

界面交付须覆盖中文与英文、iPhone 与 iPad，并支持 Android；桌面采用 Electron + React。具体产品约束以项目章程为准，视觉方向以 DESIGN 为准。工程和页面已经存在；实施与验收状态须分别核对，不重新初始化项目。

历史 Mock 闭环、移动 AI 设置和原生验证保留于 [M1 验证](docs/evidence/m1-validation.md)、[移动 AI 与设置](docs/evidence/mobile-ai-settings.md)、[设置改版](docs/evidence/settings-redesign.md)。这些记录只证明其注明版本、环境与路径，不代表当前正式界面或全部平台已验收。入口精简前的完整内容见 [历史快照](docs/evidence/rules-entry-history-2026-09-13.md)。

## 开源与外部操作

开源是已确认的发展路线，具体许可证由维护者决定；公开仓库不等于授予某种开源许可，见 [许可与商业边界](docs/open-source-commercial.md)。远端操作须遵循当次授权，仓库已存在不自动授权推送、公开其他内容、购买服务或部署。
