# Siyue 后端与认证开发交接指令

**版本：1.0 ｜ 日期：2026-09-21**  
主规格：`Siyue_Backend_Auth_Design_v1.0.md`  
验收表：`Siyue_Acceptance_Checklist.md`

> 这是给本地编程助手的开发指令，不是已经执行的变更记录。按工作包推进，每包留下实现和测试证据；不因提供了完整计划就一次性扩展所有功能。

## 1. 固定目标

思玥与秋哥助手共用 `https://api.qiugeapp.com`，思玥用 `/api/siyue/v1/*`。独立 Node/Fastify 服务、PostgreSQL 数据库、运行／迁移角色、签名密钥、issuer、audience、用户与会话。保留秋哥助手 `/api/cloud/*` 和微信精确回调。

首期邮箱注册／密码登录＋iPhone/iPad Apple 登录；微信延期，不申请 AppID、不接 SDK、不展示无效按钮。Android、Electron 首期通过邮箱使用同一思玥账号。Apple 和邮箱只绑定思玥内部 subject，不与秋哥助手统一账号。

当前产品 P0 仍是五设备家庭视频＋共享白板。复用已有 Excalidraw、family policy、subject/session、local space 设计，不重做白板，不恢复旧 M1 初始化排期。

## 2. 开始前核查

先读取当前 `AGENTS.md`、`START_HERE.md`、`ARCHITECTURE.md`、现有 OpenSpec 和本套主规格；检查远端、分支、未提交文件与实际依赖。

本方案核查快照：

| 分支 | SHA |
|---|---|
| qiuge-helper/main | `86538d4230ac97be22839168d199bf625c69b7e4` |
| siyue/feature/dev | `8baacbc4c702f86576358d02e76e45536447334f` |
| siyue/codex/video-whiteboard | `fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1` |

不能直接从旧 siyue/main 重建项目。若本地领先，保留新实现并记录与本文差异；不得 reset、覆盖或自动切换有未提交内容的工作区。文档中的“拟新增”接口不能被报告为仓库已有功能。

## 3. 建立一个对应 OpenSpec 变更

建议 change ID：`add-shared-api-independent-auth`。沿用仓库当前 OpenSpec 结构，建立 proposal/design/tasks 和必要 capability delta；将工作包映射回现有 planning/版本计划，不伪造 GitHub Issue 编号。

将主规格作为 `docs/architecture/backend-auth-v1.md` 内容基线，保留来源、默认参数、门禁和未实施状态。未获远端操作授权时仅本地编辑，提交／推送／PR／合并／部署分别遵循当次授权。

## 4. 按包实现，不合成不可审查的大改动

| 工作包 | 核心实现 | 必须交付的证据 |
|---|---|---|
| SA-01 | 基线、契约与差异清单 | 分支/SHA、范围、保留现有能力 |
| SA-02 | pg adapter、SQL migration、独立角色、配置校验、live/ready | 真 PG 空库迁移／重复迁移／权限拒绝测试 |
| SA-03 | 独立 JWT、session、refresh 轮换／恢复／撤销、reauth | 并发、重放、60 秒恢复、过期与签名负面用例 |
| SA-04 | 邮箱挑战、密码、Outbox、限流、注册／登录／找回 | 单测＋HTTP＋真实邮件送达分开记录 |
| SA-05 | typed API client、SecureStore／Electron vault、状态机 | 离线／换号／迟到响应／存储失败的原生和桌面证据 |
| SA-06 | Apple 原生配置、nonce flow、验签／code exchange | 真 bundle／真机／隐藏邮箱／再登录／取消；Mock 不代替 |
| SA-07 | 主动绑定、最后方式保护、设备撤销、注销、Apple revoke | 绑定冲突、并发解绑、删除恢复与最小审计 |
| SA-08 | 家庭真实仓储、受控邀请、guardian、child device grant | 与现有 policy 一致的正反权限测试 |
| SA-09 | 房间身份／设备票据／五席位＋白板授权接线 | 已批准服务下的真实设备和撤权测试，未批准部分留门禁 |
| SA-10 | 独立部署、Nginx 增量、备份恢复与旧服务回归 | staging 证据、回退方案、获授权后的生产 smoke |

推荐：先 SA-01/02/03，再推进邮箱／客户端与 Apple；Apple 配置缺失不阻塞邮箱和会话代码开发。未选定 RTC 不阻塞身份合同和仓储，但不能声称真实多人通话完成。微信永远不是本轮前置依赖。

