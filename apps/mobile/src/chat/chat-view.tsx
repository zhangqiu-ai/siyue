import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';
import type { ActionDraft, ChatMessage } from '@siyue/contracts';
import { getClient } from '../client';
import { useWorkspace } from '../account/workspace-provider';
import { useLocale } from '../i18n';
import { AppIcon, Button, useTheme, useToast, type Theme } from '../ui';
import { parseMarkdown, type MdSpan } from './markdown';
import { chatErrorMessages, type ChatErrorCode } from './chat-error';

export function useStyles() {
  const theme = useTheme();
  return { theme, s: makeStyles(theme) };
}

function Spans({ spans, style }: { spans: MdSpan[]; style: object }) {
  const { theme } = useStyles();
  return <Text style={style} selectable>{spans.map((span, index) => span.kind === 'bold' ? <Text key={index} style={{ fontWeight: '700' }}>{span.text}</Text>
    : span.kind === 'code' ? <Text key={index} style={{ fontFamily: 'Menlo', backgroundColor: theme.color.subtle }}>{span.text}</Text>
    : <Text key={index}>{span.text}</Text>)}</Text>;
}

/** Assistant text rendered as typeset prose: paragraphs, lists, quotes and code, never HTML. */
export function Markdown({ source, streaming }: { source: string; streaming?: boolean }) {
  const { s } = useStyles();
  const blocks = parseMarkdown(source);
  return <View style={{ gap: 10 }}>
    {blocks.map((block, index) => {
      if (block.kind === 'paragraph') return <Spans key={index} spans={block.spans} style={s.prose} />;
      if (block.kind === 'quote') return <View key={index} style={s.quote}><Spans spans={block.spans} style={s.prose} /></View>;
      if (block.kind === 'code') return <ScrollView key={index} horizontal style={s.code}><Text style={s.codeText}>{block.text}</Text></ScrollView>;
      return <View key={index} style={{ gap: 4 }}>{block.items.map((item, i) => <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
        <Text style={[s.prose, { minWidth: 18 }]}>{block.ordered ? i + 1 + '.' : '•'}</Text><View style={{ flex: 1 }}><Spans spans={item} style={s.prose} /></View></View>)}</View>;
    })}
    {streaming && <View style={s.cursor} accessibilityElementsHidden />}
  </View>;
}

