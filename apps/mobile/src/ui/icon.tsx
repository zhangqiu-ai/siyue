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
  chat: { ios: 'bubble.left', android: 'chat_bubble', web: 'chat_bubble' },
  board: { ios: 'rectangle.and.pencil.and.ellipsis', android: 'draw', web: 'draw' },
  plus: { ios: 'plus', android: 'add', web: 'add' },
  copy: { ios: 'doc.on.doc', android: 'content_copy', web: 'content_copy' },
  mic: { ios: 'mic', android: 'mic', web: 'mic' },
  micOff: { ios: 'mic.slash', android: 'mic_off', web: 'mic_off' },
  video: { ios: 'video', android: 'videocam', web: 'videocam' },
  camera: { ios: 'camera', android: 'photo_camera', web: 'photo_camera' },
  image: { ios: 'photo', android: 'image', web: 'image' },
  pen: { ios: 'pencil.tip', android: 'edit', web: 'edit' },
  eraser: { ios: 'eraser', android: 'ink_eraser', web: 'ink_eraser' },
  text: { ios: 'textformat', android: 'title', web: 'title' },
  shape: { ios: 'square.on.circle', android: 'category', web: 'category' },
  cursor: { ios: 'cursorarrow', android: 'near_me', web: 'near_me' },
  undo: { ios: 'arrow.uturn.backward', android: 'undo', web: 'undo' },
  redo: { ios: 'arrow.uturn.forward', android: 'redo', web: 'redo' },
  layers: { ios: 'square.3.layers.3d', android: 'layers', web: 'layers' },
  more: { ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' },
  cloud: { ios: 'icloud', android: 'cloud_done', web: 'cloud_done' },
  cloudOff: { ios: 'icloud.slash', android: 'cloud_off', web: 'cloud_off' },
  calendar: { ios: 'calendar', android: 'calendar_today', web: 'calendar_today' },
  hang: { ios: 'phone.down.fill', android: 'call_end', web: 'call_end' },
  record: { ios: 'record.circle', android: 'radio_button_checked', web: 'radio_button_checked' },
  people: { ios: 'person.2', android: 'group', web: 'group' },
  key: { ios: 'key', android: 'key', web: 'key' },
  mail: { ios: 'envelope', android: 'mail', web: 'mail' },
  phone: { ios: 'iphone', android: 'smartphone', web: 'smartphone' },
  tablet: { ios: 'ipad', android: 'tablet', web: 'tablet' },
  desktop: { ios: 'laptopcomputer', android: 'laptop', web: 'laptop' },
  lock: { ios: 'lock', android: 'lock', web: 'lock' },
  shield: { ios: 'checkmark.shield', android: 'verified_user', web: 'verified_user' },
  box: { ios: 'shippingbox', android: 'inventory_2', web: 'inventory_2' },
  archive: { ios: 'archivebox', android: 'archive', web: 'archive' },
  edit: { ios: 'pencil', android: 'edit', web: 'edit' },
  grip: { ios: 'line.3.horizontal', android: 'drag_indicator', web: 'drag_indicator' },
  eye: { ios: 'eye', android: 'visibility', web: 'visibility' },
  eyeOff: { ios: 'eye.slash', android: 'visibility_off', web: 'visibility_off' },
  clock: { ios: 'clock', android: 'schedule', web: 'schedule' },
  logout: { ios: 'rectangle.portrait.and.arrow.right', android: 'logout', web: 'logout' },
  apple: { ios: 'apple.logo', android: 'phone_iphone', web: 'phone_iphone' },
} satisfies Record<string, SymbolViewProps['name']>;

/** Every symbol the app may render; components accept this union for their icon props. */
export type IconName = keyof typeof symbols;

/** Decorative symbol; the containing control owns its accessible name and hit area. */
export function AppIcon({ name, color, size = 22 }: { name: IconName; color?: string; size?: number }) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  // Android SymbolView uses a font internally; keep decorative symbols at the
  // intended size while surrounding labels retain system text scaling.
  const symbolSize = Platform.OS === 'android' ? size / fontScale : size;
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
    <SymbolView name={symbols[name]} tintColor={color ?? theme.color.ink} size={symbolSize} style={{ width: size, height: size }} />
  </View>;
}
