import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useTheme } from './theme';

const symbols = {
  target: { ios: 'target', android: 'track_changes', web: 'track_changes' },
  back: { ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' },
  close: { ios: 'xmark', android: 'close', web: 'close' },
  chevronRight: { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' },
  chevronDown: { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  success: { ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' },
  info: { ios: 'info.circle.fill', android: 'info', web: 'info' },
  warning: { ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' },
  settings: { ios: 'gearshape', android: 'settings', web: 'settings' },
  compose: { ios: 'square.and.pencil', android: 'edit_square', web: 'edit_square' },
  retry: { ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' },
  send: { ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' },
  down: { ios: 'arrow.down', android: 'arrow_downward', web: 'arrow_downward' },
  stop: { ios: 'stop.fill', android: 'stop', web: 'stop' },
  menu: { ios: 'sidebar.left', android: 'menu', web: 'menu' },
} satisfies Record<string, SymbolViewProps['name']>;

/** Decorative symbol; the containing control owns its accessible name and hit area. */
export function AppIcon({ name, color, size = 22 }: { name: keyof typeof symbols; color?: string; size?: number }) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  // Android SymbolView uses a font internally; keep decorative symbols at the
  // intended size while surrounding labels retain system text scaling.
  const symbolSize = Platform.OS === 'android' ? size / fontScale : size;
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
    <SymbolView name={symbols[name]} tintColor={color ?? theme.color.ink} size={symbolSize} style={{ width: size, height: size }} />
  </View>;
}
