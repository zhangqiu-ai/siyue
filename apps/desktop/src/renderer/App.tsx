import {workspaceKey} from './workspace';
import { useLocale, type MessageKey } from './i18n';
import { Whiteboard } from './Whiteboard';
import { Settings } from './Settings';
import { useEffect, useRef, useState } from 'react';
import type { LocalClient, LocalRequest, PlanSnapshot } from '@siyue/adapters';
import type { ActionDraft, AgentRun, GoalDraft } from '@siyue/contracts';

const runMessages: Record<AgentRun['status'], MessageKey> = {
  queued: 'runQueued',
  running: 'runRunning',
  awaiting_approval: 'runApproval',
  interrupted: 'runInterrupted',
  succeeded: 'runSucceeded',
  failed: 'runFailed',
  cancelled: 'runCancelled',
};
const blank: GoalDraft = { title: '', rationale: '', projectTitles: [], taskTitles: [] };
const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
function describeError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const messages: Record<string, MessageKey> = {
    manual_unknown: 'manualUnknown',
    conflict: 'errorConflict',
    version_conflict: 'errorConflict',
    forbidden: 'errorForbidden',
    expired: 'errorExpired',
    approval_expired: 'errorExpired',
    approval_invalid: 'errorApproval',
    invalid_input: 'errorInput',
    invalid_state: 'errorState',
    corrupt_data: 'errorCorrupt',
    unsupported_schema: 'errorSchema',
    cancelled: 'errorCancelled',
    unsupported: 'errorUnsupported',
    budget_exceeded: 'errorBudget',
  };
  if (error instanceof Error && error.name === 'AbortError') return 'errorCancelled';
  return messages[code] ?? 'errorUnknown';
}
type EditorScratch={goal:string;draft:ActionDraft|null;editing:boolean;value:GoalDraft;projects:string;tasks:string;manualUnknown:boolean;request:{payload:GoalDraft;request:LocalRequest}|null};
const editorScratch=new Map<string,EditorScratch>();
function usePlan(workspaceRevision:number) {
  const [scopeKey]=useState(()=>workspaceKey());
  const saved=editorScratch.get(scopeKey);
  const client = useRef<LocalClient | null>(null);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState<PlanSnapshot | null>(null);
  const [busy, setBusy] = useState<MessageKey | ''>('');
  const [error, setError] = useState<MessageKey | ''>('');
  const [notice, setNotice] = useState<MessageKey | ''>('');
  const [savedCount, setSavedCount] = useState(0);
  const [goal, setGoal] = useState(saved?.goal??'');
  const [draft, setDraft] = useState<ActionDraft | null>(saved?.draft??null);
  const [editing, setEditing] = useState(saved?.editing??false);
  const [value, setValue] = useState<GoalDraft>(saved?.value??blank);
  const [projects, setProjects] = useState(saved?.projects??'');
  const [tasks, setTasks] = useState(saved?.tasks??'');
  const manualRequest = useRef<{ payload: GoalDraft; request: LocalRequest } | null>(saved?.request??null);
  const [manualUnknown, setManualUnknown] = useState(saved?.manualUnknown??false);
  const scratch=useRef<EditorScratch>(null!);
  scratch.current={goal,draft,editing,value,projects,tasks,manualUnknown,request:manualRequest.current};
  useEffect(()=>{editorScratch.set(scopeKey,scratch.current);});
  const payload: GoalDraft = { ...value, title: value.title.trim(), projectTitles: lines(projects), taskTitles: lines(tasks) };
  const validProject = payload.projectTitles.length === 1;
  const legacyProjects = !!draft && draft.command.kind === 'plan.create' && draft.command.payload.projectTitles.length > 1;
  const savedPayload = draft?.command.kind === 'plan.create' ? draft.command.payload : null;
  const dirty = !!savedPayload && JSON.stringify(payload) !== JSON.stringify({ ...savedPayload, rationale: savedPayload.rationale ?? '' });
  async function perform(label: MessageKey, operation: (api: LocalClient) => Promise<void>) {
    if (lock.current) return false;
    lock.current = true; setBusy(label); setError(''); setNotice('');
    try {
      const api = await getClient();
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
  const refresh = () => perform('loading', async () => {});
  useEffect(() => {
    let active=true;
    client.current=null;
    const reload=async()=>{
      await new Promise(resolve=>setTimeout(resolve,100));
      while(active&&lock.current)await new Promise(resolve=>setTimeout(resolve,10));
      if(active)void refresh();
    };
    void reload();
    return()=>{active=false;controller.current?.abort();};
  }, [workspaceRevision]);
  function loadEditor(next: GoalDraft, source: ActionDraft | null) {
    setValue({ ...next, rationale: next.rationale ?? '' }); setProjects(next.projectTitles.join('\n'));
    setTasks(next.taskTitles.join('\n')); setDraft(source); setEditing(true); setNotice('');
  }
  async function propose() {
    const abort = new AbortController(); controller.current = abort;
    await perform('generate', async (api) => {
      const next = await api.propose(goal, abort.signal);
      if (abort.signal.aborted) { setNotice('generationCancelled'); return; }
      if (next.command.kind !== 'plan.create') throw new Error('Unexpected draft');
      loadEditor(next.command.payload, next);
      setNotice('draftCreated');
    });
    controller.current = null;
  }
  async function saveDraft() {
    if (!draft || !validProject || legacyProjects) return;
    await perform('savingDraft', async (api) => {
      const next = await api.editDraft(draft.id, draft.version, payload);
      setDraft(next); setValue(payload); setNotice('draftSaved');
    });
  }
  async function confirm() {
    if (!draft || dirty || !validProject || legacyProjects) return;
    await perform('confirming', async (api) => {
      const receipt = await api.confirmDraft(draft.id, draft.version);
      setEditing(false); setDraft(null); setValue(blank); setProjects(''); setTasks(''); setSavedCount(receipt.result.entities.length); setNotice('recordsSaved');
    });
  }
  async function manual() {
    if (!validProject) return;
    await perform('savingManual', async (api) => {
      manualRequest.current ??= { payload: structuredClone(payload), request: { commandId: crypto.randomUUID(), issuedAt: new Date().toISOString() } };
      try {
        const next = await api.createManualDraft(manualRequest.current.payload, manualRequest.current.request);
        manualRequest.current = null; setManualUnknown(false);
        loadEditor(next.command.kind === 'plan.create' ? next.command.payload : payload, next);
        setNotice('manualDraftCreated');
      } catch (failure) {
        const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
        if (['invalid_input', 'approval_expired', 'command_conflict', 'forbidden'].includes(code)) {
          manualRequest.current = null; setManualUnknown(false); throw failure;
        }
        setManualUnknown(true);
        throw Object.assign(new Error('manual_unknown'), { code: 'manual_unknown' });
      }
    });
  }
  async function discard() {
    if (!draft) return;
    await perform('reject', async (api) => {
      await api.discardDraft(draft.id, draft.version);
      setDraft(null); setNotice('draftRejected');
    });
  }
  const update = (kind: 'goal' | 'project' | 'task', id: string, version: number, patch: Parameters<LocalClient['update']>[3]) =>
    perform('savingRecord', async (api) => { await api.update(kind, id, version, patch); setNotice('recordSaved'); });
  return { snapshot, busy, error, notice, savedCount, goal, setGoal, draft, editing, value, setValue, projects, setProjects, tasks, setTasks,
    payload, dirty, manualUnknown, validProject, legacyProjects, refresh, propose, saveDraft, confirm, manual, discard, update,
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
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(record.title);
  return <div className={`record ${record.status === 'archived' ? 'archived' : ''}`}>
    {editing ? <form className="rename" onSubmit={(event) => {
      event.preventDefault(); void update(kind, record.id, record.version, { title }).then((ok) => { if (ok) setEditing(false); });
    }}><input aria-label={t('renameLabel', { title: record.title })} value={title} maxLength={kind === 'task' ? 240 : 160} onChange={(event) => setTitle(event.target.value)} autoFocus />
      <button disabled={disabled || !title.trim()}>{t('saveName')}</button><button type="button" disabled={disabled} onClick={() => setEditing(false)}>{t('cancelRename')}</button></form>
      : <><span className={record.status === 'done' ? 'done record-title' : 'record-title'}>{record.title}</span>
      <span className="record-status">{t(record.status === 'archived' ? 'archived' : record.status === 'done' || record.status === 'completed' ? 'completed' : kind === 'task' ? 'todo' : 'active')}</span>
      {record.status !== 'archived' && <div className="record-actions">
        {kind === 'task' && record.status !== 'archived' && <button disabled={disabled} onClick={() => void update(kind, record.id, record.version, { status: record.status === 'done' ? 'open' : 'done' })}>{t(record.status === 'done' ? 'undoComplete' : 'complete')}</button>}
        <button disabled={disabled} onClick={() => { setTitle(record.title); setEditing(true); }}>{t('rename')}</button>
        <button disabled={disabled} onClick={() => void update(kind, record.id, record.version, { status: 'archived' })}>{t('archive')}</button>
      </div>}</>}
  </div>;
}

export function App({workspaceRevision}:{workspaceRevision:number}) {
  const { t, number, locale } = useLocale();
  const [whiteboardOpen,setWhiteboardOpen]=useState(false);
  const plan = usePlan(workspaceRevision);
  const disabled = !!plan.busy || !plan.snapshot;
  const latestRun = plan.snapshot?.runs.reduce<AgentRun | undefined>((latest, run) => !latest || run.updatedAt > latest.updatedAt ? run : latest, undefined);
  const pending = plan.snapshot?.drafts.filter((item) => ['draft', 'approved'].includes(item.status) && item.command.kind === 'plan.create') ?? [];
  if(whiteboardOpen)return <Whiteboard key={workspaceRevision} onExit={()=>setWhiteboardOpen(false)}/>;
  return <main className="shell">
    <header className="page-header"><h1>{t('pageTitle')}</h1>
      <span className="local-badge">{t(plan.error ? plan.snapshot ? 'localCheck' : 'localUnavailable' : plan.snapshot ? 'localAvailable' : 'localConnecting')}</span><button onClick={()=>setWhiteboardOpen(true)}>{locale==='en'?'Whiteboard':'白板'}</button><Settings /></header>
    <div className="feedback" aria-live="polite" aria-busy={!!plan.busy}>
      {plan.busy && <p>{t(plan.busy)}…</p>}{plan.notice && <p className="success">{t(plan.notice, { count: number(plan.savedCount) })}</p>}
      {plan.error && <div role="alert" className="error"><p>{t(plan.error)}</p><button disabled={!!plan.busy} onClick={() => void plan.refresh()}>{t('reload')}</button></div>}
    </div>
    {latestRun && <aside className="run-status" aria-live="polite"><p>{t(runMessages[latestRun.status])}</p></aside>}
    <div className="workspace">
      <section className="panel compose" aria-labelledby="compose-title"><h2 id="compose-title">{t('newGoal')}</h2>
        <label htmlFor="goal-input">{t('myGoal')}</label><textarea id="goal-input" rows={3} maxLength={160} value={plan.goal} onChange={(event) => plan.setGoal(event.target.value)} placeholder={t('goalPlaceholder')} />
        <p className="hint">{t('sampleHint')}</p>
        <div className="actions"><button className="primary" disabled={disabled || !plan.goal.trim() || plan.editing || plan.manualUnknown} onClick={() => void plan.propose()}>{t('generate')}</button>
          <button disabled={disabled || plan.editing || plan.manualUnknown} onClick={plan.startManual}>{t('createManual')}</button>
          {plan.busy === 'generate' && <button onClick={plan.cancel}>{t('cancelGeneration')}</button>}</div>
        {!plan.editing && plan.value.title && <button className="text-button" disabled={disabled} onClick={plan.reopen}>{t('resumeEditor')}</button>}
        {plan.editing && <div className="editor"><div className="section-heading"><h3>{t(plan.draft ? 'reviewDraft' : 'manualEditor')}</h3><span className="tag">{t(plan.draft ? 'unsaved' : 'manual')}</span></div>
          <label htmlFor="plan-title">{t('goalTitle')}</label><input id="plan-title" maxLength={160} value={plan.value.title} disabled={!!plan.busy || plan.manualUnknown} onChange={(event) => plan.setValue({ ...plan.value, title: event.target.value })} />
          <label htmlFor="rationale">{t('rationale')}</label><textarea id="rationale" rows={2} maxLength={1000} disabled={!!plan.busy || plan.manualUnknown} value={plan.value.rationale ?? ''} onChange={(event) => plan.setValue({ ...plan.value, rationale: event.target.value })} />
          <label htmlFor="projects">{t('projectsLabel')}</label><>{plan.legacyProjects ? <textarea id="projects" rows={3} readOnly value={plan.projects} /> : <input id="projects" maxLength={160} disabled={!!plan.busy || plan.manualUnknown} value={plan.projects} onChange={(event) => plan.setProjects(event.target.value)} />}<p className="hint">{t(plan.legacyProjects ? 'legacyProjects' : 'projectRequired')}</p></>
          <label htmlFor="tasks">{t('tasksLabel')}</label><textarea id="tasks" rows={5} disabled={!!plan.busy || plan.manualUnknown} value={plan.tasks} onChange={(event) => plan.setTasks(event.target.value)} />
          <p className="hint">{t('creationSummary', { projects: number(plan.payload.projectTitles.length), tasks: number(plan.payload.taskTitles.length) })}</p>
          {plan.draft ? <><p className="hint">{t(plan.dirty ? 'draftDirty' : 'draftConfirm')}</p><div className="actions">
            <button disabled={disabled || !plan.dirty || !plan.payload.title || !plan.validProject || plan.legacyProjects} onClick={() => void plan.saveDraft()}>{t('saveDraft')}</button>
            <button className="primary" disabled={disabled || plan.dirty || !plan.validProject || plan.legacyProjects} onClick={() => void plan.confirm()}>{t('confirmDraft')}</button>
            <button disabled={disabled} onClick={() => void plan.discard()}>{t('reject')}</button></div></>
            : <button className="primary" disabled={disabled || !plan.payload.title || !plan.validProject} onClick={() => void plan.manual()}>{t(plan.manualUnknown ? 'retryManualDraft' : 'confirmManual')}</button>}
          <button className="text-button" disabled={!!plan.busy} onClick={plan.close}>{t('collapseEditor')}</button>
        </div>}
        {pending.length > 0 && <div className="draft-list"><h3>{t('pendingDrafts')}<span className="count">{number(pending.length)}</span></h3><p className="hint">{t('pendingHint')}</p>
          {pending.map((item) => <button className="draft-item" key={item.id} disabled={disabled || plan.editing || plan.manualUnknown} onClick={() => plan.resume(item)}><span>{item.command.kind === 'plan.create' ? item.command.payload.title : t('planDraft')}</span><span className="draft-continue">{t('continue')}<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></span></button>)}
        </div>}
      </section>
      <section className="panel saved" aria-labelledby="saved-title"><div className="section-heading"><h2 id="saved-title">{t('myActions')}</h2><button className="icon-button" aria-label={t('refresh')} title={t('refresh')} disabled={!!plan.busy} onClick={() => void plan.refresh()}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 11-1l3 6M4 12l3 6a7 7 0 0 0 11-1" /></svg></button></div>
        <p className="hint">{t('savedHint')}</p>
        {plan.snapshot && !plan.snapshot.goals.length && <div className="empty"><p>{t('empty')}</p></div>}
        {(['goal', 'project', 'task'] as const).map((kind) => {
          const records = kind === 'goal' ? plan.snapshot?.goals : kind === 'project' ? plan.snapshot?.projects : plan.snapshot?.tasks;
          return records?.length ? <section className="record-group" key={kind}><h3>{t(kind === 'goal' ? 'goals' : kind === 'project' ? 'projects' : 'tasks')} <span className="count">{number(records.length)}</span></h3>
            {records.map((record) => <RecordRow key={record.id} kind={kind} record={record} disabled={disabled} update={plan.update} />)}</section> : null;
        })}
      </section>
    </div>
  </main>;
}
