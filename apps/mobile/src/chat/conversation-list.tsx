import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ThreadListPrimitive, useAui, useAuiState } from '@assistant-ui/react-native';
import { useTheme, type Theme } from '../ui/theme';

export function NewChatButton({ onSelect }: { onSelect?: () => void }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const aui = useAui();
  return <Pressable accessibilityRole="button" accessibilityLabel="新建对话" testID="chat-new" style={styles.newButton} onPress={() => {
    aui.thread.cancelRun();
    aui.threads.switchToNewThread();
    onSelect?.();
  }}><Text accessible={false} style={styles.newLabel}>✎</Text></Pressable>;
}

function ConversationItem({ index, onSelect }: { index: number; onSelect: () => void }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const aui = useAui();
  const item = useAuiState((s) => s.threadListItem);
  const selected = useAuiState((s) => s.threads.mainThreadId === s.threadListItem.id);
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} style={[styles.item, selected && styles.selected]} onPress={() => {
    if (!selected) {
      aui.thread.cancelRun();
      aui.threads.switchToThread(item.id);
    }
    onSelect();
  }}><Text numberOfLines={2} style={styles.itemText}>{item.title || `对话 ${index + 1}`}</Text></Pressable>;
}

export function ConversationList({ onSelect }: { onSelect: () => void }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View style={styles.container}>
    <ThreadListPrimitive.Items contentContainerStyle={styles.list} renderItem={({ index }) => <ConversationItem index={index} onSelect={onSelect} />} ListEmptyComponent={<Text style={styles.note}>暂无对话</Text>} />
  </View>;
}
const makeStyles = (theme: Theme) => StyleSheet.create({
  container: { flex: 1, gap: 16 },
  newButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  newLabel: { color: theme.color.ink, fontSize: 28 },
  list: { gap: 8 },
  item: { padding: 14, borderRadius: 16, borderWidth: 1, borderColor: 'transparent', gap: 6 },
  selected: { backgroundColor: theme.color.surface, borderColor: theme.color.border },
  itemText: { color: theme.color.ink, fontSize: 16, fontWeight: '600' },
  note: { color: theme.color.muted, fontSize: 12, lineHeight: 19 },
});
