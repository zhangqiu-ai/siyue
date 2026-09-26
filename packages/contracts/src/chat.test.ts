import assert from 'node:assert/strict';
import test from 'node:test';
import { chatMessageSchema, conversationSchema } from './index.js';

const conversationId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const repeat = (length: number) => 'a'.repeat(length);

const conversation = () => ({
  id: conversationId,
  spaceId: 'local-personal',
  title: '家庭英语计划',
  createdAt: '2026-09-25T02:00:00.000Z',
  updatedAt: '2026-09-25T02:06:00.000Z',
});

const message = () => ({
  id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
  conversationId,
  role: 'assistant' as const,
  text: '先确认目标，再安排每周任务',
  status: 'complete' as const,
  createdAt: '2026-09-25T02:00:01.000Z',
});

test('a conversation and a message keep the documented persisted fields', () => {
  assert.deepEqual(conversationSchema.parse(conversation()), conversation());
  assert.deepEqual(chatMessageSchema.parse(message()), message());
});

test('an empty title and an empty reply text remain valid records', () => {
  assert.equal(conversationSchema.safeParse({...conversation(), title: ''}).success, true);
  assert.equal(chatMessageSchema.safeParse({...message(), text: ''}).success, true);
});

for (const role of ['user', 'assistant'] as const)
  test(`a message accepts the ${role} role`, () => {
    assert.equal(chatMessageSchema.safeParse({...message(), role}).success, true);
  });

for (const status of ['complete', 'streaming', 'stopped', 'failed'] as const)
  test(`a message accepts the ${status} status`, () => {
    assert.equal(chatMessageSchema.safeParse({...message(), status}).success, true);
  });

for (const [label, value] of [
  ['a value that is not a uuid', {...conversation(), id: 'conversation-a'}],
  ['an empty space id', {...conversation(), spaceId: ''}],
  ['a space id longer than 200 characters', {...conversation(), spaceId: repeat(201)}],
  ['a title longer than 80 characters', {...conversation(), title: repeat(81)}],
  ['a createdAt that is not an ISO instant', {...conversation(), createdAt: '2026-09-25 02:00'}],
  ['a date-only createdAt', {...conversation(), createdAt: '2026-09-25'}],
  ['a non-string updatedAt', {...conversation(), updatedAt: 1758770000000}],
  ['an unknown extra key', {...conversation(), unreadCount: 3}],
] as const)
  test(`a conversation rejects ${label}`, () => {
    assert.equal(conversationSchema.safeParse(value).success, false);
  });

for (const [label, value] of [
  ['a value that is not a uuid', {...message(), id: 'message-a'}],
  ['a conversation id that is not a uuid', {...message(), conversationId: 'conversation-a'}],
  ['an unknown role', {...message(), role: 'system'}],
  ['an unknown status', {...message(), status: 'pending'}],
  ['text longer than 60000 characters', {...message(), text: repeat(60001)}],
  ['an error code longer than 64 characters', {...message(), errorCode: repeat(65)}],
  ['a plan draft id longer than 200 characters', {...message(), planDraftId: repeat(201)}],
  ['a createdAt that is not an ISO instant', {...message(), createdAt: 'yesterday'}],
  ['an unknown extra key', {...message(), draftId: 'draft-a'}],
] as const)
  test(`a message rejects ${label}`, () => {
    assert.equal(chatMessageSchema.safeParse(value).success, false);
  });

test('documented length limits accept their maximum', () => {
  assert.equal(conversationSchema.safeParse({...conversation(), spaceId: repeat(200)}).success, true);
  assert.equal(conversationSchema.safeParse({...conversation(), title: repeat(80)}).success, true);
  assert.equal(chatMessageSchema.safeParse({...message(), text: repeat(60000)}).success, true);
  assert.equal(chatMessageSchema.safeParse({...message(), errorCode: repeat(64)}).success, true);
  assert.equal(chatMessageSchema.safeParse({...message(), planDraftId: repeat(200)}).success, true);
});

test('a message reports plan and error references only when they are supplied', () => {
  const plain = chatMessageSchema.parse(message());
  assert.deepEqual(Object.keys(plain), ['id', 'conversationId', 'role', 'text', 'status', 'createdAt']);
  assert.equal('errorCode' in plain, false);
  assert.equal('planDraftId' in plain, false);

  const referenced = chatMessageSchema.parse({...message(), status: 'failed', errorCode: 'ai_unavailable', planDraftId: 'draft-a'});
  assert.equal(referenced.errorCode, 'ai_unavailable');
  assert.equal(referenced.planDraftId, 'draft-a');
  const stopped = chatMessageSchema.parse({...message(), status: 'stopped'});
  assert.equal('errorCode' in stopped, false);
});
