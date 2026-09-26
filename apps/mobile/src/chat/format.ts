// Chat list and message formatting. Framework-free so the rules stay unit-testable.
import { translate, type Locale, type MessageKey } from '../i18n/core.ts';
import { zh } from '../i18n/messages.ts';
import { findProvider } from '../settings/providers.ts';

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** Relative time for the recent list. A timestamp ahead of the clock reads as "now". */
export function relativeTime(iso: string, nowMs: number, t: Translate, locale: Locale = 'zh-CN'): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const elapsed = nowMs - at;
  if (elapsed < minute) return t('chat.timeNow');
  if (elapsed < hour) return t('chat.timeMinutes', { count: Math.floor(elapsed / minute) });
  if (elapsed < day) return t('chat.timeHours', { count: Math.floor(elapsed / hour) });
  if (elapsed < 7 * day) return t('chat.timeDays', { count: Math.floor(elapsed / day) });
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(at));
}

/** What a message is sent to, named without exposing credentials in the endpoint. */
export function replyScopeLabel(baseUrl: string, t: Translate): string | null {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return null;
  }
  const preset = findProvider(baseUrl);
  const key = preset ? `provider.${preset.id}.name` : '';
  const name = key && Object.hasOwn(zh, key) ? t(key as MessageKey) : host;
  return `${name} · ${t('chat.disclaimer')}`;
}

export const chatTranslate = (locale: Locale): Translate => (key, params) => translate(locale, key, params);
