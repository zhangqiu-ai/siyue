# assistant-ui Expo 示例来源

核查日期：2026-09-06。上游仓库快照：`34af371231d9cfced0bb73633825bbef0cf6e1a6`。

本目录依据 [assistant-ui 官方 Expo 示例](https://github.com/assistant-ui/assistant-ui/tree/34af371231d9cfced0bb73633825bbef0cf6e1a6/examples/with-expo) 改编：

- `components/assistant-ui/elements/thread.aui.tsx`：空态、建议入口、MessagesFlatList、键盘避让与 Composer 分区。
- `components/assistant-ui/elements/message.tsx`：MessagePrimitive.Parts、错误状态和消息操作。
- `app/_layout.tsx`：AssistantRuntimeProvider 与会话抽屉/新建操作结构；实际导航位于本项目 app 目录。

MIT 许可全文保留在 [UPSTREAM-LICENSE](UPSTREAM-LICENSE)，不为整个思玥项目选择许可证。

实际调用 API 以安装的 `@assistant-ui/react-native@0.1.40` 类型及源码为准。使用官方 runtime/primitives 管理发送、流式消息、取消、重新生成和多会话；以本项目色板与中文文案改编展示。

`ChatProvider` 使用 InMemoryThreadListAdapter；当前 `compatible-adapter.ts` 连接用户在设置中明确保存的 OpenAI 兼容服务，`mock-adapter.ts` 仅保留作确定性测试。未配置密钥时提示设置，不自动启用 Mock 或其他服务。SecureStore 保存绑定地址的个人密钥；只发送当前会话可见文字，不读取正式业务对象、不上传其他会话、不执行工具。

会话仅当前运行内存保留，配置保存/移除后替换会话列表适配器；不使用上游 assistant-cloud 服务。旧行动示例页已移至 e2e/native-recovery/legacy-goal-screen.tsx，正式应用不导入；SQLite/审批/正式写入逻辑和数据保留。附件、语音、Markdown 富渲染、持久化聊天及真实供应商验收不在已完成的基础实现内。验证见 [mobile-ai-settings.md](../../../../docs/evidence/mobile-ai-settings.md)。
