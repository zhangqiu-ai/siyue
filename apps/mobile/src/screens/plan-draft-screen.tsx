import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation, usePreventRemove } from 'expo-router/react-navigation';
import * as Crypto from 'expo-crypto';
import type { ActionDraft, GoalDraft } from '@siyue/contracts';
import { getClient } from '../client';
import { useLocale } from '../i18n';
import { Banner, Button, ListGroup, Screen, SectionLabel, useTheme } from '../ui';
import { useWorkspaceValue } from '../account/workspace-scratch';
import { useCurrentSpace } from '../shell/space-switcher';
import { DatePickerSheet } from '../space/components/date-picker-sheet';
import { MetaChip, MetaRow } from '../space/components/space-chrome';
import { AddRow, DraftTaskRow, TitleInput } from '../space/components/plan-blocks';
import { confirmVisibleDraft, errorCode, receiptCounts, recheckDraft, recreateDraft, type DraftReceiptCounts } from '../space/draft-actions';
import { createDraftAutosave, type DraftAutosave, type DraftAutosaveState } from '../space/draft-autosave';
import { editableDraftPayload, reconcileDraftReceipt, validateDraftInput } from '../space/draft-state';
import { draftMinutesLeft, formatLocalDate, localDateOf } from '../space/dates';
import { useSpaceText } from '../space/use-space-text';

export default function PlanDraftScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PlanDraftEditor key={id} id={id} />;
}

