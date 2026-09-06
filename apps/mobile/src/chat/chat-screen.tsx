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
import { theme } from '../ui/theme';

const MessageText: TextMessagePartComponent = ({ text }) => <Text selectable style={styles.messageText}>{text}</Text>;
function MessageBubble() {
  const isUser = useAuiState((s) => s.message.role === 'user');
  const status = useAuiState((s) => s.message.status);
  return <MessagePrimitive.Root style={[styles.message, isUser && styles.userMessage]}>
    <Text style={styles.speaker}>{isUser ? '你' : '思玥'}</Text>
    <View style={[styles.bubble, isUser && styles.userBubble]}>
      <MessagePrimitive.Parts components={{ Text: MessageText, Empty: () => <Text style={styles.note}>正在回应…</Text> }} />
      <ErrorPrimitive.Root><Text style={styles.error}>回复中断，请重试。</Text></ErrorPrimitive.Root>
    </View>
    {!isUser && status?.type === 'running' && <Text accessibilityLiveRegion="polite" style={styles.note}>正在生成…</Text>}
    {!isUser && status?.type === 'incomplete' && status.reason === 'cancelled' && <Text style={styles.note}>已停止，已生成的内容保留。</Text>}
    {!isUser && status?.type !== 'running' && <ActionBarPrimitive.Reload testID="chat-retry" accessibilityLabel="重新生成回复" style={styles.retry}><Text style={styles.retryText}>重新生成</Text></ActionBarPrimitive.Reload>}
  </MessagePrimitive.Root>;
}

function EmptyState() {
  return <ScrollView style={styles.flex} contentContainerStyle={styles.empty} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
    <View style={styles.sun}><Text style={styles.sunText}>✦</Text></View>
    <Text style={styles.eyebrow}>一点点，走向想成为的自己</Text>
    <Text style={styles.welcome}>今天，想从哪里开始？</Text>
    <Text style={styles.description}>聊聊你的想法，或把一个大目标，变成今天的小行动。</Text>
    <View style={styles.suggestions}>{['帮我梳理这周的目标', '我想每天练习英语', '一起回顾今天的小进步'].map((prompt) => <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send style={styles.suggestion}><Text style={styles.suggestionText}>{prompt}  ↗</Text></ThreadPrimitive.Suggestion>)}</View>
  </ScrollView>;
}

function Composer() {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const isEmpty = useAuiState((s) => !s.composer.text.trim());
  return <View style={styles.composerArea}>
    <ComposerPrimitive.Root style={styles.composer}>
      <ComposerPrimitive.Input testID="chat-input" accessibilityLabel="对话输入" multiline placeholder="说说你的想法…" placeholderTextColor={theme.color.muted} style={styles.input} />
      {isRunning ? <ComposerPrimitive.Cancel testID="chat-stop" accessibilityLabel="停止生成" style={styles.send}><Text style={styles.sendText}>■</Text></ComposerPrimitive.Cancel> : <ComposerPrimitive.Send testID="chat-send" accessibilityLabel="发送消息" style={[styles.send, isEmpty && styles.disabled]}><Text style={styles.sendText}>↑</Text></ComposerPrimitive.Send>}
    </ComposerPrimitive.Root>
    <Text style={styles.disclaimer}>本地演示回复 · 不联网，不会自动保存行动</Text>
  </View>;
}

export function ChatScreen() {
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
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.background }, flex: { flex: 1 },
  empty: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  sun: { width: 68, height: 68, borderRadius: 34, backgroundColor: theme.color.yellow, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  sunText: { color: theme.color.accent, fontSize: 38 },
  eyebrow: { color: theme.color.muted, fontSize: 13, marginBottom: 10 },
  welcome: { color: theme.color.ink, fontWeight: '700', fontSize: 28, lineHeight: 38 },
  description: { color: theme.color.muted, fontSize: 16, lineHeight: 25, marginTop: 12 },
  suggestions: { gap: 10, marginTop: 26 },
  suggestion: { borderRadius: 18, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, paddingVertical: 14, paddingHorizontal: 16 },
  suggestionText: { color: theme.color.ink, fontSize: 15 },
  messages: { padding: 20, gap: 24 },
  message: { alignItems: 'flex-start', gap: 8 }, userMessage: { alignItems: 'flex-end' },
  speaker: { color: theme.color.muted, fontSize: 12, paddingHorizontal: 4 },
  bubble: { maxWidth: '100%', padding: 16, borderRadius: 20, backgroundColor: theme.color.surface },
  userBubble: { maxWidth: '88%', backgroundColor: '#FBE3BA' },
  messageText: { color: theme.color.ink, fontSize: 16, lineHeight: 26 },
  note: { color: theme.color.muted, fontSize: 12, lineHeight: 18 },
  error: { color: theme.color.accent, fontSize: 14, marginTop: 8 },
  retry: { paddingHorizontal: 8, minHeight: 44, justifyContent: 'center' }, retryText: { color: theme.color.accent, fontSize: 13 },
  composerArea: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.border, borderRadius: 26, padding: 8 },
  input: { flex: 1, minHeight: 44, maxHeight: 130, paddingVertical: 12, paddingHorizontal: 10, fontSize: 16, lineHeight: 22, color: theme.color.ink },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.color.accent, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#FFFFFF', fontSize: 25, fontWeight: '600' }, disabled: { opacity: 0.4 },
  disclaimer: { color: theme.color.muted, fontSize: 11, textAlign: 'center', marginTop: 8 },
});
