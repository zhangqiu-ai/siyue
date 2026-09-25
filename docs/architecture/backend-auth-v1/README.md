# 后端与账号体系方案原件

来源：维护者提供的 ChatGPT 会话「评估后端与微信登录」（2026-09-21，`6ab0ee67-ca98-83ee-bf55-a8065112e9b0`），由维护者下载至本机后导入本项目。

以下三份文件保留原始文件名和内容，均已逐字节核对；它们是设计与验收基线，不是实现完成或测试通过的证据。

| 文件 | 用途 |
| --- | --- |
| [主设计方案](Siyue_Backend_Auth_Design_v1.0.md) | 架构、数据模型、API、安全与发布边界 |
| [开发交接](Siyue_Implementation_Handoff.md) | SA-01～SA-10 工作包、依赖和交付要求 |
| [验收清单](Siyue_Acceptance_Checklist.md) | 102 项待验证用例，原件保持未执行状态 |

本地开发基线：`feature/dev`，提交 `fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1`。与原方案的差异是白板实现已经合入本地开发分支；不回退到文档中较旧的 `feature/dev` 快照。

首批开发按 SA-01、SA-02、SA-03 推进。后续实现状态、规格差量和测试证据另行登记，不改写这三份原件以冒充原始方案。此方案不授权生产部署、外部数据操作或远端提交。

## 原件校验（SHA-256）

```text
ef5c002ea70cb75dcfec6ff88849ccd10e30480b96f123f75a4f6941d4e51df5  Siyue_Backend_Auth_Design_v1.0.md
99b990122098943e779fb3c66ee6a60a520b5d35c6fb34f0e2c9a81c5e358a70  Siyue_Implementation_Handoff.md
4e6e92716aa8eedf6d7aab64fa501c5ce8112c550d4f2eaf5136b02466b571a2  Siyue_Acceptance_Checklist.md
```
