import { useCallback, useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import type { FamilyManagementAcceptancePreview, FrozenFamilyReviewScope } from '@siyue/contracts';
import { AccountPage } from '../account-nav';
import { accountText } from '../account-messages';
import { authErrorText } from '../auth-messages';
import { useAccountAuth } from '../auth-provider';
import { useAccountBusyGuard } from '../hooks/use-busy-guard';
import { useLocale } from '../../i18n';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/choice';
import { fill } from '../copy';
import { useToast } from '../../ui/toast';
import { useTheme } from '../../ui/theme';
import { Text, View } from 'react-native';

type Preview = FamilyManagementAcceptancePreview | FrozenFamilyReviewScope;
export default function FamilyDetailScreen() {
  const { locale } = useLocale(); const t = accountText(locale); const theme = useTheme(); const toast = useToast();
  const { id, index, status } = useLocalSearchParams<{ id: string; index?: string; status?: string }>();
  const { client, state } = useAccountAuth();
  const [scope, setScope] = useState<Preview | null>(null);
  const [management, setManagement] = useState(false); const [guardianship, setGuardianship] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const frozen = status === 'frozen';
  useAccountBusyGuard(busy, t.familyReviewTitle, t.busy);
  const load = useCallback(async () => {
    if (!client || typeof id !== 'string') return;
    setBusy(true); setError(null); setScope(null); setManagement(false); setGuardianship(false);
    try { setScope(frozen ? await client.frozenFamilyPreview(id) : await client.familyManagementPreview(id)); }
    catch (failure) { setError(failure instanceof Error && 'code' in failure ? String(failure.code) : 'unavailable'); }
    finally { setBusy(false); }
  }, [client, frozen, id]);
  useEffect(() => { void load(); }, [load, state.generation]);
  async function accept() {
    if (!client || !scope || !management || !guardianship) return;
    setBusy(true); setError(null);
    try {
      const input = { expectedFamilyVersion: scope.familyVersion, expectedMembershipVersion: scope.membershipVersion,
        expectedOwnerMembershipVersion: scope.ownerMembershipVersion, expectedChildScopeDigest: scope.childScopeDigest,
        acceptance: { familyManagement: true as const, guardianship: true as const } };
      if (frozen) await client.acceptFrozenFamily(scope.familyId, input);
      else await client.acceptFamilyManagement(scope.familyId, input);
      toast.show(t.accepted); router.back();
    } catch (failure) { setError(failure instanceof Error && 'code' in failure ? String(failure.code) : 'unavailable'); setScope(null); }
    finally { setBusy(false); }
  }
  const name = fill(t.familyLabel, { index: Number(index) || 1 });
  return <AccountPage title={t.familyReviewTitle} lead={t.familyReviewLead} testID="account-family-detail"
    footer={<Button label={t.confirmAccept} disabled={!scope || !management || !guardianship} loading={busy} onPress={() => void accept()} />}>
    {error ? <Banner kind="error" body={authErrorText(locale, error)} action={<Button label={t.retry} variant="text" onPress={() => void load()} />} /> : null}
    {scope ? <>
      <Text style={{ color: theme.color.ink, fontSize: 20, fontWeight: '600', marginBottom: 16 }}>{fill(t.familyReviewHeading, { name })}</Text>
      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
        <View style={{ flex: 1, borderRadius: 20, padding: 16, backgroundColor: theme.color.surface }}><Text style={{ fontSize: 28, color: theme.color.ink }}>1</Text><Text style={{ color: theme.color.muted }}>{t.statFamilies}</Text></View>
        <View style={{ flex: 1, borderRadius: 20, padding: 16, backgroundColor: theme.color.surface }}><Text style={{ fontSize: 28, color: theme.color.ink }}>{scope.childCount}</Text><Text style={{ color: theme.color.muted }}>{t.statChildren}</Text></View>
      </View>
      <Banner kind="info" body={frozen ? t.familyFrozenInfo : t.familyInfo} />
      <Checkbox label={t.checkManagement} checked={management} onChange={setManagement} disabled={busy} />
      <Checkbox label={t.checkGuardianship} checked={guardianship} onChange={setGuardianship} disabled={busy} />
    </> : null}
  </AccountPage>;
}
