import { useState, type ReactNode } from 'react';
import {
  AssistantRuntimeProvider,
  InMemoryThreadListAdapter,
  useLocalRuntime,
  useRemoteThreadListRuntime,
  type RemoteThreadListAdapter,
} from '@assistant-ui/react-native';
import { mockChatAdapter } from './mock-adapter';

export function ChatProvider({ children }: { children: ReactNode }) {
  const [adapter] = useState<RemoteThreadListAdapter>(() => {
    const local: RemoteThreadListAdapter = new InMemoryThreadListAdapter();
    local.generateTitle = async (_threadId, messages) => {
      const first = messages.find((message) => message.role === 'user');
      const input = first?.content.filter((part) => part.type === 'text').map((part) => part.text).join('') ?? '';
      const title = Array.from(input.replace(/\s+/g, ' ').trim()).slice(0, 24).join('') || '新的成长对话';
      return new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'part-start', path: [0], part: { type: 'text' } });
          controller.enqueue({ type: 'text-delta', path: [0], textDelta: title });
          controller.enqueue({ type: 'part-finish', path: [0] });
          controller.close();
        },
      });
    };
    return local;
  });
  const runtime = useRemoteThreadListRuntime({
    adapter,
    runtimeHook: function useChatRuntime() {
      return useLocalRuntime(mockChatAdapter);
    },
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
