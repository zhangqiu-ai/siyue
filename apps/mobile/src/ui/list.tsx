import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { AppIcon, type IconName } from './icon';
import { useTheme, type Theme } from './theme';

type RowSlots = { first?: boolean; separatorInset?: number };

export function SectionLabel({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const styles = makeStyles(theme, 1);
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

/** ListGroup owns the surface and hands each direct ListRow its separator inset. */
export function ListGroup({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const styles = makeStyles(theme, 1);
  let previousHadIcon = false;
  const rows = Children.toArray(children).map((child, index) => {
    if (!isValidElement<{ icon?: IconName }>(child)) return child;
    const hasIcon = child.props.icon !== undefined;
    const separatorInset = hasIcon || previousHadIcon ? 60 : 16;
    previousHadIcon = hasIcon;
    return cloneElement(child as ReactElement<Record<string, unknown>>, { first: index === 0, separatorInset });
  });
  return <View style={styles.group}>{rows}</View>;
}

export function ListRow({ title, subtitle, icon, value, badge, trailing, onPress, destructive = false, centered = false, disabled = false, chevron, testID, first = false, separatorInset = 16 }: {
  title: string;
  subtitle?: string;
  icon?: IconName;
  value?: string;
  badge?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  centered?: boolean;
  disabled?: boolean;
  chevron?: boolean;
  testID?: string;
} & RowSlots) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const styles = makeStyles(theme, fontScale);
  const stacked = fontScale > 1.4 && !centered && (value !== undefined || trailing !== undefined);
  const showChevron = chevron ?? (Boolean(onPress) && !disabled);
  const label = <View style={[styles.main, centered && styles.mainCentered]}>
    <Text style={[styles.title, destructive && styles.titleDestructive, disabled && styles.titleDisabled, centered && styles.titleCentered]}>{title}</Text>
    {subtitle ? <Text style={[styles.subtitle, disabled && styles.titleDisabled]}>{subtitle}</Text> : null}
  </View>;
  const actions = value !== undefined || badge !== undefined || trailing !== undefined || showChevron
    ? <View style={[styles.actions, stacked && styles.actionsStacked]}>
      {value !== undefined ? <Text numberOfLines={stacked ? undefined : 1} style={styles.value}>{value}</Text> : null}
      {badge !== undefined ? <Text style={styles.badge}>{badge}</Text> : null}
      {trailing}
      {showChevron ? <AppIcon name="chevronRight" size={20} color={theme.color.muted} /> : null}
    </View>
    : null;
  const body = <View style={styles.body}>
    <View style={[styles.line, centered && styles.lineCentered]}>
      {label}
      {stacked ? null : actions}
    </View>
    {stacked ? actions : null}
  </View>;
  const content = <>
    {icon ? <View style={styles.tile}><AppIcon name={icon} size={18} color={destructive ? theme.color.error : theme.color.accent} /></View> : null}
    {body}
  </>;
  const separator = first ? null : <View style={[styles.separator, { left: separatorInset }]} />;
  if (!onPress) return <View testID={testID} style={styles.row}>{separator}{content}</View>;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={title}
    accessibilityState={{ disabled }}
    disabled={disabled}
    testID={testID}
    onPress={onPress}
    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
  >{separator}{content}</Pressable>;
}

const makeStyles = (theme: Theme, fontScale: number) => StyleSheet.create({
  sectionLabel: { color: theme.color.muted, fontSize: 13, lineHeight: 18, fontWeight: '500', marginTop: 24, marginBottom: 8, marginHorizontal: 4 },
  group: { backgroundColor: theme.color.surface, borderRadius: theme.radius.group, overflow: 'hidden' },
  row: { position: 'relative', flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16, paddingVertical: 10 },
  pressed: { backgroundColor: theme.color.subtle },
  separator: { position: 'absolute', top: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border },
  tile: { width: 32, height: 32, borderRadius: 9, backgroundColor: theme.color.subtle, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  body: { flex: 1, minWidth: 0 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  lineCentered: { justifyContent: 'center' },
  main: { flex: 1, minWidth: 0 },
  mainCentered: { flexGrow: 0, flexBasis: 'auto', alignItems: 'center' },
  title: { color: theme.color.ink, fontSize: 16, lineHeight: 22 },
  titleDestructive: { color: theme.color.error },
  titleDisabled: { color: theme.color.muted },
  titleCentered: { textAlign: 'center', fontWeight: '500' },
  subtitle: { color: theme.color.muted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  value: { color: theme.color.muted, fontSize: 15, lineHeight: 22, flexShrink: 1 },
  badge: { color: theme.color.onAccent, backgroundColor: theme.color.accent, fontSize: 12, lineHeight: 20, fontWeight: '600', paddingHorizontal: 8, borderRadius: 99, overflow: 'hidden' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  actionsStacked: { alignItems: fontScale > 1.4 ? 'flex-start' : 'center', flexWrap: 'wrap' },
});
