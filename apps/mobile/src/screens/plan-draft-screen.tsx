import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation, usePreventRemove } from 'expo-router/react-navigation';
import type { ActionDraft, GoalDraft } from '@siyue/contracts';
import { getClient } from '../client';
import { useLocale } from '../i18n';
import { useTheme } from '../ui/theme';
import { AppIcon } from '../ui/icon';
import { editableDraftPayload, reconcileDraftReceipt, validateDraftInput } from '../space/draft-state';

export default function PlanDraftScreen() {
  const { id } = useLocalSearchParams<{id: string}>();
  const { t, locale } = useLocale();
  const theme = useTheme(), router = useRouter(), navigation = useNavigation();
  const [draft, setDraft] = useState<ActionDraft | null>(null);
  const [latest, setLatest] = useState<ActionDraft | null>(null);
  const [input, setInput] = useState<GoalDraft | null>(null);
  const [taskKeys, setTaskKeys] = useState<number[]>([]);
  const nextTaskKey = useRef(0);
  const replaceInput = (payload: GoalDraft) => {
    setInput(payload);
    setTaskKeys(payload.taskTitles.map(() => nextTaskKey.current++));
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [saved, setSaved] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const lock = useRef(false), mounted = useRef(true);
  const original = draft?.command.kind === 'plan.create' ? draft.command.payload : null;
  const dirty = !!input && !!original && JSON.stringify(input) !== JSON.stringify(original);
  const editable = !!editableDraftPayload(draft, clock) && !unknown && !saved;
  const valid = input ? validateDraftInput(input) : null;
  const resumable = draft?.status === 'approved' && Date.parse(draft.expiresAt) > clock && !unknown && !saved && !dirty;
  const titleKey = saved ? 'draft.saved' : draft?.status === 'rejected' ? 'draft.rejected' : draft?.status === 'cancelled' ? 'draft.cancelled' : draft && draft.status !== 'applied' && Date.parse(draft.expiresAt) <= clock ? 'draft.expired' : 'draft.title';
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);
  usePreventRemove(dirty || busy, ({data}) => {
    if (busy) return;
    Alert.alert(t('ai.discardTitle'), t('draft.leave'), [
      {text: t('ai.keepEditing'), style: 'cancel'},
      {text: t('ai.discard'), style: 'destructive', onPress: () => navigation.dispatch(data.action)},
    ]);
  });
  const load = useCallback(async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(false);
    try {
      const client = await getClient();
      const current = (await client.snapshot()).drafts.find(value => value.id === id);
      if (!current || current.command.kind !== 'plan.create') throw new Error('unavailable');
      const applied = current.status === 'applied' || current.status === 'approved'
        ? await reconcileDraftReceipt(client, current) : false;
      if (mounted.current) {
        setDraft(current); replaceInput(current.command.payload); setSaved(applied); setLatest(null);
        setUnknown(!applied && current.status === 'applied');
      }
    } catch { if (mounted.current) setError(true); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const inspectLatest = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const current = (await (await getClient()).snapshot()).drafts.find(value => value.id === id);
      if (!current || current.command.kind !== 'plan.create') throw new Error('unavailable');
      if (mounted.current) setLatest(current);
    } catch { if (mounted.current) setError(true); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const act = async (kind: 'edit' | 'confirm' | 'recheck' | 'reject') => {
    if (lock.current || !draft) return;
    if (kind === 'edit' && (!editable || !valid)) return;
    if (kind === 'confirm' && ((!editable && !resumable) || !valid || dirty)) return;
    if (kind === 'reject' && !editable && !resumable) return;
    lock.current = true; setBusy(true); setError(false); Keyboard.dismiss();
    try {
      const client = await getClient();
      if (kind === 'reject') {
        await client.discardDraft(draft.id, draft.version);
        const current = (await client.snapshot()).drafts.find(value => value.id === draft.id);
        if (mounted.current && current?.command.kind === 'plan.create') { setDraft(current); replaceInput(current.command.payload); setLatest(null); }
      } else if (kind === 'edit') {
        const updated = await client.editDraft(draft.id, draft.version, valid!);
        if (mounted.current && updated.command.kind === 'plan.create') {
          setDraft(updated); replaceInput(updated.command.payload); setLatest(null);
        }
      } else {
        if (kind === 'confirm') {
          try { await client.confirmDraft(draft.id, draft.version); }
          catch { /* A missing response may follow a successful write; reconcile the same command. */ }
        }
        const applied = await reconcileDraftReceipt(client, draft);
        const current = applied ? null : (await client.snapshot()).drafts.find(value => value.id === draft.id);
        if (mounted.current) {
          setSaved(applied);
          // A successful query resolves uncertainty; preserve local input on version changes.
          setUnknown(!applied && (!current || current.status === 'applied'));
          if (applied) setLatest(null);
          if (current && current.version === draft.version) { setDraft(current); setLatest(null); }
          else if (current) setLatest(current);
          if (!applied) setError(true);
        }
      }
    } catch {
      if (mounted.current) { setError(true); if (kind === 'confirm' || kind === 'recheck') setUnknown(true); }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const button = (label: string, onPress: () => void, disabled = false, primary = false) =>
    <Pressable accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={onPress}
      style={({pressed}) => [styles.button, {backgroundColor: primary ? theme.color.accent : pressed ? theme.color.subtle : 'transparent', opacity: disabled ? 0.4 : 1}]}>
      <Text style={[styles.buttonText, {color: primary ? theme.color.onAccent : theme.color.accent}]}>{label}</Text>
    </Pressable>;
  const field = (label: string, value: string, change: (text: string) => void, maxLength: number) =>
    <View style={styles.field}><Text style={[styles.label, {color: theme.color.muted}]}>{label}</Text>
      <TextInput accessibilityLabel={label} multiline value={value} onChangeText={change} maxLength={maxLength}
        editable={editable && !busy} selectionColor={theme.color.accent}
        style={[styles.input, {color: theme.color.ink, borderBottomColor: theme.color.border}]} />
    </View>;
  return <SafeAreaView style={{flex: 1, backgroundColor: theme.color.background}}>
    <View style={styles.nav}><Pressable accessibilityRole="button" accessibilityLabel={t('common.back')} disabled={busy}
      onPress={() => router.back()} style={styles.iconButton}><AppIcon name="back" /></Pressable></View>
    <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive" contentContainerStyle={styles.content}>
      <View style={{flexDirection: 'row', alignItems: 'center', gap: 12}}><View style={{width: 40, height: 40, borderRadius: 14, backgroundColor: theme.color.subtle, alignItems: 'center', justifyContent: 'center'}}><AppIcon name="target" color={theme.color.accent} /></View><Text accessibilityRole="header" style={[styles.heading, {color: theme.color.ink, flex: 1}]}>{t(titleKey)}</Text></View>
      <Text style={[styles.body, {color: theme.color.muted}]}>{t(saved ? 'space.local' : 'draft.note')}</Text>
      {busy && <ActivityIndicator accessibilityLabel={t('space.loading')} color={theme.color.accent} />}
      {error && <Text accessibilityRole="alert" style={[styles.body, {color: theme.color.ink}]}>{t('draft.error')}</Text>}
      {unknown && <Text accessibilityRole="alert" style={[styles.body, {color: theme.color.ink}]}>{t('draft.unknown')}</Text>}
      {resumable && <Text style={[styles.body, {color: theme.color.muted}]}>{t('draft.resume')}</Text>}
      {latest?.command.kind === 'plan.create' && <View style={[styles.card, {backgroundColor: theme.color.subtle}]}>
        <Text accessibilityRole="alert" style={[styles.body, {color: theme.color.ink}]}>{t('draft.changed')}</Text>
        <Text selectable style={[styles.body, {color: theme.color.ink}]}>{[latest.command.payload.title, ...latest.command.payload.projectTitles, ...latest.command.payload.taskTitles].join('\n')}</Text>
        {button(t('draft.useLatest'), () => { if (latest.command.kind === 'plan.create') {setDraft(latest); replaceInput(latest.command.payload); setLatest(null); setUnknown(latest.status === 'applied'); setError(false);} }, busy)}
        {!!editableDraftPayload(latest, clock) && button(t('draft.applyLatest'), () => {setDraft(latest); setLatest(null); setUnknown(false); setError(false);}, busy)}
      </View>}
      {input && !saved && <>
        {!editable && !resumable && !unknown && <Text style={[styles.body, {color: theme.color.muted}]}>{t('draft.closed')}</Text>}
        <View style={[styles.card, {backgroundColor: theme.color.surface}]}>
          {field(t('draft.goal'), input.title, title => setInput({...input, title}), 160)}
          {input.projectTitles.length > 1
            ? input.projectTitles.map((title, index) => <View key={index}>{field(t('draft.project'), title, () => {}, 160)}</View>)
            : field(t('draft.project'), input.projectTitles[0] ?? '', title => setInput({...input, projectTitles: [title]}), 160)}
          {!!input.rationale && <Text selectable style={[styles.body, {color: theme.color.muted}]}>{input.rationale}</Text>}
        </View>
        <View style={[styles.card, {backgroundColor: theme.color.surface}]}>
          <Text accessibilityRole="header" style={[styles.section, {color: theme.color.ink}]}>{t('draft.tasks')}</Text>
          {input.taskTitles.map((value, index) => {
            const number = new Intl.NumberFormat(locale).format(index + 1);
            return <View key={taskKeys[index]} style={styles.task}>
              <View style={{flex: 1}}>{field(t('draft.task', {number}), value, title => setInput({...input, taskTitles: input.taskTitles.map((item, i) => i === index ? title : item)}), 240)}</View>
              {editable && <Pressable accessibilityRole="button" accessibilityLabel={t('draft.remove', {number})} disabled={busy}
                style={styles.iconButton} onPress={() => {setTaskKeys(keys => keys.filter((_, i) => i !== index)); setInput({...input, taskTitles: input.taskTitles.filter((_, i) => i !== index)});}}><AppIcon name="close" /></Pressable>}
            </View>;
          })}
          {editable && button(t('draft.add'), () => {const key = nextTaskKey.current++; setTaskKeys(keys => [...keys, key]); setInput({...input, taskTitles: [...input.taskTitles, '']});}, busy || input.taskTitles.length >= 24)}
        </View>
        {dirty && <Text style={[styles.body, {color: theme.color.muted}]}>{t('draft.dirty')}</Text>}
        {editable && dirty && button(t('draft.save'), () => void act('edit'), busy || !valid, true)}
        {(editable || resumable) && !dirty && button(t('draft.confirm'), () => void act('confirm'), busy || !valid || !!latest, true)}
        {(editable || resumable) && button(t('draft.reject'), () => Alert.alert(t('draft.reject'), t('draft.rejectBody'), [{text: t('space.cancel'), style: 'cancel'}, {text: t('draft.reject'), style: 'destructive', onPress: () => void act('reject')}]), busy || !!latest)}
      </>}
      {unknown && button(t('draft.recheck'), () => void act('recheck'), busy, true)}
      {error && !!input && !unknown && button(t('draft.latest'), () => void inspectLatest(), busy)}
      {error && !dirty && !unknown && button(t('space.refresh'), () => void load(), busy)}
      {saved && button(t('draft.return'), () => router.navigate('/space'), busy, true)}
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  nav: {paddingHorizontal: 8, alignItems: 'flex-start'}, iconButton: {minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center'},
  content: {width: '100%', maxWidth: 680, alignSelf: 'center', padding: 24, paddingBottom: 40, gap: 20},
  heading: {fontSize: 28, fontWeight: '600'}, body: {fontSize: 15, lineHeight: 24}, section: {fontSize: 20, fontWeight: '600'},
  card: {borderRadius: 24, padding: 20, gap: 12}, field: {gap: 8}, label: {fontSize: 14},
  input: {fontSize: 17, minHeight: 52, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth},
  task: {flexDirection: 'row', alignItems: 'center', gap: 8}, button: {minHeight: 52, padding: 14, borderRadius: 28, alignItems: 'center', justifyContent: 'center'},
  buttonText: {fontSize: 17, fontWeight: '600', textAlign: 'center'},
});
