import { useLocale } from '../i18n';
import { AppIcon } from '../ui/icon';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { SafeAreaView } from 'react-native-screens/experimental';
// Adapted from assistant-ui/examples/with-expo (MIT); see UPSTREAM.md.
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ActionBarPrimitive, AuiIf, ComposerPrimitive, ErrorPrimitive,
  MessagePrimitive, ThreadPrimitive, useAuiState,
  type TextMessagePartComponent,
} from '@assistant-ui/react-native';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useTheme, type Theme } from '../ui/theme';
import { useAISettings } from '../settings/ai-settings';

const MessageText: TextMessagePartComponent = ({ text }) => {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <Text selectable style={styles.messageText}>{text}</Text>;
};
function MessageBubble() {
  const { t, errorText: translateError } = useLocale();
  const theme = useTheme();
  const styles = makeStyles(theme);
  const isUser = useAuiState((s) => s.message.role === 'user');
  const status = useAuiState((s) => s.message.status);
  const error = status?.type === 'incomplete' && status.reason === 'error' ? status.error : undefined;
  const errorText = translateError(error, t('chat.interrupted'));
  return <MessagePrimitive.Root style={[styles.message, isUser && styles.userMessage]}>
    <View style={[styles.bubble, isUser && styles.userBubble]}>
      <MessagePrimitive.Parts components={{ Text: MessageText, Empty: () => <Text style={styles.note}>{status?.type === 'running' ? t('chat.responding') : t('chat.noReply')}</Text> }} />
      <ErrorPrimitive.Root><Text style={styles.error}>{errorText}</Text></ErrorPrimitive.Root>
    </View>
    {!isUser && status?.type === 'running' && <Text accessibilityLiveRegion="polite" style={styles.note}>{t('chat.generating')}</Text>}
    {!isUser && status?.type === 'incomplete' && status.reason === 'cancelled' && <Text style={styles.note}>{t('chat.stopped')}</Text>}
    {!isUser && status?.type !== 'running' && <ActionBarPrimitive.Reload testID="chat-retry" accessibilityLabel={t('chat.retry')} style={({ pressed }) => [styles.retry, pressed && styles.pressed]}><AppIcon name="retry" color={theme.color.muted} /></ActionBarPrimitive.Reload>}
  </MessagePrimitive.Root>;
}

function EmptyState() {
  const { t } = useLocale();
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <ScrollView style={styles.flex} contentContainerStyle={styles.empty} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
    <Text style={styles.welcome}>{t('chat.welcome')}</Text>
    <View style={styles.suggestions}>{[{ label: t('chat.clarify'), prompt: t('chat.clarifyPrompt') }, { label: t('chat.english'), prompt: t('chat.englishPrompt') }, { label: t('chat.review'), prompt: t('chat.reviewPrompt') }].map(({ label, prompt }) => <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}><Text style={styles.suggestionText}>{label}</Text></ThreadPrimitive.Suggestion>)}</View>
  </ScrollView>;
}

function Composer() {
  const { config, storageError } = useAISettings();
  const { t } = useLocale();
  const theme = useTheme();
  const styles = makeStyles(theme);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const isEmpty = useAuiState((s) => !s.composer.text.trim());
  return <View style={styles.composerArea}>
    <ComposerPrimitive.Root style={styles.composer}>
      <ComposerPrimitive.Input testID="chat-input" accessibilityLabel={t('chat.input')} multiline placeholder={t('chat.placeholder')} placeholderTextColor={theme.color.muted} selectionColor={theme.color.accent} style={styles.input} />
      {isRunning ? <ComposerPrimitive.Cancel testID="chat-stop" accessibilityLabel={t('chat.stop')} style={({ pressed }) => [styles.send, pressed && styles.primaryPressed]}><AppIcon name="stop" color={theme.color.onAccent} /></ComposerPrimitive.Cancel> : <ComposerPrimitive.Send testID="chat-send" accessibilityLabel={t('chat.send')} style={({ pressed }) => [styles.send, isEmpty && styles.disabled, pressed && styles.primaryPressed]}><AppIcon name="send" color={theme.color.onAccent} /></ComposerPrimitive.Send>}
    </ComposerPrimitive.Root>
    {config && !storageError && <Text style={styles.disclaimer}>{config.model} · {new URL(config.baseUrl).hostname}{'\n'}{t('chat.disclaimer')}</Text>}
  </View>;
}

