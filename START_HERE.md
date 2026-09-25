# 从这里开始

本页是当前任务的导航；当前优先级依据见下节。已有工程应继续演进；历史首次初始化任务与旧运行摘要已保留在 [入口历史快照](docs/evidence/rules-entry-history-2026-09-13.md)。

## 当前发布目标（2026-09-25）

维护者已授权将真实线上注册、登录、会话恢复和账号注销闭环收口为 **0.0.2** 小版本。独立变更：[add-shared-api-independent-auth](openspec/changes/add-shared-api-independent-auth/proposal.md)；交付范围、验证结果和未纳入事项见 [0.0.2 版本计划](planning/releases/0.0.2.md)。

0.0.1 保留为未发布的历史开发流，其中五设备家庭视频通话与共享白板仍未完成，不进入本次发布。后续继续该功能时读取 [0.0.1 计划](planning/releases/0.0.1.md)及对应 OpenSpec，不以 0.0.2 的账号验收替代视频、白板或 Android 验收。

## 确定本轮工作

1. 读取 [AGENTS.md](AGENTS.md)，检查工作目录、分支与未提交改动，保留用户已有内容。
2. 以维护者当前要求确定目标；在 [当前版本计划](planning/releases/0.0.2.md) 找到对应变更、工作包与证据。版本号以根 [package.json](package.json) 为准，版本登记按 [版本规则](planning/releases/README.md) 执行。未明确下一项时不要从历史启动提示自行恢复排期。
3. 按 [OpenSpec 流程](openspec/README.md) 选择标准或简化路径，再读取与本轮相关的现行规格及活动变更。已有授权不重复询问，新的关键取舍交由维护者决定。
4. 根据下表补读所需资料，实施范围内的最小改动，以对应路径的实际验证结果交付。

## 按需读取

| 本轮涉及 | 读取入口 |
|---|---|
| 产品范围或优先级 | [项目章程](PROJECT_CHARTER.md)、[产品定义](PRODUCT.md)、[决策登记](docs/decisions.md)、对应 [工作包](docs/backlog.md) |
| 安装、构建、运行故障 | [BOOTSTRAP](docs/BOOTSTRAP.md)、根目录与受影响包的 `package.json` |
| 页面、布局、交互 | [DESIGN](DESIGN.md)、[UI 验收分级与设备矩阵](docs/design/ui-acceptance.md) |
| 领域、契约或跨包边界 | [架构](ARCHITECTURE.md)、[领域模型](docs/domain-model.md) |
| AI、审批或外发 | [AI 基础](docs/ai-foundation.md)、[隐私安全](docs/privacy-security.md) |
| 存储、同步或账号隔离 | [数据同步](docs/data-sync.md)、[隐私安全](docs/privacy-security.md) |
| 验收与交付 | 对应变更的 tasks/evidence、[验收定义](docs/acceptance.md) |

移动正式页面的当前结构与视觉方向见 [DESIGN](DESIGN.md)。中文、英文及 iPhone、iPad 均为必需交付约束；本页不重新声明已完成哪些页面或设备验收。旧目标示例的通过结果不能代替当前正式入口验证。

## 复用已有证据

按本轮路径查阅 [M1 验证](docs/evidence/m1-validation.md)、[移动 AI 与设置](docs/evidence/mobile-ai-settings.md)、[设置改版](docs/evidence/settings-redesign.md) 或版本计划中的更新记录。核对记录对应的代码、设备和场景；详细运行数据保留在证据文件，不在入口重复维护。

## 分支与远端

日常开发起点沿用 `feature/dev` 约定；先核实分支是否存在和工作区状态，不自动切换带有用户改动的工作区，不直接向 `main` 发布。项目远端约定为 `zhangqiu-ai/siyue`，实际操作前核对 Git 配置。提交、推送、PR、合并和部署遵循当次授权；本地编辑不自动包含远端操作，也不授权改变可见性、购买服务或公开其他内容。`SY-xxx` 是规划 ID，不是 GitHub Issue 编号。
