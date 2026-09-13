# 账号与家庭空间验证计划

状态：待执行。依据 specs 与维护者已确认的交互审查包；24 小时、角色权限、儿童配对及会话后续消息已确定。本计划不代表已执行，云部署和监护变更/删除细节仍待确认。所有样例均为合成数据，不使用真实家庭/儿童信息。

## 隔离测试参与者

成人 A、成人 B、只读成员 R、未授权账号 X；儿童 C 及其监护绑定。设备 A1/A2 为同账号跨设备，B1 为协作设备，C1 为儿童设备。至少 iPhone 与 iPad 真机分别覆盖核心路径，Android/Electron 按既有支持范围补验证；模拟器结果单独记录。

## 行为与证据

| 编号 | 操作和失败注入 | 必须观察的结果 | 对应规格 |
|---|---|---|---|
| V01 | A 邮箱获取验证码，验证、退出、再次验证；错误/过期/重复码/限流 | 同一账号与空间恢复；失败不签发令牌，验证码与令牌不进日志 | account-session / Verified identity、Email verification safety |
| V02 | A1 保存对话及任务，A2 登录；中断回复后终止进程重开 | ID、内容与状态一致；中断明确且不自动再次模型调用 | space-sync / Durable content and scoped sync |
| V03 | A 分享同一记录，B 编辑，A2 拉取；检查数据库/授权投影 | 同原件 ID 与版本推进、实际编辑者回执，无副本及身份冒用 | family-space / Single shared record |
| V04 | X 猜测原件ID；R直接请求写入；B请求未共享关联内容 | 列表、正文、元数据、事件和游标均不越权；写入拒绝 | family-space / Private personal space；space-experience / Read-only member |
| V05 | 并发接受邀请，随后使用过期/撤销/其他身份邀请 | 合法接受幂等，其他请求拒绝，不多建成员或扩大角色 | family-space / Invitation lifecycle |
| V06 | B1 离线编辑共享记录，A撤权，B1重连 | 先校验权限；不上传成功、不复活权限，受控恢复本人未提交输入 | family-space / Membership revocation；space-sync / Bounded offline collaboration |
| V07 | 最后成功服务端核验后 24 小时边界、调回时钟、设备重启及离线连续编辑 | 满 24 小时或无法证明有效时锁定并要求联网；本地操作与调时不得续期 | space-sync / Bounded offline collaboration |
| V08 | A/B同时改同一字段；断网后并发改目标/任务 | 双方输入保留，冲突可理解、可解决，不静默最后写入覆盖 | space-sync / Conflicts and deletion |
| V09 | 服务端提交后丢响应；重复命令、同ID不同参数；云端下发 | 对账原回执、仅一次副作用，参数冲突拒绝，下发不重上传 | space-sync / Authoritative commands |
| V10 | 修改草稿参数、审批过期/拒绝/撤销后重投 | 无新正式写入，要求重新有效确认；输入保留 | space-sync / Approval changed |
| V11 | A退出切B，延迟释放A请求；切空间时保留编辑 | 旧结果不进入新账号/空间、旧队列不重标归属，AI不外发旧内容 | account-session / Account isolation；space-experience / Switch with unsaved edits |
| V12 | 监护人连接C1、撤销设备、伪造儿童主体或配对确认 | C1只得儿童权限，不得监护人令牌；撤销后拒绝刷新与同步 | account-session / Managed child identity |
| V13 | 唯一所有者退出/删账号，与转移或解散并发 | 无无主家庭，不静默删除其他人私人内容，结果可对账 | account-session / Account deletion；family-space / Family lifecycle |
| V14 | 删除记录后旧端重放、备份恢复、过期游标重建 | 原件/授权投影不复活，恢复不绕过权限 | space-sync / Conflicts and deletion |
| V15 | 旧本机数据认领取消、重复导入、迁移中止、未来schema | 无静默上传/覆盖，原始数据仍可恢复，导入幂等 | account-session / Local adoption；space-sync / Safe migration |
| V16 | 共享内容未授权AI用途，尝试发给模型；切账号/撤权竞争 | 不自动加入外发上下文，不因家庭可读而获得AI外发权 | family-space / AI use is separate |
| V17 | 中英文、明暗、大字号、键盘、iPad窄窗、桌面键盘 | 核心操作与后果说明可达；真实平台行为与Figma分别验收 | space-experience / Bilingual adaptive delivery |
| V18 | 管理员改权/移除所有者；编辑者再次共享、撤销共享或删除他人原件；儿童调用管理接口 | 均拒绝；家庭管理权不升级为对象所有权或监护权 | family-space / Family and object permissions |
| V19 | 配对码过期、撤销、重放、并发确认、无监护关系确认；配对后读取儿童私人内容 | 拒绝无效挑战；合法重复仅同一绑定，儿童令牌独立，配对不自动开放私人内容 | account-session / Guardian pairing authorization |
| V20 | 共享完整会话后新增消息，撤销后继续新增，再用旧ID请求 | 共享确认与会话持续提示包含后续消息；有权者收到同一会话，撤销后服务端停止发送，其他会话保持私有 | family-space / Shared conversation continuity |

## 两地网络与邮件 PoC

在用户确认云地域/服务与测试资源后，使用专用测试账号在中国大陆和选定海外实际网络各执行：DNS/TLS、验证码获取与投递、验证、令牌刷新、增量同步、断线重连和重复投递。记录网络区域/运营商、设备、UTC时间、服务地域、成功/失败、耗时及脱敏关联ID；单一主机结果不推定另一地区可用。

需实测的邮件类别由实际首批使用邮箱确定，不能凭域名声称可投递；禁止未经授权发信。当前无云端工程、发信域名或两地网络验收证据，不执行注册、购买和部署。

## 服务退出和恢复 PoC

在隔离环境验证导出身份映射、空间、共享授权、正文及必要回执；恢复后同ID可查询，已删数据不复活、被撤设备不重获权限。身份服务与同步引擎退出是两条独立路径；无法迁出访问令牌时重新登录，不伪造令牌兼容。正式采用前核查实际使用版本的许可、备份保留和恢复步骤。

## 记录格式

每次记录：规格场景、代码commit/未提交diff标识、数据schema、客户端/服务版本、设备/系统、网络条件、命令或手动步骤、期望与实际、pass/fail/not_run、证据路径。首次失败日志保留，修复后另记复测。未执行项保持未执行，截图不证明权限/事务正确。

## 已执行的隔离子实验（不改变V01–V20整项状态）

- V07时钟策略：见[离线租约实验](../../../docs/evidence/offline-lease-poc-2026-09-09.md)，未替代原生计时/重启验收。
- V04/V18对象权限策略：见[权限模型实验](../../../docs/evidence/share-policy-poc-2026-09-09.md)，未接真实API事务。
- V11会话竞态：见[隔离模型实验](../../../docs/evidence/session-fence-poc-2026-09-09.md)，10项Node测试通过；持久队列、流式UI、凭据/缓存分区及原生后台尚未接入。
