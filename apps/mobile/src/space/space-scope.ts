import type { WorkspaceState } from '@siyue/adapters';
import type { SpaceMessageKey } from './messages.ts';

/** What the space screens may truthfully say about the open workspace.
 * The workspace exposes a scope and a readiness status only: there is no sync state,
 * no pending-change count, no offline lease and no read-only permission for this client.
 * Everything shown here is derived from those two facts and nothing is invented. */
export interface SpaceView {
  readonly kind: 'local' | 'account';
  readonly labelKey: SpaceMessageKey;
  readonly syncKey: SpaceMessageKey;
}

export function spaceView(state: WorkspaceState): SpaceView | null {
  const scope = state.scope;
  if (!scope) return null;
  return scope.kind === 'account'
    ? { kind: 'account', labelKey: 'scope.account', syncKey: 'sync.account' }
    : { kind: 'local', labelKey: 'scope.local', syncKey: 'sync.local' };
}
