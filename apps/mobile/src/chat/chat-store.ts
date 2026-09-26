// 思玥对话本机存储：按空间持久保存对话与消息。
// 边界：只写本机键值存储，不上传、不记录消息文本；不导入 React Native、Node API 或第三方模块。
import { chatMessageSchema, conversationSchema, type ChatMessage, type Conversation } from '@siyue/contracts';

/** Injected key-value backend. The app passes expo-sqlite's kv-store; tests pass an in-memory map. */
export type ChatStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Optional key listing, used to erase a whole space even when its index cannot be read. */
  keys?(): string[];
};

export type ChatStoreErrorCode = 'chat_invalid' | 'chat_capacity' | 'chat_not_found';

export class ChatStoreError extends Error {
  readonly code: ChatStoreErrorCode;
  constructor(code: ChatStoreErrorCode, message: string) {
    super(message);
    this.name = 'ChatStoreError';
    this.code = code;
  }
}

/** `null` clears an optional field; an absent key leaves it untouched. */
export type ChatMessagePatch = {
  text?: string;
  status?: ChatMessage['status'];
  errorCode?: string | null;
  planDraftId?: string | null;
};

/** Distinct corrupt rows skipped so far: never repaired in place, never counted twice by repeated reads. */
export type ChatReadReport = { skippedConversations: number; skippedMessages: number };

export type ChatStoreOptions = { newId?: () => string; now?: () => string };

export type ChatStore = {
  /** The space this store reads and writes; also stored as each conversation's `spaceId`. */
  readonly spaceId: string;
  listConversations(): Conversation[];
  getMessages(conversationId: string): ChatMessage[];
  createConversation(firstUserText: string): Conversation;
  appendMessage(message: ChatMessage): void;
  updateMessage(id: string, patch: ChatMessagePatch): ChatMessage;
  renameConversation(id: string, title: string): Conversation;
  deleteConversation(id: string): void;
  deleteAllForSpace(): void;
  getReadReport(): ChatReadReport;
  subscribe(listener: () => void): () => void;
};

/** Hard bounds: exceeding a bound fails with `chat_capacity` instead of silently dropping stored data. */
export const CHAT_LIMITS = { conversations: 500, messages: 2000, createdTitleCodePoints: 24, titleCodePoints: 80 } as const;

const documentVersion = 1;
const spaceIdPattern = /^[A-Za-z0-9._-]{1,200}$/;
const accountSpacePattern = /^[a-z][a-z0-9-]*\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Per-space storage prefix. Account spaces reuse the board namespace rule (`siyue.account.<namespace>.`),
 * so every account space and the local space keep separate keys in the shared kv store.
 */
export function chatStoragePrefix(spaceId: string): string {
  if (typeof spaceId !== 'string' || !spaceIdPattern.test(spaceId)) throw new ChatStoreError('chat_invalid', '对话空间标识无效。');
  const namespace = accountSpacePattern.exec(spaceId)?.[1];
  return namespace ? `siyue.account.${namespace}.chat.v1.` : `siyue.chat.v1.${spaceId}.`;
}

/** Titles are bounded in code points for the reader and in UTF-16 units for the contract schema. */
function clipTitle(text: string, codePoints: number): string {
  let clipped = '';
  let count = 0;
  for (const character of text) {
    if (count >= codePoints || clipped.length + character.length > CHAT_LIMITS.titleCodePoints) break;
    clipped += character;
    count += 1;
  }
  return clipped;
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function defaultNewId(): string {
  const generator = globalThis.crypto?.randomUUID;
  if (!generator) throw new ChatStoreError('chat_invalid', '缺少 UUID 生成器。');
  return generator.call(globalThis.crypto);
}

/** Snapshot comparison for reactive readers: unchanged content must not trigger a re-render. */
export function equalConversations(left: readonly Conversation[], right: readonly Conversation[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other !== undefined && entry.id === other.id && entry.spaceId === other.spaceId && entry.title === other.title
      && entry.createdAt === other.createdAt && entry.updatedAt === other.updatedAt;
  });
}

export function equalMessages(left: readonly ChatMessage[], right: readonly ChatMessage[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other !== undefined && entry.id === other.id && entry.conversationId === other.conversationId && entry.role === other.role
      && entry.text === other.text && entry.status === other.status && entry.errorCode === other.errorCode
      && entry.planDraftId === other.planDraftId && entry.createdAt === other.createdAt;
  });
}

