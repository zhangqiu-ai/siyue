# assistant-ui Expo 示例来源

核查日期：2026-09-06。上游仓库快照：`34af371231d9cfced0bb73633825bbef0cf6e1a6`。

本目录依据 [assistant-ui 官方 Expo 示例](https://github.com/assistant-ui/assistant-ui/tree/34af371231d9cfced0bb73633825bbef0cf6e1a6/examples/with-expo) 改编：

- `components/assistant-ui/elements/thread.aui.tsx`：空态、建议入口、MessagesFlatList、键盘避让与 Composer 分区。
- `components/assistant-ui/elements/message.tsx`：MessagePrimitive.Parts、错误状态和消息操作。
- `app/_layout.tsx`：AssistantRuntimeProvider 与会话抽屉/新建操作结构；实际导航位于本项目 app 目录。

MIT 许可全文保留在 [UPSTREAM-LICENSE](UPSTREAM-LICENSE)，不为整个思玥项目选择许可证。

实际调用 API 以安装的 `@assistant-ui/react-native@0.1.40` 类型及源码为准。使用官方 runtime/primitives 管理发送、流式消息、取消、重新生成和多会话；以本项目色板与中文文案改编展示。

`ChatProvider` 明确使用 InMemoryThreadListAdapter，`mock-adapter.ts` 在本机异步逐段产出累计文本。不使用上游云服务、API 密钥、上传或工具执行。会话仅当前运行内存保留；不变更行动页的 SQLite/审批/正式写入逻辑。普通文字输入及逐段输出已接入；附件、语音、Markdown 富渲染、真实 Provider 和持久化会话不在本次范围。
