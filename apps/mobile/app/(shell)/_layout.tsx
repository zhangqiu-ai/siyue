import { Drawer } from 'expo-router/drawer';
import { useLocale } from '../../src/i18n';
import { useTheme } from '../../src/ui';
import { Sidebar } from '../../src/shell/sidebar';
import { useWideLayout } from '../../src/shell/top-bar';

export default function ShellLayout() {
  const { t } = useLocale();
  const theme = useTheme();
  const wide = useWideLayout();
  return <Drawer initialRouteName="index" drawerContent={(props) => <Sidebar onNavigate={wide ? undefined : () => props.navigation.closeDrawer()} />}
    screenOptions={{ headerShown: false, overlayAccessibilityLabel: t('sidebar.close'), drawerType: wide ? 'permanent' : 'front', swipeEdgeWidth: 32,
      drawerStyle: { backgroundColor: theme.color.background, width: wide ? 300 : 312, borderRightWidth: wide ? 1 : 0, borderRightColor: theme.color.border } }}>
    <Drawer.Screen name="index" />
    <Drawer.Screen name="chat/[id]" />
    <Drawer.Screen name="space" />
    <Drawer.Screen name="space/goal/[id]" />
    <Drawer.Screen name="space/members" />
    <Drawer.Screen name="boards" />
  </Drawer>;
}
