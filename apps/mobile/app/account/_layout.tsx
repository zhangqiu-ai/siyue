import { Stack } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { AccountFrame } from '../../src/account/split-layout';
import { canSplitAccount } from '../../src/account/split-width';
import { useTheme } from '../../src/ui/theme';

/** Every account route lives in this stack, so the account area owns one header policy (the design keeps
 *  the large title in the page body) and one wide-window frame. */
export default function AccountLayout() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  // The deletion flow is one three-step task, so it opens as a single modal: a form sheet on a wide
  // window, a full-screen modal on a phone.
  const deletion = canSplitAccount(width) ? 'formSheet' as const : 'fullScreenModal' as const;
  return <AccountFrame>
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.background } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="reset" />
      <Stack.Screen name="sign-up" />
      <Stack.Screen name="methods" />
      <Stack.Screen name="password" />
      <Stack.Screen name="devices" />
      <Stack.Screen name="family" />
      <Stack.Screen name="family/[id]" />
      <Stack.Screen name="space" />
      <Stack.Screen name="delete" options={{ presentation: deletion }} />
    </Stack>
  </AccountFrame>;
}
