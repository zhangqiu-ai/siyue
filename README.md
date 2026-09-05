# 思玥 · Siyue

AI-first 个人成长应用 / An AI-first personal growth app.

> 立项基线 v0.1 · 2026-09-05。当前仓库已进入工程初始化阶段：包含三端最小骨架、共享 Domain/Contracts/AI 包与立项文档，但尚未安装依赖或完成真机构建。

思玥帮助用户把目标转化为行动，在语言练习、项目推进和个人资产记录中积累真实证据，再由 AI 辅助理解、规划与复盘。个人成长操作系统是长期愿景，不意味着第一版覆盖全部生活领域。

## 已确认的产品约束

| 项目 | 约束 |
|---|---|
| 品牌 | 中文「思玥」，英文「Siyue」；工程标识建议 `siyue` |
| 定位 | AI-first 个人成长；语言学习、目标与项目管理、个人资产管理是长期核心域 |
| 平台 | 移动优先，iOS 优先，同时支持 Android；桌面采用 Electron + React，不采用 Tauri |
| 发展路线 | 初期个人开源项目，后续逐步商业化 |

## 文档入口

1. [PROJECT_CHARTER.md](PROJECT_CHARTER.md)：为什么立项、范围、负责人职责与交付标准。
2. [PRODUCT.md](PRODUCT.md)：首版用户场景、功能范围与非目标。
3. [ARCHITECTURE.md](ARCHITECTURE.md)：客户端、业务、AI、数据与可选云服务的边界。
4. [docs/ai-foundation.md](docs/ai-foundation.md)：模型、工具、审批、记忆、语音与运行状态。
5. [docs/domain-model.md](docs/domain-model.md)：领域对象和数据约束。
6. [docs/data-sync.md](docs/data-sync.md)：本地优先、写入权威、冲突、账号切换。
7. [docs/privacy-security.md](docs/privacy-security.md)：敏感数据、权限、密钥与删除。
8. [docs/roadmap.md](docs/roadmap.md)、[docs/backlog.md](docs/backlog.md)：里程碑与工作包。
9. [docs/decisions.md](docs/decisions.md)、[docs/acceptance.md](docs/acceptance.md)：决策状态与验收。
10. [START_HERE.md](START_HERE.md)、[AGENTS.md](AGENTS.md)：开发启动与 AI 编程协作规则。
11. [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md)：本轮工程初始化、固定版本、运行命令和未验证项。

## 当前工程状态

已创建移动、桌面、服务端最小代码骨架，以及 Domain / Contracts / AI 共享包。依赖锁文件、CI 运行、真机测试、数据库迁移、远端 GitHub 仓库及发布流水线仍未创建或验证。`planning/` 提供尚未创建为 GitHub Issue 的工作包与未执行测试定义。

本次查询未在当前 GitHub 连接可访问范围内找到 `zhangqiu-ai/siyue`；这不证明其他授权范围中不存在该仓库。没有修改现有仓库、注册域名、购买服务或发布代码。

## 开源状态

开源是已确认的发展路线，具体许可证尚待维护者决定。此文档包不附有效 `LICENSE`，不宣称代码已获某一开源许可证授权。见 [docs/open-source-commercial.md](docs/open-source-commercial.md)。

外部技术事实和检索范围见 [docs/sources.md](docs/sources.md)。
