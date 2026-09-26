import { useEffect, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { router } from 'expo-router';
import { AccountPage } from '../account-nav';
import { accountText } from '../account-messages';
import { authErrorText } from '../auth-messages';
import { useAccountAuth } from '../auth-provider';
import { useAccountBusyGuard } from '../hooks/use-busy-guard';
import { useLocale } from '../../i18n';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { PasswordField } from '../../ui/text-field';
import { PasswordRules } from '../../ui/password-rules';
import { ResultView } from '../../ui/result-view';

export default function PasswordScreen() {
  const { locale } = useLocale(); const t = accountText(locale);
  const { client, state } = useAccountAuth();
  const [current, setCurrent] = useState(''); const [next, setNext] = useState(''); const [repeat, setRepeat] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const [retry, setRetry] = useState(state.passwordChangePending === true);
  const [done, setDone] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (state.passwordChangePending === true) setRetry(true); }, [state.passwordChangePending]);
  useEffect(() => { setCurrent(''); setNext(''); setRepeat(''); }, [state.account?.subjectId]);
  useAccountBusyGuard(busy || retry, t.passwordTitle, retry ? t.uncertainBody : t.busy);
  async function update() {
    if (!client || busy) return;
    setBusy(true); setError(null);
    try {
      if (retry) await client.retryPasswordChange();
      else {
        const requestKey = key ?? Crypto.randomUUID();
        if (!key) setKey(requestKey);
        await client.changePassword(current, next, requestKey);
      }
      setCurrent(''); setNext(''); setRepeat(''); setKey(null); setRetry(false); setDone(true);
    } catch (failure) {
      const code = failure instanceof Error && 'code' in failure ? String(failure.code) : 'unavailable';
      setError(code);
      if (client.hasPendingPasswordChange()) setRetry(true);
      else setKey(null);
    } finally { setBusy(false); }
  }
  if (done) return <AccountPage nav="none" testID="account-password-done"
    footer={<Button label={t.signInAgain} onPress={() => router.replace('/account/sign-in' as never)} />}>
    <ResultView title={t.passwordDoneTitle} body={t.passwordDoneBody} />
  </AccountPage>;
  return <AccountPage title={t.passwordTitle} testID="account-password-change"
    footer={<Button label={retry ? t.retryRequest : t.updatePassword} loading={busy}
      disabled={!retry && (!current || next.length < 6 || next.length > 20 || next !== repeat)} onPress={() => void update()} />}>
    <Banner kind={retry ? 'warn' : 'info'} title={retry ? t.uncertainTitle : undefined} body={retry ? t.uncertainBody : t.passwordInfo} />
    {error ? <Banner kind="error" body={authErrorText(locale, error)} /> : null}
    {!retry ? <>
      <PasswordField label={t.currentPassword} value={current} onChangeText={setCurrent}
        showLabel={t.showPassword} hideLabel={t.hidePassword} autoComplete="current-password"
        trailing={<Button label={t.forgot} size="sm" variant="text" onPress={() => router.push('/account/reset' as never)} />} />
      <PasswordField label={t.newPassword} value={next} onChangeText={setNext}
        showLabel={t.showPassword} hideLabel={t.hidePassword} autoComplete="new-password" />
      <PasswordField label={t.repeatNewPassword} value={repeat} onChangeText={setRepeat}
        showLabel={t.showPassword} hideLabel={t.hidePassword} autoComplete="new-password" />
      <PasswordRules value={next} confirm={repeat} lengthLabel={t.lengthRule} matchLabel={t.matchRule}
        overLabel={n => t.overLength.replace('{count}', String(n - 20))} />
    </> : null}
  </AccountPage>;
}
