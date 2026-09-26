import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { BottomSheet } from '../../ui/bottom-sheet';
import { AppIcon } from '../../ui/icon';
import { ListGroup, ListRow, SectionLabel } from '../../ui/list';
import { useToast } from '../../ui/toast';
import { useTheme, type Theme } from '../../ui/theme';
import { useLocale } from '../../i18n';
import { accountText } from '../account-messages';
import { authErrorText } from '../auth-messages';
import { useAccountAuth } from '../auth-provider';
import { useWorkspace } from '../workspace-provider';
import { useHomeData } from '../hooks/use-home-data';
import { useAccountBusyGuard } from '../hooks/use-busy-guard';
import { buildHomeRows, buildIdentity, rowBlocked, type AccountHomeRow, type AccountIdentity } from '../home-view';
import { AccountNav } from '../account-nav';

/** The signed-in account home. It is one component in two placements: the page itself on a phone, and
 *  the permanently visible list on the left of a wide window, where the selected row is marked and the
 *  chosen sub-page opens beside it. */
export function AccountHomePanel({ mode }: { mode: 'page' | 'sidebar' }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const { locale } = useLocale();
  const text = accountText(locale);
  const toast = useToast();
  const { client, state } = useAccountAuth();
  const { state: space } = useWorkspace();
  const data = useHomeData();
  const pathname = usePathname();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offline = state.status === 'offline-available' || state.status === 'service-unavailable';
  const adult = state.session?.subjectKind !== 'child';
  const identity = buildIdentity({ methods: data.methods, offline, child: !adult, text });
  const rows = buildHomeRows({ methods: data.methods, deviceCount: data.deviceCount, pendingFamilies: data.pendingFamilies,
    offline, adult, spaceKind: space.scope?.kind ?? null, text });
  useAccountBusyGuard(busy, text.title, text.busy);

  async function signOut() {
    if (!client || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await client.logout();
      setConfirming(false);
      toast.show(result.server === 'pending' ? text.signedOutPending : text.signedOut);
      router.replace('/account');
    } catch (failure) {
      setError(failure instanceof Error && 'code' in failure ? String(failure.code) : 'unavailable');
      setConfirming(false);
    } finally { setBusy(false); }
  }

  /** A session this device could not verify is re-checked from here; nothing else is retried. */
  async function reconnect() {
    if (!client) return;
    setBusy(true); setError(null);
    try { await client.bootstrap(); }
    catch (failure) { setError(failure instanceof Error && 'code' in failure ? String(failure.code) : 'unavailable'); }
    finally { setBusy(false); }
  }

  const section = (keys: readonly AccountHomeRow['key'][]) => rows.filter(row => keys.includes(row.key));
  const open = (row: AccountHomeRow) => { if (!rowBlocked(row, offline)) router.push(row.route as never); };

  function rowValue(row: AccountHomeRow): string | undefined {
    return row.value ?? (rowBlocked(row, offline) ? text.needNetwork : null) ?? undefined;
  }

  function pageRow(row: AccountHomeRow) {
    return <ListRow key={row.key} icon={row.icon} title={row.title} value={rowValue(row)} badge={row.badge ?? undefined}
      disabled={rowBlocked(row, offline)} onPress={() => open(row)} testID={`account-row-${row.key}`} />;
  }

  function sidebarRow(row: AccountHomeRow) {
    const selected = pathname === row.route || pathname.startsWith(`${row.route}/`);
    const disabled = rowBlocked(row, offline);
    return <Pressable key={row.key} accessibilityRole="button" accessibilityLabel={row.title} accessibilityState={{ disabled }}
      disabled={disabled} testID={`account-side-${row.key}`} onPress={() => open(row)}
      style={({ pressed }) => [styles.sideRow, selected && styles.sideRowSelected, pressed && !disabled && styles.pressed]}>
      <View style={styles.sideTile}><AppIcon name={row.icon} size={18} color={disabled ? theme.color.muted : theme.color.accent} /></View>
      <View style={styles.sideMain}>
        <Text numberOfLines={1} style={[styles.sideTitle, disabled && styles.mutedText]}>{row.title}</Text>
        {rowValue(row) ? <Text numberOfLines={1} style={styles.sideValue}>{rowValue(row)}</Text> : null}
      </View>
      {row.badge ? <Text style={styles.sideBadge}>{row.badge}</Text> : null}
    </Pressable>;
  }

  return <View style={styles.panel}>
    <AccountNav kind="close" />
    <ScrollView testID={`account-${mode}`} contentContainerStyle={[styles.content, mode === 'sidebar' && styles.contentSide]} keyboardShouldPersistTaps="handled">
      {offline ? <Banner kind="warn" title={text.offlineTitle} body={text.offlineBody}
        action={<Button variant="tonal" size="sm" icon="retry" label={text.retry} loading={busy} onPress={() => void reconnect()} />} /> : null}
      {error ? <Banner kind="error" body={authErrorText(locale, error)} /> : null}
      {mode === 'page' ? <Text accessibilityRole="header" style={styles.title}>{text.title}</Text> : null}
      <IdentityCard identity={identity} />
      {mode === 'page' ? <>
        <SectionLabel>{text.sectionSignIn}</SectionLabel>
        <ListGroup>{section(['methods', 'password', 'devices']).map(pageRow)}</ListGroup>
        {section(['family']).length > 0 ? <><SectionLabel>{text.sectionFamily}</SectionLabel>
          <ListGroup>{section(['family']).map(pageRow)}</ListGroup></> : null}
        <SectionLabel>{text.sectionDevice}</SectionLabel>
        <ListGroup>{section(['space']).map(pageRow)}</ListGroup>
        <View style={styles.spaced}>
          <ListGroup><ListRow title={text.signOut} centered chevron={false} testID="account-row-signout" onPress={() => { setError(null); setConfirming(true); }} /></ListGroup>
        </View>
        {adult ? <View style={styles.spaced}>
          <ListGroup><ListRow title={text.deleteAccount} centered chevron={false} destructive testID="account-row-delete" onPress={() => router.push('/account/delete/impact' as never)} /></ListGroup>
        </View> : null}
      </> : <>
        <ListGroup>{rows.map(sidebarRow)}</ListGroup>
        <View style={styles.spaced}><ListGroup><ListRow title={text.signOut} centered chevron={false}
          testID="account-row-signout" onPress={() => { setError(null); setConfirming(true); }} /></ListGroup></View>
        {adult ? <View style={styles.spaced}><ListGroup><ListRow title={text.deleteAccount} centered chevron={false}
          destructive testID="account-row-delete" onPress={() => router.push('/account/delete/impact' as never)} /></ListGroup></View> : null}
      </>}
    </ScrollView>
    <BottomSheet visible={confirming} onClose={() => setConfirming(false)} title={text.signOutTitle} description={text.signOutBody}>
      <View style={styles.sheetActions}>
        <Button label={busy ? text.busy : text.signOut} loading={busy} onPress={() => void signOut()} testID="account-signout-confirm" />
        <Button label={text.cancel} variant="text" disabled={busy} onPress={() => setConfirming(false)} />
      </View>
    </BottomSheet>
  </View>;
}

