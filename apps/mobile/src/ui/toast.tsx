import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppIcon } from './icon';
import { useTheme, type Theme } from './theme';

const visibleMs = 2200;
type ToastValue = { show: (message: string) => void };
const ToastContext = createContext<ToastValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(theme, insets.top);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const value = useMemo<ToastValue>(() => ({
    show: (next: string) => {
      if (timer.current) clearTimeout(timer.current);
      setMessage(next);
      timer.current = setTimeout(() => { timer.current = null; setMessage(null); }, visibleMs);
      AccessibilityInfo.announceForAccessibility(next);
    },
  }), []);
  return <ToastContext.Provider value={value}>
    {children}
    {message ? <View pointerEvents="none" style={styles.layer}>
      <View accessibilityLiveRegion="polite" style={styles.pill}>
        <AppIcon name="check" size={18} color={theme.color.background} />
        <Text style={styles.text}>{message}</Text>
      </View>
    </View> : null}
  </ToastContext.Provider>;
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error('Toast requires ToastProvider');
  return value;
}

const makeStyles = (theme: Theme, top: number) => StyleSheet.create({
  layer: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', zIndex: 60 },
  pill: { marginTop: top + 12, maxWidth: '92%', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: theme.color.ink, borderRadius: 99, paddingHorizontal: 16, paddingVertical: 10 },
  text: { flexShrink: 1, color: theme.color.background, fontSize: 14, lineHeight: 20, fontWeight: '500' },
});
