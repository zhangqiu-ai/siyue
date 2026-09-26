import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import type { AccountLoginMethod } from '@siyue/contracts';
import { AccountPage } from '../account-nav';
import { accountText } from '../account-messages';
import { authErrorText } from '../auth-messages';
import { useAccountAuth } from '../auth-provider';
import { useAccountBusyGuard } from '../hooks/use-busy-guard';
import { useLocale } from '../../i18n';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { ListGroup, ListRow } from '../../ui/list';
import { BottomSheet } from '../../ui/bottom-sheet';
import { PasswordField } from '../../ui/text-field';
import { useToast } from '../../ui/toast';

export default function MethodsScreen() {
  const { locale } = useLocale(); const t = accountText(locale); const toast = useToast();
  const { client, state } = useAccountAuth();
  const [methods, setMethods] = useState<readonly AccountLoginMethod[] | null>(null);
  const [selected, setSelected] = useState<AccountLoginMethod | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAccountBusyGuard(busy, t.methodsTitle, t.busy);
  const reload = useCallback(async () => {
    if (!client) return;
    setBusy(true); setError(null);
    try { setMethods((await client.loginMethods()).items); }
    catch (failure) { setError(failure instanceof Error && 'code' in failure ? String(failure.code) : 'unavailable'); }
    finally { setBusy(false); }
  }, [client]);
  useEffect(() => { void reload(); setMethods(null); setSelected(null); setPassword(''); }, [reload, state.generation]);
  async function unlink() {
    if (!client || !selected || selected.kind !== 'email_password') return;
    setBusy(true); setError(null);
    try {
      await client.unlinkIdentity(selected.identityId, password);
      setPassword(''); setSelected(null); toast.show(t.unlinked);
      router.replace('/account');
    } catch (failure) { setError(failure instanceof Error && 'code' in failure ? String(failure.code) : 'unavailable'); }
    finally { setBusy(false); }
  }
  return <AccountPage title={t.methodsTitle} lead={t.methodsLead} testID="account-methods">
    {error ? <Banner kind="error" body={authErrorText(locale, error)} /> : null}
    {methods === null ? <Button label={t.retry} loading={busy} onPress={() => void reload()} /> :
      <ListGroup>{methods.map(method => <ListRow key={method.identityId} icon={method.kind === 'apple' ? 'apple' : 'mail'}
        title={method.kind === 'apple' ? t.methodAppleDetail : t.methodEmail}
        subtitle={method.kind === 'email_password' ? method.emailMask : undefined}
        value={methods.length === 1 ? t.onlyMethod : undefined}
        trailing={methods.length > 1 && method.kind === 'email_password' ? <Button label={t.remove} size="sm" variant="danger"
          onPress={() => setSelected(method)} /> : undefined} />)}</ListGroup>}
    <BottomSheet visible={selected !== null} onClose={() => { if (!busy) { setSelected(null); setPassword(''); } }}
      title={t.unlinkTitle} description={t.unlinkBody}>
      <PasswordField label={t.unlinkPassword} value={password} onChangeText={setPassword}
        showLabel={t.showPassword} hideLabel={t.hidePassword} autoComplete="current-password" />
      {error ? <Banner kind="error" body={authErrorText(locale, error)} /> : null}
      <Button label={t.remove} variant="dangerFill" loading={busy} disabled={!password} onPress={() => void unlink()} />
    </BottomSheet>
  </AccountPage>;
}
