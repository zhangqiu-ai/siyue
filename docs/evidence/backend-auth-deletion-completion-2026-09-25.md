# 注销页面、冻结复核与历史清理 · 2026-09-25

本记录更新 2026-09-24 前置证据中的“正式提交路由关闭、完整页面及冻结复核未接线”结论。工作目录仍为 `feature/dev`，保留既有改动；只操作隔离临时数据库和独立 QA 应用，无生产迁移或发布。

## 已确认规则与实现

维护者授权采用建议：逐家庭选择；转交给已加入且明确接受责任的成人；唯一管理者结束管理时冻结仍有其他成员的家庭；指定运维复核；历史记录分类清理；按已确认 iPhone／iPad 设计实施。设计与决策见 [设计稿](../design/account-deletion-completion-draft-2026-09-24.md)及 [决策记录](../decisions.md)。

- 正式 `DELETE /v1/me/account` 仅在独立账本和提交服务已配置时注册。再次验证、逐家庭声明、UUID 幂等键、加密回执恢复及清理守卫连通。缺少账本的实例继续拒绝受理。
- 桌面与移动账号入口提供影响预览、逐家庭处置、接受状态、最终再次验证、显式原请求重试和受保护回执冷启动恢复。密码提交后立即清空；回执秘密不进入页面。
- 成人成员可查看自己能承担的家庭，分别确认管理与适用监护责任。冻结状态下的接受不会自行恢复家庭。
- 冻结复核使用独立数据库运维身份的 CLI；运行时身份不能执行复核。必须核对接受范围、版本、24 小时有效接受和共同作品结果；仍待核对的作品不得解冻。闭环保留对方的接受和不可变复核凭证，重复请求须完全匹配原参数。旧儿童授权不会恢复。
- 历史清理移除本人失效临时资料；可分离关联脱敏；他人有效记录保留。不可分离共享内容与尚有保留用途的记录继续待处理，回执不会误报完成。迁移 0024～0026 为增量变更。

## 验证环境与命令

Node Playwright 使用真实 Fastify、临时 PostgreSQL 主库与独立账本；桌面用真实 Electron 及独立 user-data。原生 QA 使用合成账号和本机回环 API，不调用 Apple 或邮件服务。

- `corepack pnpm build:packages`、server build、mobile/desktop typecheck 通过；contracts **60/60**、adapters **262/262**、desktop auth IPC **8/8**、server 单元 **53/53**。
- `node --test --test-concurrency=2 apps/server/tests/integration/*.test.mjs` 最终 **488/488**。本机完整日志 `artifacts/account-deletion-20260925/siyue-deletion-integration-verified.log`。初跑发生旧字段/策略断言、尚未落盘的 CLI 测试导入和高负载启动超时；修正后整套重新执行通过。
- Playwright 五个文件共 **21** 个用例最终分别通过：`deletion-client` **12/12**、`deletion-flow` **1/1**、`deletion-submission` **3/3**、`desktop-deletion-complete` **2/2**、`desktop-deletion-ui` **3/3**。初跑旧历史语义和已移除的泛化家庭提示断言失败；按新规则补入真实他人 seat、pending/accepted 邀请分别处理后复跑通过，桌面定位改为角色/文本。
- 正式提交 Playwright 串联真实 HTTP → 冻结 → 接收人声明 → 实际运维登录 CLI → 受保护清理 → 再次幂等重放；核对对方接受记录和运维凭证保留、注销者关联清除。
- `spec:check` **6/6**、`git diff --check` 通过。更新后的桌面确认及完成截图位于本机 `artifacts/e2e/2026-09-24T17-01-33.090Z-78278/desktop-deletion-complete--ae7c1-gress-after-process-restart/`；已检查完成页无空家庭章节及无关冻结提示。

### 保留边界

共同作品无法安全分离、他人仍有效的保留记录，继续待处理。特别是注销者曾为已关闭冻结复核的**接收人**时，现有不可变运维凭证仍包含其主体关联，返回 `retained_review_closure`；本轮不提供自动到期删除或手工强置完成。此安全保留不是所有历史资料均已清理的证明。

真实 Apple 供应商撤销、生产迁移与部署、真实五设备 RTC 不属于上述通过结果。原生模拟器结果也不能替代真机。


## iPhone／iPad 原生完成断言

同一 Release QA 构建在新建隔离模拟器验证：iPhone 17 Pro（iOS 26.5，`96945097-A203-4EC9-8651-7953F7EF0681`）和 iPad Pro 11 M5（iOS 26.5，`69400DC1-4561-488D-BE95-E417FCD3E39E`）。`testDeletionChinese` / `testDeletionEnglish` 在每台设备各 **2/2**，共 **4/4**，无跳过。中文明色、英文暗色经过真实原生输入、正式页面、HTTP 受理、清理器与 Keychain 回执；冷启动后明确断言“服务端资料与外部撤销均已完成”，且不再出现密码确认控件。

可重复命令见 [原生 QA 注销专项](../../apps/mobile/e2e/account-auth/README.md#注销专项2026-09-25)。首次完整构建成功；追加最终完成断言后只重编译 XCTest（`SKIP_BUNDLING=1` 保留已验证且未改的应用 JS），重建合成数据库后重跑全部四例成功。

最终结果包：

- `artifacts/account-ui-native/deletion-phone-completion-20260925.xcresult`
- `artifacts/account-ui-native/deletion-pad-completion-20260925.xcresult`

首轮截图附件已导出至 `artifacts/account-ui-native/deletion-{phone,pad}-20260925-attachments/`，核对确认页与中英进度页；iPad 内容居中、手机可滚动访问提交，完成态无错报或截断。截图中安全输入被系统隐藏，不把空白截图当作未输入的判断。

本轮原生只覆盖邮箱密码、无家庭依赖的完整注销；家庭转交与冻结复核在上述 HTTP／桌面／数据库用例验证，未将它们声称为原生家庭全场景验收。Android 原生注销、真实 Apple、真机与五设备通话仍无本轮通过证据。所有本轮测试日志归档于 `artifacts/account-deletion-20260925/`，这些本机测试产物可能不随 Git 分发。
