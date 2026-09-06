import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ThreadListPrimitive, useAui, useAuiState } from '@assistant-ui/react-native';
import { theme } from '../ui/theme';

export function NewChatButton({ onSelect }: { onSelect?: () => void }) {
  const aui = useAui();
  return <Pressable accessibilityRole="button" accessibilityLabel="新建对话" testID="chat-new" style={styles.newButton} onPress={() => {
    aui.thread.cancelRun();
    aui.threads.switchToNewThread();
    onSelect?.();
  }}><Text style={styles.newLabel}>＋ 新对话</Text></Pressable>;
}

function ConversationItem({ index, onSelect }: { index: number; onSelect: () => void }) {
  const aui = useAui();
  const item = useAuiState((s) => s.threadListItem);
  const selected = useAuiState((s) => s.threads.mainThreadId === s.threadListItem.id);
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} style={[styles.item, selected && styles.selected]} onPress={() => {
    if (!selected) {
      aui.thread.cancelRun();
      aui.threads.switchToThread(item.id);
    }
    onSelect();
  }}><Text numberOfLines={2} style={styles.itemText}>{item.title || `成长对话 ${index + 1}`}</Text><Text style={styles.itemDetail}>{selected ? '正在查看' : '继续对话'}</Text></Pressable>;
}

export function ConversationList({ onSelect }: { onSelect: () => void }) {
  return <View style={styles.container}>
    <NewChatButton onSelect={onSelect} />
    <Text style={styles.heading}>本次对话</Text>
    <ThreadListPrimitive.Items contentContainerStyle={styles.list} renderItem={({ index }) => <ConversationItem index={index} onSelect={onSelect} />} ListEmptyComponent={<Text style={styles.note}>开始聊天后，会话会出现在这里。</Text>} />
    <Text style={styles.note}>本地演示 · 会话仅保留在本次运行中，重启后清空。</Text>
  </View>;
}
const styles = StyleSheet.create({
  container: { flex: 1, gap: 16 },
  newButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 14, backgroundColor: theme.color.yellow },
  newLabel: { color: theme.color.ink, fontWeight: '600', fontSize: 15 },
  heading: { color: theme.color.muted, fontSize: 13 },
  list: { gap: 8 },
  item: { padding: 14, borderRadius: 16, borderWidth: 1, borderColor: 'transparent', gap: 6 },
  selected: { backgroundColor: theme.color.surface, borderColor: theme.color.border },
  itemText: { color: theme.color.ink, fontSize: 16, fontWeight: '600' },
  itemDetail: { color: theme.color.muted, fontSize: 12 },
  note: { color: theme.color.muted, fontSize: 12, lineHeight: 19 },
});
