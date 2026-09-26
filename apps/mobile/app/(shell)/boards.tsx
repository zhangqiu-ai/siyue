import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import type { BoardStart, BoardSummary } from '@siyue/whiteboard';
import { boardStrings } from '@siyue/whiteboard/strings';
import { useWorkspace } from '../../src/account/workspace-provider';
import { useLocale } from '../../src/i18n';
import { TopBar, BarButton } from '../../src/shell/top-bar';
import { AppIcon, BottomSheet, Button, TextField, useTheme } from '../../src/ui';
import { boardAge, boardLibraryClient } from '../../src/whiteboard/library-client';
import { nativeBoardService } from '../../src/whiteboard/native-service';

const labels = {
  'zh-CN': { title: '白板', local: '自动保存在这台设备', new: '新建白板', blank: '空白白板', photo: '拍题开始', library: '从相册开始',
    empty: '还没有白板。选一种方式开始。', pages: (n: number) => `${n} 页`, more: '白板操作', rename: '重命名', delete: '删除白板',
    deleteBody: '删除后无法恢复。', cancel: '取消', save: '保存', failed: '无法读取白板库。原有白板已保留。', retry: '重试',
    actionFailed: '操作未完成，请重试。' },
  'en-US': { title: 'Whiteboards', local: 'Saved automatically on this device', new: 'New board', blank: 'Blank board', photo: 'Start from a photo', library: 'Start from library',
    empty: 'No boards yet. Choose a way to begin.', pages: (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`, more: 'Board actions', rename: 'Rename', delete: 'Delete board',
    deleteBody: 'This cannot be undone.', cancel: 'Cancel', save: 'Save', failed: 'Cannot open the board library. Your boards are kept.', retry: 'Retry',
    actionFailed: 'Action could not be completed. Try again.' },
};

export default function BoardsRoute() {
  const { state } = useWorkspace();
  return <BoardsScreen key={state.revision} />;
}

function BoardsScreen() {
  const { host } = useWorkspace();
  const { locale } = useLocale();
  const language = locale === 'en' ? 'en-US' : 'zh-CN';
  const t = labels[language];
  const theme = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [session] = useState(() => Crypto.randomUUID());
  const [service, setService] = useState<ReturnType<typeof nativeBoardService> | null>(null);
  const client = useMemo(() => service ? boardLibraryClient(session, service.request, Crypto.randomUUID) : null, [session, service]);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [newSheet, setNewSheet] = useState(false);
  const [selected, setSelected] = useState<BoardSummary | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const next = host ? host.board(session) : nativeBoardService(session);
    setService(next);
    return () => next.dispose();
  }, [host, session]);
  const refresh = useCallback(async () => {
    if (!client) return;
    try { const next = await client.list(boardStrings(language).migratedBoardTitle); setBoards(next); setError(false); }
    catch { setError(true); }
    finally { setLoading(false); }
  }, [client, language]);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  const open = (board: BoardSummary) => router.push({ pathname: '/whiteboard', params: { id: board.id } });
  const start = (choice: BoardStart) => { setNewSheet(false); router.push({ pathname: '/whiteboard', params: { start: choice } }); };
  const rename = async () => {
    if (!client || !selected || !name.trim() || busy) return;
    setBusy(true);
    try { await client.rename(selected.id, name); setRenaming(false); setSelected(null); await refresh(); }
    catch { Alert.alert(t.actionFailed); }
    finally { setBusy(false); }
  };
  const remove = () => {
    if (!client || !selected) return;
    const target = selected;
    Alert.alert(t.delete, t.deleteBody, [
      { text: t.cancel, style: 'cancel' },
      { text: t.delete, style: 'destructive', onPress: () => void (async () => {
        setBusy(true);
        try { await client.delete(target.id); setSelected(null); await refresh(); }
        catch { Alert.alert(t.actionFailed); }
        finally { setBusy(false); }
      })() },
    ]);
  };
  const columns = width >= 700 ? 3 : 2;
  const contentWidth = Math.min(width - 32, 900);
  const cardWidth = (contentWidth - 32 - 12 * (columns - 1)) / columns;
  const styles = makeStyles(theme);
  return <View style={styles.root} testID="board-library">
    <TopBar right={<BarButton icon="plus" label={t.new} onPress={() => setNewSheet(true)} />} />
    <ScrollView contentContainerStyle={[styles.content, { maxWidth: 900 }]}>
      <Text accessibilityRole="header" style={styles.title}>{t.title}</Text>
      <Text style={styles.lead}>{t.local}</Text>
      {error ? <View style={styles.error}><Text style={styles.errorText}>{t.failed}</Text><Button variant="tonal" label={t.retry} onPress={() => void refresh()} /></View> : null}
      {!error && !loading && boards.length === 0 ? <Text style={styles.empty}>{t.empty}</Text> : null}
      <View style={styles.grid}>
        {boards.map(board => <Pressable key={board.id} accessibilityRole="button" accessibilityLabel={`${board.title}, ${t.pages(board.pageCount)}`}
          onPress={() => open(board)} onLongPress={() => setSelected(board)} style={[styles.card, { width: cardWidth }]}>
          <View style={styles.thumbnail}>{board.thumbnail ? <Image source={{ uri: board.thumbnail }} resizeMode="contain" style={StyleSheet.absoluteFill} /> : <AppIcon name="board" size={40} color={theme.color.muted} />}</View>
          <Text style={styles.cardTitle} numberOfLines={2}>{board.title}</Text>
          <Text style={styles.meta}>{t.pages(board.pageCount)} · {boardAge(board.updatedAt, Date.now(), language)}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`${t.more}: ${board.title}`} onPress={event => { event.stopPropagation(); setSelected(board); }} style={styles.more}><AppIcon name="more" size={18} /></Pressable>
        </Pressable>)}
        <Pressable accessibilityRole="button" accessibilityLabel={t.new} onPress={() => setNewSheet(true)} style={[styles.newCard, { width: cardWidth }]}>
          <AppIcon name="plus" size={27} color={theme.color.muted} /><Text style={styles.newText}>{t.new}</Text>
        </Pressable>
      </View>
    </ScrollView>
    <BottomSheet visible={newSheet} onClose={() => setNewSheet(false)} title={t.new}>
      <View style={styles.choices}>
        <Button variant="tonal" icon="pen" label={t.blank} onPress={() => start('blank')} />
        <Button variant="tonal" icon="camera" label={t.photo} onPress={() => start('photo')} />
        <Button variant="tonal" icon="image" label={t.library} onPress={() => start('library')} />
      </View>
    </BottomSheet>
    <BottomSheet visible={selected !== null && !renaming} onClose={() => setSelected(null)} title={selected?.title}>
      <View style={styles.choices}>
        <Button variant="tonal" icon="edit" label={t.rename} onPress={() => { setName(selected?.title ?? ''); setRenaming(true); }} />
        <Button variant="danger" label={t.delete} onPress={remove} disabled={busy} />
      </View>
    </BottomSheet>
    <BottomSheet visible={renaming} onClose={() => { setRenaming(false); setSelected(null); }} title={t.rename}>
      <View style={styles.choices}><TextField label={t.rename} value={name} onChangeText={setName} maxLength={80} />
        <Button label={t.save} disabled={!name.trim() || busy} onPress={() => void rename()} /></View>
    </BottomSheet>
  </View>;
}

const makeStyles = (theme: ReturnType<typeof useTheme>) => StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.background },
  content: { alignSelf: 'center', width: '100%', paddingHorizontal: 16, paddingBottom: 32 },
  title: { color: theme.color.ink, fontSize: 28, lineHeight: 34, fontWeight: '600', marginTop: 20 },
  lead: { color: theme.color.muted, fontSize: 15, lineHeight: 22, marginTop: 6, marginBottom: 24 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: { backgroundColor: theme.color.surface, borderRadius: 20, padding: 10, paddingBottom: 12, minHeight: 192 },
  thumbnail: { width: '100%', aspectRatio: 4 / 3, borderRadius: 12, backgroundColor: theme.color.background, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginBottom: 10 },
  cardTitle: { color: theme.color.ink, fontSize: 15, lineHeight: 21, fontWeight: '600', paddingHorizontal: 4 },
  meta: { color: theme.color.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 4, marginTop: 2 },
  more: { position: 'absolute', right: 10, bottom: 8, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  newCard: { minHeight: 192, borderWidth: 1.5, borderStyle: 'dashed', borderColor: theme.color.controlBorder, borderRadius: 20, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 8 },
  newText: { color: theme.color.muted, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  choices: { gap: 10 },
  empty: { color: theme.color.muted, fontSize: 15, lineHeight: 22, marginBottom: 18 },
  error: { backgroundColor: theme.color.errorSurface, padding: 16, borderRadius: 16, gap: 12, marginBottom: 18 },
  errorText: { color: theme.color.error, fontSize: 14, lineHeight: 20 },
});
