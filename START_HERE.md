# 从这里开始：首个开发切片

当前仓库已包含首轮工程骨架，但尚未安装依赖、生成 lockfile 或完成真机构建。先读 `docs/BOOTSTRAP.md`，不要把代码存在等同于平台已验证。

## 建议首次交给编程工具的任务

```text
请按当前 Siyue 仓库的 AGENTS.md 和立项文档开始 M1，不要实现全部路线图。

先检查 git status、现有文件和本机可用工具。保留已有内容，不改动其他仓库，不公开代码，不部署服务。

本轮处理 SY-001 与 SY-002；再在隔离验证目录中准备 SY-003。使用 React Native + Expo 建移动入口（iOS 优先、支持 Android），使用 Electron + React 建桌面入口。采用 TypeScript workspace，但不要创建大量空包。

先定义 PersonalSpace、Goal、Project、Task、ActionDraft、CommandReceipt 的最小模型、校验和确定性命令契约。通过 Mock Provider 验证草稿与确认的边界。移动和桌面使用同一领域测试，不在共享业务层导入平台 API。

记录依赖版本和实际可执行命令。对本机无法执行的 iOS/Android/Windows 测试明确写未运行；不要说全部平台已支持。数据库驱动与生产同步须按 SY-003 的 PoC 结果定，不把未经测试的 PowerSync/SQLite 组合锁死到全部业务。

提交前说明文件差异、真实测试结果、未决事项。达到本轮验收后停止，不自动做资产、支付、插件市场或生产部署。
```

## 后续切片顺序

通过 SY-003 选择存储适配；实现 SY-004 与 SY-005 的事务和安全边界；随后 SY-006/007/008/009 完成 AI 草稿到正式目标。每一阶段都保留手动编辑与取消路径。

## 远端仓库

建议工程名 `siyue`。仓库名、组织、可见性及许可确认后再执行远端建库或上传。当前连接未找到目标仓库，不把文档下载等同于 GitHub 已初始化。本次没有 GitHub Issue 编号；SY-xxx 是规划 ID。
