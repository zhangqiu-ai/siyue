import {useWorkspaceValue} from '../account/workspace-scratch';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Keyboard, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { DrawerToggleButton } from 'expo-router/drawer';
import { useNavigation, usePreventRemove } from 'expo-router/react-navigation';
import type { PlanSnapshot } from '@siyue/adapters';
import { getClient } from '../client';
import { useLocale } from '../i18n';
import { AppIcon } from '../ui/icon';
import { useTheme } from '../ui/theme';
import { goalProgress, taskEditState } from '../space/goal-progress';

export default function PersonalSpaceScreen() {
  const { t, locale } = useLocale();
  const theme = useTheme();
  const navigation = useNavigation();
  const router = useRouter();
  const { width, fontScale } = useWindowDimensions();
  const wide = width >= 820 && fontScale <= 1.4;
  const [snapshot, setSnapshot] = useState<PlanSnapshot | null>(null);
  const [selected, setSelected] = useWorkspaceValue<string | null>('space.selected',null);
  const [editing, setEditing] = useWorkspaceValue<{ id: string; version: number; title: string; originalTitle: string } | null>('space.editing',null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState(false);
  const [clock, setClock] = useState(Date.now());
  useFocusEffect(useCallback(() => {
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []));
  const dirty = !!editing && editing.title !== editing.originalTitle;
  usePreventRemove(dirty || busy, ({ data }) => {
    if (busy) { Alert.alert(t('space.loading')); return; }
    Alert.alert(t('ai.discardTitle'), t('space.discardBody'), [
      { text: t('ai.keepEditing'), style: 'cancel' },
      { text: t('ai.discard'), style: 'destructive', onPress: () => navigation.dispatch(data.action) },
    ]);
  });
  const locked = useRef(false), mounted = useRef(true), revision = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  const refresh = useCallback(async () => {
    if (locked.current) return;
    const request = ++revision.current;
    setBusy(true); setError(false);
    try {
      const data = await (await getClient()).snapshot();
      if (mounted.current && request === revision.current) setSnapshot(data);
    } catch { if (mounted.current && request === revision.current) setError(true); }
    finally { if (mounted.current && request === revision.current) setBusy(false); }
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  const update = async (task: { id: string; version: number }, patch: { title?: string; status?: 'open' | 'done' }) => {
    if (locked.current || busy) return;
    locked.current = true; revision.current++; setBusy(true); setError(false); setNotice(false);
    let saved = false;
    try {
      const client = await getClient();
      await client.update('task', task.id, task.version, patch);
      saved = true;
      // Refresh the formal query after its verified receipt; never guess a new version.
      const data = await client.snapshot();
      if (mounted.current) { setSnapshot(data); setEditing(null); Keyboard.dismiss(); setNotice(true); }
    } catch {
      if (mounted.current) { setError(true); if (saved) setEditing(null); }
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const goals = snapshot?.goals.filter(goal => goal.status !== 'archived') ?? [];
  const goal = goals.find(item => item.id === selected);
  const editState = editing ? taskEditState(snapshot, editing) : null;
  const progress = snapshot && goal ? goalProgress(snapshot, goal.id) : null;
  const cancelEdit = useCallback(() => {
    if (busy) return;
    const close = () => { Keyboard.dismiss(); setEditing(null); setError(false); };
    if (!dirty) { close(); return; }
    Alert.alert(t('ai.discardTitle'), t('space.discardBody'), [
      { text: t('ai.keepEditing'), style: 'cancel' },
      { text: t('ai.discard'), style: 'destructive', onPress: close },
    ]);
  }, [busy, dirty, t]);
  const back = useCallback(() => { setSelected(null); setNotice(false); }, []);
  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (editing) { cancelEdit(); return true; }
      if (selected) { back(); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [editing, selected, cancelEdit, back]));
  useLayoutEffect(() => {
    const saveDisabled = !dirty || busy || !editing?.title.trim() || !editState?.canEdit || editState.changed;
    navigation.setOptions({
      title: editing ? t('space.editTitle') : goal ? t('space.goalTitle') : t('space.title'),
      // Give large-text editing actions the full toolbar; keep context in the body.
      headerTitle: editing && fontScale > 1.4 ? () => null : undefined,
      swipeEnabled: !selected && !editing,
      headerLeft: () => editing
        ? <Pressable accessibilityRole="button" disabled={busy} onPress={cancelEdit} style={styles.navButton}><Text style={{ color: theme.color.ink, fontSize: 17, opacity: busy ? 0.4 : 1 }}>{t('space.cancel')}</Text></Pressable>
        : selected
          ? <Pressable accessibilityRole="button" accessibilityLabel={t('common.back')} onPress={back} style={styles.navButton}><AppIcon name="back" /></Pressable>
          : <DrawerToggleButton accessibilityLabel={t('sidebar.open')} tintColor={theme.color.ink} />,
      headerRight: () => editing
        ? <Pressable accessibilityRole="button" accessibilityLabel={t('space.save')} accessibilityState={{ disabled: saveDisabled }} disabled={saveDisabled} onPress={() => void update(editing, { title: editing.title.trim() })} style={styles.navButton}>{busy ? <ActivityIndicator color={theme.color.ink} /> : <Text style={{ color: theme.color.ink, fontSize: 17, fontWeight: '600', opacity: saveDisabled ? 0.35 : 1 }}>{t('space.saveShort')}</Text>}</Pressable>
        : null,
    });
  });
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const count = (done: number, total: number) => t('space.progress', { done: number(done), total: number(total) });
  const text = { color: theme.color.ink }, muted = { color: theme.color.muted };
  const button = { minHeight: 48, padding: 12, justifyContent: 'center' as const, borderRadius: 12 };
  const goalsPane = <View style={[styles.pane, wide && { flex: 1 }]}>
    <Text style={[styles.caption, muted]}>{new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</Text>
    <Text accessibilityRole="header" style={[styles.heading, text]}>{t('space.continue')}</Text>
    <Text style={[styles.caption, muted]}>{t('space.local')}</Text>
    <Pressable accessibilityRole="button" disabled={busy || !!editing} onPress={() => router.push('/plan-create')} style={[button, {backgroundColor: theme.color.accent, borderRadius: 28, alignItems: 'center'}]}><Text style={{color: theme.color.onAccent, fontSize: 17, fontWeight: '600'}}>{t('plan.create')}</Text></Pressable>
    {!!snapshot?.drafts.some(item => item.command.kind === 'plan.create' && ['draft', 'approved', 'expired'].includes(item.status)) && <>
      <Text accessibilityRole="header" style={[styles.title, text]}>{t('draft.list')}</Text>
      {snapshot.drafts.filter(item => item.command.kind === 'plan.create' && ['draft', 'approved', 'expired'].includes(item.status)).map(item =>
        <Pressable key={item.id} accessibilityRole="button" disabled={!!editing || busy}
          onPress={() => router.push({pathname: '/plan-draft', params: {id: item.id}})}
          style={[styles.card, {backgroundColor: theme.color.surface}]}>
          <View style={styles.actions}><AppIcon name="compose" /><View style={{flex: 1}}><Text style={[styles.body, text]}>{item.command.kind === 'plan.create' ? item.command.payload.title : ''}</Text>{(item.status === 'expired' || Date.parse(item.expiresAt) <= clock) && <Text style={[styles.caption, muted]}>{t('draft.expired')}</Text>}</View><AppIcon name="chevronRight" /></View>
        </Pressable>)}
    </>}
    {goals.map((item, index) => {
      const value = goalProgress(snapshot!, item.id), focus = index === 0;
      return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.title}, ${count(value.completed, value.total)}`} accessibilityState={{ selected: selected === item.id, disabled: !!editing }} disabled={!!editing} onPress={() => { setSelected(item.id); setNotice(false); }} style={({ pressed }) => [styles.card, { backgroundColor: focus ? (pressed ? theme.color.focusPressed : theme.color.focus) : (pressed ? theme.color.subtle : theme.color.surface), borderWidth: selected === item.id ? 2 : 0, borderColor: theme.color.selectedBorder }]}>
        <Text style={[styles.title, { color: focus ? theme.color.onFocus : theme.color.ink }]}>{item.title}</Text>
        <View accessibilityRole="progressbar" accessibilityLabel={item.title} accessibilityValue={{ min: 0, max: value.total || 1, now: value.completed, text: count(value.completed, value.total) }} style={[styles.track, { backgroundColor: focus ? theme.color.focusTrack : theme.color.progressTrack }]}><View style={{ height: 6, width: `${value.total ? value.completed / value.total * 100 : 0}%`, backgroundColor: focus ? theme.color.focusProgress : theme.color.progress }} /></View>
        <Text style={[styles.caption, { color: focus ? theme.color.focusMuted : theme.color.muted }]}>{count(value.completed, value.total)}</Text>
        <View style={styles.trailing}><AppIcon name="chevronRight" color={focus ? theme.color.onFocus : theme.color.ink} /></View>
      </Pressable>;
    })}
    {!busy && snapshot && goals.length === 0 && <View style={[styles.card, { backgroundColor: theme.color.surface }]}><Text style={[styles.title, text]}>{t('space.empty')}</Text><Text style={[styles.body, muted]}>{t('space.emptyBody')}</Text></View>}
  </View>;
  const detailPane = goal && progress ? <View style={[styles.pane, wide && { flex: 1.3 }]}>
    <Text accessibilityRole="header" style={[styles.heading, text]}>{goal.title}</Text>
    <View style={[styles.actions, { flexWrap: 'wrap' }]}><Text style={[styles.caption, muted]}>{count(progress.completed, progress.total)}</Text>{notice && <Text accessibilityLiveRegion="polite" style={[styles.caption, muted]}>{t('space.saved')}</Text>}</View>
    {progress.tasks.length === 0 && <Text style={[styles.body, muted]}>{t('space.noTasks')}</Text>}
    <View style={[styles.card, { backgroundColor: theme.color.surface }]}>
      {progress.tasks.map(task => <View key={task.id} style={[styles.task, { borderBottomColor: theme.color.border }]}>
        <>
          <Pressable accessibilityRole="checkbox" accessibilityLabel={task.title} accessibilityState={{ checked: task.status === 'done', disabled: busy || !!editing }} disabled={busy || !!editing} onPress={() => void update(task, { status: task.status === 'done' ? 'open' : 'done' })} style={[button, { width: 48, alignItems: 'center' }]}><View style={[styles.checkbox, { borderColor: theme.color.controlBorder, backgroundColor: task.status === 'done' ? theme.color.accent : theme.color.surface }]}>{task.status === 'done' && <AppIcon name="check" size={18} color={theme.color.onAccent} />}</View></Pressable>
          <Text style={[styles.body, text, { flex: 1, textDecorationLine: task.status === 'done' ? 'line-through' : 'none' }]}>{task.title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t('space.editTask', { title: task.title })} disabled={busy || !!editing} onPress={() => { setEditing({ id: task.id, version: task.version, title: task.title, originalTitle: task.title }); setNotice(false); }} style={button}><AppIcon name="compose" /></Pressable>
        </>
      </View>)}
    </View>
  </View> : null;
  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }} edges={['bottom']}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" refreshControl={!editing ? <RefreshControl refreshing={busy && !locked.current} onRefresh={() => void refresh()} tintColor={theme.color.muted} colors={[theme.color.accent]} /> : undefined} automaticallyAdjustKeyboardInsets contentContainerStyle={[styles.content, { maxWidth: editing ? 640 : wide ? 1180 : theme.layout.contentWidth }]}>
      {error && <View style={styles.actions}><Text accessibilityRole="alert" style={[styles.body, text, { flex: 1 }]}>{t('space.error')}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('space.refresh')} disabled={busy} onPress={() => void refresh()} style={button}><AppIcon name="retry" /></Pressable></View>}
      {editing && fontScale > 1.4 && <Text accessibilityRole="header" style={[styles.heading, text]}>{t('space.editTitle')}</Text>}
      {editing && editState && <View style={[styles.card, { backgroundColor: theme.color.surface }]}>
        <Text key={`task-name-${fontScale}`} accessibilityRole="header" style={[styles.title, text]}>{t('space.taskName')}</Text>
        <TextInput selectionColor={theme.color.accent} autoFocus accessibilityLabel={t('space.taskName')} multiline maxLength={240} editable={!busy} value={editing.title} onChangeText={title => setEditing({ ...editing, title })} style={[styles.input, text, { borderColor: theme.color.controlBorder }]} />
        {!editState.canEdit && <Text accessibilityRole="alert" style={[styles.body, text]}>{t('space.unavailable')}</Text>}
        {editState.canEdit && editState.changed && <View style={{ gap: 8 }}><Text accessibilityRole="alert" style={[styles.body, text]}>{t('space.changed')}</Text><Text selectable style={[styles.body, muted]}>{editState.task?.title}</Text><Pressable accessibilityRole="button" disabled={busy} style={button} onPress={() => setEditing({ ...editing, version: editState.task!.version })}><Text style={text}>{t('space.applyLatest')}</Text></Pressable></View>}

      </View>}
      {!editing && <View style={{ flexDirection: wide ? 'row' : 'column', gap: 32 }}>{(wide || !goal) && goalsPane}{detailPane}</View>}
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  navButton: { minWidth: 48, minHeight: 48, paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center' },
  content: { width: '100%', alignSelf: 'center', padding: 20, gap: 16, paddingBottom: 40 },
  pane: { gap: 20, minWidth: 0 }, heading: { fontSize: 28, fontWeight: '600' }, title: { fontSize: 21, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24 }, caption: { fontSize: 13, lineHeight: 21 }, card: { padding: 20, borderRadius: 24, gap: 12 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' }, trailing: { alignItems: 'flex-end' },
  task: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 }, input: { borderWidth: 1, borderRadius: 12, padding: 12, minHeight: 56, fontSize: 17 },
  checkbox: { width: 24, height: 24, borderRadius: 7, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
