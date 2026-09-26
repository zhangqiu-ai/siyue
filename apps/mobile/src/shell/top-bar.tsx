import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useNavigation } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocale } from '../i18n';
import { AppIcon, useTheme } from '../ui';

/** Wide windows keep the sidebar visible; narrow ones use a drawer opened from this bar. */
export function useWideLayout() {
  const { width } = useWindowDimensions();
  return width >= 700;
}

export function TopBar({ right, left }: { right?: ReactNode; left?: ReactNode }) {
  const navigation = useNavigation();
  const wide = useWideLayout();
  const insets = useSafeAreaInsets();
  const { t } = useLocale();
  const theme = useTheme();
  return <View style={[styles.bar, { paddingTop: insets.top + 6 }]}>
    {left ?? (wide ? <View style={styles.spacer} /> : <Pressable accessibilityRole="button" accessibilityLabel={t('sidebar.open')} onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
      style={[styles.button, { backgroundColor: theme.color.surface }]}><AppIcon name="menu" size={20} /></Pressable>)}
    <View style={styles.right}>{right}</View>
  </View>;
}

export function BarButton({ icon, label, onPress }: { icon: Parameters<typeof AppIcon>[0]['name']; label: string; onPress: () => void }) {
  const theme = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={[styles.button, { backgroundColor: theme.color.surface }]}><AppIcon name={icon} size={20} /></Pressable>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 6 },
  button: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  spacer: { width: 44, height: 44 },
  right: { flexDirection: 'row', gap: 8, alignItems: 'center' },
});
