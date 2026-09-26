import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { AccountPage } from '../account-nav';
import { accountText } from '../account-messages';
import { authErrorText } from '../auth-messages';
import { useAccountAuth } from '../auth-provider';
import { useLocale } from '../../i18n';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { ListGroup, ListRow } from '../../ui/list';
import { fill } from '../copy';

type FamilyItem = { familyId: string; status: 'active' | 'frozen' };
export default function FamilyScreen() {
  const { locale } = useLocale(); const t = accountText(locale);
  const { client, state } = useAccountAuth();
  const [families, setFamilies] = useState<readonly FamilyItem[] | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!client) return;
    setBusy(true); setError(null);
    try { setFamilies(await client.familyResponsibilities()); }
    catch (failure) { setError(failure instanceof Error && 'code' in failure ? String(failure.code) : 'unavailable'); }
    finally { setBusy(false); }
  }, [client]);
  useEffect(() => { setFamilies(null); void load(); }, [load, state.generation]);
  return <AccountPage title={t.familyTitle} lead={t.familyLead} testID="account-family">
    {error ? <Banner kind="error" body={authErrorText(locale, error)} /> : null}
    <Button label={t.familyRefresh} size="sm" variant="tonal" loading={busy} onPress={() => void load()} />
    {families?.length === 0 ? <Banner kind="info" body={t.familyEmpty} /> : null}
    {families ? <ListGroup>{families.map((family, index) => <ListRow key={family.familyId} icon="people"
      title={fill(t.familyLabel, { index: index + 1 })}
      subtitle={family.status === 'frozen' ? t.familyStatusFrozen : t.familyStatusActive}
      badge={t.familyBadge} testID={`account-family-${index + 1}`}
      onPress={() => router.push({ pathname: '/account/family/[id]', params: { id: family.familyId, index: String(index + 1), status: family.status } } as never)} />)}</ListGroup> : null}
  </AccountPage>;
}
