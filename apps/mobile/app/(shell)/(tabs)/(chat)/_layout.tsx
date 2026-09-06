import { Stack } from 'expo-router';
import { DrawerToggleButton } from 'expo-router/drawer';
import { NewChatButton } from '../../../../src/chat/conversation-list';
import { theme } from '../../../../src/ui/theme';

export default function ChatLayout() {
  return <Stack screenOptions={{ title: '思玥', headerShadowVisible: false, headerStyle: { backgroundColor: theme.color.background }, headerTintColor: theme.color.ink, headerLeft: () => <DrawerToggleButton accessibilityLabel="打开侧边栏" tintColor={theme.color.ink} />, headerRight: () => <NewChatButton /> }} />;
}
