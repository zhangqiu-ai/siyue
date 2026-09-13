import { useLocale } from '../../src/i18n';
import { AppIcon } from '../../src/ui/icon';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Drawer, DrawerToggleButton, type DrawerContentComponentProps } from 'expo-router/drawer';
import { router } from 'expo-router';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { ConversationList, NewChatButton } from '../../src/chat/conversation-list';
import { useTheme } from '../../src/ui/theme';

function Sidebar(props: DrawerContentComponentProps) {
  const { t } = useLocale();
  const theme = useTheme();
  const close = () => props.navigation.closeDrawer();
  return <SafeAreaView style={{ flex: 1, padding: 20 }}>
    <View style={{ paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text style={{ fontSize: 28, fontWeight: '600', color: theme.color.ink }}>{t('brand')}</Text>
      <NewChatButton onSelect={() => { router.navigate('/'); close(); }} />
    </View>
    <Pressable accessibilityRole="button" onPress={() => { router.navigate('/space'); close(); }} style={({ pressed }) => ({ minHeight: 56, borderRadius: 12, padding: 16, marginBottom: 12, backgroundColor: pressed ? theme.color.subtle : theme.color.surface })}><Text style={{ color: theme.color.ink, fontSize: 17 }}>{t('space.title')}</Text></Pressable>
    <ConversationList onSelect={() => { router.navigate('/'); close(); }} />
    <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: theme.color.border, paddingTop: 12 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('settings.title')} onPress={() => { close(); router.navigate('/settings'); }} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, backgroundColor: pressed ? theme.color.subtle : 'transparent', alignItems: 'center', justifyContent: 'center' })}><AppIcon name="settings" /></Pressable>
    </View>
  </SafeAreaView>;
}
export default function ShellLayout() {
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The drawer's fixed platform header height cannot fit accessibility text.
  const spaceHeaderHeight = fontScale > 1.4 ? insets.top + Math.ceil(24 * fontScale) + 16 : undefined;
  const { t } = useLocale();
  const theme = useTheme();
  return <Drawer initialRouteName="index" drawerContent={props => <Sidebar {...props} />} screenOptions={{ overlayAccessibilityLabel: t('sidebar.close'), headerShown: false, drawerType: 'front', drawerStyle: { backgroundColor: theme.color.background, width: 310 }, swipeEdgeWidth: 32 }}>
    <Drawer.Screen name="space" options={{ headerShown: true, title: t('space.title'), headerShadowVisible: false, headerStyle: { backgroundColor: theme.color.background, height: spaceHeaderHeight }, headerTintColor: theme.color.ink, headerLeft: () => <DrawerToggleButton accessibilityLabel={t('sidebar.open')} tintColor={theme.color.ink} /> }} />
    <Drawer.Screen name="index" options={{ headerShown: true, title: '', headerShadowVisible: false, headerStyle: { backgroundColor: theme.color.background }, headerTintColor: theme.color.ink, headerLeft: () => <DrawerToggleButton accessibilityLabel={t('sidebar.open')} tintColor={theme.color.ink} />, headerRight: () => <NewChatButton /> }} />
  </Drawer>;
}
