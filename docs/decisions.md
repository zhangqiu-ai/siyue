# 决策登记册

状态说明：Confirmed = 用户明确约束；Baseline = 本轮推荐实施基线；Validate = 需工程证据；Owner decision = 维护者决定后生效；Deferred = 暂不实现。

| ID | 决策 | 状态 | 冻结前需要什么 |
|---|---|---|---|
| D-001 | 中文思玥、英文 Siyue | Confirmed | 名字确认不代表商标或域名已获权 |
| D-002 | iOS 优先、支持 Android；桌面 Electron + React | Confirmed | 各端真实验收；不再评选 Tauri |
| D-003 | 初期个人开源、后续商业化 | Confirmed | 具体许可、公开内容和服务边界待定 |
| ADR-001 | React Native + Expo；纯 TS 共享业务 | Baseline / Validate | 已生成 Expo 57 工程骨架；仍需安装、原生构建与真机验证 |
| ADR-002 | 模块化单体、少量 workspace 包 | Baseline | 已初始化 `apps/*` + `packages/{domain,contracts,ai}`；后续按需要扩展 |
| ADR-003 | AI SDK Core + 薄 Agent 层；Hermes 可选 | Baseline / Validate | 已固定 AI SDK 7 并加入 Mock Agent；真实 Provider、流、工具、审批与取消仍待验证 |
| ADR-004 | SQLite + 可选 PostgreSQL；同步候选 PowerSync | Validate | RN/Electron、离线冲突、账号切换、许可、退出方案 |
| ADR-005 | 本机正式写入与同步服务端裁决分开 | Baseline / Validate | 幂等、重复投递、断点对账、审批版本测试 |
| ADR-006 | 小型结构化记忆优先，图谱和向量后置 | Baseline | 来源、纠正、删除与复盘覆盖测试 |
| ADR-007 | 手机前台交互；可靠后台任务可选服务端 | Baseline | 不宣称手机常驻；授权数据范围 |
| D-004 | 开源许可证 | Owner decision | Apache-2.0 为候选，不自动附 LICENSE |
| D-005 | 仓库新建/关联、初始可见性、是否移植旧代码 | Owner decision | 不自动公开或修改原项目 |
| D-006 | 云平台、模型供应商、费用上限、正式域名与包标识 | Owner decision / Validate | 凭据、费用、持有权、地区可用性验证 |
| D-007 | 首发地区、账号主体、分发与订阅路径 | Owner decision | 目标市场与平台审核，不沿用其他产品结果 |
| D-008 | 第三方插件、自动交易、全本地模型、完整团队功能 | Deferred | 新用户故事、安全审查和专项预算 |

## 变更规则

修改 Confirmed 约束必须取得用户明确指令。Baseline 可以在有证据的情况下调整，并记录原因与替代影响。Validate 不能在 README 中写成“已支持”。所有决定记录日期、提出人角色、证据、状态和影响；禁止以助手的个人推荐冒充用户已拍板。

本次未向旧仓库提交代码，也不把旧仓库的 AGENTS 或产品规则自动升级为本项目规则。
