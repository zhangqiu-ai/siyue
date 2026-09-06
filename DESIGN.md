# 思玥 Siyue · 设计方向

状态：Headspace 风格参考已由维护者确认（2026-09-06）；思玥具体页面与最终设计变量待原型确认。

## 已选参考与读取顺序

1. 先读本文件，确定思玥的范围与覆盖规则。
2. 读取 [Headspace iOS 设计参考](docs/design/references/headspace/DESIGN.md)，作为已选的视觉探索基准。
3. 原生实现时参考 [Expo / React Native 补充](docs/design/references/headspace/DESIGN-expo.md)，API 与依赖须以本项目 Expo 57 的实际兼容性为准，不直接执行示例安装或覆盖已有工程。

上游原文已保留；来源、固定提交与文件 SHA-256 见 [SOURCE.json](docs/design/references/headspace/SOURCE.json)，第三方文档许可见同目录 LICENSE。该许可只覆盖引入的参考材料，不为思玥全项目设定许可证。

## 思玥采用的方向

- 温暖、轻松、有人情味的成长陪伴感。
- 暖奶油底色、温暖强调色、柔和形状与清楚的信息层级；具体色号和尺寸以参考稿为探索起点，待思玥原型确认。
- 动效舒缓且有功能目的，兼顾减少动态效果的系统偏好。
- 用清晰的目标、草稿与行动记录承载内容，避免把工程运行信息变成页面视觉中心。

## 项目覆盖规则

- 品牌始终为思玥 / Siyue。上游是社区整理的风格参考，不是 Headspace 官方规范；不把精确色号、字体或动效数值称为官方实测。
- 不复制 Headspace 的 logo、角色插画、文案或商业字体资产；使用思玥自己的内容与有适当授权的资产。中文字体需另行验证可读性与平台适配。
- 上游的冥想、睡眠、课程、订阅、连续打卡等页面与功能不构成思玥的新需求，不直接复制其导航结构。当前范围仍是目标输入、可编辑草稿、明确确认、正式保存、重启查看与完成任务。
- 使用 huashu-design 做高保真 HTML 原型和评审；原型经维护者确认后再实现正式 UI。本项目禁止使用 ui-ux-pro-max。
- 移动端保持 React Native + Expo，桌面保持 Electron + React。通用控件已由维护者选择 Expo UI（2026-09-06），导航保留 Expo Router；AI 对话组件尚待单独接入。
- Spectr 用于需要从授权录屏提取新设计参考的场景；现成 Headspace 文档不需要重新运行 Spectr。不得让提取流程覆盖唯一的已确认设计文件。

## 尚待确认

首页及核心流程布局、思玥品牌配色的最终数值、中文排版、插画方向与各组件状态。当前安装完成不代表原型、生产 UI 或原生验收完成。

## 原生组件基础（2026-09-06）

- `@expo/ui@57.0.16` 为移动端直接依赖，使用 Universal API，iOS 映射 SwiftUI，Android 映射 Compose。
- `apps/mobile/src/ui/theme.ts` 集中维护探索色板、间距和圆角；强调色使用较深橙色以改善白色按钮文字的对比，暖橙保留为装饰色。最终数值待原型确认。
- `apps/mobile/src/ui/native-host.tsx` 统一浅色外观与原生 seedColor。它在 iOS 是 tint，在 Android 生成系统色板，不要求两端像素一致。
- 开发模式首页的“打开原生组件预览”进入 `/ui-preview`：使用 Expo Router 原生标题栏、Expo UI 输入框、开关与按钮。仅本页内存反馈，不调用 AI 或写入业务记录；生产环境重定向首页。
- 下一步仍先用 huashu-design 确认核心页面原型，再将正式页面迁移到基础组件。底部导航分区与 AI 对话布局尚未实施。

## AI 应用框架（2026-09-06）

维护者已确认以 assistant-ui 官方 Expo 示例搭建应用框架，补充底部导航并应用暖色方向。本轮授权为可运行的应用骨架；详细品牌页面仍继续原型评审。

- 底部：对话 / 行动；使用 Expo Router NativeTabs。当前不增加空的学习、资产等分区。
- 顶部：页面标题、打开会话侧栏、新建对话；使用各 Tab 内的 Stack 原生标题栏。
- 侧栏：新建会话、本次会话列表、目标与行动入口、开发模式组件预览。
- 对话：使用 assistant-ui runtime 和输入/消息/会话 primitives，流式本地演示、停止及重新生成。会话仅本次进程内存保留，界面明确提示；行动页仍使用原有 SQLite。
- 共用色板仍在 `apps/mobile/src/ui/theme.ts`；聊天源码及许可来源见 `apps/mobile/src/chat/UPSTREAM.md`。Expo UI 继续作为通用原生控件基础。
- 真实模型、聊天记录持久化、附件、实时语音、Markdown 富渲染均未随应用框架自动完成。
