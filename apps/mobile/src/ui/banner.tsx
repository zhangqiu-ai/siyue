import { StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { AppIcon, type IconName } from './icon';
import { useTheme, type Theme } from './theme';

type BannerKind = 'info' | 'warn' | 'error';

export function Banner({ kind, title, body, action }: { kind: BannerKind; title?: string; body?: string; action?: ReactNode }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const looks: Record<BannerKind, { icon: IconName; background: string; foreground: string; iconColor: string }> = {
    info: { icon: 'info', background: theme.color.focus, foreground: theme.color.onFocus, iconColor: theme.color.onFocus },
    warn: { icon: 'warning', background: theme.color.warnSurface, foreground: theme.color.ink, iconColor: theme.color.warn },
    error: { icon: 'warning', background: theme.color.errorSurface, foreground: theme.color.ink, iconColor: theme.color.error },
  };
  const look = looks[kind];
  return <View
    accessibilityRole={kind === 'error' ? 'alert' : undefined}
    accessibilityLiveRegion={kind === 'error' ? undefined : 'polite'}
    style={[styles.banner, { backgroundColor: look.background }]}
  >
    <AppIcon name={look.icon} size={20} color={look.iconColor} />
    <View style={styles.main}>
      {title ? <Text style={[styles.title, { color: look.foreground }]}>{title}</Text> : null}
      {body ? <Text style={[styles.body, { color: look.foreground }]}>{body}</Text> : null}
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  </View>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: theme.radius.control, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 16 },
  main: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, lineHeight: 20, fontWeight: '600', marginBottom: 2 },
  body: { fontSize: 14, lineHeight: 20 },
  action: { marginTop: 10 },
});
