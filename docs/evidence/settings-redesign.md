# 移动设置与示例入口清理验收

日期：2026-09-06。范围：维护者要求的移动 UI 清理与 AI 设置改版；不删除个人数据库，不推进新的领域功能。

## 实现与设计依据

- 正式底部导航为对话/设置；删除目标与行动示例路由、原生组件预览路由及侧栏入口。旧目标屏幕移至 `apps/mobile/e2e/native-recovery/legacy-goal-screen.tsx`，供隔离 QA 使用；领域、存储与已有记录保留。历史正常应用目标 UI 用例不再适用于当前路由，不能沿用为当前 UI 验收。
- `settings-screen.tsx` 使用摘要分组列表；`ai-provider-screen.tsx` 承载配置与可搜索的供应商选择表单；地址默认折叠，自定义接口可编辑。保持黑白灰、明暗两种主题。
- 对照 [Apple 设置规范](https://developer.apple.com/design/human-interface-guidelines/settings) 的应用级偏好范围，以及 [Chatbox 模型配置](https://docs.chatboxai.app/en/guides/providers) 的供应商、密钥和服务地址配置方式。具体页面分层和地址折叠是本项目的设计选择，不是引用产品的逐像素复制。
- 六家预设由官方资料核对：[DeepSeek](https://api-docs.deepseek.com/)、[通义千问](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[智谱](https://docs.bigmodel.cn/cn/guide/models/text/glm-4.7)、[Kimi](https://platform.kimi.com/docs/api/chat)、[硅基流动](https://docs.siliconflow.cn/docs/api/chat-completions-post)、[火山方舟](https://www.volcengine.com/docs/82379/1494384)。另提供自定义接口。方舟不默认猜测用户已开通的模型；百炼需根据账号地域与业务空间修改地址。仍只保存一份当前服务配置。

## 实际验证

工作目录 `/Users/feature/code/siyue`。

| 验证 | 结果 |
| --- | --- |
| `corepack pnpm --filter @siyue/mobile typecheck` | 通过 |
| `corepack pnpm --filter @siyue/mobile test` | 38/38 通过，含 SSE 与安全存储行为；日志 `/tmp/siyue-settings-redesign-tests.log` |
| `corepack pnpm --filter @siyue/mobile exec expo export --platform ios --platform android --output-dir dist` | 双平台 Hermes 导出通过；日志 `/tmp/siyue-settings-redesign-export.log` |
| iOS 模拟器实际交互 | 新导航冷启动、设置入口、供应商选择表单、搜索 Kimi/选择、模型与地址填充、展开地址、空密钥保存拒绝、返回与明暗切换通过 |
| 截图检查 | 同设备改版前后、供应商表单、连接页、暗色首页、清理后侧栏；已逐图查看 |

设备：Siyue M1 QA，iPhone 17 Pro，iOS 26.5，UUID `7328BC59-6853-445B-A888-E99496AB2048`。沿用已安装的 Debug 构建与 Metro 更新；本轮无新增原生依赖、未重做原生构建。检查后恢复明色主题，AI 配置仍未配置，未发送真实供应商请求。

## 截图对比结论

本地对比页面：[comparison.html](../../artifacts/settings-redesign/comparison.html)。截图均为 `simctl io screenshot` 原图，位于同目录，属于本机忽略的验收产物。

- 改版前：设置首页混合外观、服务介绍、预设与长表单，首屏看不到保存与连接测试。
- 改版后：首页完整展示 AI 入口、外观与本机信息；具体配置独立进入，默认折叠地址时保存与连接测试可见。
- 供应商选择页七个选项可见，搜索可缩小列表；明暗主题截图未见文本或按钮裁切。
- 侧栏已无目标与行动、组件预览及重复外观控件；底部导航为对话与设置。

## 未验收与边界

未执行真实供应商调用、真实密钥测试、Android 原生 UI、真机、完整无障碍/大字号验收。预设存在不代表用户账号权限或余额可用。保存/移除安全存储有既有单元及此前模拟器证据，本轮新页面交互仅验证空密钥失败路径，不能宣称覆盖所有成功/失败路径。未提交、推送或部署。SY-009、SY-021 保持 in_progress。


## 后续调整：设置退出底部导航

维护者要求设置不占据底部主导航。移除 NativeTabs 层与设置 tab，聊天直接由 Drawer 承载，设置移至根 Stack 独立页面。设置从侧栏进入，可返回聊天。模拟器已实际验证冷启动、打开侧栏、进入设置；截图 `artifacts/settings-redesign/chat-no-tabs.png` 与 `settings-no-tabs.png` 为本轮新状态，前文截图为改版历史。类型检查通过。本轮未改变 AI 或存储行为。维护者随后明确指聊天首页设置引导；已移除该链接及配置加载占位，侧栏设置入口保留。模拟器冷启动后的 AX 树与截图确认首页不再出现该引导，类型检查与 diff 检查通过。截图为 `artifacts/settings-redesign/chat-no-settings-guide.png`；对比上一张 `chat-no-tabs.png`，输入框下方的设置链接已消失。

后续统一精简已实施，最新界面与验证见 [UI 精简](ui-simplification.md)，本页原截图保留为历史对比。
