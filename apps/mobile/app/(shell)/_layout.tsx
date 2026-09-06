import { SafeAreaView } from 'react-native-safe-area-context';
import { Drawer, DrawerItem, type DrawerContentComponentProps } from 'expo-router/drawer';
import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { ConversationList } from '../../src/chat/conversation-list';
import { theme } from '../../src/ui/theme';

function Sidebar(props: DrawerContentComponentProps) {
  const close = () => props.navigation.closeDrawer();
  return <SafeAreaView style={{ flex: 1, padding: 20 }}>
    <View style={{ paddingVertical: 24, gap: 8 }}>
      <Text style={{ fontSize: 28, fontWeight: '700', color: theme.color.ink }}>思玥</Text>
      <Text style={{ fontSize: 14, color: theme.color.muted }}>给成长一点空间</Text>
    </View>
    <ConversationList onSelect={() => { router.navigate('/'); close(); }} />
    <View style={{ marginTop: 24, borderTopWidth: 1, borderTopColor: theme.color.border, paddingTop: 12 }}>
      <DrawerItem label="目标与行动" onPress={() => { router.navigate('/goals'); close(); }} labelStyle={{ color: theme.color.ink }} />
      {__DEV__ && <DrawerItem label="原生组件预览" onPress={() => { close(); router.push('/ui-preview'); }} labelStyle={{ color: theme.color.muted }} />}
    </View>
  </SafeAreaView>;
}
export default function ShellLayout() {
  return <Drawer drawerContent={props => <Sidebar {...props} />} screenOptions={{ headerShown: false, drawerType: 'front', drawerStyle: { backgroundColor: theme.color.background, width: 310 }, swipeEdgeWidth: 32 }}>
    <Drawer.Screen name="(tabs)" />
  </Drawer>;
}