export function createChatStore(backend: ChatStorage, spaceId: string, options: ChatStoreOptions = {}): ChatStore {
  const prefix = chatStoragePrefix(spaceId);
  const indexKey = `${prefix}index`;
  const keyOf = (conversationId: string) => `${prefix}conversation.${conversationId}`;
  const listeners = new Set<() => void>();
  const report: ChatReadReport = { skippedConversations: 0, skippedMessages: 0 };
  const counted = { conversations: new Set<string>(), messages: new Set<string>() };
  /** Message id to conversation, learned from reads and appends so streaming updates stay O(1). */
  const locations = new Map<string, string>();
  const newId = options.newId ?? defaultNewId;
  const now = options.now ?? (() => new Date().toISOString());

  const notify = () => { for (const listener of [...listeners]) listener(); };

  const parseJson = (raw: string): unknown => {
    try { return JSON.parse(raw); } catch { return undefined; }
  };

  function skip(kind: keyof typeof counted, identity: string): void {
    if (counted[kind].has(identity)) return;
    counted[kind].add(identity);
    if (kind === 'conversations') report.skippedConversations += 1;
    else report.skippedMessages += 1;
  }

  function readIndex(): Conversation[] {
    const raw = backend.getItem(indexKey);
    if (raw === null) return [];
    const document = parseJson(raw);
    if (!isRecord(document) || document.version !== documentVersion || !Array.isArray(document.conversations)) {
      skip('conversations', 'index');
      return [];
    }
    const conversations = new Map<string, Conversation>();
    for (const [position, entry] of document.conversations.entries()) {
      const parsed = conversationSchema.safeParse(entry);
      // A row under another space's prefix is corrupt here: stored conversations never cross spaces.
      if (!parsed.success || parsed.data.spaceId !== spaceId) { skip('conversations', `index#${position}`); continue; }
      const existing = conversations.get(parsed.data.id);
      if (existing) {
        skip('conversations', `index#${parsed.data.id}`);
        if (Date.parse(parsed.data.updatedAt) > Date.parse(existing.updatedAt)) conversations.set(parsed.data.id, parsed.data);
        continue;
      }
      conversations.set(parsed.data.id, parsed.data);
    }
    return [...conversations.values()];
  }

  function writeIndex(conversations: readonly Conversation[]): void {
    backend.setItem(indexKey, JSON.stringify({ version: documentVersion, conversations }));
  }

  function readMessages(conversationId: string): ChatMessage[] {
    const raw = backend.getItem(keyOf(conversationId));
    if (raw === null) return [];
    const document = parseJson(raw);
    if (!isRecord(document) || document.version !== documentVersion || !Array.isArray(document.messages)) {
      skip('conversations', `conversation.${conversationId}`);
      return [];
    }
    const messages: ChatMessage[] = [];
    for (const [position, entry] of document.messages.entries()) {
      const parsed = chatMessageSchema.safeParse(entry);
      if (!parsed.success || parsed.data.conversationId !== conversationId) { skip('messages', `${conversationId}#${position}`); continue; }
      locations.set(parsed.data.id, parsed.data.conversationId);
      // A reply still marked streaming means the app was killed mid-run: keep the partial text and stop it.
      messages.push(parsed.data.status === 'streaming' ? { ...parsed.data, status: 'stopped' } : parsed.data);
    }
    return messages;
  }

  function writeMessages(conversationId: string, messages: readonly ChatMessage[]): void {
    backend.setItem(keyOf(conversationId), JSON.stringify({ version: documentVersion, messages }));
  }

  function requireConversation(conversationId: string): { conversations: Conversation[]; conversation: Conversation } {
    const conversations = readIndex();
    const conversation = conversations.find((entry) => entry.id === conversationId);
    if (!conversation) throw new ChatStoreError('chat_not_found', '找不到这段对话。');
    return { conversations, conversation };
  }

  /** Activity is the newest appended message, so `updatedAt` never moves backwards and renames do not reorder. */
  function touch(conversation: Conversation, at: string): Conversation {
    return Date.parse(at) > Date.parse(conversation.updatedAt) ? { ...conversation, updatedAt: at } : conversation;
  }

  /** A cold lookup has no message index, so it scans this space's conversation documents once. */
  function locateMessage(messageId: string): string | null {
    for (const conversation of readIndex()) {
      const messages = readMessages(conversation.id);
      if (messages.some((message) => message.id === messageId)) return conversation.id;
    }
    return null;
  }

  return {
    spaceId,
    listConversations() {
      return readIndex().sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    },
    getMessages(conversationId) {
      // An unknown or deleted conversation reads as empty; mutations reject unknown ids instead.
      return typeof conversationId === 'string' ? readMessages(conversationId) : [];
    },
    createConversation(firstUserText) {
      if (typeof firstUserText !== 'string') throw new ChatStoreError('chat_invalid', '首条消息必须是文本。');
      const conversations = readIndex();
      if (conversations.length >= CHAT_LIMITS.conversations) throw new ChatStoreError('chat_capacity', '当前空间的对话数量已达上限。');
      const createdAt = now();
      const parsed = conversationSchema.safeParse({
        id: newId(), spaceId, title: clipTitle(collapse(firstUserText), CHAT_LIMITS.createdTitleCodePoints), createdAt, updatedAt: createdAt,
      });
      if (!parsed.success) throw new ChatStoreError('chat_invalid', '对话不符合本机存储格式。');
      writeMessages(parsed.data.id, []);
      writeIndex([...conversations, parsed.data]);
      notify();
      return parsed.data;
    },
    appendMessage(message) {
      const parsed = chatMessageSchema.safeParse(message);
      if (!parsed.success) throw new ChatStoreError('chat_invalid', '消息不符合本机存储格式。');
      const { conversations, conversation } = requireConversation(parsed.data.conversationId);
      const messages = readMessages(parsed.data.conversationId);
      // Re-appending an id is reported instead of duplicating or overwriting it.
      if (messages.some((entry) => entry.id === parsed.data.id)) throw new ChatStoreError('chat_invalid', '这条消息已存在。');
      if (messages.length >= CHAT_LIMITS.messages) throw new ChatStoreError('chat_capacity', '这段对话的消息数量已达上限。');
      writeMessages(parsed.data.conversationId, [...messages, parsed.data]);
      locations.set(parsed.data.id, parsed.data.conversationId);
      const touched = touch(conversation, parsed.data.createdAt);
      writeIndex(conversations.map((entry) => (entry.id === conversation.id ? touched : entry)));
      notify();
    },
    updateMessage(id, patch) {
      const conversationId = locations.get(id) ?? locateMessage(id);
      if (!conversationId) throw new ChatStoreError('chat_not_found', '找不到这条消息。');
      const messages = readMessages(conversationId);
      const position = messages.findIndex((entry) => entry.id === id);
      const current = messages[position];
      if (!current) throw new ChatStoreError('chat_not_found', '找不到这条消息。');
      const next: Record<string, unknown> = { ...current };
      if (patch.text !== undefined) next.text = patch.text;
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.errorCode !== undefined) { if (patch.errorCode === null) delete next.errorCode; else next.errorCode = patch.errorCode; }
      if (patch.planDraftId !== undefined) { if (patch.planDraftId === null) delete next.planDraftId; else next.planDraftId = patch.planDraftId; }
      const parsed = chatMessageSchema.safeParse(next);
      if (!parsed.success) throw new ChatStoreError('chat_invalid', '消息更新不符合本机存储格式。');
      const updated = [...messages];
      updated[position] = parsed.data;
      writeMessages(conversationId, updated);
      notify();
      return parsed.data;
    },
    renameConversation(id, title) {
      if (typeof title !== 'string') throw new ChatStoreError('chat_invalid', '标题必须是文本。');
      const { conversations, conversation } = requireConversation(id);
      const parsed = conversationSchema.safeParse({ ...conversation, title: clipTitle(collapse(title), CHAT_LIMITS.titleCodePoints) });
      if (!parsed.success) throw new ChatStoreError('chat_invalid', '标题不符合本机存储格式。');
      writeIndex(conversations.map((entry) => (entry.id === conversation.id ? parsed.data : entry)));
      notify();
      return parsed.data;
    },
    deleteConversation(id) {
      const { conversations, conversation } = requireConversation(id);
      for (const message of readMessages(conversation.id)) locations.delete(message.id);
      // Drop the body first: an interrupted delete leaves an orphan document, never a listed empty conversation.
      backend.removeItem(keyOf(conversation.id));
      writeIndex(conversations.filter((entry) => entry.id !== conversation.id));
      notify();
    },
    deleteAllForSpace() {
      const keys = new Set(readIndex().map((conversation) => keyOf(conversation.id)));
      keys.add(indexKey);
      if (backend.keys) for (const key of backend.keys()) if (key.startsWith(prefix)) keys.add(key);
      for (const key of keys) backend.removeItem(key);
      locations.clear();
      notify();
    },
    getReadReport() {
      return { ...report };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
