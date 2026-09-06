import { Host } from '@expo/ui';
import type { ComponentProps } from 'react';
import { theme } from './theme';

/** Shared native tint; the first preview uses the approved light visual direction. */
export function NativeHost(props: ComponentProps<typeof Host>) {
  return <Host colorScheme="light" seedColor={theme.color.accent} matchContents={{ vertical: true }} {...props} />;
}
