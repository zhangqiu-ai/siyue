import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { theme } from '../../../src/ui/theme';

export default function TabLayout() {
  return <NativeTabs tintColor={theme.color.accent} backgroundColor={theme.color.background} labelStyle={{ color: theme.color.muted }}>
    <NativeTabs.Trigger name="(chat)" disableAutomaticContentInsets>
      <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }} md="chat_bubble" />
      <NativeTabs.Trigger.Label>对话</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="(goals)">
      <NativeTabs.Trigger.Icon sf={{ default: 'checkmark.circle', selected: 'checkmark.circle.fill' }} md="check_circle" />
      <NativeTabs.Trigger.Label>行动</NativeTabs.Trigger.Label>
    </NativeTabs.Trigger>
  </NativeTabs>;
}
