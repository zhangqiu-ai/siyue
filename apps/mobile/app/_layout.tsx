import 'react-native-reanimated';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ChatProvider } from '../src/chat/chat-provider';
import { theme } from '../src/ui/theme';

export default function RootLayout() {
  return <GestureHandlerRootView style={{ flex: 1 }}>
    <ChatProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.background } }}>
        <Stack.Screen name="(shell)" />
        <Stack.Screen name="ui-preview" />
      </Stack>
    </ChatProvider>
  </GestureHandlerRootView>;
}