## 5. 必须保留的代码合同

`GET /v1/account/session` 通过既有 `SessionVerifier` 返回原严格对象：

```ts
{
  subjectId: string;
  subjectKind: 'adult' | 'child';
  sessionId: string;
  expiresAt: string;
}
```

不擅自加 envelope、role、家庭列表等字段。其他 API 采用主规格规定的 envelope。既有错误格式调整必须同步调用方和测试。

登录凭据与主体分离；数据库生成真实主体、session 与权限快照，客户端不能自己指定 adult／guardian／owner。保留已有 `familyMembership`／`familyShareGrant` 的版本与对象隔离。

## 6. 禁止事项

不得读取／迁移／复制秋哥助手用户库来省事；不得共享 JWT 密钥、账号或 refresh；不得公开本地 Mock 鉴权；不得生成固定测试用户作为生产兜底；不得把微信 AppID 写成假值。

不得让 Apple `.p8`、邮件 key、DB URL、验证码、JWT、refresh、二维码秘密进入日志、提交、构建产物或聊天输出。第三方可撤销 token 与思玥 refresh 的存储规则不同，按主规格分别加密／摘要。

不得将 refresh 放普通 SQLite／AsyncStorage／Renderer／Excalidraw DOM；安全存储失败不能退回明文。不能把网络故障当账号失效，更不能清掉用户本地白板。

不得把用户切换后的迟到响应写到新账号缓存；不得拿 family member 身份自动授权所有图片、编辑、永久另存和录像。

不得全量替换 Nginx 配置、重建共享 PostgreSQL volume、改变旧微信回调、执行破坏性 down migration。生产维护、购买、AppID 申请或第三方数据上传须另有授权。

## 7. 本期必须实现的两个难点

**刷新恢复**：客户端 single-flight 并先原子保存 pendingRotationId；服务端一次消费旧 token，60 秒内仅相同请求恢复同一份加密响应，不产生新后继；不同 rotationId 重放撤销设备 session；过窗要求登录但保留本地数据。

**Apple 完整性**：仅接受服务端验证的 iss/aud/exp/nonce/签名与交易绑定；server code exchange；identity 按 verified subject 唯一；隐藏邮箱和再次姓名为空不阻塞登录；保留加密外部凭据以便注销撤销；主动绑定而非按邮箱合并。

## 8. 每包交付格式

每个包报告：修改文件、功能合同、数据库变化、实际测试命令和结果、未运行项、失败与风险、下包依赖。测试报告标明环境、SHA、设备和日期；不输出真实凭据。

“代码实现”“本地自动化通过”“第三方联调通过”“真机通过”“生产部署通过”是五种不同状态，逐项写清。没有真实邮箱／Apple／ECS 配置时，完成可实施部分并列出准确的外部门禁，不伪造成功。

## 9. 可直接复制给编程助手

```text
请依据随附 Siyue_Backend_Auth_Design_v1.0.md 和验收表，在现有 Siyue 工程上实施共享 API 域名、独立后端与账号体系。

先核对当前分支、未提交变更、AGENTS/START_HERE/OpenSpec 和现有视频白板实现，不从旧 main 重建，不覆盖用户改动。首批完成 SA-01、SA-02、SA-03，并为邮箱 SA-04 与客户端 SA-05 定好契约；按已完成包继续推进，不跳过安全测试。

确认架构：api.qiugeapp.com；思玥 /api/siyue/v1/*；独立服务/数据库/DB roles/JWT issuer/audience/keys/sessions；保留秋哥助手 /api/cloud/* 和微信回调。首期 Apple＋邮箱，微信不申请、不接入、不显示。

复用 subjectId/adult-child、严格 VerifiedAccountSession、family policy、local space 和 Excalidraw。真实账号验证不能自动赋予家庭/房间/白板权限。实现完整注册、refresh 轮换与丢响应恢复、主动绑定、账号切换、撤销与注销，不以 Mock 或 UI 跳转当闭环。

只进行本次授权范围内的本地开发和测试；未经另行明确授权，不推送、合并、部署、付费、申请 AppID 或操作生产数据。缺少外部配置只阻塞对应真实验收，不阻塞数据库/邮箱/会话等独立开发。

每个工作包给出实际文件变更、测试结果、尚未通过的门禁和下一包依赖；不要把五设备视频白板未完成项勾成完成。
```
