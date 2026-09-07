# 版本记录流程验证

日期：2026-09-07。目录 `/Users/feature/code/siyue`，分支 `feature/dev`。保留已有 UI 与国际化未提交改动，仅补目标版本行，不改其任务或验收结论。

## 改动与范围

- 新增 planning/releases 的规则与 0.0.1 计划、CHANGELOG 的未发布入口；活动 UI/国际化变更补 `Target release: 0.0.1`。本次版本登记不扩大功能授权，待验收不写已交付。
- 根、三应用、四共享包的 package.json 与 Expo app.json 共九个版本字段改为 0.0.1。服务端 health 从服务包配置读取版本；手机设置本就从 Expo 配置读取，无需更改页面。
- 根 AGENTS、OpenSpec 与入口文档要求开发前登记、验收后补用户变化、延期留痕、实际发布后填写日期；CI 增加版本检查和检查器测试。
- manifest.json 的 0.1 为文档清单版本；历史 schema、依赖版本和测试记录保留。被忽略的本地原生工程仍含旧版本，须在实际原生构建前同步并核对包体；独立 E2E 宿主版本不等同产品版本。

## 验证边界

本次不执行完整应用构建、模拟器/真机或发布；修改源码版本不代表已安装 App 或既有工件更新。远端 CI、签名包体版本和发布日期均未验证。不提交、推送或创建 tag。

## 实际验证

环境：Node 22.22.3 / Corepack pnpm 11.25.0。

- 版本字段变更后首次 pnpm 执行提示 workspace structure changed；`corepack pnpm install --frozen-lockfile --ignore-scripts` 通过刷新安装元数据，锁文件无需更新。Registry 安全策略查询有连接重试，最终通过。
- `corepack pnpm release:check`：通过。
- `corepack pnpm test:release-workflow`：7 项通过、0 失败，含版本漂移、缺文件、缺登记、非法归属及真实 CLI 非零退出验证。
- `corepack pnpm --filter @siyue/server test`：7 项通过、0 失败，包含 health 返回 0.0.1 的断言。
- `corepack pnpm --filter @siyue/server typecheck`：通过。
- `corepack pnpm spec:check`：通过；`git diff --check`：通过。
- 新版本文件及新增链接、JSON/YAML 结构检查通过。没有把这些检查当作版本发布验收。
