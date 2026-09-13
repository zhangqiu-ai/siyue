# 共享权限隔离实验 · 2026-09-09

Target release: 0.0.1；关联 add-account-family-spaces / V04、V18、V20 的部分策略条件。

文件：`experiments/account-family/share-policy.mjs`、`share-policy.test.mjs`。

在仓库根目录、Node v22.22.3 执行 `node --test experiments/account-family/share-policy.test.mjs`：7 项通过。验证家庭管理员不自动获得私人内容、只读不可编辑、编辑者不可再次共享/撤销/删除、原件所有者权限、当前成员与共享授权均必需、源空间/家庭/对象精确匹配、会话版本变化沿用当前权限、AI 外发不复用共享权限。

现有领域命令按空间 members 的 canRead/canWrite 授权；不能直接把共享成员加入私人空间，否则会扩大到未共享原件。因此正式接入需要在服务端事务内解析 ShareGrant，再以真实 actor 对选定原件执行；实验没有更改现有处理器。

限制：输入假定来自新鲜的可信服务端快照。未验证鉴权、边界 schema、事务竞争、数据库查询过滤、消息流过滤或真实设备；不可将此函数直接当 HTTP 权限边界，也不能据此标记 V04/V18/V20 完整通过。家庭管理、监护与删除执行不在实验内。
