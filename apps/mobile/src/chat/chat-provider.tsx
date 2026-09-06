import { useMemo, type ReactNode } from 'react';
import {
  AssistantRuntimeProvider,
  InMemoryThreadListAdapter,
  useLocalRuntime,
  useRemoteThreadListRuntime,
  type RemoteThreadListAdapter,
} from '@assistant-ui/react-native';
import { useAISettings } from '../settings/ai-settings';
import { useCompatibleChatAdapter } from './compatible-adapter';

export function ChatProvider({ children }: { children: ReactNode }) {
  const { revision } = useAISettings();
  // Replacing the list adapter clears its threads using the library's generation
  // handling, while preserving the navigation tree and unsaved goal forms.
  const adapter = useMemo<RemoteThreadListAdapter>(() => {
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
  }, [revision]);
  const runtime = useRemoteThreadListRuntime({
    adapter,
    runtimeHook: function useChatRuntime() {
      return useLocalRuntime(useCompatibleChatAdapter());
    },
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
