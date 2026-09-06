import { Host } from '@expo/ui';
import type { ComponentProps } from 'react';
import { useTheme } from './theme';

/** Shared native tint and appearance follow the selected monochrome theme. */
export function NativeHost(props: ComponentProps<typeof Host>) {
  const theme = useTheme();
  return <Host colorScheme={theme.mode} seedColor={theme.color.accent} matchContents={{ vertical: true }} {...props} />;
}
