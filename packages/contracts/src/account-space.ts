import {z} from 'zod';
import {authEnvironmentSchema} from './auth-client.js';

/** Local ownership metadata, never a server permission or a file path supplied by a renderer. */
export const accountSpaceBindingSchema=z.object({
  schemaVersion:z.literal(1),environment:authEnvironmentSchema,subjectId:z.uuid(),
  namespace:z.uuid(),spaceId:z.uuid(),
}).strict();
export type AccountSpaceBinding=z.infer<typeof accountSpaceBindingSchema>;
export const workspaceStateSchema=z.object({revision:z.number().int().nonnegative(),status:z.enum(['loading','ready','unavailable']),
  scope:z.union([z.object({kind:z.literal('local')}).strict(),accountSpaceBindingSchema.extend({kind:z.literal('account')})]).nullable(),canCreate:z.boolean()}).strict();
