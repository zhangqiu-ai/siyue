import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppIcon, type IconName } from '../../ui';
import { useTheme, type Theme } from '../../ui/theme';

/** Icon-only control with a 44pt target, matching the prototype's round nav button. */
export function IconButton({ name, label, onPress, disabled = false, tone = 'surface', testID }: {
  name: IconName; label: string; onPress: () => void; disabled?: boolean; tone?: 'surface' | 'plain'; testID?: string;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    disabled={disabled}
    testID={testID}
    onPress={onPress}
    style={({ pressed }) => [styles.iconButton, tone === 'surface' && styles.iconSurface, pressed && !disabled && styles.pressed, disabled && styles.disabled]}
  >
    <AppIcon name={name} size={20} color={theme.color.ink} />
  </Pressable>;
}

/** The space name is the page title and the way into the space switcher. */
export function SpaceTitleButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={onPress}
    style={styles.titleButton}
  >
    <Text accessibilityRole="header" style={styles.title} numberOfLines={2}>{label}</Text>
    <AppIcon name="chevronDown" size={20} color={theme.color.ink} />
  </Pressable>;
}

/** Always-visible line under the title. Only facts the workspace exposes are shown. */
export function SyncLine({ icon, text }: { icon: IconName; text: string }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View accessibilityLiveRegion="polite" style={styles.syncLine}>
    <AppIcon name={icon} size={15} color={theme.color.muted} />
    <Text style={styles.syncText}>{text}</Text>
  </View>;
}

export function Pill({ label, tone = 'plain' }: { label: string; tone?: 'plain' | 'on' }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <Text style={[styles.pill, tone === 'on' && styles.pillOn]}>{label}</Text>;
}

/** Chip used for the space choice, target date and the goal detail metadata row. */
export function MetaChip({ label, icon, onPress, disabled = false, accessibilityLabel }: {
  label: string; icon?: IconName; onPress?: () => void; disabled?: boolean; accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const content = <>
    {icon ? <AppIcon name={icon} size={15} color={theme.color.muted} /> : null}
    <Text style={styles.chipLabel} numberOfLines={2}>{label}</Text>
  </>;
  if (!onPress) return <View style={styles.chip}>{content}</View>;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.chip, pressed && !disabled && styles.pressed, disabled && styles.disabled]}
  >{content}</Pressable>;
}

export function MetaRow({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View style={styles.metaRow}>{children}</View>;
}

export function ProgressBar({ ratio }: { ratio: number }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const value = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return <View style={styles.track}><View style={[styles.fill, { width: `${value * 100}%` }]} /></View>;
}

/** Explanatory note: a small icon next to quiet text. */
export function Note({ icon, children }: { icon: IconName; children: ReactNode }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View style={styles.note}>
    <AppIcon name={icon} size={16} color={theme.color.muted} />
    <Text style={styles.noteText}>{children}</Text>
  </View>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  iconSurface: { backgroundColor: theme.color.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.border },
  pressed: { backgroundColor: theme.color.subtle },
  disabled: { opacity: 0.45 },
  titleButton: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  title: { color: theme.color.ink, fontSize: 30, lineHeight: 38, fontWeight: '600', letterSpacing: -0.3, marginVertical: 4, flexShrink: 1 },
  syncLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, marginBottom: 18 },
  syncText: { color: theme.color.muted, fontSize: 13, lineHeight: 18, flexShrink: 1 },
  pill: { color: theme.color.muted, backgroundColor: theme.color.subtle, fontSize: 12, lineHeight: 20, paddingHorizontal: 8, borderRadius: 99, overflow: 'hidden' },
  pillOn: { color: theme.color.onFocus, backgroundColor: theme.color.focus },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34, paddingHorizontal: 12, borderRadius: 99, backgroundColor: theme.color.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.border, flexShrink: 1 },
  chipLabel: { color: theme.color.ink, fontSize: 13, lineHeight: 18, flexShrink: 1 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6, marginBottom: 4 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: theme.color.subtle, marginTop: 14, marginBottom: 6 },
  fill: { height: '100%', borderRadius: 3, backgroundColor: theme.color.accent },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 12, marginHorizontal: 4 },
  noteText: { color: theme.color.muted, fontSize: 13, lineHeight: 19, flex: 1, minWidth: 0 },
});
