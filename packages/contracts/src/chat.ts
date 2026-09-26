import { z } from 'zod';

const spaceId = z.string().min(1).max(200);
const instant = z.string().datetime();

/** One persisted conversation, scoped to the space that owns it. Title may be empty until a first message arrives. */
export const conversationSchema = z.object({
  id: z.uuid(),
  spaceId,
  title: z.string().min(0).max(80),
  createdAt: instant,
  updatedAt: instant,
}).strict();

/**
 * One persisted message. `planDraftId` is the id of an ActionDraft rendered as a plan card,
 * never an approved or applied change; `errorCode` describes a `failed` reply.
 */
export const chatMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  role: z.enum(['user', 'assistant']),
  text: z.string().max(60000),
  status: z.enum(['complete', 'streaming', 'stopped', 'failed']),
  errorCode: z.string().max(64).optional(),
  planDraftId: z.string().max(200).optional(),
  createdAt: instant,
}).strict();

export type Conversation = z.infer<typeof conversationSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
