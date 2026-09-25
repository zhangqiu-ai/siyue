import {useWorkspaceValue,useWorkspaceRef} from '../account/workspace-scratch';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useNavigation, usePreventRemove } from 'expo-router/react-navigation';
import * as Crypto from 'expo-crypto';
import type { GoalDraft } from '@siyue/contracts';
import type { LocalRequest } from '@siyue/adapters';
import { getClient } from '../client';
import { useLocale, type MessageKey } from '../i18n';
import { AppIcon } from '../ui/icon';
import { useTheme } from '../ui/theme';
import { usePlanGeneration } from '../space/use-plan-generation';
import { planErrorKey } from '../space/plan-error';

export default function PlanCreateScreen() {
  const {t} = useLocale(), theme = useTheme(), router = useRouter(), navigation = useNavigation();
  const generate = usePlanGeneration();
  const [mode, setMode] = useWorkspaceValue<'ai' | 'manual'>('create.mode','ai');
  const [goal, setGoal] = useWorkspaceValue('create.goal',''), [project, setProject] = useWorkspaceValue('create.project','');
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useWorkspaceValue('create.unknown',false);
  const [error, setError] = useState<MessageKey | null>(null), [created, setCreated] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null), locked = useRef(false), mounted = useRef(true);
  const manual = useWorkspaceRef<{payload: GoalDraft; request: LocalRequest} | null>('create.manual',null);
  useEffect(() => { mounted.current = true; return () => {mounted.current = false; controller.current?.abort();}; }, []);
  usePreventRemove(!created && (busy || !!goal || !!project), ({data}) => {
    if (busy) return;
    Alert.alert(t('ai.discardTitle'), t(unknown ? 'plan.manualUnknown' : 'plan.leave'), [
      {text: t('ai.keepEditing'), style: 'cancel'},
      // Leaves this space's edit buffers untouched, so returning restores the input; not a discard.
      {text: t('ai.keepAndReturn'), onPress: () => navigation.dispatch(data.action)},
      {text: t('ai.discard'), style: 'destructive', onPress: () => {
        setGoal(''); setProject(''); setUnknown(false); manual.current = null;
        navigation.dispatch(data.action);
      }},
    ]);
  });
  useEffect(() => { if (created && !busy) router.replace({pathname: '/plan-draft', params: {id: created}}); }, [created, busy, router]);
  const submit = async () => {
    if (locked.current || !goal.trim() || mode === 'manual' && !project.trim()) return;
    locked.current = true; setBusy(true); setError(null); Keyboard.dismiss();
    const abort = new AbortController(); controller.current = abort;
    try {
      const draft = mode === 'ai' ? await generate(goal, abort.signal) : await (async () => {
        manual.current ??= {payload: {title: goal.trim(), projectTitles: [project.trim()], taskTitles: []}, request: {commandId: Crypto.randomUUID(), issuedAt: new Date().toISOString()}};
        return (await getClient()).createManualDraft(manual.current.payload, manual.current.request);
      })();
      if (mounted.current) {manual.current=null;setGoal('');setProject('');setCreated(draft.id);setUnknown(false);}
    } catch (failure) {
      if (mounted.current) {
        if (mode === 'ai') setError(planErrorKey(failure));
        else {
          const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined;
          const definite = ['invalid_input', 'approval_expired', 'command_conflict', 'forbidden'].includes(String(code));
          if (definite) manual.current = null;
          setUnknown(!definite); setError(definite ? 'draft.error' : 'plan.manualUnknown');
        }
      }
    } finally { locked.current = false; controller.current = null; if (mounted.current) setBusy(false); }
  };
  const button = (label: string, action: () => void, disabled = false, primary = false) => <Pressable accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={action}
    style={({pressed}) => [styles.button, {backgroundColor: primary ? theme.color.accent : pressed ? theme.color.subtle : 'transparent', opacity: disabled ? 0.4 : 1}]}><Text style={[styles.buttonText, {color: primary ? theme.color.onAccent : theme.color.accent}]}>{label}</Text></Pressable>;
  return <SafeAreaView style={{flex: 1, backgroundColor: theme.color.background}}>
    <View style={styles.nav}><Pressable accessibilityRole="button" accessibilityLabel={t('common.back')} disabled={busy} style={styles.back} onPress={() => router.back()}><AppIcon name="back" /></Pressable></View>
    <ScrollView automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={[styles.heading, {color: theme.color.ink}]}>{t('plan.create')}</Text>
      <View style={[styles.modes, {backgroundColor: theme.color.subtle}]}>{(['ai', 'manual'] as const).map(value => <Pressable key={value} accessibilityRole="button" accessibilityState={{selected: mode === value, disabled: busy || unknown}} disabled={busy || unknown} onPress={() => {setMode(value); setError(null);}}
        style={[styles.mode, {backgroundColor: mode === value ? theme.color.surface : 'transparent'}]}><Text style={[styles.buttonText, {color: theme.color.ink}]}>{t(value === 'ai' ? 'plan.ai' : 'plan.manual')}</Text></Pressable>)}</View>
      <View style={[styles.card, {backgroundColor: theme.color.surface}]}>
        <Text style={[styles.body, {color: theme.color.muted}]}>{t('plan.prompt')}</Text>
        <TextInput accessibilityLabel={t('draft.goal')} multiline maxLength={160} value={goal} onChangeText={setGoal} editable={!busy && !unknown} selectionColor={theme.color.accent} style={[styles.input, {color: theme.color.ink, borderColor: theme.color.controlBorder}]} />
        {mode === 'manual' && <><Text style={[styles.body, {color: theme.color.muted}]}>{t('draft.project')}</Text><TextInput accessibilityLabel={t('draft.project')} multiline maxLength={160} value={project} onChangeText={setProject} editable={!busy && !unknown} selectionColor={theme.color.accent} style={[styles.input, {color: theme.color.ink, borderColor: theme.color.controlBorder}]} /></>}
      </View>
      <Text style={[styles.body, {color: theme.color.muted}]}>{t(mode === 'ai' ? 'plan.disclosure' : 'plan.manualNote')}</Text>
      {error && <Text accessibilityRole="alert" style={[styles.body, {color: error === 'plan.cancelled' || error === 'plan.manualUnknown' || error === 'plan.configRequired' ? theme.color.ink : theme.color.error}]}>{t(error)}</Text>}
      {busy && <View style={{gap: 12}}><ActivityIndicator color={theme.color.accent} /><Text accessibilityLiveRegion="polite" style={[styles.body, {color: theme.color.muted}]}>{t(mode === 'ai' ? 'plan.generating' : 'space.loading')}</Text></View>}
      {busy && mode === 'ai' ? button(t('plan.stop'), () => controller.current?.abort()) : button(t(unknown ? 'plan.retryManual' : mode === 'ai' ? 'plan.generate' : 'plan.manualDraft'), () => void submit(), busy || !goal.trim() || mode === 'manual' && !project.trim(), true)}
      {mode === 'ai' && button(t('settings.aiService'), () => router.push('/ai-provider'), busy)}
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  nav: {paddingHorizontal: 8, alignItems: 'flex-start'}, back: {width: 48, height: 48, alignItems: 'center', justifyContent: 'center'},
  content: {width: '100%', maxWidth: 680, alignSelf: 'center', padding: 24, gap: 20, paddingBottom: 40}, heading: {fontSize: 28, fontWeight: '600'},
  modes: {flexDirection: 'row', flexWrap: 'wrap', padding: 4, borderRadius: 20}, mode: {flexGrow: 1, padding: 14, borderRadius: 16},
  card: {padding: 20, borderRadius: 24, gap: 12}, input: {minHeight: 70, fontSize: 18, paddingVertical: 12, paddingHorizontal: 16, borderWidth: 1, borderRadius: 12},
  body: {fontSize: 15, lineHeight: 24}, button: {minHeight: 52, padding: 14, borderRadius: 28, alignItems: 'center', justifyContent: 'center'}, buttonText: {fontSize: 17, fontWeight: '600', textAlign: 'center'},
});
