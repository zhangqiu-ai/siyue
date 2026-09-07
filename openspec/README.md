# 思玥规格与变更流程

2026-09-07 起用于新开发；维护者已批准采用本流程。本轮仅建立规则，不批准聊天历史功能的具体行为或实现。

## 入口与文档职责

所有开发者和代理先读 [AGENTS.md](../AGENTS.md)。本目录采用 OpenSpec 内置 `spec-driven` 模板，项目补充通过 [config.yaml](config.yaml) 注入；不维护第二套模板或 schema。

| 文件 | 唯一职责 |
|---|---|
| [PRODUCT.md](../PRODUCT.md)、[PROJECT_CHARTER.md](../PROJECT_CHARTER.md) | 产品范围与约束 |
| [docs/decisions.md](../docs/decisions.md) | 关键决策、授权与依据 |
| `specs/<capability>/spec.md` | 已验收的现行行为；未覆盖的历史功能按实际代码和证据判断 |
| `changes/<change-id>/` | 本次提案、需求差量、技术方案与实施任务 |
| [docs/backlog.md](../docs/backlog.md)、[planning/backlog.json](../planning/backlog.json) | SY 工作包依赖、优先级和进度，关联 change-id |
| [docs/acceptance.md](../docs/acceptance.md)、[planning/test-cases.json](../planning/test-cases.json) | 跨功能验收；功能细节引用规格，不重复粘贴 |
| [docs/evidence](../docs/evidence) | 命令、环境、实际结果与未验证项 |

规格不能覆盖维护者约束。发现实现偏离规格时记录差异并决定修复还是提案修改，不能只改规格掩盖缺陷。未实现提案不得写入现行规格。

## 变更分级

- **标准流程**：新功能、用户可观察行为变化、数据结构、权限、AI 外发、接口或跨端交互变化，先建立 change。
- **简化流程**：不改变语义的文案、细微样式、文档维护、恢复已明确预期行为的局部缺陷修复。说明范围、原预期及验证即可；涉及安全、数据、权限或契约的修复仍走标准流程。
- **重大取舍**：新增外部服务、破坏性迁移、家庭共享、账号权限、同步等，在标准流程中写明替代方案、风险及恢复方案，先取得维护者对关键取舍的明确确认。
- 不确定时先做只读调查并提出分类依据。维护者已明确的需求和授权可直接登记，不重复询问；无法推断的方向或数据决策保持待决。

## 标准流程

1. **提案**：用 kebab-case 命名 change-id。填写 Why、范围与非目标、Capabilities、Impact，以及 `Authorization`（日期、来源、已批准范围、待决项）。关联 SY 工作包；无适用项如实说明。
2. **规格与设计**：在 `specs/<capability>/spec.md` 写 ADDED / MODIFIED / REMOVED 差量。Requirement 使用 SHALL / MUST；每项至少一个 `#### Scenario:`，写 WHEN / THEN。交互按需附原型；技术设计说明模块、失败状态及适用的数据/安全边界。
3. **开工**：提案、规格、设计、任务齐备，阻止实施的待决项已解决，严格校验通过。OpenSpec 的 ready 状态只表示文件依赖满足，不代表维护者已批准。
4. **实施与审查**：按任务小步实施，先跑定向验证。需求改变先更新差量；超出已批准范围重新确认。审查对照规格和实际 diff。
5. **验收**：逐项记录场景与证据，分别写通过、失败、未运行、阻塞。勾选任务不能代替证据；关键验收未完成时保持活动变更，不使用跳过校验强行归档。
6. **同步与归档**：验收后将差量合入现行规格并归档变更，复查归档 diff 与严格校验。同步相关 backlog / 验收状态；原始证据保留。项目授权范围内的本地归档可直接做，commit、push、合并和发布仍按当次授权执行。

## 可执行命令

在仓库根目录使用锁定的开发依赖；新机器先 `corepack pnpm install --frozen-lockfile`。`pnpm openspec` 包装器禁用 CLI 匿名遥测；无需全局安装或代理专用斜杠命令。

```sh
corepack pnpm openspec new change persist-chat-history
corepack pnpm openspec instructions proposal --change persist-chat-history
# 填完 proposal 后，依次读取 specs、design、tasks 的 instructions 并填写文件
corepack pnpm openspec status --change persist-chat-history
corepack pnpm openspec validate persist-chat-history --strict --no-interactive
corepack pnpm spec:check
# 仅在验收完成后执行，会同步规格并移动变更目录
corepack pnpm openspec archive persist-chat-history
corepack pnpm spec:check
```

上面功能名仅为命令示例，未创建聊天历史提案。无需倒补所有历史规格；首次修改已有能力时补充有证据的基线，再描述本次差量。AI 助手使用同一 CLI 和项目规则；若以后生成工具集成文件，先检查其是否与规则冲突，不自动覆盖现有指令。

## PR 与自动检查

PR 正文必须二选一填写完整的一行：

```text
OpenSpec-Change: actual-change-id
```

或：

```text
OpenSpec-Exempt: 仅删除重复消息署名，消息内容和交互语义不变。
```

规则建立这类纯文档/工具维护可说明豁免，无需伪造业务变更。活动与已归档变更都可关联。一个 PR 默认一个变更；多个独立功能拆 PR。

`spec:check` 使用官方严格校验检查规格与差量；`spec:pr` 检查引用的提案存在，或豁免原因非空且不是占位符。CI 执行这些检查与检查器测试。它不能判定豁免是否合理、授权真假、代码符合需求或业务测试充分，这些仍须人工/代理审查；每次实现仍须运行受影响应用的测试。

CI 文件随下一次获授权的推送生效。本次没有设置 GitHub 分支保护；在仓库规则将 `OpenSpec checks` 设为必需检查前，它不是禁止合并的硬门槛。

## 官方依据

查阅并核对发布版本 1.12.0（2026-09-07）：[项目配置](https://github.com/Fission-AI/OpenSpec/blob/v1.12.0/docs/customization.md)、[CLI](https://github.com/Fission-AI/OpenSpec/blob/v1.12.0/docs/cli.md)。本流程的变更分级、授权与证据要求是思玥项目约定，不是 OpenSpec 自动强制的能力。
