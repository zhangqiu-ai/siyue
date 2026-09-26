import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { Appearance, useColorScheme } from 'react-native';
import Storage from 'expo-sqlite/kv-store';

export type ThemeMode = 'light' | 'dark';
const common = {
  layout: { contentWidth: 760 },
  space: { small: 8, medium: 16, large: 24, section: 32 },
  radius: { card: 24, field: 12, group: 20, control: 16 },
};
export const themes = {
  light: { ...common, mode: 'light' as const, color: {
    focus: '#E7EDE5', focusPressed: '#DDE6D9', onFocus: '#25352B', focusMuted: '#506254', focusTrack: '#BBCABB', focusProgress: '#53755D',
    background: '#F7F8F2', surface: '#FFFEFA', ink: '#25352B', muted: '#5D695F',
    accent: '#476B53', accentPressed: '#395A44', onAccent: '#FFFFFF', subtle: '#EDF0E8', border: '#D4DCD0', controlBorder: '#7A8C7C',
    progress: '#53755D', progressTrack: '#BBCABB', selectedBorder: '#53755D', error: '#A33E32',
    errorSurface: '#F7E9E5', warn: '#7A5B12', warnSurface: '#F4EEDC', apple: '#000000', onApple: '#FFFFFF',
  } },
  dark: { ...common, mode: 'dark' as const, color: {
    focus: '#28372D', focusPressed: '#334738', onFocus: '#F0F3E9', focusMuted: '#BCCBBB', focusTrack: '#4B5E4E', focusProgress: '#B7CDB8',
    background: '#151C17', surface: '#202A23', ink: '#F0F3E9', muted: '#B3C0B2',
    accent: '#B7CDB8', accentPressed: '#A3BDA6', onAccent: '#203326', subtle: '#2D3930', border: '#435346', controlBorder: '#839887',
    progress: '#B7CDB8', progressTrack: '#4B5E4E', selectedBorder: '#B7CDB8', error: '#F1A99D',
    errorSurface: '#3A2724', warn: '#E8CF8E', warnSurface: '#38321F', apple: '#FFFFFF', onApple: '#000000',
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
