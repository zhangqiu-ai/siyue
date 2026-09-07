import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { Appearance, useColorScheme } from 'react-native';
import Storage from 'expo-sqlite/kv-store';

export type ThemeMode = 'light' | 'dark';
const common = {
  layout: { contentWidth: 760 },
  space: { small: 8, medium: 16, large: 24, section: 32 },
  radius: { card: 24, field: 12 },
};
export const themes = {
  light: { ...common, mode: 'light' as const, color: {
    background: '#FAFAFA', surface: '#FFFFFF', ink: '#171717', muted: '#666666',
    accent: '#171717', accentPressed: '#333333', onAccent: '#FFFFFF', subtle: '#EEEEEE', border: '#D9D9D9', controlBorder: '#858585',
  } },
  dark: { ...common, mode: 'dark' as const, color: {
    background: '#101010', surface: '#1C1C1C', ink: '#F5F5F5', muted: '#A6A6A6',
    accent: '#F5F5F5', accentPressed: '#D4D4D4', onAccent: '#171717', subtle: '#292929', border: '#404040', controlBorder: '#777777',
  } },
};
export type Theme = typeof themes[ThemeMode];
const preferenceKey = 'siyue.appearance';
const ThemeContext = createContext<{ mode: ThemeMode; setMode: (mode: ThemeMode) => void } | null>(null);

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [mode, updateMode] = useState<ThemeMode>(() => {
    try {
      const saved = Storage.getItemSync(preferenceKey);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch { /* Appearance remains usable when preference storage is unavailable. */ }
    return Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
  });
  useEffect(() => { Appearance.setColorScheme(mode); }, [mode]);
  const setMode = (next: ThemeMode) => {
    updateMode(next);
    try { Storage.setItemSync(preferenceKey, next); } catch { /* Keep the in-session selection. */ }
  };
  return createElement(ThemeContext.Provider, { value: { mode, setMode } }, children);
}

export function useTheme() {
  const preference = useContext(ThemeContext);
  const system = useColorScheme();
  return themes[preference?.mode ?? (system === 'dark' ? 'dark' : 'light')];
}

export function useThemePreference() {
  const preference = useContext(ThemeContext);
  if (!preference) throw new Error('Theme selection requires AppThemeProvider');
  return preference;
}
