## Context

设计依据是[统一原型](../../../docs/design/prototype/README.md)，各功能说明见同目录的 account.md、shell.md、chat.md、space.md、plan.md、whiteboard.md。维护者已通过原型并同意三项取舍（见 proposal 的 Authorization）。项目未投产，旧界面不保留兼容层，但已有本地数据必须保留并能被新界面读出。

## Goals / Non-Goals

目标：移动端按原型重建六个功能的页面与交互；抽出一套共享组件，所有页面只用语义色和共享组件；补齐对话持久化、草稿日期、多块白板三项数据能力。

非目标：设置页重做、创建家庭空间与邀请流程、RTC 接入、云端对话同步、附件与语音输入。桌面端按同一信息结构跟进，但不承诺本变更内与移动端功能对等。

## Decisions

**路由**。以 expo-router 重组：`(shell)` 下的 Drawer 承载 `index`（新对话）、`chat/[id]`、`space`、`space/goal/[id]`、`space/members`、`whiteboard`；`account/*`、`plan/*` 与 `whiteboard/invite` 用模态展示；`whiteboard/[id]` 与通话页全屏。iPad 宽窗口改为常驻侧栏（Drawer 的 permanent 类型），窄窗口退回抽屉，断点按实际可用宽度判定。

**共享组件**。新增 `apps/mobile/src/ui/` 下的 Button（primary / tonal / text / danger / dangerFill / apple，内置加载态）、TextField、PasswordField、OtpField、PasswordRules、Banner、ListGroup/ListRow、ChoiceCard、Checkbox、StepHeader、BottomSheet、Toast、ResultView、ProgressRing、Composer。组件只读 `useTheme()` 的语义色；禁用态用 subtle 背景与 muted 文字表达，不用整体透明度。theme.ts 新增 errorSurface、warn、warnSurface、apple、onApple，明暗成对并通过对比度测试。

**账号**。复用现有 adapters 状态机（createEmailEntry、createEmailRegistration、account-deletion-flow、auth-controller），只重写界面层；原 account-screen.tsx 中的状态拆到按页面的 hooks。幂等键、结果未知的重试、主体变化清空表单、注销回执读取等既有行为保持不变。

**对话持久化**。在 contracts 中新增 Conversation（id、spaceId、title、createdAt、updatedAt）与 ChatMessage（id、conversationId、role、text、status、createdAt）；本机按空间保存在 expo-sqlite 的键值存储中（与白板相同的空间前缀规则：本机空间 `siyue.chat.v1.local.*`，账号空间 `siyue.account.<namespace>.chat.v1.*`），会话索引与每个会话正文分开存放。修改或移除 AI 配置不再清空对话。标题取首条用户消息的前 24 个字符，可在后续加入重命名。旧版本只在内存中的对话无可迁移数据。

**对话内计划草稿**。对话请求带一个“提出计划”工具；AI 调用该工具时，客户端走现有 `propose` 生成 ActionDraft，并在消息中保存草稿 ID 以渲染草稿卡。工具只能创建草稿，不能审批或写入。服务不支持工具调用时，对话照常进行，不显示草稿卡。

**草稿自动保存**。草稿页对编辑做 600ms 防抖，调用 `editDraft` 生成新版本；点按确认时先等待进行中的保存完成，再对最新版本执行 approve 与 apply，审批仍绑定 payloadHash 与版本。GoalDraft 增加可选 `targetDate`（YYYY-MM-DD），确认时写入 Goal.targetDate；不递增共享的 schemaVersion（它同时约束命令、审批、回执与整个空间状态，递增需要跨包迁移）；`targetDate` 为严格可选字段，旧草稿读入时视为无日期。确认使用 `confirmLatestDraft`，可见版本与最新保存版本不一致时返回 `draft_changed`，不写入任何内容。

**多块白板**。白板存档协议升级：由单一 `local-whiteboard` 改为白板索引（id、spaceId、title、pageCount、updatedAt、thumbnail）加各白板正文。首次启动时把已有的 `local-whiteboard` 读入为一块名为“我的白板”的白板，原键保留到迁移确认成功后再清理。移除显式保存按钮与全屏保存遮罩，保留防抖自动保存、离开前 flush 与冲突提示；冲突文案改为“这块白板在别处更新过，已保留两份”。页面切换改为保留各页编辑器实例或历史，避免清空撤销记录。

**家庭通话界面**。本变更只交付发起与通话中的界面，接到 add-family-video-whiteboard 的会话与录制接口；接口未就绪时入口隐藏，不显示伪造的通话状态。

## Risks / Trade-offs

- 路由大面积重组会使现有原生 UI 自动化脚本全部失效，需要随每个功能重写。
- 对话持久化引入新的本机数据，需在隐私说明中写明保存位置，且删除空间时一并删除。
- Excalidraw 保留撤销历史需要按页缓存编辑器状态，内存占用上升；页数上限维持 30。
- 桌面端暂不跟进会造成跨端外观差异，在 tasks 中单列跟进项。

## Migration Plan

旧界面文件直接删除，不保留开关。数据迁移只涉及白板存档（一次性读入，原键延后清理）与草稿 schemaVersion（向前兼容读取）。回滚方式是回退代码版本；迁移期间原白板键不被删除，因此回滚不丢数据。

## Open Questions

- 设置页是否跟随重做（本变更不含）。
- 创建家庭空间与邀请成员的流程设计。
- O01、O02、O05、O06 中仍待决的部分（见 add-family-video-whiteboard）。
