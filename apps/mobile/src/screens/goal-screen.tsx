import { Link } from 'expo-router';
import { theme } from '../ui/theme';
import { describeError } from '../errors';
import { useEffect, useRef, useState } from 'react';
import type { LocalClient, PlanSnapshot } from '@siyue/adapters';
import type { ActionDraft, AgentRun, GoalDraft } from '@siyue/contracts';

const runMessages: Record<AgentRun['status'], string> = {
  queued: '等待生成示例计划。尚未创建正式记录。',
  running: '正在生成示例计划。尚未创建正式记录。',
  awaiting_approval: '草稿已就绪，等待你检查和确认。可从待确认草稿继续。',
  interrupted: '上次生成已中断，没有自动重试。你可以重新生成；已有草稿可另行继续。',
  succeeded: '计划已确认完成，正式结果可在“我的行动”中查看。',
  failed: '上次生成失败，没有自动重试。请检查已存草稿与正式记录后再尝试。',
  cancelled: '上次运行已取消。取消不代表回滚，请以已存草稿与正式记录为准。',
};
const blank: GoalDraft = { title: '', rationale: '', projectTitles: [], taskTitles: [] };
const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

function usePlan(loadClient: () => Promise<LocalClient>) {
  const client = useRef<LocalClient | null>(null);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState<PlanSnapshot | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [goal, setGoal] = useState('');
  const [draft, setDraft] = useState<ActionDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<GoalDraft>(blank);
  const [projects, setProjects] = useState('');
  const [tasks, setTasks] = useState('');
  const payload: GoalDraft = { ...value, title: value.title.trim(), projectTitles: lines(projects), taskTitles: lines(tasks) };
  const savedPayload = draft?.command.kind === 'plan.create' ? draft.command.payload : null;
  const dirty = !!savedPayload && JSON.stringify(payload) !== JSON.stringify({ ...savedPayload, rationale: savedPayload.rationale ?? '' });
  async function perform(label: string, operation: (api: LocalClient) => Promise<void>) {
    if (lock.current) return false;
    lock.current = true; setBusy(label); setError(''); setNotice('');
    try {
      const api = client.current ?? await loadClient();
      client.current = api;
      await operation(api);
      setSnapshot(await api.snapshot());
      return true;
    } catch (failure) {
      setError(describeError(failure));
      if (client.current) {
        try { setSnapshot(await client.current.snapshot()); } catch { /* Keep the last verified view and the error. */ }
      }
      return false;
    } finally { lock.current = false; setBusy(''); }
  }
  const refresh = () => perform('读取本地记录', async () => {});
  useEffect(() => { void refresh(); return () => controller.current?.abort(); }, []);
  function loadEditor(next: GoalDraft, source: ActionDraft | null) {
    setValue({ ...next, rationale: next.rationale ?? '' }); setProjects(next.projectTitles.join('\n'));
    setTasks(next.taskTitles.join('\n')); setDraft(source); setEditing(true); setNotice('');
  }
  async function propose() {
    if (lock.current) return;
    const abort = new AbortController(); controller.current = abort;
    try {
      await perform('生成示例计划', async (api) => {
        const next = await api.propose(goal, abort.signal);
        if (abort.signal.aborted) { setNotice('生成已取消，请检查待确认草稿。'); return; }
        if (next.command.kind !== 'plan.create') throw new Error('Unexpected draft');
        loadEditor(next.command.payload, next);
        setNotice('示例草稿已保存到本机，尚未创建正式目标。');
      });
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  }
  async function saveDraft() {
    if (!draft) return;
    await perform('保存草稿', async (api) => {
      const next = await api.editDraft(draft.id, draft.version, payload);
      setDraft(next); setValue(payload); setNotice('草稿修改已保存。请检查后明确确认。');
    });
  }
  async function confirm() {
    if (!draft || dirty) return;
    await perform('确认并保存', async (api) => {
      const receipt = await api.confirmDraft(draft.id, draft.version);
      setEditing(false); setDraft(null); setValue(blank); setProjects(''); setTasks(''); setNotice(`已保存到本机 · ${receipt.result.entities.length} 条正式记录。`);
    });
  }
  async function manual() {
    await perform('保存手动计划', async (api) => {
      const receipt = await api.saveManual(payload);
      setEditing(false); setValue(blank); setProjects(''); setTasks(''); setNotice(`已保存到本机 · ${receipt.result.entities.length} 条正式记录。`);
    });
  }
  async function discard() {
    if (!draft) return;
    await perform('拒绝草稿', async (api) => {
      await api.discardDraft(draft.id, draft.version);
      setDraft(null); setNotice('草稿已拒绝，没有创建正式目标。编辑内容保留，可手动保存。');
    });
  }
  const update = (kind: 'goal' | 'project' | 'task', id: string, version: number, patch: Parameters<LocalClient['update']>[3]) =>
    perform('保存记录', async (api) => { await api.update(kind, id, version, patch); setNotice('修改已保存到本机。'); });
  return { snapshot, busy, error, notice, goal, setGoal, draft, editing, value, setValue, projects, setProjects, tasks, setTasks,
    payload, dirty, refresh, propose, saveDraft, confirm, manual, discard, update,
    cancel: () => controller.current?.abort(),
    startManual: () => loadEditor({ ...blank, title: goal.trim() }, null),
    resume: (item: ActionDraft) => { if (item.command.kind === 'plan.create') loadEditor(item.command.payload, item); },
    close: () => setEditing(false), reopen: () => setEditing(true),
  };
}

import { getClient } from '../client';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

function Button({ title, onPress, disabled = false, primary = false, testID }: { title: string; onPress: () => void; disabled?: boolean; primary?: boolean; testID?: string }) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, primary && styles.primary, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={[styles.buttonText, primary && styles.primaryText]}>{title}</Text>
  </Pressable>;
}
function Field({ label, value, onChangeText, multiline = false, maxLength, disabled = false, testID }: {
  label: string; value: string; onChangeText: (value: string) => void; multiline?: boolean; maxLength?: number; disabled?: boolean; testID?: string;
}) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput testID={testID} accessibilityLabel={label} value={value} onChangeText={onChangeText}
    multiline={multiline} maxLength={maxLength} editable={!disabled} style={[styles.input, multiline && styles.multiline]} textAlignVertical="top" /></View>;
}
function RecordRow({ kind, record, disabled, update }: {
  kind: 'goal' | 'project' | 'task'; record: { id: string; version: number; title: string; status: string };
  disabled: boolean; update: ReturnType<typeof usePlan>['update'];
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(record.title);
  return <View testID={`siyue-record-${kind}-${record.id}`} collapsable={false} style={styles.record}>
    {editing ? <><Field label="修改名称" value={title} onChangeText={setTitle} maxLength={kind === 'task' ? 240 : 160} disabled={disabled} />
      <View style={styles.actions}><Button testID={`siyue-record-save-name-${kind}-${record.id}`} title="保存名称" disabled={disabled || !title.trim()} onPress={() => void update(kind, record.id, record.version, { title }).then((ok) => { if (ok) setEditing(false); })} />
      <Button testID={`siyue-record-cancel-name-${kind}-${record.id}`} title="取消改名" disabled={disabled} onPress={() => setEditing(false)} /></View></>
      : <><Text style={[styles.recordTitle, record.status === 'done' && styles.done]}>{record.title}</Text>
        <Text testID={`siyue-record-status-${kind}-${record.id}`} style={styles.hint}>{record.status === 'archived' ? '已归档' : record.status === 'done' || record.status === 'completed' ? '已完成' : kind === 'task' ? '待完成' : '进行中'}</Text>
        {record.status !== 'archived' && <View style={styles.actions}>
          {kind === 'task' && record.status !== 'archived' && <Button testID={`siyue-task-toggle-${record.id}`} title={record.status === 'done' ? '撤销完成' : '完成任务'} disabled={disabled} onPress={() => void update(kind, record.id, record.version, { status: record.status === 'done' ? 'open' : 'done' })} />}
          <Button testID={`siyue-record-rename-${kind}-${record.id}`} title="改名" disabled={disabled} onPress={() => { setTitle(record.title); setEditing(true); }} />
          <Button testID={`siyue-record-archive-${kind}-${record.id}`} title="归档" disabled={disabled} onPress={() => void update(kind, record.id, record.version, { status: 'archived' })} />
        </View>}</>}
  </View>;
}
export default function HomeScreen({ loadClient = getClient, embedded = false }: { loadClient?: () => Promise<LocalClient>; embedded?: boolean } = {}) {
  const plan = usePlan(loadClient);
  const disabled = !!plan.busy || !plan.snapshot;
  const latestRun = plan.snapshot?.runs.reduce<AgentRun | undefined>((latest, run) => !latest || run.updatedAt > latest.updatedAt ? run : latest, undefined);
  const pending = plan.snapshot?.drafts.filter((item) => ['draft', 'approved'].includes(item.status) && item.command.kind === 'plan.create') ?? [];
  return <SafeAreaView style={styles.safe} edges={embedded ? [] : ['top', 'bottom']}><StatusBar style="dark" />
    <KeyboardAvoidingView style={styles.safe} enabled={!embedded || Platform.OS !== 'ios'} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView automaticallyAdjustKeyboardInsets={embedded} testID="siyue-main-scroll" contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {embedded && __DEV__ && <Link href="/ui-preview" style={{ color: '#A8421F', paddingVertical: 12 }}>打开原生组件预览 →</Link>}
        <Text testID="siyue-page-start" style={styles.eyebrow}>SIYUE / 思玥</Text><Text style={styles.title} accessibilityRole="header">让想做的事，{ '\n' }有一个开始。</Text>
        <Text style={styles.lead}>写下一个目标，把它变成今天能做的小事。</Text>
        <Text testID="siyue-local-state" style={styles.badge}>{plan.error ? plan.snapshot ? '本机空间状态待核对' : '本机空间暂不可用' : plan.snapshot ? '本机空间 · 离线可用' : '正在连接本机空间'}</Text>
        {!!plan.busy && <View style={styles.actions}><ActivityIndicator color="#365d48" /><Text accessibilityLiveRegion="polite" style={styles.hint}>{plan.busy}…</Text></View>}
        {!!plan.notice && <Text accessibilityLiveRegion="polite" style={styles.notice}>{plan.notice}</Text>}
        {!!plan.error && <View style={styles.error}><Text testID="siyue-error-message" accessibilityRole="alert" style={styles.errorText}>{plan.error}</Text><Button title="重新读取本地记录" disabled={!!plan.busy} onPress={() => void plan.refresh()} /></View>}
        {latestRun && <View style={styles.runStatus}><Text style={styles.label}>最近一次示例计划</Text><Text testID="siyue-run-status" accessibilityLiveRegion="polite" style={styles.hint}>{runMessages[latestRun.status]}</Text></View>}
        <View style={styles.panel}><Text style={styles.eyebrow}>01 / 从一个目标开始</Text><Text style={styles.heading} accessibilityRole="header">今天，想往哪里成长？</Text>
          <Field testID="siyue-goal-input" label="我的目标" value={plan.goal} onChangeText={plan.setGoal} multiline maxLength={160} />
          <Text style={styles.hint}>当前使用本机确定性 Mock 生成示例计划，不联网、不调用真实 AI。所有内容都可以修改。</Text>
          <View style={styles.actions}><Button testID="siyue-generate" title="生成示例计划" primary disabled={disabled || !plan.goal.trim() || plan.editing} onPress={() => void plan.propose()} />
            <Button testID="siyue-manual-create" title="手动创建" disabled={disabled || plan.editing} onPress={plan.startManual} />
            {plan.busy === '生成示例计划' && <Button testID="siyue-cancel-generation" title="取消生成" onPress={plan.cancel} />}</View>
          {!plan.editing && !!plan.value.title && <Button title="继续当前编辑" disabled={disabled} onPress={plan.reopen} />}
          {plan.editing && <View style={styles.editor}><Text style={styles.subheading} accessibilityRole="header">{plan.draft ? '检查并编辑草稿' : '手动编辑计划'}</Text>
            <Text style={styles.hint}>{plan.draft ? '尚未正式保存' : '手动创建 · 不需要模型'}</Text>
            <Field label="目标标题" value={plan.value.title} onChangeText={(title) => plan.setValue({ ...plan.value, title })} maxLength={160} disabled={!!plan.busy} />
            <Field label="为什么想做（选填）" value={plan.value.rationale ?? ''} onChangeText={(rationale) => plan.setValue({ ...plan.value, rationale })} multiline maxLength={1000} disabled={!!plan.busy} />
            <Field label="项目 · 每行一个，最多 8 个" value={plan.projects} onChangeText={plan.setProjects} multiline disabled={!!plan.busy} />
            <Field label="任务 · 每行一个，最多 24 个" value={plan.tasks} onChangeText={plan.setTasks} multiline disabled={!!plan.busy} />
            <Text style={styles.hint}>确认后将创建 1 个目标、{plan.payload.projectTitles.length} 个项目、{plan.payload.taskTitles.length} 个任务。{plan.payload.projectTitles.length > 1 ? '这些任务会归入第一个项目。' : ''}</Text>
            {plan.draft ? <><Text style={styles.hint}>{plan.dirty ? '修改尚未保存。先保存草稿，再确认正式创建。' : '请核对以上内容，只有明确确认后才创建正式记录。'}</Text>
              <View style={styles.actions}><Button title="保存草稿修改" disabled={disabled || !plan.dirty || !plan.payload.title} onPress={() => void plan.saveDraft()} />
                <Button title="确认并正式保存" primary disabled={disabled || plan.dirty} onPress={() => void plan.confirm()} />
                <Button title="拒绝草稿" disabled={disabled} onPress={() => void plan.discard()} /></View></>
              : <Button title="确认保存手动计划" primary disabled={disabled || !plan.payload.title} onPress={() => void plan.manual()} />}
            <Button title="收起编辑（保留输入）" disabled={!!plan.busy} onPress={plan.close} />
          </View>}
          {pending.length > 0 && <View style={styles.editor}><Text style={styles.subheading} accessibilityRole="header">待确认草稿 · {pending.length}</Text>
            <Text style={styles.hint}>已保存在本机，选择一份继续检查。草稿不会自动执行。</Text>
            {pending.map((item) => <Button key={item.id} title={`继续：${item.command.kind === 'plan.create' ? item.command.payload.title : '计划草稿'}`} disabled={disabled || plan.editing} onPress={() => plan.resume(item)} />)}
          </View>}
        </View>
        <View style={styles.panel}><Text style={styles.eyebrow}>02 / 把成长留在每天</Text><Text style={styles.heading} accessibilityRole="header">我的行动</Text>
          <Text style={styles.hint}>正式记录保存于这台设备。关闭后重新打开，可继续查看和完成任务。</Text><Button title="刷新正式记录" disabled={!!plan.busy} onPress={() => void plan.refresh()} />
          {plan.snapshot && !plan.snapshot.goals.length && <View style={styles.empty}><Text style={styles.emptySymbol}>↗</Text><Text style={styles.subheading}>第一步，可以很小。</Text><Text testID="siyue-goals-empty" style={styles.hint}>确认一个计划后，目标和行动会出现在这里。</Text></View>}
          {(['goal', 'project', 'task'] as const).map((kind) => {
            const records = kind === 'goal' ? plan.snapshot?.goals : kind === 'project' ? plan.snapshot?.projects : plan.snapshot?.tasks;
            return records?.length ? <View style={styles.editor} key={kind}><Text testID={`siyue-count-${kind}`} style={styles.subheading} accessibilityRole="header">{kind === 'goal' ? '目标' : kind === 'project' ? '项目' : '任务'} · {records.length}</Text>
              {records.map((record) => <RecordRow key={record.id} kind={kind} record={record} disabled={disabled} update={plan.update} />)}</View> : null;
          })}
        </View><Text testID="siyue-page-end" style={styles.footer}>一步一步，成为想成为的自己。</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.background },
  container: { padding: 20, gap: 14, paddingBottom: 32 },
  eyebrow: { fontSize: 11, letterSpacing: 1.8, color: '#6c7b6d', fontWeight: '600' },
  title: { fontSize: 36, lineHeight: 47, letterSpacing: -1, color: theme.color.ink, fontWeight: '600' },
  lead: { fontSize: 14, lineHeight: 24, color: theme.color.muted },
  badge: { alignSelf: 'flex-start', fontSize: 11, color: '#526544', backgroundColor: '#e8eddf', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  runStatus: { backgroundColor: '#edf0e7', borderRadius: 10, padding: 14, gap: 4 },
  panel: { backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: 16, padding: 18, gap: 10 },
  heading: { fontSize: 22, lineHeight: 30, color: theme.color.ink, fontWeight: '600' },
  subheading: { fontSize: 16, lineHeight: 25, color: theme.color.accent, fontWeight: '600' },
  field: { gap: 7, marginTop: 7 }, label: { fontSize: 12, lineHeight: 21, fontWeight: '600', color: '#52604f' },
  input: { backgroundColor: '#fffefb', borderColor: '#cbd1c7', borderWidth: 1, borderRadius: 8, padding: 12, color: theme.color.ink, fontSize: 16, lineHeight: 24, minHeight: 46 },
  multiline: { minHeight: 95 }, hint: { fontSize: 12, lineHeight: 21, color: theme.color.muted },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  button: { borderColor: '#c9d2c8', borderWidth: 1, backgroundColor: '#fffefa', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 13, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: theme.color.accent, fontSize: 13, lineHeight: 20 },
  primary: { backgroundColor: theme.color.accent, borderColor: theme.color.accent }, primaryText: { color: '#fff' }, disabled: { opacity: .4 }, pressed: { opacity: .7 },
  editor: { marginTop: 14, paddingTop: 18, borderTopColor: '#e2e4d9', borderTopWidth: 1, gap: 10 },
  record: { paddingVertical: 14, gap: 8, borderBottomWidth: 1, borderBottomColor: '#e5e5da' }, recordTitle: { color: theme.color.ink, fontSize: 16, lineHeight: 25 },
  done: { textDecorationLine: 'line-through', color: '#71816c' },
  notice: { backgroundColor: '#e8eddf', color: '#3b6249', padding: 14, borderRadius: 9, fontSize: 13, lineHeight: 23 },
  error: { borderColor: '#e1c5ad', borderWidth: 1, padding: 14, backgroundColor: '#fff4e8', borderRadius: 9, gap: 12 }, errorText: { color: '#804e28', fontSize: 13, lineHeight: 23 },
  empty: { paddingVertical: 36, alignItems: 'center', gap: 12 }, emptySymbol: { fontSize: 38, color: '#9aab85' }, footer: { textAlign: 'center', fontSize: 11, color: '#929a86', paddingTop: 12 },
});
