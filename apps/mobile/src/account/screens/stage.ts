import type { AuthClientState } from '@siyue/contracts';

/** Which surface the account area shows for one authentication state. It is derived only from the
 *  controller's published state, so every route agrees on whether the account is usable. */
export type AccountStage = 'home' | 'restoring' | 'entry' | 'fatal';

export function accountStage(state: AuthClientState): AccountStage {
  // A password change this device started but could not confirm keeps its locked retry surface even
  // when the session reads as expired: the only honest action is repeating that same request.
  if (state.passwordChangePending === true) return 'home';
  // An unreadable secure store is not an empty account: nothing may be rendered as signed in or out.
  if (state.status === 'secure-storage-unavailable') return 'fatal';
  if (state.account !== null && state.status !== 'reauth-required' && state.status !== 'bootstrapping' && state.status !== 'logging-out') return 'home';
  if (state.status === 'bootstrapping' || state.status === 'authenticating' || state.status === 'logging-out') return 'restoring';
  return 'entry';
}
