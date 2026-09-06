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
function describeError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const messages: Record<string, string> = {
    conflict: '记录已有变化，请刷新后重新检查。你的输入仍然保留。',
    version_conflict: '记录已有变化，请刷新后重新检查。你的输入仍然保留。',
    forbidden: '当前没有执行权限，未授权的操作无法保存。',
    expired: '草稿或审批已过期，请重新生成并确认。',
    approval_expired: '草稿或审批已过期，请重新生成并确认。',
    approval_invalid: '审批已失效，请刷新草稿并重新确认。',
    invalid_input: '内容格式不符合要求。请检查标题、项目与任务数量后重试。',
    invalid_state: '记录状态已变化，当前操作不可执行。请刷新后检查。',
    corrupt_data: '本地数据未通过完整性检查，原始数据已保留。请停止写入并联系维护者恢复。',
    unsupported_schema: '此版本无法读取本地数据格式。原始数据已保留，请使用兼容版本打开。',
    cancelled: '生成已取消，输入仍然保留。',
    unsupported: '当前运行环境或模型不支持此操作。若本地记录尚未加载，请在思玥应用中打开；模型不可用时可手动创建。',
    budget_exceeded: '模型预算已用尽，请使用手动创建。',
  };
  if (error instanceof Error && error.name === 'AbortError') return '生成已取消，输入仍然保留。';
  return messages[code] ?? `操作未能确认完成${code ? `（${code}）` : ''}。请刷新本地记录后重试，输入仍然保留。`;
}
function usePlan() {
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
      const api = client.current ?? await getClient();
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
    const abort = new AbortController(); controller.current = abort;
    await perform('生成示例计划', async (api) => {
      const next = await api.propose(goal, abort.signal);
      if (abort.signal.aborted) { setNotice('生成已取消，请检查待确认草稿。'); return; }
      if (next.command.kind !== 'plan.create') throw new Error('Unexpected draft');
      loadEditor(next.command.payload, next);
      setNotice('示例草稿已保存到本机，尚未创建正式目标。');
    });
    controller.current = null;
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

import { getClient } from './client';

function RecordRow({ kind, record, disabled, update }: {
  kind: 'goal' | 'project' | 'task'; record: { id: string; version: number; title: string; status: string };
  disabled: boolean; update: ReturnType<typeof usePlan>['update'];
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(record.title);
  return <div className={`record ${record.status === 'archived' ? 'archived' : ''}`}>
    {editing ? <form className="rename" onSubmit={(event) => {
      event.preventDefault(); void update(kind, record.id, record.version, { title }).then((ok) => { if (ok) setEditing(false); });
    }}><input aria-label={`修改${record.title}的名称`} value={title} maxLength={kind === 'task' ? 240 : 160} onChange={(event) => setTitle(event.target.value)} autoFocus />
      <button disabled={disabled || !title.trim()}>保存名称</button><button type="button" disabled={disabled} onClick={() => setEditing(false)}>取消改名</button></form>
      : <><span className={record.status === 'done' ? 'done record-title' : 'record-title'}>{record.title}</span>
      <span className="record-status">{record.status === 'archived' ? '已归档' : record.status === 'done' || record.status === 'completed' ? '已完成' : kind === 'task' ? '待完成' : '进行中'}</span>
      {record.status !== 'archived' && <div className="record-actions">
        {kind === 'task' && record.status !== 'archived' && <button disabled={disabled} onClick={() => void update(kind, record.id, record.version, { status: record.status === 'done' ? 'open' : 'done' })}>{record.status === 'done' ? '撤销完成' : '完成任务'}</button>}
        <button disabled={disabled} onClick={() => { setTitle(record.title); setEditing(true); }}>改名</button>
        <button disabled={disabled} onClick={() => void update(kind, record.id, record.version, { status: 'archived' })}>归档</button>
      </div>}</>}
  </div>;
}

export function App() {
  const plan = usePlan();
  const disabled = !!plan.busy || !plan.snapshot;
  const latestRun = plan.snapshot?.runs.reduce<AgentRun | undefined>((latest, run) => !latest || run.updatedAt > latest.updatedAt ? run : latest, undefined);
  const pending = plan.snapshot?.drafts.filter((item) => ['draft', 'approved'].includes(item.status) && item.command.kind === 'plan.create') ?? [];
  return <main className="shell">
    <header className="page-header"><h1>目标与行动</h1>
      <span className="local-badge">{plan.error ? plan.snapshot ? '本机空间状态待核对' : '本机空间暂不可用' : plan.snapshot ? '本机空间 · 离线可用' : '正在连接本机空间'}</span></header>
    <div className="feedback" aria-live="polite" aria-busy={!!plan.busy}>
      {plan.busy && <p>{plan.busy}…</p>}{plan.notice && <p className="success">{plan.notice}</p>}
      {plan.error && <div role="alert" className="error"><p>{plan.error}</p><button disabled={!!plan.busy} onClick={() => void plan.refresh()}>重新读取本地记录</button></div>}
    </div>
    {latestRun && <aside className="run-status" aria-live="polite"><p>{runMessages[latestRun.status]}</p></aside>}
    <div className="workspace">
      <section className="panel compose" aria-labelledby="compose-title"><h2 id="compose-title">新目标</h2>
        <label htmlFor="goal-input">我的目标</label><textarea id="goal-input" rows={3} maxLength={160} value={plan.goal} onChange={(event) => plan.setGoal(event.target.value)} placeholder="例如：开始规律地阅读" />
        <p className="hint">本机示例生成，不调用 AI；内容可编辑。</p>
        <div className="actions"><button className="primary" disabled={disabled || !plan.goal.trim() || plan.editing} onClick={() => void plan.propose()}>生成示例计划</button>
          <button disabled={disabled || plan.editing} onClick={plan.startManual}>手动创建</button>
          {plan.busy === '生成示例计划' && <button onClick={plan.cancel}>取消生成</button>}</div>
        {!plan.editing && plan.value.title && <button className="text-button" disabled={disabled} onClick={plan.reopen}>继续当前编辑</button>}
        {plan.editing && <div className="editor"><div className="section-heading"><h3>{plan.draft ? '检查并编辑草稿' : '手动编辑计划'}</h3><span className="tag">{plan.draft ? '尚未正式保存' : '手动'}</span></div>
          <label htmlFor="plan-title">目标标题</label><input id="plan-title" maxLength={160} value={plan.value.title} disabled={!!plan.busy} onChange={(event) => plan.setValue({ ...plan.value, title: event.target.value })} />
          <label htmlFor="rationale">为什么想做（选填）</label><textarea id="rationale" rows={2} maxLength={1000} disabled={!!plan.busy} value={plan.value.rationale ?? ''} onChange={(event) => plan.setValue({ ...plan.value, rationale: event.target.value })} />
          <label htmlFor="projects">项目 · 每行一个，最多 8 个</label><textarea id="projects" rows={3} disabled={!!plan.busy} value={plan.projects} onChange={(event) => plan.setProjects(event.target.value)} />
          <label htmlFor="tasks">任务 · 每行一个，最多 24 个</label><textarea id="tasks" rows={5} disabled={!!plan.busy} value={plan.tasks} onChange={(event) => plan.setTasks(event.target.value)} />
          <p className="hint">确认后将创建 1 个目标、{plan.payload.projectTitles.length} 个项目、{plan.payload.taskTitles.length} 个任务。{plan.payload.projectTitles.length > 1 ? '这些任务会归入第一个项目，可在后续迭代调整关联。' : ''}</p>
          {plan.draft ? <><p className="hint">{plan.dirty ? '修改尚未保存。先保存草稿，再确认正式创建。' : '请核对以上内容，只有明确确认后才创建正式记录。'}</p><div className="actions">
            <button disabled={disabled || !plan.dirty || !plan.payload.title} onClick={() => void plan.saveDraft()}>保存草稿修改</button>
            <button className="primary" disabled={disabled || plan.dirty} onClick={() => void plan.confirm()}>确认并正式保存</button>
            <button disabled={disabled} onClick={() => void plan.discard()}>拒绝草稿</button></div></>
            : <button className="primary" disabled={disabled || !plan.payload.title} onClick={() => void plan.manual()}>确认保存手动计划</button>}
          <button className="text-button" disabled={!!plan.busy} onClick={plan.close}>收起编辑（保留输入）</button>
        </div>}
        {pending.length > 0 && <div className="draft-list"><h3>待确认草稿 <span className="count">{pending.length}</span></h3><p className="hint">草稿已存本机，确认后才执行。</p>
          {pending.map((item) => <button className="draft-item" key={item.id} disabled={disabled || plan.editing} onClick={() => plan.resume(item)}><span>{item.command.kind === 'plan.create' ? item.command.payload.title : '计划草稿'}</span><span>继续 →</span></button>)}
        </div>}
      </section>
      <section className="panel saved" aria-labelledby="saved-title"><div className="section-heading"><h2 id="saved-title">我的行动</h2><button className="icon-button" aria-label="刷新" title="刷新" disabled={!!plan.busy} onClick={() => void plan.refresh()}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 11-1l3 6M4 12l3 6a7 7 0 0 0 11-1" /></svg></button></div>
        <p className="hint">记录保存在本机，重启后可继续。</p>
        {plan.snapshot && !plan.snapshot.goals.length && <div className="empty"><p>暂无行动</p></div>}
        {(['goal', 'project', 'task'] as const).map((kind) => {
          const records = kind === 'goal' ? plan.snapshot?.goals : kind === 'project' ? plan.snapshot?.projects : plan.snapshot?.tasks;
          return records?.length ? <section className="record-group" key={kind}><h3>{kind === 'goal' ? '目标' : kind === 'project' ? '项目' : '任务'} <span className="count">{records.length}</span></h3>
            {records.map((record) => <RecordRow key={record.id} kind={kind} record={record} disabled={disabled} update={plan.update} />)}</section> : null;
        })}
      </section>
    </div>
  </main>;
}
