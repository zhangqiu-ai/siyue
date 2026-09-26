import test from 'node:test';
import assert from 'node:assert/strict';
import { chatMessageSchema, conversationSchema } from '@siyue/contracts';
import {
  CHAT_LIMITS,
  ChatStoreError,
  chatStoragePrefix,
  createChatStore,
  equalConversations,
  equalMessages,
} from '../src/chat/chat-store.ts';

const START = Date.parse('2026-09-25T00:00:00.000Z');
const uuid = (value) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const iso = (offset = 0) => new Date(START + offset * 1000).toISOString();
const accountSpace = `production.${uuid(0xabcdef)}`;
const localPrefix = 'siyue.chat.v1.local.';

function memoryBackend(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    keys: () => [...values.keys()],
  };
}

function openStore(backend = memoryBackend(), spaceId = 'local') {
  let nextId = 0;
  let nextInstant = 0;
  return {
    backend,
    store: createChatStore(backend, spaceId, { newId: () => uuid(++nextId), now: () => iso(++nextInstant) }),
  };
}

const message = (conversationId, overrides = {}) => ({
  id: uuid(1), conversationId, role: 'user', text: '你好', status: 'complete', createdAt: iso(1), ...overrides,
});
const rejects = (run, code) => assert.throws(run, (error) => error instanceof ChatStoreError && error.code === code);
const conversationKey = (id) => `${localPrefix}conversation.${id}`;
const seedConversations = (count, spaceId = 'local') => Array.from({ length: count }, (_, index) => ({
  id: uuid(index + 1), spaceId, title: `对话 ${index}`, createdAt: iso(index), updatedAt: iso(index),
}));
const seedMessages = (conversationId, count) => Array.from({ length: count }, (_, index) => ({
  id: uuid(0x100000 + index), conversationId, role: 'user', text: `第 ${index} 条`, status: 'complete', createdAt: iso(index),
}));
const storedMessages = (backend, id) => JSON.parse(backend.values.get(conversationKey(id))).messages;

test('created conversation takes 24 code points of the first message and stores the space identity', () => {
  const { backend, store } = openStore();
  const text = Array.from({ length: 30 }, (_, index) => String.fromCodePoint(0x1f600 + index)).join('');
  const conversation = store.createConversation(`  ${text}  `);
  assert.equal(Array.from(conversation.title).length, CHAT_LIMITS.createdTitleCodePoints);
  assert.equal(conversation.title, Array.from(text).slice(0, 24).join(''));
  assert.equal(conversation.spaceId, 'local');
  assert.equal(conversation.createdAt, conversation.updatedAt);
  const [persisted] = JSON.parse(backend.values.get(`${localPrefix}index`)).conversations;
  assert.equal(conversationSchema.safeParse(persisted).success, true);
  assert.deepEqual(persisted, conversation);
  const multiline = ['  多行', '   标题', '文本  '].join('\n');
  assert.equal(store.createConversation(multiline).title, '多行 标题 文本');
});

test('messages keep append order, survive restart and only newer messages move the activity time', () => {
  const { backend, store } = openStore();
  const conversation = store.createConversation('第一个问题');
  store.appendMessage(message(conversation.id, { id: uuid(0x11), text: '第一条', createdAt: iso(5) }));
  store.appendMessage(message(conversation.id, { id: uuid(0x12), role: 'assistant', text: '回复', createdAt: iso(6) }));
  // An older timestamp must never move the conversation backwards in the list.
  store.appendMessage(message(conversation.id, { id: uuid(0x13), text: '更早的一条', createdAt: iso(1) }));
  const restarted = openStore(backend).store;
  assert.deepEqual(restarted.getMessages(conversation.id).map((entry) => [entry.id, entry.text]), [
    [uuid(0x11), '第一条'], [uuid(0x12), '回复'], [uuid(0x13), '更早的一条'],
  ]);
  assert.equal(restarted.listConversations()[0].updatedAt, iso(6));
  assert.equal(restarted.getMessages(conversation.id).every((entry) => chatMessageSchema.safeParse(entry).success), true);
  assert.deepEqual(restarted.getMessages(uuid(0x999)), []);
});

test('the conversation list is newest first', () => {
  const { store } = openStore();
  const first = store.createConversation('A');
  const second = store.createConversation('B');
  const third = store.createConversation('C');
  store.appendMessage(message(second.id, { id: uuid(0x21), createdAt: iso(90) }));
  assert.deepEqual(store.listConversations().map((entry) => entry.id), [second.id, third.id, first.id]);
});

