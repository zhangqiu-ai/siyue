import { useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { Goal, Task } from '@siyue/contracts';
import { AppIcon, Banner, BottomSheet, Button, ListGroup, ListRow, Screen, SectionLabel, useTheme } from '../../ui';
import { useLocale } from '../../i18n';
import { DatePickerSheet } from '../components/date-picker-sheet';
import { MetaChip, MetaRow, ProgressBar } from '../components/space-chrome';
import { TaskRow } from '../components/space-lists';
import { formatLocalDate, localDateOf } from '../dates';
import { goalProgress } from '../goal-progress';
import { usePlanSnapshot } from '../use-plan-snapshot';
import { useSpaceText } from '../use-space-text';

type Editor = { kind: 'goal'; id: string; version: number; title: string; date: string | null }
  | { kind: 'task'; id: string; version: number; title: string; date: string | null };

export default function GoalDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter(), theme = useTheme(), t = useSpaceText(), { locale } = useLocale();
  const { snapshot, loading, failed, reload, update, addTask } = usePlanSnapshot();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [calendar, setCalendar] = useState(false);
  const [menu, setMenu] = useState(false);
  const [why, setWhy] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newTasks, setNewTasks] = useState<Record<string, string>>({});
  const [savingTask, setSavingTask] = useState(false);
  const savingTaskRef = useRef(false);
  const goal = snapshot?.goals.find(item => item.id === id);
  const progress = useMemo(() => snapshot && goal ? goalProgress(snapshot, goal.id) : null, [snapshot, goal]);
  const projects = snapshot?.projects.filter(item => item.goalId === goal?.id && item.status !== 'archived') ?? [];
  const openTasks = progress?.tasks.filter(item => item.status === 'open') ?? [];
  const doneTasks = progress?.tasks.filter(item => item.status === 'done') ?? [];
  const today = localDateOf();
  const act = async (kind: 'goal' | 'task', entity: Goal | Task, patch: Record<string, unknown>) => {
    setNotice(null);
    const result = await update(kind, entity.id, entity.version, patch);
    if (result.kind === 'applied') { setEditor(null); setMenu(false); setCalendar(false); }
    else setNotice(t(result.kind === 'conflict' ? 'home.changedBody' : 'home.error'));
  };
  const submitTask = async (projectId?: string) => {
    if (!goal || savingTaskRef.current) return;
    const key = projectId ?? goal.id;
    const title = (newTasks[key] ?? '').trim();
    if (!title) return;
    savingTaskRef.current = true;
    setSavingTask(true);
    setNotice(null);
    try {
      const result = await addTask(goal.id, title, projectId);
      if (result.kind === 'applied') setNewTasks(current => ({ ...current, [key]: '' }));
      else setNotice(t(result.kind === 'conflict' ? 'home.changedBody' : 'goal.addFailed'));
    } finally {
      savingTaskRef.current = false;
      setSavingTask(false);
    }
  };
  const addRow = (projectId?: string) => {
    if (!goal || goal.status === 'archived') return null;
    const key = projectId ?? goal.id;
    return <View style={styles.addRow}>
      <TextInput accessibilityLabel={t('draft.add')} placeholder={t('draft.add')} placeholderTextColor={theme.color.muted}
        value={newTasks[key] ?? ''} onChangeText={value => setNewTasks(current => ({ ...current, [key]: value }))}
        editable={!savingTask} maxLength={240} returnKeyType="done" onSubmitEditing={() => void submitTask(projectId)}
        style={[styles.addInput, { color: theme.color.ink }]} />
      <Pressable accessibilityRole="button" accessibilityLabel={t('draft.add')}
        accessibilityState={{ disabled: savingTask || !(newTasks[key] ?? '').trim() }}
        disabled={savingTask || !(newTasks[key] ?? '').trim()}
        onPress={() => void submitTask(projectId)} style={styles.addButton}>
        <AppIcon name="plus" size={20} color={(newTasks[key] ?? '').trim() ? theme.color.accent : theme.color.muted} />
      </Pressable>
    </View>;
  };
  const taskRow = (task: Task) => <TaskRow key={task.id} title={task.title}
    done={task.status === 'done'}
    due={formatLocalDate(locale, task.dueLocalDate, today)}
    toggleLabel={t(task.status === 'done' ? 'goal.uncheckTask' : 'goal.checkTask', { title: task.title })}
    onToggle={() => void act('task', task, { status: task.status === 'done' ? 'open' : 'done' })}
    openLabel={t('goal.editTask', { title: task.title })}
    onOpen={() => setEditor({ kind: 'task', id: task.id, version: task.version, title: task.title, date: task.dueLocalDate ?? null })}
  />;
  const dateLabels = { title: editor?.kind === 'goal' ? t('goal.date') : t('goal.taskDue'), today: t('goal.dueToday'), tomorrow: t('goal.dueTomorrow'), saturday: t('goal.dueSaturday'), clear: t('goal.dueClear'), pick: t('goal.duePick') };
  const saveEditor = () => {
    if (!editor || !snapshot || !editor.title.trim()) return;
    const entity = editor.kind === 'goal' ? snapshot.goals.find(item => item.id === editor.id) : snapshot.tasks.find(item => item.id === editor.id);
    if (!entity || entity.version !== editor.version) { setNotice(t('home.changedBody')); setEditor(null); return; }
    void act(editor.kind, entity, editor.kind === 'goal'
      ? { title: editor.title.trim(), targetDate: editor.date }
      : { title: editor.title.trim(), dueLocalDate: editor.date });
  };
  if (!goal && !loading) return <Screen title={t('goal.missing')}><Button label={t('goal.missingAction')} onPress={() => router.replace('/space')} /></Screen>;
  return <>
    <Screen maxWidth={680} testID="goal-detail">
      <Pressable accessibilityRole="button" accessibilityLabel={t('goal.missingAction')} onPress={() => router.replace('/space')} style={styles.back}>
        <Text style={{ color: theme.color.accent, fontSize: 16 }}>‹ {t('home.goals')}</Text>
      </Pressable>
      {failed && <Banner kind="warn" title={t('home.error')} action={<Button label={t('home.retry')} size="sm" onPress={() => void reload()} />} />}
      {notice && <Banner kind="warn" title={notice} />}
      {goal && progress && <>
        <View style={styles.headingRow}>
          <Text accessibilityRole="header" style={[styles.heading, { color: theme.color.ink }]}>{goal.title}</Text>
          {goal.status !== 'archived' && <Button label={t('goal.more')} variant="tonal" size="sm" onPress={() => setMenu(true)} />}
        </View>
        <MetaRow>
          {goal.targetDate && <MetaChip icon="calendar" label={formatLocalDate(locale, goal.targetDate, today) ?? goal.targetDate} />}
          <MetaChip icon="check" label={t('goal.doneCount', { done: progress.completed, total: progress.total })} />
        </MetaRow>
        <ProgressBar ratio={progress.total ? progress.completed / progress.total : 0} />
        {goal.rationale && <Pressable accessibilityRole="button" accessibilityState={{ expanded: why }} onPress={() => setWhy(value => !value)} style={styles.expand}>
          <Text style={[styles.expandLabel, { color: theme.color.ink }]}>{t('goal.why')} {why ? '⌃' : '⌄'}</Text>
          {why && <Text style={[styles.body, { color: theme.color.muted }]}>{goal.rationale}</Text>}
        </Pressable>}
        {goal.status === 'archived' && <Banner kind="info" title={t('goal.archivedNotice')} />}
        {projects.map(project => <View key={project.id}>
          <SectionLabel>{project.title}</SectionLabel>
          <ListGroup>
            {openTasks.filter(task => task.projectId === project.id).map(taskRow)}
            {addRow(project.id)}
          </ListGroup>
        </View>)}
        {projects.length === 0 && goal.status !== 'archived' && <ListGroup>{addRow()}</ListGroup>}
        {doneTasks.length > 0 && <>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: doneOpen }} onPress={() => setDoneOpen(value => !value)} style={styles.expand}>
            <Text style={[styles.expandLabel, { color: theme.color.ink }]}>{t('goal.doneTasks', { count: doneTasks.length })} {doneOpen ? '⌃' : '⌄'}</Text>
          </Pressable>
          {doneOpen && <ListGroup>{doneTasks.map(taskRow)}</ListGroup>}
        </>}
      </>}
    </Screen>
    <BottomSheet visible={menu} onClose={() => setMenu(false)} title={goal?.title}>
      {goal && <View style={styles.menu}>
        <ListGroup>
          <ListRow title={t('goal.rename')} onPress={() => { setEditor({ kind: 'goal', id: goal.id, version: goal.version, title: goal.title, date: goal.targetDate ?? null }); setMenu(false); }} />
          <ListRow title={t(goal.status === 'completed' ? 'goal.reopen' : 'goal.complete')} onPress={() => void act('goal', goal, { status: goal.status === 'completed' ? 'active' : 'completed' })} />
          <ListRow title={t('goal.archive')} destructive onPress={() => { setMenu(false); Alert.alert(t('goal.archive'), t('goal.archiveBody'), [
            { text: t('goal.cancel'), style: 'cancel' },
            { text: t('goal.archiveAction'), style: 'destructive', onPress: () => void act('goal', goal, { status: 'archived' }) },
          ]); }} />
        </ListGroup>
      </View>}
    </BottomSheet>
    <BottomSheet visible={!!editor} onClose={() => setEditor(null)} title={editor?.kind === 'goal' ? t('goal.rename') : t('goal.editTask', { title: editor?.title ?? '' })}>
      {editor && <View style={styles.editor}>
        <TextInput accessibilityLabel={editor.kind === 'goal' ? t('draft.titleLabel') : t('goal.taskTitle')} value={editor.title}
          onChangeText={title => setEditor({ ...editor, title })} maxLength={editor.kind === 'goal' ? 160 : 240}
          style={[styles.editInput, { color: theme.color.ink, borderColor: theme.color.border }]} />
        <MetaChip icon="calendar" label={editor.date ? formatLocalDate(locale, editor.date, today) ?? editor.date : t('goal.dueNone')}
          onPress={() => setCalendar(true)} />
        <Button label={t('goal.save')} disabled={!editor.title.trim() || loading} onPress={saveEditor} />
      </View>}
    </BottomSheet>
    <DatePickerSheet visible={calendar} onClose={() => setCalendar(false)} locale={locale} labels={dateLabels} value={editor?.date}
      onSelect={date => { if (editor) setEditor({ ...editor, date }); setCalendar(false); }}
      onClear={() => { if (editor) setEditor({ ...editor, date: null }); setCalendar(false); }} />
  </>;
}

const styles = StyleSheet.create({
  back: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', marginBottom: 10 },
  headingRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  heading: { fontSize: 26, lineHeight: 34, fontWeight: '600', flex: 1 },
  body: { fontSize: 15, lineHeight: 23 },
  expand: { paddingVertical: 16, gap: 8 },
  expandLabel: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  addRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 8 },
  addInput: { flex: 1, fontSize: 16, minHeight: 44 },
  addButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  menu: { paddingTop: 12 },
  editor: { gap: 16, paddingTop: 14 },
  editInput: { minHeight: 52, borderBottomWidth: 1, fontSize: 17 },
});
