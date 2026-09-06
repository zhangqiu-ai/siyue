import { SafeAreaView } from 'react-native-safe-area-context';
import { Drawer, DrawerToggleButton, type DrawerContentComponentProps } from 'expo-router/drawer';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { ConversationList, NewChatButton } from '../../src/chat/conversation-list';
import { useTheme } from '../../src/ui/theme';

function Sidebar(props: DrawerContentComponentProps) {
  const theme = useTheme();
  const close = () => props.navigation.closeDrawer();
  return <SafeAreaView style={{ flex: 1, padding: 20 }}>
    <View style={{ paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text style={{ fontSize: 28, fontWeight: '700', color: theme.color.ink }}>思玥</Text>
      <NewChatButton onSelect={() => { router.navigate('/'); close(); }} />
    </View>
    <ConversationList onSelect={() => { router.navigate('/'); close(); }} />
    <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: theme.color.border, paddingTop: 12 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="设置" onPress={() => { close(); router.navigate('/settings'); }} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Text accessible={false} style={{ color: theme.color.ink, fontSize: 26 }}>⚙︎</Text></Pressable>
    </View>
  </SafeAreaView>;
}
export default function ShellLayout() {
  const theme = useTheme();
  return <Drawer drawerContent={props => <Sidebar {...props} />} screenOptions={{ headerShown: false, drawerType: 'front', drawerStyle: { backgroundColor: theme.color.background, width: 310 }, swipeEdgeWidth: 32 }}>
    <Drawer.Screen name="index" options={{ headerShown: true, title: '', headerShadowVisible: false, headerStyle: { backgroundColor: theme.color.background }, headerTintColor: theme.color.ink, headerLeft: () => <DrawerToggleButton accessibilityLabel="打开侧边栏" tintColor={theme.color.ink} />, headerRight: () => <NewChatButton /> }} />
  </Drawer>;
}