function IdentityCard({ identity }: { identity: AccountIdentity }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View style={styles.card} testID="account-identity">
    <View style={styles.avatar}>{identity.skeleton || identity.avatar === null
      ? <AppIcon name="people" size={26} color={theme.color.onFocus} />
      : <Text style={styles.avatarText}>{(identity.avatar ?? '').toUpperCase()}</Text>}</View>
    <View style={styles.cardMain}>
      {identity.skeleton ? <View style={styles.skeleton} /> : <Text style={styles.cardName} numberOfLines={1}>{identity.name}</Text>}
      <View style={styles.pills}>{identity.pills.map(pill => <View key={pill.key} style={styles.pill}>
        {pill.dot ? <View style={[styles.dot, pill.dot === 'off' && styles.dotOff]} /> : null}
        <Text style={styles.pillText}>{pill.label}</Text>
      </View>)}</View>
    </View>
  </View>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  panel: { flex: 1, backgroundColor: theme.color.background },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 4, paddingBottom: 32 },
  contentSide: { maxWidth: undefined, paddingHorizontal: 16 },
  title: { color: theme.color.ink, fontSize: 30, lineHeight: 38, fontWeight: '600', letterSpacing: -0.3, marginTop: 4, marginBottom: 12 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: theme.color.focus, borderRadius: theme.radius.card, padding: 18 },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: theme.color.accent, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  avatarText: { color: theme.color.onAccent, fontSize: 24, lineHeight: 30, fontWeight: '600' },
  cardMain: { flex: 1, minWidth: 0, gap: 8 },
  cardName: { color: theme.color.onFocus, fontSize: 18, lineHeight: 24, fontWeight: '600' },
  skeleton: { width: '60%', height: 18, borderRadius: 9, backgroundColor: theme.color.subtle },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: theme.color.surface, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { color: theme.color.ink, fontSize: 13, lineHeight: 18 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.accent },
  dotOff: { backgroundColor: theme.color.muted },
  spaced: { marginTop: 28 },
  sideRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 12, paddingVertical: 10 },
  sideRowSelected: { backgroundColor: theme.color.focus },
  pressed: { backgroundColor: theme.color.subtle },
  sideTile: { width: 32, height: 32, borderRadius: 9, backgroundColor: theme.color.subtle, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  sideMain: { flex: 1, minWidth: 0 },
  sideTitle: { color: theme.color.ink, fontSize: 16, lineHeight: 22 },
  mutedText: { color: theme.color.muted },
  sideValue: { color: theme.color.muted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  sideBadge: { color: theme.color.onAccent, backgroundColor: theme.color.accent, fontSize: 12, lineHeight: 20, fontWeight: '600', paddingHorizontal: 8, borderRadius: 99, overflow: 'hidden' },
  sheetActions: { gap: 8, marginTop: 8 },
});
