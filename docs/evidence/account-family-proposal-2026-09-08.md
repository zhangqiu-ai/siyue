# 账号与家庭空间提案准备 · 2026-09-08

范围：[add-account-family-spaces](../../openspec/changes/add-account-family-spaces/proposal.md)，归属 0.0.1（维护者本轮明确并入）。只完成规格草案与版本范围登记，不含应用实施、云资源或 Figma 工件。

现场：`/Users/feature/code/siyue`，`feature/dev`，开始前 `git status --short` 为空。

已核对 contracts/domain/adapters/server 与移动 ChatProvider：可复用空间检查、审批、事务、回执；生产身份、家庭成员和同步尚未实现。独立代理复核发现只读成员场景错误地允许编辑，已修订为编辑权限才可写，并补服务端拒绝只读写入场景。

已执行：

- `corepack pnpm spec:check`：4 项通过、0 失败。
- `corepack pnpm release:check`：通过，0.0.1 归属与计划登记一致。
- `git diff --check`：通过。
- Python 本地 Markdown 链接存在检查：通过（本次新增规格、版本计划、PRODUCT 和 decisions）。

未运行：应用测试、原生/真机、云服务 PoC、生产部署；本轮仅文档，不据校验宣称业务已验收。Figma 尚未创建，按用户要求在提案关键取舍确认后进行。

待确认：登录方式、使用/部署地域、儿童身份、家庭角色、共享副本/引用语义、离线授权策略。前三项已发出具体问题，未把预选项视为答案。其余建议见 design D2–D4；确认后细化实施任务与工作包。未修改业务代码、依赖或数据；未 commit/push。

后续回复已收到并写入 proposal/design/account-session：邮箱验证码、中国大陆与海外、受管理儿童身份。此前“三项待确认”是历史过程，现已解决；云部署、监护细则与 D2–D4 仍待决。

同日进一步回复已确认同一内容共享及限期离线读写，相关规格已更新。官方候选资料研究已形成 account-sync-options-2026-09-08.md，尚非选型。修订后 spec:check（4/4）、release:check、diff --check 再次通过；design 的 Figma review package 尚待确认。
