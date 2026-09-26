import type { AccountLoginMethod } from '@siyue/contracts';
import type { IconName } from '../ui/icon';
import { fill } from './copy.ts';
import type { AccountText } from './account-messages';

/** Which of the account home's list rows this state can offer. The rows are built from what the client
 *  actually reported, so a value is never guessed: an unread list shows no count, and a row that needs
 *  the network while the session cannot be verified says so instead of opening a page that must fail. */
export type AccountHomeRowKey = 'methods' | 'password' | 'devices' | 'family' | 'space';

export interface AccountHomeRow {
  readonly key: AccountHomeRowKey;
  readonly icon: IconName;
  readonly title: string;
  readonly value: string | null;
  readonly badge: string | null;
  readonly route: string;
  readonly needsNetwork: boolean;
}

export interface AccountHomeInput {
  readonly methods: readonly AccountLoginMethod[] | null;
  readonly deviceCount: number | null;
  readonly pendingFamilies: number | null;
  readonly offline: boolean;
  readonly adult: boolean;
  readonly spaceKind: 'account' | 'local' | null;
  readonly text: AccountText;
}

/** Only Apple is left, so the password row and the email pill have nothing to describe. */
export function isAppleOnly(methods: readonly AccountLoginMethod[] | null): boolean {
  return methods !== null && methods.length > 0 && methods.every(method => method.kind === 'apple');
}

export function maskedEmailOf(methods: readonly AccountLoginMethod[] | null): string | null {
  for (const method of methods ?? []) if (method.kind === 'email_password') return method.emailMask;
  return null;
}

export type AccountPill = { readonly key: 'status' | 'email' | 'apple'; readonly label: string; readonly dot: 'on' | 'off' | null };

export interface AccountIdentity {
  readonly skeleton: boolean;
  readonly avatar: string | null;
  readonly name: string;
  readonly pills: readonly AccountPill[];
}

/** The identity card answers three questions before any action: which account, how it signs in and
 *  whether the session could be verified. A list that could not be read is not shown as a fact. */
export function buildIdentity(input: Omit<AccountHomeInput, 'deviceCount' | 'pendingFamilies' | 'adult' | 'spaceKind'> & { readonly child: boolean }): AccountIdentity {
  const { methods, offline, child, text } = input;
  const status: AccountPill = { key: 'status', label: offline ? text.offline : text.signedIn, dot: offline ? 'off' : 'on' };
  if (methods === null) return { skeleton: true, avatar: null, name: '', pills: [status] };
  const appleOnly = isAppleOnly(methods);
  const masked = maskedEmailOf(methods);
  const pills: AccountPill[] = [status];
  if (!appleOnly) pills.push({ key: 'email', label: text.pillEmail, dot: null });
  if (methods.some(method => method.kind === 'apple')) pills.push({ key: 'apple', label: text.pillApple, dot: null });
  if (masked !== null) return { skeleton: false, avatar: [...masked][0] ?? null, name: masked, pills };
  return { skeleton: false, avatar: null, name: child ? text.childAccount : appleOnly ? text.appleAccount : text.title, pills };
}

/** The rows the account home groups into 登录与安全 / 家庭 / 这台设备. */
export function buildHomeRows(input: AccountHomeInput): readonly AccountHomeRow[] {
  const { methods, deviceCount, pendingFamilies, offline, adult, spaceKind, text } = input;
  const appleOnly = isAppleOnly(methods);
  const rows: AccountHomeRow[] = [{
    key: 'methods', icon: 'mail', title: text.rowMethods,
    value: methods === null ? null : appleOnly ? text.pillApple : text.methodsEmailApple,
    badge: null, route: '/account/methods', needsNetwork: true,
  }];
  if (!appleOnly) rows.push({ key: 'password', icon: 'key', title: text.rowPassword, value: text.rowPasswordValue, badge: null, route: '/account/password', needsNetwork: true });
  rows.push({
    key: 'devices', icon: 'phone', title: text.rowDevices,
    value: offline ? text.needNetwork : deviceCount === null ? null : fill(text.devicesCount, { count: deviceCount }),
    badge: null, route: '/account/devices', needsNetwork: true,
  });
  if (adult) rows.push({
    key: 'family', icon: 'people', title: text.rowFamily,
    value: offline ? text.needNetwork : pendingFamilies === 0 ? text.familyNone : null,
    badge: !offline && pendingFamilies !== null && pendingFamilies > 0 ? fill(text.familyPending, { count: pendingFamilies }) : null,
    route: '/account/family', needsNetwork: true,
  });
  rows.push({
    key: 'space', icon: 'box', title: text.rowSpace,
    value: spaceKind === 'account' ? text.spaceAccount : spaceKind === null ? null : text.spaceOriginal,
    badge: null, route: '/account/space', needsNetwork: false,
  });
  return rows;
}

/** A row that needs the network is offered as a disabled row while the session cannot be verified. */
export function rowBlocked(row:AccountHomeRow, offline:boolean): boolean {
  return offline && row.needsNetwork;
}
