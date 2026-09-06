import { useEffect, useState } from 'react';
import { SafeAreaView } from 'react-native-screens/experimental';
// Adapted from assistant-ui/examples/with-expo (MIT); see UPSTREAM.md.
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
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
  const theme = useTheme();
  const styles = makeStyles(theme);
  const isUser = useAuiState((s) => s.message.role === 'user');
  const status = useAuiState((s) => s.message.status);
  const error = status?.type === 'incomplete' && status.reason === 'error' ? status.error : undefined;
  const errorText = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '回复中断，请重试。';
  return <MessagePrimitive.Root style={[styles.message, isUser && styles.userMessage]}>
    <Text style={styles.speaker}>{isUser ? '你' : 'AI'}</Text>
    <View style={[styles.bubble, isUser && styles.userBubble]}>
      <MessagePrimitive.Parts components={{ Text: MessageText, Empty: () => <Text style={styles.note}>{status?.type === 'running' ? '正在回应…' : '未收到回复'}</Text> }} />
      <ErrorPrimitive.Root><Text style={styles.error}>{errorText}</Text></ErrorPrimitive.Root>
    </View>
    {!isUser && status?.type === 'running' && <Text accessibilityLiveRegion="polite" style={styles.note}>正在生成…</Text>}
    {!isUser && status?.type === 'incomplete' && status.reason === 'cancelled' && <Text style={styles.note}>已停止，已生成的内容保留。</Text>}
    {!isUser && status?.type !== 'running' && <ActionBarPrimitive.Reload testID="chat-retry" accessibilityLabel="重新生成回复" style={styles.retry}><Text accessible={false} style={styles.retryText}>↻</Text></ActionBarPrimitive.Reload>}
  </MessagePrimitive.Root>;
}

function EmptyState() {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <ScrollView style={styles.flex} contentContainerStyle={styles.empty} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
    <Text style={styles.welcome}>有什么想聊的？</Text>
    <View style={styles.suggestions}>{[{ label: '理清想法', prompt: '帮我理清一个想法' }, { label: '练习英语', prompt: '陪我练习英语对话' }, { label: '回顾今天', prompt: '一起回顾今天' }].map(({ label, prompt }) => <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send style={styles.suggestion}><Text style={styles.suggestionText}>{label}</Text></ThreadPrimitive.Suggestion>)}</View>
  </ScrollView>;
}

function Composer() {
  const { config, storageError } = useAISettings();
  const theme = useTheme();
  const styles = makeStyles(theme);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const isEmpty = useAuiState((s) => !s.composer.text.trim());
  return <View style={styles.composerArea}>
    <ComposerPrimitive.Root style={styles.composer}>
      <ComposerPrimitive.Input testID="chat-input" accessibilityLabel="对话输入" multiline placeholder="说说你的想法…" placeholderTextColor={theme.color.muted} selectionColor={theme.color.accent} style={styles.input} />
      {isRunning ? <ComposerPrimitive.Cancel testID="chat-stop" accessibilityLabel="停止生成" style={styles.send}><Text style={styles.sendText}>■</Text></ComposerPrimitive.Cancel> : <ComposerPrimitive.Send testID="chat-send" accessibilityLabel="发送消息" style={[styles.send, isEmpty && styles.disabled]}><Text style={styles.sendText}>↑</Text></ComposerPrimitive.Send>}
    </ComposerPrimitive.Root>
    {config && !storageError && <Text style={styles.disclaimer}>{config.model} · {new URL(config.baseUrl).hostname}{'\n'}仅发送当前会话文字</Text>}
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
    <AuiIf condition={(s) => !s.thread.isEmpty}><ThreadPrimitive.MessagesFlatList testID="chat-messages" style={styles.flex} contentContainerStyle={styles.messages} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled">{() => <MessageBubble />}</ThreadPrimitive.MessagesFlatList></AuiIf>
    <Composer />
    </SafeAreaView>
  </KeyboardAvoidingView>;
}
const makeStyles = (theme: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.background }, flex: { flex: 1 },
  empty: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  welcome: { color: theme.color.ink, fontWeight: '700', fontSize: 28, lineHeight: 38 },
  suggestions: { gap: 10, marginTop: 26 },
  suggestion: { borderRadius: 18, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, paddingVertical: 14, paddingHorizontal: 16 },
  suggestionText: { color: theme.color.ink, fontSize: 15 },
  messages: { padding: 20, gap: 24 },
  message: { alignItems: 'flex-start', gap: 8 }, userMessage: { alignItems: 'flex-end' },
  speaker: { color: theme.color.muted, fontSize: 12, paddingHorizontal: 4 },
  bubble: { maxWidth: '100%', padding: 16, borderRadius: 20, backgroundColor: theme.color.surface },
  userBubble: { maxWidth: '88%', backgroundColor: theme.color.subtle },
  messageText: { color: theme.color.ink, fontSize: 16, lineHeight: 26 },
  note: { color: theme.color.muted, fontSize: 12, lineHeight: 18 },
  error: { color: theme.color.accent, fontSize: 14, marginTop: 8 },
  retry: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }, retryText: { color: theme.color.muted, fontSize: 24 },
  composerArea: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.border, borderRadius: 26, padding: 8 },
  input: { flex: 1, minHeight: 44, maxHeight: 130, paddingVertical: 12, paddingHorizontal: 10, fontSize: 16, lineHeight: 22, color: theme.color.ink },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.color.accent, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: theme.color.onAccent, fontSize: 25, fontWeight: '600' }, disabled: { opacity: 0.4 },
  disclaimer: { color: theme.color.muted, fontSize: 11, textAlign: 'center', marginTop: 8 },
});
