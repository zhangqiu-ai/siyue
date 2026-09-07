import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { en, zh, type MessageKey } from './messages';
export type { MessageKey } from './messages';
export type Locale = 'zh-CN' | 'en';
export const resolveLocale = (value: unknown): Locale => value === 'en' ? 'en' : 'zh-CN';
export function translate(locale: Locale, key: MessageKey, params: Record<string, string> = {}) {
  return (locale === 'en' ? en[key] ?? zh[key] : zh[key]).replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`);
}
function readPreference() {
  try { return { locale: resolveLocale(localStorage.getItem('siyue.locale')), failed: false }; }
  catch { return { locale: 'zh-CN' as const, failed: true }; }
}
const LocaleContext = createContext<null | { locale: Locale; setLocale: (locale: Locale) => void; failed: boolean; t: typeof translator; number: (value: number) => string }>(null);
const translator = (key: MessageKey, params?: Record<string, string>) => translate('zh-CN', key, params);
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState(readPreference);
  const { locale, failed } = preference;
  useEffect(() => { document.documentElement.lang = locale; document.title = translate(locale, 'brand'); }, [locale]);
  function setLocale(next: Locale) {
    let failed = false;
    try { localStorage.setItem('siyue.locale', next); } catch { failed = true; }
    setPreference({ locale: next, failed });
  }
  return <LocaleContext.Provider value={{ locale, setLocale, failed, t: (key, params) => translate(locale, key, params), number: (value) => new Intl.NumberFormat(locale).format(value) }}>{children}</LocaleContext.Provider>;
}
export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('LocaleProvider is required');
  return value;
}