test('each space reads and writes its own keys', () => {
  const backend = memoryBackend();
  const local = openStore(backend, 'local').store;
  const account = openStore(backend, accountSpace).store;
  const localChat = local.createConversation('本机');
  account.createConversation('账号');
  assert.equal(local.listConversations().length, 1);
  assert.equal(account.listConversations().length, 1);
  assert.equal(local.listConversations()[0].spaceId, 'local');
  assert.equal(account.listConversations()[0].spaceId, accountSpace);
  assert.equal(chatStoragePrefix('local'), localPrefix);
  assert.equal(chatStoragePrefix(accountSpace), `siyue.account.${uuid(0xabcdef)}.chat.v1.`);
  // The account prefix follows the board namespace rule and does not depend on the environment name.
  assert.equal(chatStoragePrefix(`development.${uuid(0xabcdef)}`), chatStoragePrefix(accountSpace));
  // A row copied under another space's prefix is corrupt there and never surfaces.
  backend.setItem(`siyue.account.${uuid(0xabcdef)}.chat.v1.index`, JSON.stringify({ version: 1, conversations: [localChat] }));
  assert.deepEqual(account.listConversations(), []);
  assert.deepEqual(account.getReadReport(), { skippedConversations: 1, skippedMessages: 0 });
  for (const invalid of ['', 'has space', 'x'.repeat(201), 'a/b']) rejects(() => chatStoragePrefix(invalid), 'chat_invalid');
});

test('capacity refusals keep the stored data intact', () => {
  const backend = memoryBackend();
  const conversations = seedConversations(CHAT_LIMITS.conversations);
  backend.setItem(`${localPrefix}index`, JSON.stringify({ version: 1, conversations }));
  const { store } = openStore(backend);
  rejects(() => store.createConversation('再来一段对话'), 'chat_capacity');
  assert.equal(JSON.parse(backend.values.get(`${localPrefix}index`)).conversations.length, CHAT_LIMITS.conversations);
  const target = conversations[0];
  backend.setItem(conversationKey(target.id), JSON.stringify({ version: 1, messages: seedMessages(target.id, CHAT_LIMITS.messages) }));
  rejects(() => store.appendMessage(message(target.id, { id: uuid(0x500000) })), 'chat_capacity');
  assert.equal(storedMessages(backend, target.id).length, CHAT_LIMITS.messages);
  assert.equal(store.getMessages(target.id).length, CHAT_LIMITS.messages);
});

test('corrupt rows are skipped and counted instead of crashing', () => {
  const backend = memoryBackend();
  const valid = seedConversations(1)[0];
  backend.setItem(`${localPrefix}index`, JSON.stringify({
    version: 1,
    conversations: [
      valid,
      { ...valid, id: 'not-a-uuid' },
      { ...valid, id: uuid(0x31), spaceId: 'other-space' },
      { ...valid, id: uuid(0x32), title: 'x'.repeat(81) },
      { ...valid, id: uuid(0x33), unread: 2 },
      'garbage',
      { ...valid, id: uuid(0x34), updatedAt: iso(400) },
      { ...valid, id: uuid(0x34), updatedAt: iso(300) },
    ],
  }));
  const { store } = openStore(backend);
  assert.deepEqual(store.listConversations().map((entry) => entry.id), [uuid(0x34), valid.id]);
  assert.equal(store.listConversations()[0].updatedAt, iso(400));
  assert.deepEqual(store.getReadReport(), { skippedConversations: 6, skippedMessages: 0 });
  backend.setItem(conversationKey(valid.id), JSON.stringify({
    version: 1,
    messages: [
      message(valid.id, { id: uuid(0x42) }),
      message(uuid(0x99), { id: uuid(0x43) }),
      message(valid.id, { id: uuid(0x44), role: 'system' }),
      message(valid.id, { id: uuid(0x45), extra: true }),
      null,
    ],
  }));
  assert.deepEqual(store.getMessages(valid.id).map((entry) => entry.id), [uuid(0x42)]);
  assert.deepEqual(store.getReadReport(), { skippedConversations: 6, skippedMessages: 4 });
});

test('an unreadable document reads as empty and is reported', () => {
  const backend = memoryBackend({ [`${localPrefix}index`]: '{ dropped', [conversationKey('x')]: '[]' });
  const { store } = openStore(backend);
  assert.deepEqual(store.listConversations(), []);
  assert.deepEqual(store.getMessages('x'), []);
  assert.deepEqual(store.getReadReport(), { skippedConversations: 2, skippedMessages: 0 });
  // Repeated reads report the same damaged rows once each.
  store.listConversations();
  store.getMessages('x');
  assert.deepEqual(store.getReadReport(), { skippedConversations: 2, skippedMessages: 0 });
});

