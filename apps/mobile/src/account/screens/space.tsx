import { useState } from 'react';
import { AccountPage } from '../account-nav';
import { accountText } from '../account-messages';
import { useAccountAuth } from '../auth-provider';
import { useWorkspace } from '../workspace-provider';
import { useLocale } from '../../i18n';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { useToast } from '../../ui/toast';
import { useTheme } from '../../ui/theme';
import { Text, View } from 'react-native';

export default function SpaceScreen() {
  const { locale } = useLocale(); const t = accountText(locale); const theme = useTheme(); const toast = useToast();
  const { state: auth } = useAccountAuth(); const { host, state } = useWorkspace();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const current = state.scope?.kind ?? null;
  async function create() {
    if (!host || !state.canCreate) return;
    setBusy(true); setError(false);
    try { await host.createAccountSpace(auth.generation); toast.show(t.spaceAccountCreated); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  const card = (title: string, body: string, selected: boolean) => <View style={{ backgroundColor: selected ? theme.color.focus : theme.color.surface,
    borderRadius: 20, padding: 18, marginBottom: 12 }}><Text style={{ fontSize: 18, fontWeight: '600', color: theme.color.ink }}>{title}</Text>
    <Text style={{ color: theme.color.muted, marginTop: 6 }}>{body}</Text>{selected ? <Text style={{ color: theme.color.accent, marginTop: 8 }}>{locale === 'en' ? 'Current' : '当前使用'}</Text> : null}</View>;
  return <AccountPage title={t.spaceTitle} lead={t.spaceLead} testID="account-space"
    footer={state.canCreate ? <Button label={t.createSpace} loading={busy} onPress={() => void create()} /> : undefined}>
    {error ? <Banner kind="error" body={t.spaceUnavailable} /> : null}
    {card(t.spaceOriginalCard, t.spaceOriginalDetail, current === 'local')}
    {card(t.spaceAccountCard, current === 'account' ? t.spaceAccountCreated : t.spaceAccountDetail, current === 'account')}
    <Banner kind="info" body={t.spaceNote} />
  </AccountPage>;
}
