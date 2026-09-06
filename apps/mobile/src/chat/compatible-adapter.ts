import { fetch as expoFetch } from 'expo/fetch';
import type { ChatModelAdapter } from '@assistant-ui/react-native';
import { useAISettings } from '../settings/ai-settings';
import { SettingsError } from '../settings/credential-store';
import { CompatibleChatError, streamCompatibleReply, type CompatibleMessage } from './compatible-transport';

export function useCompatibleChatAdapter(): ChatModelAdapter {
  const settings = useAISettings();
  return {
    async *run({ messages, abortSignal }) {
      const sessionSignal = settings.getSessionSignal();
      const controller = new AbortController();
      const abort = () => controller.abort();
      abortSignal.addEventListener('abort', abort, { once: true });
      sessionSignal.addEventListener('abort', abort, { once: true });
      try {
        if (abortSignal.aborted || sessionSignal.aborted) return;
        const credentials = await settings.getCredentials();
        if (controller.signal.aborted) return;
        // Only visible text from this conversation; no goals, tools, or other threads.
        const history: CompatibleMessage[] = messages.filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') }))
          .filter((message) => message.content.trim());
        if (history.reduce((size, message) => size + message.content.length, 0) > 60_000) {
          throw new SettingsError('当前对话过长，请新建对话后继续。');
        }
        for await (const text of streamCompatibleReply(credentials, history, controller.signal, expoFetch)) {
          yield { content: [{ type: 'text', text }] };
        }
        if (sessionSignal.aborted && !abortSignal.aborted) throw new SettingsError('应用已进入后台或 AI 配置已变更，回复已停止。');
      } catch (error) {
        if (!abortSignal.aborted) yield { status: { type: 'incomplete', reason: 'error', error: {
          code: 'unknown', message: error instanceof SettingsError || error instanceof CompatibleChatError ? error.message : '回复中断，请检查 AI 设置后重试。',
        } } };
      } finally {
        abortSignal.removeEventListener('abort', abort);
        sessionSignal.removeEventListener('abort', abort);
        controller.abort();
      }
    },
  };
}
