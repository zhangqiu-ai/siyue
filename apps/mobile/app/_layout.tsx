import {WorkspaceProvider} from '../src/account/workspace-provider';
import 'react-native-reanimated';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import { AppThemeProvider, useTheme } from '../src/ui/theme';
import { ToastProvider } from '../src/ui/toast';
import { AISettingsProvider } from '../src/settings/ai-settings';
import { LocaleProvider } from '../src/i18n';
import { AccountAuthProvider } from '../src/account/auth-provider';
import { SpaceSwitcherProvider } from '../src/shell/space-switcher';

function ThemedLayout() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const sheet = width >= 700 ? 'formSheet' as const : 'fullScreenModal' as const;
  const navigationTheme = { ...(theme.mode === 'dark' ? DarkTheme : DefaultTheme), colors: { ...(theme.mode === 'dark' ? DarkTheme : DefaultTheme).colors, primary: theme.color.accent, background: theme.color.background, card: theme.color.surface, text: theme.color.ink, border: theme.color.border, notification: theme.color.accent } };
  return <GestureHandlerRootView style={{ flex: 1 }}>
    <ThemeProvider value={navigationTheme}><ToastProvider><SpaceSwitcherProvider>
      <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.background } }}>
        <Stack.Screen name="(shell)" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="account" />
        <Stack.Screen name="ai-provider" />
        <Stack.Screen name="plan" options={{ presentation: sheet }} />
        <Stack.Screen name="whiteboard" options={{ presentation: 'fullScreenModal', gestureEnabled: false }} />
      </Stack>
    </SpaceSwitcherProvider></ToastProvider></ThemeProvider>
  </GestureHandlerRootView>;
}

export default function RootLayout() {
  return <LocaleProvider><AppThemeProvider><AccountAuthProvider><AISettingsProvider><WorkspaceProvider><ThemedLayout /></WorkspaceProvider></AISettingsProvider></AccountAuthProvider></AppThemeProvider></LocaleProvider>;
}