function Messages() {
  const { t } = useLocale();
  const theme = useTheme();
  const styles = makeStyles(theme);
  const list = useRef<ComponentRef<typeof ThreadPrimitive.MessagesFlatList>>(null);
  const threadId = useAuiState(s => s.threads.mainThreadId);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  useEffect(() => setAwayFromBottom(false), [threadId]);
  return <View style={styles.messageArea}>
    <ThreadPrimitive.MessagesFlatList ref={list} testID="chat-messages" style={styles.flex} contentContainerStyle={styles.messages} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" onScroll={({ nativeEvent }) => {
      setAwayFromBottom(nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height - nativeEvent.contentOffset.y > 4);
    }}>{() => <MessageBubble />}</ThreadPrimitive.MessagesFlatList>
    {awayFromBottom && <Pressable accessibilityRole="button" accessibilityLabel={t('chat.latest')} testID="chat-scroll-bottom" onPress={() => list.current?.scrollToEnd({ animated: false })} style={({ pressed }) => [styles.scrollBottom, pressed && styles.pressed]}>
      <AppIcon name="down" />
    </Pressable>}
  </View>;
}

export function ChatScreen() {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const headerHeight = useHeaderHeight();
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}>
    <SafeAreaView edges={{ bottom: !keyboardVisible }} style={styles.flex}>
    <AuiIf condition={(s) => s.thread.isEmpty}><EmptyState /></AuiIf>
    <AuiIf condition={(s) => !s.thread.isEmpty}><Messages /></AuiIf>
    <Composer />
    </SafeAreaView>
  </KeyboardAvoidingView>;
}
const makeStyles = (theme: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.background }, flex: { flex: 1 },
  empty: { width: '100%', maxWidth: theme.layout.contentWidth, alignSelf: 'center', flexGrow: 1, justifyContent: 'center', padding: 20 },
  welcome: { color: theme.color.ink, fontWeight: '600', fontSize: 28, lineHeight: 38 },
  suggestions: { gap: 12, marginTop: 24 },
  suggestion: { borderRadius: theme.radius.field, borderWidth: 1, borderColor: theme.color.controlBorder, backgroundColor: theme.color.surface, paddingVertical: 14, paddingHorizontal: 16 },
  suggestionText: { color: theme.color.ink, fontSize: 16, lineHeight: 24 },
  pressed: { backgroundColor: theme.color.subtle },
  primaryPressed: { backgroundColor: theme.color.accentPressed },
  messageArea: { flex: 1, width: '100%', maxWidth: theme.layout.contentWidth, alignSelf: 'center' },
  scrollBottom: { position: 'absolute', bottom: 8, right: 20, width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: theme.color.controlBorder, backgroundColor: theme.color.surface, alignItems: 'center', justifyContent: 'center' },
  messages: { width: '100%', maxWidth: theme.layout.contentWidth, alignSelf: 'center', padding: 20, gap: 24 },
  message: { alignItems: 'flex-start', gap: 8 }, userMessage: { alignItems: 'flex-end' },
  bubble: { maxWidth: '100%', padding: 16, borderRadius: theme.radius.card, backgroundColor: theme.color.surface },
  userBubble: { maxWidth: '88%', backgroundColor: theme.color.subtle },
  messageText: { color: theme.color.ink, fontSize: 16, lineHeight: 26 },
  note: { color: theme.color.muted, fontSize: 13, lineHeight: 20 },
  error: { color: theme.color.error, fontSize: 14, marginTop: 8 },
  retry: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  composerArea: { width: '100%', maxWidth: theme.layout.contentWidth, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.controlBorder, borderRadius: theme.radius.card, padding: 8 },
  input: { flex: 1, minHeight: 48, maxHeight: 160, paddingVertical: 12, paddingHorizontal: 8, fontSize: 16, lineHeight: 24, color: theme.color.ink },
  send: { width: 48, height: 48, borderRadius: 24, backgroundColor: theme.color.accent, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  disclaimer: { color: theme.color.muted, fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 8 },
});