function PlanDraftCard({ id }: { id: string }) {
  const { t } = useLocale();
  const { s } = useStyles();
  const { state } = useWorkspace();
  const [draft, setDraft] = useState<ActionDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  useFocusEffect(useCallback(() => {
    let live = true;
    setLoaded(false);
    void getClient().then(client => client.snapshot()).then(snapshot => {
      if (live) setDraft(snapshot.drafts.find(item => item.id === id && item.command.kind === 'plan.create') ?? null);
    }).catch(() => { if (live) setDraft(null); }).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [id, state.revision]));
  if (!loaded) return null;
  if (!draft || draft.command.kind !== 'plan.create') return <View style={s.planCard}>
    <Text style={s.planLabel}>{t('chat.planDraft')}</Text><Text style={s.note}>{t('chat.planUnavailable')}</Text>
  </View>;
  const plan = draft.command.payload;
  const active = draft.status === 'draft' || draft.status === 'approved';
  const expired = active && Date.parse(draft.expiresAt) <= Date.now();
  const status = draft.status === 'applied' ? 'chat.planApplied' : expired || draft.status === 'expired' ? 'chat.planExpired'
    : active ? 'chat.planNeedsApproval' : 'chat.planClosed';
  return <View style={s.planCard}>
    <Text style={s.planLabel}>{t('chat.planDraft')} · {t(status)}</Text>
    <Text style={s.planTitle}>{plan.title}</Text>
    <Text style={s.note}>{active && !expired ? t('chat.planCounts', { projects: plan.projectTitles.length, tasks: plan.taskTitles.length }) : t('chat.planStatusBody')}</Text>
    <Button size="sm" variant="tonal" label={t(active && !expired ? 'chat.planReview' : 'chat.planViewStatus')} onPress={() => router.push({ pathname: '/plan/draft', params: { id } })} />
  </View>;
}

export function MessageView({ message, last, running, onStop, onRegenerate, onCreatePlan, planBusy, planError }: {
  message: ChatMessage; last: boolean; running: boolean; onStop: () => void; onRegenerate: () => void;
  onCreatePlan?: () => void; planBusy?: boolean; planError?: string | null;
}) {
  const { t } = useLocale();
  const { theme, s } = useStyles();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  if (message.role === 'user') return <View style={s.userBubble}><Text style={s.userText} selectable>{message.text}</Text></View>;
  const failed = message.status === 'failed';
  const busy = message.status === 'streaming';
  return <View style={{ gap: 6 }}>
    {(message.text || busy) ? <Markdown source={message.text} streaming={busy} /> : null}
    {message.status === 'stopped' && <Text style={s.note}>{t('chat.stoppedShort')}</Text>}
    {message.planDraftId && <PlanDraftCard id={message.planDraftId} />}
    {onCreatePlan && !message.planDraftId && !busy && !failed && <Button size="sm" variant="tonal" icon="target" label={t('chat.makePlan')} loading={planBusy} onPress={onCreatePlan} />}
    {planError && <Text accessibilityRole="alert" style={s.errorText}>{planError}</Text>}
    {failed && <View style={s.errorBox} accessibilityRole="alert">
      <AppIcon name="warning" size={20} color={theme.color.error} />
      <View style={{ flex: 1, gap: 10 }}>
        <Text style={s.errorText}>{t(chatErrorMessages[(message.errorCode ?? 'unknown') as ChatErrorCode] ?? 'chat.errorUnknown')}</Text>
        {(message.errorCode === 'unconfigured' || message.errorCode === 'auth') ? <Button size="sm" variant="tonal" label={t('chat.connect')} onPress={() => router.push('/ai-provider')} />
          : last ? <Button size="sm" variant="tonal" icon="retry" label={t('chat.resend')} onPress={onRegenerate} /> : null}
      </View>
    </View>}
    {!busy && message.text ? <View style={s.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel={copied ? t('chat.copied') : t('chat.copy')} style={s.action}
        onPress={() => void Clipboard.setStringAsync(message.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => toast.show(t('chat.copyFailed')))}>
        <AppIcon name={copied ? 'check' : 'copy'} size={18} color={theme.color.muted} />
      </Pressable>
      {!failed && last ? <Pressable accessibilityRole="button" accessibilityLabel={t('chat.retry')} style={s.action} onPress={onRegenerate}>
        <AppIcon name="retry" size={18} color={theme.color.muted} />
      </Pressable> : null}
    </View> : null}
  </View>;
}

export function Composer({ value, onChange, onSend, onStop, running, autoFocus }: { value: string; onChange: (v: string) => void; onSend: () => void; onStop: () => void; running: boolean; autoFocus?: boolean }) {
  const { t } = useLocale();
  const { theme, s } = useStyles();
  const ready = value.trim().length > 0;
  return <View style={s.composer}>
    <TextInput accessibilityLabel={t('chat.input')} placeholder={t('chat.placeholder')} placeholderTextColor={theme.color.muted} value={value} onChangeText={onChange}
      multiline maxLength={8000} autoFocus={autoFocus} style={s.composerInput} />
    {running ? <Pressable accessibilityRole="button" accessibilityLabel={t('chat.stop')} onPress={onStop} style={[s.send, { backgroundColor: theme.color.ink }]}><AppIcon name="stop" size={16} color={theme.color.background} /></Pressable>
      : <Pressable accessibilityRole="button" accessibilityLabel={t('chat.send')} accessibilityState={{ disabled: !ready }} disabled={!ready} onPress={onSend}
        style={[s.send, { backgroundColor: ready ? theme.color.accent : theme.color.subtle }]}><AppIcon name="send" size={18} color={ready ? theme.color.onAccent : theme.color.muted} /></Pressable>}
  </View>;
}

export function ConnectCard() {
  const { t } = useLocale();
  const { theme, s } = useStyles();
  const { width, fontScale } = useWindowDimensions();
  const stacked = fontScale > 1.3 || width < 340;
  return <View style={[s.connect, stacked && { flexDirection: 'column', alignItems: 'stretch' }]}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, flex: stacked ? undefined : 1 }}>
      <AppIcon name="info" size={22} color={theme.color.accent} />
      <View style={{ flex: 1 }}><Text style={s.connectTitle}>{t('chat.connectTitle')}</Text><Text style={s.note}>{t('chat.connectBody')}</Text></View>
    </View>
    <Button size={stacked ? 'md' : 'sm'} label={t('chat.connect')} onPress={() => router.push('/ai-provider')} />
  </View>;
}

