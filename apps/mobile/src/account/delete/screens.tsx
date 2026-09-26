import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { AccountPage } from '../account-nav';
import { useDeletionFlow } from './deletion-flow-provider';
import { deletionText, fill } from '../deletion-messages';
import { accountText } from '../account-messages';
import { authErrorText } from '../auth-messages';
import { useLocale } from '../../i18n';
import { useTheme, type Theme } from '../../ui/theme';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { ChoiceCard } from '../../ui/choice';
import { StepHeader } from '../../ui/step-header';
import { PasswordField } from '../../ui/text-field';
import AppleSignInButton from '../apple-button';
import { authorizeApple } from '../apple-native';
import { choicesSettled, confirmRows, familySection, introRows, progressSection, recipientSection } from '../deletion-view';
import { recipientSelectable } from '../deletion-recipients';
import { useAccountBusyGuard } from '../hooks/use-busy-guard';

const path = (name: string) => `/account/delete/${name}` as never;

function usePage() {
  const flow = useDeletionFlow(); const { locale } = useLocale(); const t = deletionText(locale);
  const theme = useTheme(); const styles = makeStyles(theme);
  const [error, setError] = useState<string | null>(null);
  const names: Record<string, string> = {};
  for (const [familyId, recipient] of Object.entries(flow.picked)) if (recipient) names[familyId] = recipient.label;
  useAccountBusyGuard(flow.state.busy || flow.state.locked && flow.state.retryPending, t.entry, t.leavingBusy);
  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try { return await work(); }
    catch (failure) { setError(failure instanceof Error && 'code' in failure ? String(failure.code) : 'unavailable'); return false; }
  };
  const notice = error || flow.state.error ? <Banner kind="error" body={authErrorText(locale, error ?? flow.state.error ?? 'unavailable')} /> : null;
  return { ...flow, locale, t, theme, styles, names, run, notice };
}

function Rows({ rows }: { rows: readonly { key: string; title: string; detail: string }[] }) {
  const theme = useTheme(); const styles = makeStyles(theme);
  return <View style={styles.card}>{rows.map((row, index) => <View key={row.key} style={[styles.row, index > 0 && styles.divider]}>
    <Text style={styles.rowTitle}>{row.title}</Text><Text style={styles.detail}>{row.detail}</Text>
  </View>)}</View>;
}

export function ImpactScreen() {
  const p = usePage(); const { flow, state, t, notice, run } = p;
  useEffect(() => { if (state.step === 'progress') router.replace(path('progress')); }, [state.step]);
  return <AccountPage title={t.titleImpact} nav="close" testID="account-delete-impact"
    footer={<>
      {state.locked || p.owed ? <Button label={t.retryOriginal} loading={state.busy} onPress={() => void run(async () => { await flow.retry(); router.replace(path('progress')); })} /> :
        <Button label={t.viewFamilies} variant="tonal" loading={state.busy} onPress={() => void run(async () => {
          if (await flow.loadImpact()) router.push(path(flow.getState().step === 'families' ? 'families' : 'confirm'));
        })} />}
      <Button label={t.cancel} variant="text" onPress={() => router.back()} />
    </>}>
    <StepHeader caption={t.entry} step={1} total={3} />
    <Text style={p.styles.lead}>{t.introLead}</Text>
    <Rows rows={introRows(t)} />
    <Banner kind="info" body={t.impactNote} />{notice}
  </AccountPage>;
}

export function FamiliesScreen() {
  const p = usePage(); const { flow, state, t, names, styles, picked, setPicked, setTarget, notice } = p;
  const section = familySection(state, t, names);
  const done = state.families.filter(family => family.choice !== null).length;
  const settled = state.families.length === 0 || choicesSettled(state, picked);
  return <AccountPage title={t.titleFamilies} lead={t.familiesLead} testID="account-delete-families"
    footer={<>
      <Text style={styles.count}>{fill(accountText(p.locale).processedFamilies, { done, total: state.families.length })}</Text>
      <Button label={t.reviewChoices} disabled={!settled || state.busy} onPress={() => { if (flow.continue()) router.push(path('confirm')); }} testID="account-delete-next" />
    </>}>
    <StepHeader caption={t.entry} step={2} total={3} />
    {section.families.map(item => <View key={item.familyId} style={styles.familyCard}>
      <Text style={styles.rowTitle}>{item.title}</Text><Text style={styles.detail}>{item.detail}</Text>
      {item.options.map(option => <ChoiceCard key={option.kind} title={option.label} detail={option.detail}
        selected={item.choice?.kind === option.kind} disabled={state.busy}
        onPress={() => {
          if (option.kind === 'end-family-access') { flow.chooseDisposition({ familyId: item.familyId, kind: 'end-family-access' }); setPicked(item.familyId, undefined); }
          else { setTarget(item.familyId); router.push(path('recipient')); void p.readRecipients(item.familyId); }
        }} />)}
      {item.choiceDetail ? <Text style={styles.detail}>{item.choiceDetail}</Text> : null}
    </View>)}
    <Banner kind="info" body={t.familiesNote} />{notice}
  </AccountPage>;
}

