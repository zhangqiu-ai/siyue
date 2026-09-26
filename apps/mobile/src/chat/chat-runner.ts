import { useMemo, useSyncExternalStore } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import * as Crypto from 'expo-crypto';
import type { ChatMessage } from '@siyue/contracts';
import { useAISettings } from '../settings/ai-settings';
import { SettingsError } from '../settings/credential-store';
import { streamCompatibleReply, type CompatibleMessage } from './compatible-transport';
import { chatErrorCode } from './chat-error';
import type { ChatStore } from './chat-store';

/** Replies being generated, keyed by the assistant message id. Kept outside React so leaving a
 *  screen does not stop a reply; a settings change or backgrounding still aborts via the session signal. */
const running = new Map<string, AbortController>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
let version = 0;
const snapshot = () => version;
const bump = () => { version++; changed(); };

export const TRANSCRIPT_LIMIT = 60_000;

/** Only the visible text of this conversation before the reply, skipping failed turns. */
export function transcriptBefore(messages: readonly ChatMessage[], assistantId: string): CompatibleMessage[] {
  const index = messages.findIndex((message) => message.id === assistantId);
  const earlier = index < 0 ? messages : messages.slice(0, index);
  return earlier
    .filter((message) => message.status !== 'failed' || message.role === 'user')
    .filter((message) => !(message.role === 'assistant' && message.status === 'streaming'))
    .map((message) => ({ role: message.role, content: message.text }))
    .filter((message) => message.content.trim().length > 0);
}

export function useRunningReplies(): (assistantId: string) => boolean {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return (assistantId) => running.has(assistantId);
}

export function useChatRunner(store: ChatStore) {
  const settings = useAISettings();
  return useMemo(() => {
    const now = () => new Date().toISOString();
    async function generate(conversationId: string, assistantId: string) {
      const controller = new AbortController();
      running.set(assistantId, controller); bump();
      const session = settings.getSessionSignal();
      const abort = () => controller.abort();
      session.addEventListener('abort', abort, { once: true });
      let text = '', lastWrite = 0;
      try {
        const transcript = transcriptBefore(store.getMessages(conversationId), assistantId);
        if (transcript.reduce((size, message) => size + message.content.length, 0) > TRANSCRIPT_LIMIT) throw new SettingsError('当前对话过长，请新建对话后继续。');
        const credentials = await settings.getCredentials();
        for await (const chunk of streamCompatibleReply(credentials, transcript, controller.signal, expoFetch)) {
          text = chunk;
          if (Date.now() - lastWrite > 150) { store.updateMessage(assistantId, { text }); lastWrite = Date.now(); }
        }
        if (controller.signal.aborted) store.updateMessage(assistantId, { text, status: 'stopped', errorCode: null });
        else store.updateMessage(assistantId, { text, status: 'complete', errorCode: null });
      } catch (error) {
        if (controller.signal.aborted) store.updateMessage(assistantId, { text, status: 'stopped', errorCode: null });
        else store.updateMessage(assistantId, { text, status: 'failed', errorCode: chatErrorCode(error) });
      } finally {
        session.removeEventListener('abort', abort);
        running.delete(assistantId); bump();
      }
    }
    function startReply(conversationId: string) {
      const id = Crypto.randomUUID();
      store.appendMessage({ id, conversationId, role: 'assistant', text: '', status: 'streaming', createdAt: now() });
      void generate(conversationId, id);
      return id;
    }
    return {
      /** Sends a user message, creating the conversation when needed, and returns its id. */
      send(conversationId: string | null, text: string): string {
        const clean = text.trim();
        const id = conversationId ?? store.createConversation(clean).id;
        store.appendMessage({ id: Crypto.randomUUID(), conversationId: id, role: 'user', text: clean, status: 'complete', createdAt: now() });
        startReply(id);
        return id;
      },
      stop(assistantId: string) { running.get(assistantId)?.abort(); },
      /** Replaces a finished, stopped or failed reply with a new one for the same user turn. */
      regenerate(conversationId: string, assistantId: string) {
        if (running.has(assistantId)) return;
        store.updateMessage(assistantId, { text: '', status: 'streaming', errorCode: null, planDraftId: null });
        void generate(conversationId, assistantId);
      },
    };
  }, [store, settings]);
}
