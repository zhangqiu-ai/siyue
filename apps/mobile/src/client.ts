import {configuredClient} from './account/workspace-runtime';
import type { LocalClient } from '@siyue/adapters';
import { createNativeClient } from './native-client';

let current: Promise<LocalClient> | undefined;
export function getClient(): Promise<LocalClient> {
  const workspace=configuredClient();
  if(workspace)return workspace;
  current ??= createNativeClient().catch((error: unknown) => {
    current = undefined;
    throw error;
  });
  return current;
}