function PlanDraftEditor({ id }: { id: string }) {
  const router = useRouter(), navigation = useNavigation(), theme = useTheme(), t = useSpaceText(), { locale } = useLocale(), space = useCurrentSpace();
  const [draft, setDraft] = useWorkspaceValue<ActionDraft | null>(`draft.${id}.original`, null);
  const [input, setInput] = useWorkspaceValue<GoalDraft | null>(`draft.${id}.input`, null);
  const [keys, setKeys] = useState<number[]>([]), nextKey = useRef(0);
  const [latest, setLatest] = useState<ActionDraft | null>(null);
  const [state, setState] = useState<DraftAutosaveState<GoalDraft> | null>(null);
  const [busy, setBusy] = useState(false), [permitExit, setPermitExit] = useState(false), [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false), [result, setResult] = useState<DraftReceiptCounts | null>(null);
  const [dateOpen, setDateOpen] = useState(false), [clock, setClock] = useState(Date.now());
  const mounted = useRef(true), lock = useRef(false);
  const draftRef = useRef(draft), inputRef = useRef(input), autosave = useRef<DraftAutosave<GoalDraft> | null>(null);
  const currentPayload = draft?.command.kind === 'plan.create' ? draft.command.payload : null;
  const dirty = !!input && !!currentPayload && JSON.stringify(input) !== JSON.stringify(currentPayload);
  const valid = input ? validateDraftInput(input) : null;
  const expired = !!draft && Date.parse(draft.expiresAt) <= clock && !result;
  const closed = draft?.status === 'rejected' || draft?.status === 'cancelled';
  const editable = !!editableDraftPayload(draft, clock) && !unknown && !result && !latest;
  const canJoin = !!valid && valid.taskTitles.length > 0 && !unknown && !result && !expired && !latest && (draft?.status === 'draft' || draft?.status === 'approved');
  const minutes = draft ? draftMinutesLeft(draft.expiresAt, clock) : 0;
  const install = useCallback((record: ActionDraft) => {
    autosave.current?.dispose();
    draftRef.current = record; setDraft(record);
    const controller = createDraftAutosave<GoalDraft>({
      delayMs: 600,
      save: async payload => {
        const current = draftRef.current;
        if (!current || current.command.kind !== 'plan.create') throw new Error('draft_unavailable');
        const client = await getClient();
        let saved: ActionDraft;
        try { saved = await client.editDraft(current.id, current.version, payload); }
        catch (failure) {
          if (errorCode(failure) === 'version_conflict' && mounted.current) {
            const newest = (await client.snapshot()).drafts.find(item => item.id === current.id);
            if (newest?.command.kind === 'plan.create') setLatest(newest);
          }
          throw failure;
        }
        draftRef.current = saved;
        if (mounted.current) setDraft(saved);
        return { version: saved.version };
      },
    });
    autosave.current = controller;
    setState(controller.getState());
    controller.subscribe(value => { if (mounted.current) setState(value); });
  }, []);
  const replaceInput = useCallback((payload: GoalDraft) => {
    inputRef.current = payload; setInput(payload);
    setKeys(payload.taskTitles.map(() => nextKey.current++));
  }, []);
  const load = useCallback(async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const client = await getClient();
      const current = (await client.snapshot()).drafts.find(item => item.id === id);
      if (!current || current.command.kind !== 'plan.create') throw new Error('draft_unavailable');
      const applied = current.status === 'applied' && await reconcileDraftReceipt(client, current);
      if (!mounted.current) return;
      if (applied) {
        const receipt = await client.receipt(current.command.commandId);
        setResult(receipt ? receiptCounts(receipt) : null);
      }
      if (inputRef.current && draftRef.current && draftRef.current.version !== current.version &&
          JSON.stringify(inputRef.current) !== JSON.stringify(draftRef.current.command.kind === 'plan.create' ? draftRef.current.command.payload : null)) {
        setLatest(current);
      } else {
        const restored = inputRef.current && draftRef.current?.version === current.version ? inputRef.current : current.command.payload;
        install(current); replaceInput(restored);
        if (JSON.stringify(restored) !== JSON.stringify(current.command.payload) && validateDraftInput(restored)) autosave.current?.update(restored);
      }
      setUnknown(current.status === 'applied' && !applied);
    } catch { if (mounted.current) setError(t('home.error')); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }, [id, install, replaceInput]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => setClock(Date.now()), 15_000);
    return () => { mounted.current = false; clearInterval(timer); autosave.current?.dispose(); };
  }, [load]);
  usePreventRemove((dirty || busy) && !result && !permitExit, ({ data }) => {
    if (busy) return;
    Alert.alert(t('draft.leaveTitle'), t('draft.leaveBody'), [
      { text: t('draft.leaveKeep'), style: 'cancel' },
      { text: t('draft.leaveDiscard'), style: 'destructive', onPress: () => { setPermitExit(true); setTimeout(() => navigation.dispatch(data.action), 0); } },
    ]);
  });
  const change = (payload: GoalDraft) => {
    inputRef.current = payload; setInput(payload); setError(null);
    const parsed = validateDraftInput(payload);
    if (parsed && editable) autosave.current?.update(parsed);
  };
  const join = async () => {
    if (lock.current || !canJoin || !draft) return;
    const visible = inputRef.current && validateDraftInput(inputRef.current);
    if (!visible || visible.taskTitles.length === 0) { setError(t('draft.joinNeedsTitle')); return; }
    lock.current = true; setBusy(true); setError(null);
    try {
      const client = await getClient();
      // React state can trail the final keystroke; force the exact visible payload into the save queue.
      if (JSON.stringify(visible) !== JSON.stringify(draftRef.current?.command.kind === 'plan.create' ? draftRef.current.command.payload : null)) autosave.current?.update(visible);
      const outcome = await confirmVisibleDraft({
        flush: () => autosave.current!.flush(),
        visible: () => draftRef.current ? { payloadHash: draftRef.current.payloadHash, version: draftRef.current.version } : null,
        confirm: (hash, version) => client.confirmLatestDraft(id, hash, version),
        latest: async () => (await client.snapshot()).drafts.find(item => item.id === id) ?? null,
        reconcile: current => reconcileDraftReceipt(client, current),
      });
      if (!mounted.current) return;
      if (outcome.kind === 'applied') {
        const receipt = outcome.receipt ?? await client.receipt(draftRef.current!.command.commandId);
        if (receipt) setResult(receiptCounts(receipt));
        else { setUnknown(true); setError(t('draft.unknownBody')); }
      } else if (outcome.kind === 'changed') {
        const current = (await client.snapshot()).drafts.find(item => item.id === id);
        if (current) setLatest(current);
        setError(t('draft.changedBody'));
      } else if (outcome.kind === 'save_failed') setError(t('draft.saveFailed'));
      else { setUnknown(true); setError(t('draft.unknownBody')); }
    } catch { if (mounted.current) { setUnknown(true); setError(t('draft.unknownBody')); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const recheck = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const client = await getClient();
      const status = await recheckDraft({ latest: async () => (await client.snapshot()).drafts.find(item => item.id === id) ?? null, reconcile: current => reconcileDraftReceipt(client, current) });
      if (!mounted.current) return;
      if (status === 'applied') {
        const receipt = draftRef.current ? await client.receipt(draftRef.current.command.commandId) : null;
        if (receipt) { setResult(receiptCounts(receipt)); setUnknown(false); }
        else setError(t('draft.unknownBody'));
      } else if (status === 'not_applied') {
        const current = (await client.snapshot()).drafts.find(item => item.id === id);
        if (current?.command.kind === 'plan.create') { install(current); replaceInput(current.command.payload); }
        setUnknown(false); setError(t('draft.rechecked'));
      }
      else setError(t('draft.unknownBody'));
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const discard = () => Alert.alert(t('draft.discardTitle'), t('draft.discardBody'), [
    { text: t('draft.keepEditing'), style: 'cancel' },
    { text: t('draft.discardConfirm'), style: 'destructive', onPress: () => { void (async () => {
      if (lock.current || !draftRef.current) return;
      lock.current = true; setBusy(true); setError(null);
      try {
        await autosave.current?.flush().catch(() => undefined);
        const client = await getClient();
        const current = (await client.snapshot()).drafts.find(item => item.id === draftRef.current!.id);
        if (!current || current.command.kind !== 'plan.create') throw new Error('draft_unavailable');
        await client.discardDraft(current.id, current.version);
        autosave.current?.dispose();
        setPermitExit(true); setInput(null); setTimeout(() => router.replace('/space'), 0);
      } catch { if (mounted.current) setError(t('home.error')); }
      finally { lock.current = false; if (mounted.current) setBusy(false); }
    })(); } },
  ]);
  const recreate = async () => {
    if (!input || lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const created = await recreateDraft({ payload: input, create: payload => (async () => {
        const request = { commandId: Crypto.randomUUID(), issuedAt: new Date().toISOString() };
        return (await getClient()).createManualDraft(payload, request);
      })() });
      router.replace({ pathname: '/plan/draft', params: { id: created.id } });
    } catch { setError(t('home.error')); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const applyLatest = () => {
    if (!latest || latest.command.kind !== 'plan.create') return;
    install(latest); replaceInput(latest.command.payload); setLatest(null); setError(null); setUnknown(false);
  };
  const statusKey = state?.status === 'saving' ? 'draft.stateSaving' : state?.status === 'error' ? 'draft.stateError' : dirty ? 'draft.stateIdle' : 'draft.stateSaved';
  const footer = result ? <>
    {result.goalId && <Button label={t('done.viewGoal')} onPress={() => router.replace({ pathname: '/space/goal/[id]', params: { id: result.goalId! } })} />}
    <Button label={t('done.finish')} variant="text" onPress={() => router.replace('/space')} />
  </> : closed ? <Button label={t('done.finish')} onPress={() => router.replace('/space')} />
    : unknown ? <Button label={t('draft.recheck')} loading={busy} onPress={() => void recheck()} />
    : expired ? <Button label={t('draft.recreate')} loading={busy} onPress={() => void recreate()} />
    : <>
      <Button label={t('draft.join', { space: space.name })} disabled={!canJoin} loading={busy} onPress={() => void join()} />
      <Button label={t('draft.discard')} variant="text" disabled={busy} onPress={discard} />
    </>;
  return <>
    <Screen maxWidth={680} testID="plan-draft" footer={footer}>
      {!result && <Pressable accessibilityRole="button" accessibilityLabel={t('goal.close')} onPress={() => router.back()} style={styles.close}><Text style={{ color: theme.color.ink, fontSize: 24 }}>×</Text></Pressable>}
      {result ? <View style={styles.result}>
        <Text accessibilityRole="header" style={[styles.heading, { color: theme.color.ink }]}>{t('done.title', { space: space.name })}</Text>
        <Text style={[styles.body, { color: theme.color.muted }]}>{t('done.body', { goals: result.goals, projects: result.projects, tasks: result.tasks })}</Text>
      </View> : <>
        {closed ? <Banner kind="info" title={t('draft.closed')} />
          : expired ? <Banner kind="warn" title={t('draft.expired')} body={t('draft.expiredBody')} />
          : unknown ? <Banner kind="warn" title={t('draft.unknown')} body={t('draft.unknownBody')} />
          : <View style={styles.status}><Text style={{ color: theme.color.accent }}>{t(statusKey)}</Text><Text style={{ color: theme.color.muted }}>{t('draft.validFor', { minutes })}</Text></View>}
        {error && <Banner kind="warn" title={error} action={state?.status === 'error' && !unknown ? <Button label={t('draft.retrySave')} size="sm" onPress={() => autosave.current?.retry()} /> : undefined} />}
        {latest && <Banner kind="warn" title={t('draft.changed')} body={t('draft.changedBody')} action={<Button label={t('home.retry')} size="sm" onPress={applyLatest} />} />}
        {input && <>
          <TitleInput value={input.title} onChangeText={title => change({ ...input, title })} accessibilityLabel={t('draft.titleLabel')} placeholder={t('draft.namePlaceholder')} editable={editable} />
          <MetaRow>
            <MetaChip icon="calendar" label={input.targetDate ? formatLocalDate(locale, input.targetDate, localDateOf()) ?? input.targetDate : t('draft.dateChip')} onPress={editable ? () => setDateOpen(true) : undefined} />
            <MetaChip icon="target" label={space.name} />
          </MetaRow>
          <SectionLabel>{t('draft.why')}</SectionLabel>
          <TextInput accessibilityLabel={t('draft.why')} placeholder={t('draft.whyPlaceholder')} placeholderTextColor={theme.color.muted}
            multiline maxLength={1000} editable={editable} value={input.rationale ?? ''} onChangeText={rationale => change({ ...input, rationale })}
            style={[styles.textArea, { color: theme.color.ink, backgroundColor: theme.color.surface }]} />
          <SectionLabel>{t('draft.projectLabel')}</SectionLabel>
          <TextInput accessibilityLabel={t('draft.projectName')} maxLength={160} editable={editable} value={input.projectTitles[0] ?? ''}
            onChangeText={title => change({ ...input, projectTitles: [title] })} style={[styles.project, { color: theme.color.ink, backgroundColor: theme.color.surface }]} />
          <SectionLabel>{t('draft.tasks', { count: input.taskTitles.length })}</SectionLabel>
          <ListGroup>
            {input.taskTitles.map((value, index) => <DraftTaskRow key={keys[index] ?? index} value={value} total={input.taskTitles.length} editable={editable}
              labels={{ task: t('draft.taskLabel', { number: index + 1 }), reorder: t('draft.moveDown', { number: index + 1 }), remove: t('draft.remove', { number: index + 1 }) }}
              onChangeText={title => change({ ...input, taskTitles: input.taskTitles.map((item, at) => at === index ? title : item) })}
              onRemove={() => { setKeys(current => current.filter((_, at) => at !== index)); change({ ...input, taskTitles: input.taskTitles.filter((_, at) => at !== index) }); }}
              onReorder={() => { if (index >= input.taskTitles.length - 1) return; const titles = [...input.taskTitles]; [titles[index], titles[index + 1]] = [titles[index + 1]!, titles[index]!]; setKeys(current => { const copy = [...current]; [copy[index], copy[index + 1]] = [copy[index + 1]!, copy[index]!]; return copy; }); change({ ...input, taskTitles: titles }); }} />)}
            <AddRow label={t('draft.add')} disabled={!editable || input.taskTitles.length >= 24} onPress={() => { setKeys(current => [...current, nextKey.current++]); change({ ...input, taskTitles: [...input.taskTitles, ''] }); }} />
          </ListGroup>
          {!valid && <Text accessibilityRole="alert" style={[styles.note, { color: theme.color.error }]}>{t('draft.joinNeedsTitle')}</Text>}
          {state?.status === 'error' && <Button label={t('draft.retrySave')} variant="tonal" onPress={() => autosave.current?.retry()} />}
        </>}
      </>}
    </Screen>
    <DatePickerSheet visible={dateOpen} onClose={() => setDateOpen(false)} locale={locale} value={input?.targetDate}
      labels={{ title: t('goal.date'), today: t('goal.dueToday'), tomorrow: t('goal.dueTomorrow'), saturday: t('goal.dueSaturday'), clear: t('goal.dueClear'), pick: t('goal.duePick') }}
      onSelect={date => { if (input) change({ ...input, targetDate: date }); setDateOpen(false); }}
      onClear={() => { if (input) { const { targetDate: _date, ...rest } = input; change(rest); } setDateOpen(false); }} />
  </>;
}

const styles = StyleSheet.create({
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  heading: { fontSize: 28, lineHeight: 36, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24 },
  result: { alignItems: 'center', paddingTop: 64, gap: 18 },
  status: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, marginBottom: 18, fontSize: 13 },
  textArea: { minHeight: 92, borderRadius: 16, padding: 14, fontSize: 16, lineHeight: 23 },
  project: { minHeight: 54, borderRadius: 16, paddingHorizontal: 14, fontSize: 16 },
  note: { fontSize: 13, lineHeight: 19, marginTop: 10 },
});
