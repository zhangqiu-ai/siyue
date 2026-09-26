import { useCallback } from 'react';
import { useLocale } from '../i18n';
import { spaceTranslate, type SpaceMessageKey } from './messages.ts';

/** Feature-local copy. The locale still comes from the app's locale provider. */
export function useSpaceText() {
  const { locale } = useLocale();
  return useCallback((key: SpaceMessageKey, params?: Record<string, string | number>) => spaceTranslate(locale, key, params), [locale]);
}