test('a reply left streaming by a killed app loads as stopped', () => {
  const { backend, store } = openStore();
  const conversation = store.createConversation('继续上次的回复');
  store.appendMessage(message(conversation.id, { id: uuid(0x51), role: 'assistant', text: '已生成一半', status: 'streaming' }));
  const restarted = openStore(backend).store;
  const [loaded] = restarted.getMessages(conversation.id);
  assert.equal(loaded.status, 'stopped');
  assert.equal(loaded.text, '已生成一半');
  // The read normalizes in memory only; the next write persists the stopped state.
  assert.equal(storedMessages(backend, conversation.id)[0].status, 'streaming');
  restarted.appendMessage(message(conversation.id, { id: uuid(0x52), createdAt: iso(9) }));
  assert.deepEqual(storedMessages(backend, conversation.id).map((entry) => entry.status), ['stopped', 'complete']);
});

test('message writes validate the contract, reject duplicates and unknown conversations', () => {
  const backend = memoryBackend();
  const { store } = openStore(backend);
  const conversation = store.createConversation('写入校验');
  for (const invalid of [
    { unknown: true },
    message(conversation.id, { id: uuid(0x61), role: 'system' }),
    message(conversation.id, { id: uuid(0x62), status: 'pending' }),
    message(conversation.id, { id: uuid(0x63), text: 'x'.repeat(60001) }),
    message(conversation.id, { id: uuid(0x64), errorCode: 'x'.repeat(65) }),
    message(conversation.id, { id: uuid(0x65), planDraftId: 'x'.repeat(201) }),
    message(conversation.id, { id: 'not-a-uuid' }),
    message(conversation.id, { id: uuid(0x66), createdAt: 'yesterday' }),
  ]) rejects(() => store.appendMessage(invalid), 'chat_invalid');
  rejects(() => store.appendMessage(message(uuid(0x777))), 'chat_not_found');
  store.appendMessage(message(conversation.id, { id: uuid(0x67) }));
  rejects(() => store.appendMessage(message(conversation.id, { id: uuid(0x67) })), 'chat_invalid');
  assert.equal(store.getMessages(conversation.id).length, 1);
  // Optional fields are absent from storage rather than written as undefined.
  assert.deepEqual(Object.keys(storedMessages(backend, conversation.id)[0]).sort(), ['conversationId', 'createdAt', 'id', 'role', 'status', 'text']);
});

