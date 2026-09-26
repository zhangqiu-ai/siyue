import { useEffect, useMemo, useState } from 'react';
import * as Crypto from 'expo-crypto';
import Storage from 'expo-sqlite/kv-store';
import type { ChatMessage, Conversation } from '@siyue/contracts';
import { scopeKey, useWorkspace } from '../account/workspace-provider';
import { createChatStore, equalConversations, equalMessages, type ChatStorage, type ChatStore } from './chat-store';

/** The shared kv store is SQLite-backed; each space writes under its own prefix and nothing leaves the device. */
const backend: ChatStorage = {
  getItem: (key) => Storage.getItemSync(key),
  setItem: (key, value) => { Storage.setItemSync(key, value); },
  removeItem: (key) => { Storage.removeItemSync(key); },
  keys: () => Storage.getAllKeysSync(),
};

const stores = new Map<string, ChatStore>();

/** One store per space so every screen shares the same reads, writes and listeners. */
export function chatStoreForSpace(spaceId: string): ChatStore {
  const existing = stores.get(spaceId);
  if (existing) return existing;
  const store = createChatStore(backend, spaceId, { newId: () => Crypto.randomUUID() });
  stores.set(spaceId, store);
  return store;
}

function useCurrentChatStore(): ChatStore {
  const { state } = useWorkspace();
  const spaceId = scopeKey(state);
  return useMemo(() => chatStoreForSpace(spaceId), [spaceId]);
}

type Snapshot<T> = { store: ChatStore; id: string | null; value: T };

/** Re-reads on every store notification and keeps the previous value when nothing this view shows changed. */
function useChatSnapshot<T>(store: ChatStore, id: string | null, read: () => T, equal: (left: T, right: T) => boolean): T {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>(() => ({ store, id, value: read() }));
  // Switching space or conversation must not show the previous one's content while the effect resubscribes.
  if (snapshot.store !== store || snapshot.id !== id) setSnapshot({ store, id, value: read() });
  useEffect(() => store.subscribe(() => setSnapshot((previous) => {
    if (previous.store !== store || previous.id !== id) return { store, id, value: read() };
    const next = read();
    return equal(previous.value, next) ? previous : { store, id, value: next };
  })), [store, id]);
  return snapshot.value;
}

export function useChatStore(): { store: ChatStore; conversations: Conversation[] } {
  const store = useCurrentChatStore();
  const conversations = useChatSnapshot(store, null, () => store.listConversations(), equalConversations);
  return { store, conversations };
}

export function useConversation(conversationId: string | null | undefined): ChatMessage[] {
  const store = useCurrentChatStore();
  const id = typeof conversationId === 'string' ? conversationId : null;
  return useChatSnapshot(store, id, () => (id === null ? [] : store.getMessages(id)), equalMessages);
}
