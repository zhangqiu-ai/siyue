import { Stack } from 'expo-router';
import { DeletionFlowProvider } from '../../../src/account/delete/deletion-flow-provider';
import { useTheme } from '../../../src/ui/theme';

/** The deletion steps share one flow, so the choices made on one step are the ones the next step sends. */
export default function DeleteLayout() {
  const theme = useTheme();
  return <DeletionFlowProvider>
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.background } }}>
      <Stack.Screen name="impact" />
      <Stack.Screen name="families" />
      <Stack.Screen name="recipient" />
      <Stack.Screen name="confirm" />
      <Stack.Screen name="progress" />
    </Stack>
  </DeletionFlowProvider>;
}