/** A scrolling transcript that follows new text unless the reader has scrolled up. */
export function Transcript({ children, footer, contentKey }: { children: ReactNode; footer?: ReactNode; contentKey: string }) {
  const { t } = useLocale();
  const { theme, s } = useStyles();
  const ref = useRef<ScrollView>(null);
  const [away, setAway] = useState(false);
  const following = useRef(true);
  useEffect(() => { following.current = true; setAway(false); }, [contentKey]);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height;
    following.current = distance < 80;
    setAway(distance > 480);
  };
  return <View style={{ flex: 1 }}>
    <ScrollView ref={ref} onScroll={onScroll} scrollEventThrottle={64} keyboardShouldPersistTaps="handled" contentContainerStyle={s.transcript}
      onContentSizeChange={() => { if (following.current) ref.current?.scrollToEnd({ animated: false }); }}>
      <View style={s.column}>{children}</View>
    </ScrollView>
    {away && <Pressable accessibilityRole="button" accessibilityLabel={t('chat.latest')} onPress={() => { following.current = true; ref.current?.scrollToEnd({ animated: true }); }} style={s.latest}>
      <AppIcon name="down" size={18} color={theme.color.ink} /></Pressable>}
    {footer}
  </View>;
}

export function useWide() {
  const { width } = useWindowDimensions();
  return width >= 700;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  prose: { fontSize: 16, lineHeight: 25, color: theme.color.ink },
  quote: { backgroundColor: theme.color.subtle, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
  code: { backgroundColor: theme.color.subtle, borderRadius: 12, padding: 12 },
  codeText: { fontFamily: 'Menlo', fontSize: 14, lineHeight: 20, color: theme.color.ink },
  cursor: { width: 8, height: 18, borderRadius: 2, backgroundColor: theme.color.accent },
  userBubble: { alignSelf: 'flex-end', maxWidth: '84%', backgroundColor: theme.color.focus, borderRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 10 },
  userText: { fontSize: 16, lineHeight: 23, color: theme.color.onFocus },
  note: { fontSize: 13, lineHeight: 19, color: theme.color.muted },
  errorBox: { flexDirection: 'row', gap: 10, backgroundColor: theme.color.errorSurface, borderRadius: 16, padding: 14 },
  errorText: { fontSize: 14, lineHeight: 20, color: theme.color.ink },
  planCard: { backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1.5, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, gap: 8 },
  planLabel: { fontSize: 13, lineHeight: 18, color: theme.color.accent, fontWeight: '600' },
  planTitle: { fontSize: 18, lineHeight: 24, color: theme.color.ink, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 2, marginLeft: -8 },
  action: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: theme.color.surface, borderWidth: 1.5, borderColor: theme.color.border, borderRadius: 26, paddingLeft: 18, paddingRight: 6, paddingVertical: 6 },
  composerInput: { flex: 1, fontSize: 17, lineHeight: 24, color: theme.color.ink, minHeight: 40, maxHeight: 140, paddingTop: 8, paddingBottom: 8 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  connect: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: theme.color.surface, borderRadius: 20, padding: 16 },
  connectTitle: { fontSize: 16, lineHeight: 22, fontWeight: '600', color: theme.color.ink },
  transcript: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24 },
  column: { width: '100%', maxWidth: 720, alignSelf: 'center', gap: 18 },
  latest: { position: 'absolute', right: 20, bottom: 96, width: 44, height: 44, borderRadius: 22, backgroundColor: theme.color.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.color.border },
});
