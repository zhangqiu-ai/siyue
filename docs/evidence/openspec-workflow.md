# OpenSpec 流程落地验证

日期：2026-09-07。工作目录 `/Users/feature/code/siyue`，分支 `feature/dev`；开工工作区干净。

## 变更

- 根 AGENTS、README、START_HERE 加入统一流程；openspec 配置使用内置 spec-driven 与项目 rules，开发流程自身已成为一份现行规格。
- PR 与 Issue 模板增加变更/豁免入口；PR 检查器验证恰好一个关联、提案存在或具体豁免理由，拒绝缺失、占位和路径穿越。它不判断业务语义或授权真实性。
- GitHub Actions 定义 `OpenSpec checks`，监听 PR 创建、代码更新、重新打开、正文修改与就绪，以及 main / feature/dev 推送；contents 只读，不使用 pull_request_target。执行 frozen install（忽略安装脚本）、检查器测试、规格校验与 PR 关联检查。
- @fission-ai/openspec 1.12.0 为根 devDependency，锁文件仅新增工具及所需依赖；不升级应用依赖。工具要求 Node >=20.19.0；现场 Node 22.22.3，Corepack pnpm 11.25.0。
- 采用 `init --tools none`，不写全局或项目代理 skill；任何代理可通过 AGENTS 与统一 CLI 使用流程。包装器关闭匿名遥测，不通过 shell 拼接参数。

## 实际结果

| 命令 / 检查 | 结果 |
|---|---|
| `corepack pnpm view @fission-ai/openspec version engines --json` | 发布版 1.12.0，Node >=20.19.0 |
| `corepack pnpm add -Dw --save-exact @fission-ai/openspec@1.12.0` | 通过；部分 registry 连接重试后完成 |
| `OPENSPEC_TELEMETRY=0 corepack pnpm exec openspec init --tools none` | 通过；创建结构，保留原 AGENTS |
| `corepack pnpm openspec --version` | 1.12.0 |
| `corepack pnpm install --frozen-lockfile --ignore-scripts` | 通过；锁文件无需更改 |
| `corepack pnpm spec:check` | 1 项现行规格通过，0 失败 |
| `corepack pnpm test:spec-workflow` | 5 项测试通过，0 失败；涵盖活动/归档、非法引用、豁免、模板及事件 |
| `corepack pnpm spec:pr` | 本地无 PR 事件，明确跳过；模拟 PR 事件在测试中验证 |
| 隔离临时目录 `new change workflow-smoke` → `instructions proposal --change workflow-smoke --json` | 退出码 0，断言实际输出包含思玥上下文、Authorization 规则及内置 Why 模板；临时目录已清理 |
| `git diff --check` | 通过 |

## 边界

未运行应用测试、构建或原生验收：本轮只涉及流程、开发工具与文档，无应用代码修改。未测试 Windows 工具执行，未在 GitHub 运行 CI，未设置分支保护，未提交、推送、部署。规则文件已在本地生效；远端强制门槛尚未启用。不提升任何业务工作包或验收状态。没有创建聊天历史变更。

官方依据：[OpenSpec 1.12.0 配置](https://github.com/Fission-AI/OpenSpec/blob/v1.12.0/docs/customization.md)、[CLI](https://github.com/Fission-AI/OpenSpec/blob/v1.12.0/docs/cli.md)、[checkout v4](https://github.com/actions/checkout/blob/v4/README.md)、[setup-node v4](https://github.com/actions/setup-node/blob/v4/README.md)；发布包 CLI 与配置注入经过本地执行核验。
