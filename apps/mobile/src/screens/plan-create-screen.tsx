import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useNavigation, usePreventRemove } from 'expo-router/react-navigation';
import * as Crypto from 'expo-crypto';
import type { GoalDraft } from '@siyue/contracts';
import type { LocalRequest } from '@siyue/adapters';
import { getClient } from '../client';
import { useLocale } from '../i18n';
import { useTheme } from '../ui/theme';
import { Button, Screen } from '../ui';
import { useWorkspaceRef, useWorkspaceValue } from '../account/workspace-scratch';
import { useCurrentSpace, useSpaceSwitcher } from '../shell/space-switcher';
import { useAISettings } from '../settings/ai-settings';
import { ModeSwitch, ExampleChips, Quote, Skeleton } from '../space/components/plan-blocks';
import { usePlanGeneration } from '../space/use-plan-generation';
import { useSpaceText } from '../space/use-space-text';
import { planErrorKey } from '../space/plan-error';

export default function PlanCreateScreen() {
  const router = useRouter(), navigation = useNavigation(), theme = useTheme(), t = useSpaceText();
  const { t: shared } = useLocale();
  const space = useCurrentSpace(), switcher = useSpaceSwitcher(), ai = useAISettings(), generate = usePlanGeneration();
  const [mode, setMode] = useWorkspaceValue<'ai' | 'manual'>('create.mode', 'ai');
  const [goal, setGoal] = useWorkspaceValue('create.goal', '');
  const [busy, setBusy] = useState(false), [stopped, setStopped] = useState(false), [permitExit, setPermitExit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useWorkspaceValue('create.unknown', false);
  const manual = useWorkspaceRef<{ payload: GoalDraft; request: LocalRequest } | null>('create.manual', null);
  const active = useRef(true), lock = useRef(false), controller = useRef<AbortController | null>(null);
  const canAI = ai.ready && ai.hasKey && !ai.storageError;
  const selectedMode = canAI ? mode : 'manual';
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  usePreventRemove((busy || !!goal) && !permitExit, ({ data }) => {
    if (busy) return;
    Alert.alert(shared('ai.discardTitle'), shared('plan.leave'), [
      { text: shared('ai.keepEditing'), style: 'cancel' },
      { text: shared('ai.keepAndReturn'), onPress: () => navigation.dispatch(data.action) },
      { text: shared('ai.discard'), style: 'destructive', onPress: () => { setPermitExit(true); setGoal(''); manual.current = null; setUnknown(false); setTimeout(() => navigation.dispatch(data.action), 0); } },
    ]);
  });
  const submit = async () => {
    const title = goal.trim();
    if (lock.current || !title || title.length > 160) { setError(t('plan.invalidGoal')); return; }
    lock.current = true; setBusy(true); setStopped(false); setError(null);
    const abort = new AbortController(); controller.current = abort;
    try {
      const draft = selectedMode === 'ai' ? await generate(title, abort.signal) : await (async () => {
        // Keep the command identity stable across a network/receipt-unknown retry.
        manual.current ??= { payload: { title, projectTitles: [title], taskTitles: [] }, request: { commandId: Crypto.randomUUID(), issuedAt: new Date().toISOString() } };
        return (await getClient()).createManualDraft(manual.current.payload, manual.current.request);
      })();
      if (active.current && !abort.signal.aborted) {
        setPermitExit(true); manual.current = null; setUnknown(false); setGoal('');
        setTimeout(() => router.replace({ pathname: '/plan/draft', params: { id: draft.id } }), 0);
      }
    } catch (failure) {
      if (active.current) {
        const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
        if (abort.signal.aborted || code === 'cancelled') { setStopped(true); setError(t('plan.stopped')); }
        else if (selectedMode === 'ai') setError(shared(planErrorKey(failure)));
        else { const definite = ['invalid_input', 'approval_expired', 'command_conflict', 'forbidden'].includes(code); if (definite) manual.current = null; setUnknown(!definite); setError(shared(definite ? 'draft.error' : 'plan.manualUnknown')); }
      }
    } finally { lock.current = false; controller.current = null; if (active.current) setBusy(false); }
  };
  return <Screen maxWidth={560} testID="plan-create" footer={!busy && <Button label={t(selectedMode === 'ai' ? 'plan.submitAi' : 'plan.submitManual')} disabled={!goal.trim() || unknown} onPress={() => void submit()} />}>
    <Pressable accessibilityRole="button" accessibilityLabel={shared('common.back')} onPress={() => router.back()} style={styles.close}><Text style={{ color: theme.color.ink, fontSize: 24 }}>×</Text></Pressable>
    {busy && selectedMode === 'ai' ? <>
      <Text accessibilityRole="header" style={[styles.heading, { color: theme.color.ink }]}>{t('generating.title')}</Text>
      <Quote>{goal}</Quote>
      <Skeleton width="70%" height={26} /><Skeleton width="40%" />
      <View style={styles.skeletonTasks}>{[88, 72, 80, 64, 76].map(width => <Skeleton key={width} width={`${width}%`} />)}</View>
      <Button label={t('generating.stop')} variant="tonal" onPress={() => controller.current?.abort()} />
    </> : <>
      <Text accessibilityRole="header" style={[styles.heading, { color: theme.color.ink }]}>{t('plan.title')}</Text>
      <ModeSwitch value={selectedMode} groupLabel={t('plan.modeGroup')} disabled={busy || unknown} onChange={setMode} options={[
        { value: 'ai', label: t('plan.modeAi'), disabled: !canAI },
        { value: 'manual', label: t('plan.modeManual') },
      ]} />
      {!canAI && <Text style={[styles.note, { color: theme.color.muted }]}>{t('plan.noteUnconfigured')}</Text>}
      <TextInput accessibilityLabel={t('plan.goalLabel')} placeholder={t('plan.goalPlaceholder')}
        placeholderTextColor={theme.color.muted} multiline maxLength={160} value={goal} onChangeText={text => { setGoal(text); setError(null); manual.current = null; setUnknown(false); }}
        editable={!busy && !unknown} style={[styles.input, { color: theme.color.ink, borderColor: theme.color.border, backgroundColor: theme.color.surface }]} />
      <Text style={[styles.note, { color: theme.color.muted }]}>{t('plan.examples')}</Text>
      <ExampleChips examples={[t('plan.example1'), t('plan.example2'), t('plan.example3')]} onPick={text => { setGoal(text); setError(null); manual.current = null; setUnknown(false); }} />
      <Text style={[styles.note, { color: theme.color.muted }]}>{t(selectedMode === 'ai' ? 'plan.noteAi' : 'plan.noteManual')}</Text>
      <Pressable accessibilityRole="button" onPress={() => switcher.open()} style={styles.spaceChoice}><Text style={{ color: theme.color.accent }}>{t('plan.spaceChip', { space: space.name })} ⌄</Text></Pressable>
      {error && <Text accessibilityRole="alert" style={[styles.note, { color: stopped ? theme.color.muted : theme.color.error }]}>{error}</Text>}
      {unknown && <Button label={shared('plan.retryManual')} variant="tonal" onPress={() => void submit()} />}
      {!canAI && <Button label={t('plan.connect')} variant="text" onPress={() => router.push('/ai-provider')} />}
    </>}
  </Screen>;
}

const styles = StyleSheet.create({
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  heading: { fontSize: 30, lineHeight: 38, fontWeight: '600', marginBottom: 22 },
  input: { minHeight: 142, borderWidth: 1, borderRadius: 18, padding: 16, fontSize: 20, lineHeight: 28, textAlignVertical: 'top' },
  note: { fontSize: 14, lineHeight: 21, marginTop: 20 },
  spaceChoice: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, marginTop: 18, borderRadius: 99 },
  skeletonTasks: { paddingTop: 16, paddingBottom: 30 },
});
