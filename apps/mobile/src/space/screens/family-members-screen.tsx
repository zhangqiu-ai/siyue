import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Banner, Button, Screen } from '../../ui';
import { useSpaceText } from '../use-space-text';

/** The workspace has no family membership reader yet. Never synthesize member names or roles. */
export default function FamilyMembersScreen() {
  const router = useRouter(), t = useSpaceText();
  return <Screen title={t('members.title')} testID="family-members">
    <Pressable accessibilityRole="button" accessibilityLabel={t('goal.missingAction')} onPress={() => router.replace('/space')} style={{ minHeight: 44, justifyContent: 'center' }}><Text>{t('goal.missingAction')}</Text></Pressable>
    <Banner kind="info" title={t('members.unavailableTitle')} body={t('members.unavailableBody')} />
    <View style={{ marginTop: 20 }}><Button label={t('goal.missingAction')} variant="tonal" onPress={() => router.replace('/space')} /></View>
  </Screen>;
}
