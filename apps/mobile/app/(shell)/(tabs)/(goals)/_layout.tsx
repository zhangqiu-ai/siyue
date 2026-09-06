import { Stack } from 'expo-router';
import { DrawerToggleButton } from 'expo-router/drawer';
import { theme } from '../../../../src/ui/theme';

export default function GoalsLayout() {
  return <Stack screenOptions={{ title: '目标与行动', headerShadowVisible: false, headerStyle: { backgroundColor: theme.color.background }, headerTintColor: theme.color.ink, headerLeft: () => <DrawerToggleButton accessibilityLabel="打开侧边栏" tintColor={theme.color.ink} /> }} />;
}
