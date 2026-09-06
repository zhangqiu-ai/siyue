import 'react-native-reanimated';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ChatProvider } from '../src/chat/chat-provider';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import { AppThemeProvider, useTheme } from '../src/ui/theme';
import { AISettingsProvider } from '../src/settings/ai-settings';

function ThemedLayout() {
  const theme = useTheme();
  const navigationTheme = { ...(theme.mode === 'dark' ? DarkTheme : DefaultTheme), colors: { ...(theme.mode === 'dark' ? DarkTheme : DefaultTheme).colors, primary: theme.color.accent, background: theme.color.background, card: theme.color.surface, text: theme.color.ink, border: theme.color.border, notification: theme.color.accent } };
  return <GestureHandlerRootView style={{ flex: 1 }}>
    <ThemeProvider value={navigationTheme}><ChatProvider>
      <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.background } }}>
        <Stack.Screen name="(shell)" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="ai-provider" />
      </Stack>
    </ChatProvider></ThemeProvider>
  </GestureHandlerRootView>;
}

export default function RootLayout() {
  return <AppThemeProvider><AISettingsProvider><ThemedLayout /></AISettingsProvider></AppThemeProvider>;
}
