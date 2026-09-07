import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { preferenceNotice, readLocale, saveLocale, translate, type Locale, type MessageKey } from './core';
import { localizedError } from './errors';
export type { Locale, MessageKey } from './core';
interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  preferenceError: string | null;
  errorText: (raw: unknown, fallback?: string) => string;
}
const LocaleContext = createContext<LocaleContextValue | null>(null);
export function LocaleProvider({ children }: React.PropsWithChildren) {
  const [preference, setPreference] = useState(() => readLocale(Storage));
  const setLocale = useCallback((locale: Locale) => setPreference({ locale, failed: !saveLocale(Storage, locale) }), []);
  const value = useMemo<LocaleContextValue>(() => ({
    locale: preference.locale, setLocale,
    t: (key, params) => translate(preference.locale, key, params),
    preferenceError: preferenceNotice(preference.locale, preference.failed),
    errorText: (raw, fallback) => localizedError(preference.locale, raw, fallback),
  }), [preference, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('LocaleProvider is required');
  return value;
}
