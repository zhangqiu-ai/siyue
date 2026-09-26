import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useLocale } from '../../src/i18n';
import { useAISettings } from '../../src/settings/ai-settings';
import { useTheme, type Theme } from '../../src/ui';
import { useChatStore } from '../../src/chat/use-chat-store';
import { useChatRunner } from '../../src/chat/chat-runner';
import { Composer, ConnectCard } from '../../src/chat/chat-view';
import { chatTranslate, replyScopeLabel } from '../../src/chat/format';
import { BarButton, TopBar } from '../../src/shell/top-bar';
import { useCurrentSpace } from '../../src/shell/space-switcher';

export default function NewChatScreen() {
  const { t, locale } = useLocale();
  const theme = useTheme();
  const s = makeStyles(theme);
  const settings = useAISettings();
  const { store } = useChatStore();
  const runner = useChatRunner(store);
  const space = useCurrentSpace();
  const [draft, setDraft] = useState('');
  const suggestions = [t('chat.suggestPlan'), t('chat.suggestEnglish'), t('chat.suggestReview')];
  const connected = settings.ready && settings.config !== null;
  const scope = settings.config ? replyScopeLabel(settings.config.baseUrl, chatTranslate(locale)) : null;
  const send = () => {
    if (!draft.trim()) return;
    const id = runner.send(null, draft);
    setDraft('');
    router.replace({ pathname: '/chat/[id]', params: { id } });
  };
  return <View style={s.page}>
    <TopBar right={<BarButton icon="compose" label={t('chat.new')} onPress={() => setDraft('')} />} />
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
        <View style={s.column}>
          <Text accessibilityRole="header" maxFontSizeMultiplier={1.6} style={s.title}>{t('chat.greeting')}</Text>
          <Text maxFontSizeMultiplier={1.8} style={s.lead}>{space.name}</Text>
          <View style={{ gap: 8, alignItems: 'flex-start' }}>
            {suggestions.map((suggestion) => <Pressable key={suggestion} accessibilityRole="button" onPress={() => setDraft(suggestion)} style={({ pressed }) => [s.chip, pressed && { backgroundColor: theme.color.subtle }]}>
              <Text maxFontSizeMultiplier={2} style={s.chipText}>{suggestion}</Text></Pressable>)}
          </View>
        </View>
      </ScrollView>
      <SafeAreaView edges={['bottom']} style={s.footer}>
        <View style={s.column}>
          {!settings.ready ? null : connected ? <>
            <Composer value={draft} onChange={setDraft} onSend={send} onStop={() => {}} running={false} />
            {scope && <Text style={s.meta}>{scope}</Text>}
          </> : <ConnectCard />}
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  </View>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.color.background },
  content: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 36, paddingBottom: 24 },
  column: { width: '100%', maxWidth: 720, alignSelf: 'center' },
  title: { fontSize: 30, lineHeight: 38, fontWeight: '600', color: theme.color.ink },
  lead: { fontSize: 16, lineHeight: 24, color: theme.color.muted, marginTop: 6, marginBottom: 24 },
  chip: { borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, minHeight: 44 },
  chipText: { fontSize: 15, lineHeight: 21, color: theme.color.ink },
  footer: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 8, gap: 6 },
  meta: { fontSize: 12, lineHeight: 18, color: theme.color.muted, textAlign: 'center', marginTop: 6 },
});
