# 规则调整验证 · 2026-09-13

范围：AGENTS、按需工程规则、README/START_HERE、OpenSpec 指南与配置、UI 检查说明、backlog 阅读提示、决策及版本登记。纯规则/文档维护，按简化流程；维护者明确授权一次完成冲突修正、按需加载及流程减负。无业务行为、契约或状态升级；未修改全局规则或账号策略。

原 README/START_HERE 全文见 [历史快照](rules-entry-history-2026-09-13.md)。其他已有未提交修改保留；本轮没有应用代码改动。

验证工作目录：/Users/feature/code/siyue。运行时：Node v22.22.3；pnpm 使用项目 corepack 入口。

- `corepack pnpm spec:check`：通过，4 项、0 失败（3 个活动变更及 development-workflow 现行规格）。
- `corepack pnpm release:check`：通过。
- `git diff --check`：通过。
- Python 本地链接检查（跳过代码块和外部 URL）：11 份本轮 Markdown 的 143 个相对文件链接存在；根及移动 package.json 可解析。
- 子代理验证 README/START_HERE 原文逐字保留，入口链接通过。
- 根 AGENTS 从 188 行减至 66 行；减少的是常驻加载，专项安全与验证细则保留在按需文档，并非删除项目要求。

未运行应用测试、原生/真机验收或提示词性能对照实验：没有应用变更，本轮不能据此宣称执行速度或业务验收提升。未提交、推送或部署。