export function RecipientScreen() {
  const p = usePage(); const { flow, t, target, picked, setPicked, recipientRead, readingRecipients, readRecipients, notice } = p;
  const section = recipientSection(recipientRead, t);
  return <AccountPage title={t.titleRecipient} lead={t.recipientLead} testID="account-delete-recipient"
    footer={<Button label={t.backToFamilies} variant="tonal" onPress={() => router.back()} />}>
    {target === null ? <Banner kind="warn" body={t.recipientUnavailable} /> : <>
      {readingRecipients ? <Banner kind="info" body={t.recipientLoading} /> : null}
      {section.status === 'unavailable' ? <Banner kind="warn" body={t.recipientUnavailable} /> : null}
      {section.status === 'empty' && !readingRecipients ? <Banner kind="info" body={t.recipientEmpty} /> : null}
      {section.rows.map(row => <ChoiceCard key={row.subjectId} title={row.title} detail={row.detail}
        selected={picked[target]?.subjectId === row.subjectId} disabled={!row.selectable}
        onPress={() => {
          const candidate = recipientRead?.kind === 'ready' ? recipientRead.recipients.find(item => item.subjectId === row.subjectId) : undefined;
          if (!candidate || !recipientSelectable(candidate)) return;
          flow.chooseDisposition({ familyId: target, kind: 'transfer', recipientSubjectId: candidate.subjectId });
          setPicked(target, candidate); router.back();
        }} />)}
      <Banner kind="info" body={t.recipientNote} />{notice}
      <Button label={t.refreshRecipients} variant="text" disabled={readingRecipients} onPress={() => void readRecipients(target)} />
    </>}
  </AccountPage>;
}

export function ConfirmScreen() {
  const p = usePage(); const { flow, state, t, names, notice, run } = p;
  const [password, setPassword] = useState('');
  const locked = state.locked && state.retryPending || p.owed;
  useEffect(() => { if (state.step === 'progress') router.replace(path('progress')); }, [state.step]);
  useEffect(() => { if (state.step === 'families' && state.error) router.replace(path('families')); }, [state.error, state.step]);
  return <AccountPage title={t.titleConfirm} lead={t.confirmLead} testID="account-delete-confirm"
    footer={<>
      {locked ? <Button label={t.retryOriginal} loading={state.busy} onPress={() => void run(async () => {
        await flow.retry(); router.replace(path('progress'));
      })} /> : <>
        <Button label={t.confirmSubmit} variant="dangerFill" loading={state.busy} disabled={!password}
          onPress={() => void run(async () => { const secret = password; setPassword(''); await flow.submitWithPassword(secret); router.replace(path('progress')); })}
          testID="account-delete-submit" />
        {p.appleEnabled ? <AppleSignInButton disabled={state.busy} onPress={() => void run(async () => {
          await flow.submitWithApple(authorizeApple); router.replace(path('progress'));
        })} /> : null}
      </>}
    </>}>
    <StepHeader caption={t.entry} step={3} total={3} />
    <Rows rows={confirmRows(state, t, names)} />
    <Button label={t.modifyChoices} variant="text" disabled={locked || state.busy || state.families.length === 0}
      onPress={() => { if (flow.backToFamilies()) router.back(); }} />
    <Banner kind={locked ? 'warn' : 'info'} body={locked ? t.lockedNote : t.confirmNote} />{notice}
    {!locked ? <PasswordField label={t.password} value={password} onChangeText={setPassword}
      showLabel={p.locale === 'en' ? 'Show password' : '显示密码'} hideLabel={p.locale === 'en' ? 'Hide password' : '隐藏密码'}
      autoComplete="current-password" /> : null}
  </AccountPage>;
}

export function ProgressScreen() {
  const p = usePage(); const { flow, state, t, notice, run } = p;
  const progress = progressSection(state, t);
  return <AccountPage title={t.titleProgress} lead={t.progressLead} testID="account-delete-progress"
    footer={<>
      <Button label={t.refreshProgress} loading={state.busy} onPress={() => void run(() => flow.loadProgress())} />
      <Button label={t.close} variant="text" onPress={() => router.replace('/account')} />
    </>}>
    {progress.rows.length ? <View style={p.styles.timeline}>{progress.rows.map((row, index) => <View key={row.key} style={p.styles.timelineRow}>
      <View style={p.styles.timelineRail}>
        <View style={[p.styles.timelineDot, row.tone === 'muted' && p.styles.timelineDotPending]} />
        {index < progress.rows.length - 1 ? <View style={p.styles.timelineLine} /> : null}
      </View>
      <View style={p.styles.timelineText}><Text style={p.styles.rowTitle}>{row.title}</Text><Text style={p.styles.detail}>{row.detail}</Text></View>
    </View>)}</View> : null}
    {progress.receiptMissing ? <Banner kind="warn" body={t.progressMissing} /> : null}
    <Banner kind="info" body={t.progressNote} />{notice}
  </AccountPage>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  card: { backgroundColor: theme.color.surface, borderRadius: 20, overflow: 'hidden', marginBottom: 16 },
  row: { padding: 16, gap: 4 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border },
  rowTitle: { color: theme.color.ink, fontSize: 16, fontWeight: '600' },
  detail: { color: theme.color.muted, fontSize: 14, lineHeight: 21, marginTop: 3 },
  lead: { color: theme.color.ink, fontSize: 16, lineHeight: 24, marginBottom: 16 },
  familyCard: { backgroundColor: theme.color.surface, borderRadius: 20, padding: 16, marginBottom: 12 },
  count: { color: theme.color.muted, textAlign: 'center', fontSize: 14 },
  timeline: { backgroundColor: theme.color.surface, borderRadius: 20, padding: 18, marginBottom: 16 },
  timelineRow: { flexDirection: 'row', gap: 14, minHeight: 66 },
  timelineRail: { width: 16, alignItems: 'center' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: theme.color.accent, marginTop: 4 },
  timelineDotPending: { backgroundColor: theme.color.muted },
  timelineLine: { flex: 1, width: 2, backgroundColor: theme.color.border, marginVertical: 4 },
  timelineText: { flex: 1, paddingBottom: 16 },
});