test('message updates patch text, status, error and plan draft, and can clear optional fields', () => {
  const backend = memoryBackend();
  const { store } = openStore(backend);
  const other = store.createConversation('另一段对话');
  const conversation = store.createConversation('正在生成');
  const assistant = message(conversation.id, { id: uuid(0x71), role: 'assistant', text: '', status: 'streaming' });
  store.appendMessage(assistant);
  const activity = store.listConversations().map((entry) => [entry.id, entry.updatedAt]);
  assert.equal(store.updateMessage(assistant.id, { text: '完整回复', status: 'complete', planDraftId: 'draft-1' }).text, '完整回复');
  const failed = store.updateMessage(assistant.id, { status: 'failed', errorCode: 'network' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'network');
  assert.equal(failed.planDraftId, 'draft-1');
  const cleared = store.updateMessage(assistant.id, { errorCode: null, planDraftId: null, status: 'stopped' });
  assert.equal('errorCode' in cleared, false);
  assert.equal('planDraftId' in cleared, false);
  // Updating a message is not new conversation activity.
  assert.deepEqual(store.listConversations().map((entry) => [entry.id, entry.updatedAt]), activity);
  assert.equal(store.getMessages(other.id).length, 0);
  for (const patch of [{ text: 'x'.repeat(60001) }, { status: 'pending' }, { errorCode: 'x'.repeat(65) }, { planDraftId: 'x'.repeat(201) }]) {
    rejects(() => store.updateMessage(assistant.id, patch), 'chat_invalid');
  }
  rejects(() => store.updateMessage(uuid(0x999), { text: '无此消息' }), 'chat_not_found');
  // A cold store finds the message without having read its conversation first.
  const cold = openStore(backend).store;
  assert.equal(cold.updateMessage(assistant.id, { status: 'complete' }).status, 'complete');
  assert.equal(cold.getMessages(conversation.id)[0].text, '完整回复');
});

test('renaming trims, clips the title and keeps the activity time', () => {
  const { store } = openStore();
  const conversation = store.createConversation('原始标题');
  store.appendMessage(message(conversation.id, { id: uuid(0x81), createdAt: iso(30) }));
  const renamed = store.renameConversation(conversation.id, `  ${'标'.repeat(120)}  `);
  assert.equal(Array.from(renamed.title).length, CHAT_LIMITS.titleCodePoints);
  assert.equal(renamed.updatedAt, iso(30));
  assert.equal(store.listConversations()[0].title, renamed.title);
  // The contract caps titles in UTF-16 units as well, so wide characters clip sooner.
  assert.equal(Array.from(store.renameConversation(conversation.id, '😀'.repeat(60)).title).length, 40);
  assert.equal(store.renameConversation(conversation.id, '   ').title, '');
  rejects(() => store.renameConversation(conversation.id, 42), 'chat_invalid');
  rejects(() => store.renameConversation(uuid(0x999), 'x'), 'chat_not_found');
});

test('deleting a conversation removes its index row and body', () => {
  const backend = memoryBackend();
  const { store } = openStore(backend);
  const kept = store.createConversation('保留');
  const dropped = store.createConversation('删除');
  store.appendMessage(message(dropped.id, { id: uuid(0x91) }));
  store.deleteConversation(dropped.id);
  assert.deepEqual(store.listConversations().map((entry) => entry.id), [kept.id]);
  assert.equal(backend.values.has(conversationKey(dropped.id)), false);
  assert.deepEqual(store.getMessages(dropped.id), []);
  rejects(() => store.deleteConversation(dropped.id), 'chat_not_found');
});

test('deleting a space erases only that space, even when its index is unreadable', () => {
  const backend = memoryBackend({ 'local-whiteboard': '{}' });
  const { store } = openStore(backend);
  const kept = store.createConversation('保留');
  const dropped = store.createConversation('删除');
  store.appendMessage(message(dropped.id, { id: uuid(0xa1) }));
  const account = openStore(backend, accountSpace).store;
  account.createConversation('账号空间');
  store.deleteAllForSpace();
  assert.deepEqual(store.listConversations(), []);
  assert.equal(backend.values.has('local-whiteboard'), true);
  assert.equal(backend.values.has(conversationKey(kept.id)), false);
  assert.equal(backend.values.has(conversationKey(dropped.id)), false);
  assert.equal(account.listConversations().length, 1);
  // A corrupt index with a leftover body is still erased when the backend can list keys.
  backend.setItem(`${localPrefix}index`, '{ dropped');
  backend.setItem(conversationKey('orphan'), '{}');
  store.deleteAllForSpace();
  assert.equal([...backend.values.keys()].some((key) => key.startsWith(localPrefix)), false);
  assert.equal(account.listConversations().length, 1);
  // Without key listing, an unreadable index can only clear the index itself.
  const blind = memoryBackend({ [`${localPrefix}index`]: '{ dropped', [conversationKey('orphan')]: '{}' });
  delete blind.keys;
  createChatStore(blind, 'local').deleteAllForSpace();
  assert.equal(blind.values.has(`${localPrefix}index`), false);
  assert.equal(blind.values.has(conversationKey('orphan')), true);
});

test('subscribers hear each change once and stop after unsubscribing', () => {
  const { store } = openStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  const conversation = store.createConversation('订阅');
  assert.equal(notifications, 1);
  const entry = message(conversation.id, { id: uuid(0xb1) });
  store.appendMessage(entry);
  assert.equal(notifications, 2);
  store.updateMessage(entry.id, { status: 'complete' });
  store.renameConversation(conversation.id, '新标题');
  assert.equal(notifications, 4);
  store.deleteConversation(conversation.id);
  store.deleteAllForSpace();
  assert.equal(notifications, 6);
  store.listConversations();
  store.getMessages(uuid(0x999));
  assert.equal(notifications, 6);
  unsubscribe();
  store.createConversation('之后');
  assert.equal(notifications, 6);
});

test('snapshot comparison reports only real changes', () => {
  const { store } = openStore();
  const conversation = store.createConversation('比较');
  const empty = store.getMessages(conversation.id);
  const entry = message(conversation.id, { id: uuid(0xc1) });
  store.appendMessage(entry);
  const withMessage = store.getMessages(conversation.id);
  assert.equal(equalConversations(store.listConversations(), store.listConversations()), true);
  assert.equal(equalConversations(store.listConversations(), []), false);
  assert.equal(equalMessages(withMessage, store.getMessages(conversation.id)), true);
  assert.equal(equalMessages(withMessage, empty), false);
  assert.equal(equalMessages(withMessage, [...withMessage, entry]), false);
  store.updateMessage(entry.id, { text: '改' });
  assert.equal(equalMessages(withMessage, store.getMessages(conversation.id)), false);
});
