import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useLocale } from '../../../src/i18n';
import { useAISettings } from '../../../src/settings/ai-settings';
import { Button, useTheme, type Theme } from '../../../src/ui';
import { useChatStore, useConversation } from '../../../src/chat/use-chat-store';
import { useChatRunner, useRunningReplies } from '../../../src/chat/chat-runner';
import { Composer, ConnectCard, MessageView, Transcript } from '../../../src/chat/chat-view';
import { BarButton, TopBar } from '../../../src/shell/top-bar';
import { usePlanGeneration } from '../../../src/space/use-plan-generation';
import { planErrorKey } from '../../../src/space/plan-error';

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useLocale();
  const theme = useTheme();
  const s = makeStyles(theme);
  const settings = useAISettings();
  const { store, conversations } = useChatStore();
  const runner = useChatRunner(store);
  const generatePlan = usePlanGeneration();
  const isRunning = useRunningReplies();
  const messages = useConversation(id);
  const [draft, setDraft] = useState('');
  const [planBusyId, setPlanBusyId] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const planController = useRef<AbortController | null>(null);
  useEffect(() => () => planController.current?.abort(), [id]);
  const exists = conversations.some((conversation) => conversation.id === id);
  const last = messages[messages.length - 1];
  const activeReply = messages.find((message) => message.role === 'assistant' && isRunning(message.id));
  const latestUser = [...messages].reverse().find((message) => message.role === 'user');
  const connected = settings.ready && settings.config !== null;
  const send = () => { if (!draft.trim() || activeReply || !id) return; setPlanError(null); runner.send(id, draft); setDraft(''); };
  const createPlan = async (messageId: string) => {
    if (!latestUser || !id || planBusyId || activeReply) return;
    const controller = new AbortController();
    planController.current = controller;
    setPlanBusyId(messageId); setPlanError(null);
    try {
      const proposed = await generatePlan(latestUser.text, controller.signal);
      if (!controller.signal.aborted) store.updateMessage(messageId, { planDraftId: proposed.id });
    } catch (error) {
      if (!controller.signal.aborted) setPlanError(t(planErrorKey(error)));
    } finally {
      if (planController.current === controller) planController.current = null;
      setPlanBusyId(null);
    }
  };
  return <View style={s.page}>
    <TopBar right={<BarButton icon="compose" label={t('chat.new')} onPress={() => router.navigate('/')} />} />
    {!exists ? <View style={s.missing}><Text style={s.note}>{t('chat.notFound')}</Text><Button variant="tonal" label={t('chat.new')} onPress={() => router.navigate('/')} /></View> :
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Transcript contentKey={id ?? ''} footer={<SafeAreaView edges={['bottom']} style={s.footer}><View style={s.column}>
        {!settings.ready ? null : connected ? <Composer value={draft} onChange={setDraft} onSend={send} running={!!activeReply} onStop={() => { if (activeReply) runner.stop(activeReply.id); }} /> : <ConnectCard />}
      </View></SafeAreaView>}>
        {messages.map((message) => <MessageView key={message.id} message={message} last={message.id === last?.id} running={isRunning(message.id)}
          onStop={() => runner.stop(message.id)} onRegenerate={() => { if (id) { setPlanError(null); runner.regenerate(id, message.id); } }}
          onCreatePlan={message.id === last?.id && message.role === 'assistant' && message.status === 'complete' && latestUser && /计划|安排|拆解|目标|plan|schedule|break down/i.test(latestUser.text)
            ? () => void createPlan(message.id) : undefined}
          planBusy={planBusyId === message.id} planError={message.id === last?.id ? planError : null} />)}
      </Transcript>
    </KeyboardAvoidingView>}
  </View>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.color.background },
  column: { width: '100%', maxWidth: 720, alignSelf: 'center' },
  footer: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 8 },
  missing: { flex: 1, padding: 24, gap: 16, justifyContent: 'center', alignItems: 'center' },
  note: { fontSize: 15, lineHeight: 22, color: theme.color.muted, textAlign: 'center' },
});
