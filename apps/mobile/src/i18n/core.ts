import { en, zh } from './messages.ts';
export type Locale = 'zh-CN' | 'en';
export type MessageKey = keyof typeof zh;
export const localeKey = 'siyue.locale';
export interface PreferenceStorage { getItemSync(key: string): string | null; setItemSync(key: string, value: string): void }
export function readLocale(storage: PreferenceStorage): { locale: Locale; failed: boolean } {
  try { return { locale: storage.getItemSync(localeKey) === 'en' ? 'en' : 'zh-CN', failed: false }; }
  catch { return { locale: 'zh-CN', failed: true }; }
}
export function saveLocale(storage: PreferenceStorage, locale: Locale): boolean {
  try { storage.setItemSync(localeKey, locale); return true; } catch { return false; }
}
export function translate(locale: Locale, key: MessageKey, params: Record<string, string | number> = {}): string {
  const message = (locale === 'en' ? en[key] : zh[key]) ?? zh[key];
  return message.replace(/\{(\w+)\}/g, (match, name: string) => params[name] === undefined ? match : typeof params[name] === 'number' ? new Intl.NumberFormat(locale).format(params[name]) : params[name]);
}
export function preferenceNotice(locale: Locale, failed: boolean): string | null {
  return failed ? locale === 'en' ? 'Language applies for this session. Device preferences are unavailable; select your language again to retry saving.' : '语言仅在本次使用中生效。本机偏好存储不可用，请重新选择语言以重试保存。' : null;
}
