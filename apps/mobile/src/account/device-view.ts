import type { AccountDeviceSession } from '@siyue/contracts';
import type { IconName } from '../ui/icon';
import { fill } from './copy';
import type { AccountText } from './account-messages';

/** Only the platform the server reported decides the icon; a session that reported none keeps the
 *  generic device glyph instead of guessing what hardware it runs on. */
export function deviceIcon(platform: AccountDeviceSession['platform']): IconName {
  return platform === 'desktop' ? 'desktop' : 'phone';
}

export function deviceName(device: AccountDeviceSession, text: AccountText): string {
  const label = device.deviceLabel?.trim() ?? '';
  return label.length > 0 ? label : text.unnamedDevice;
}

export function authMethodLabel(method: AccountDeviceSession['authMethod'], text: AccountText): string {
  if (method === 'apple') return text.pillApple;
  if (method === 'child') return text.methodChild;
  return text.methodEmail;
}

/** How long ago the server last saw this session, in the same shaped wording the approved design uses. */
export function activeAgo(lastSeenAt: string, now: number, text: AccountText): string {
  const seen = Date.parse(lastSeenAt);
  const elapsed = Number.isFinite(seen) ? Math.max(0, now - seen) : 0;
  if (elapsed < 3600_000) return fill(text.minutesAgo, { count: Math.max(1, Math.round(elapsed / 60_000)) });
  if (elapsed < 86_400_000) return fill(text.hoursAgo, { count: Math.round(elapsed / 3_600_000) });
  return fill(text.daysAgo, { count: Math.round(elapsed / 86_400_000) });
}

/** The one line under a device name: this device, or when it was last active plus how it signs in. */
export function deviceDetail(device: AccountDeviceSession, now: number, text: AccountText): string {
  const method = authMethodLabel(device.authMethod, text);
  return device.current ? `${text.thisDevice} · ${method}` : `${fill(text.activeAgo, { value: activeAgo(device.lastSeenAt, now, text) })} · ${method}`;
}

/** Revoking another device needs a proof this device can produce here: the current password, or a fresh
 *  Apple authorization. An Apple-only account has no password to offer, which is a stated limitation,
 *  not a form the caller can never complete. */
export function canVerifyHere(methodsAreAppleOnly: boolean, appleAvailable: boolean): boolean {
  return !methodsAreAppleOnly || appleAvailable;
}
