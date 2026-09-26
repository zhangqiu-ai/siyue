import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { router } from 'expo-router';
import AppleSignInButton from '../apple-button';
import { authorizeApple, isAppleAvailable } from '../apple-native';
import { useAccountAuth } from '../auth-provider';
import { accountText } from '../account-messages';
import { authErrorText } from '../auth-messages';
import { useLocale } from '../../i18n';
import { AccountPage } from '../account-nav';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { ResultView } from '../../ui/result-view';
import { useAccountBusyGuard } from '../hooks/use-busy-guard';
import { useTheme } from '../../ui/theme';

export function RestoringScreen() {
  const { locale } = useLocale(); const t = accountText(locale); const theme = useTheme();
  return <AccountPage title={t.title} nav="close" testID="account-restoring">
    <View accessibilityLabel={t.busy} style={{ backgroundColor: theme.color.focus, borderRadius: 24, padding: 20, flexDirection: 'row', gap: 16 }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: theme.color.subtle }} />
      <View style={{ flex: 1, gap: 12, justifyContent: 'center' }}>
        <View style={{ height: 18, width: '65%', borderRadius: 9, backgroundColor: theme.color.subtle }} />
        <View style={{ height: 14, width: '45%', borderRadius: 7, backgroundColor: theme.color.subtle }} />
      </View>
    </View>
  </AccountPage>;
}

export function EntryScreen() {
  const { locale } = useLocale();
  const t = accountText(locale);
  const { client, state } = useAccountAuth();
  const [apple, setApple] = useState(false);
  const [email, setEmail] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAccountBusyGuard(busy, t.entryTitle, t.busy);
  useEffect(() => {
    if (!client) return;
    let live = true;
    void client.providers().then(async providers => {
      const available = Platform.OS === 'ios' && providers.apple.enabled && providers.apple.platforms.includes('ios') && await isAppleAvailable();
      if (live) { setEmail(providers.emailPassword.enabled); setApple(available); }
    }).catch(() => { if (live) setError('unavailable'); });
    void client.deletionStatus().then(value => { if (live) setReceipt(value !== null); }).catch(() => {});
    return () => { live = false; };
  }, [client, state.generation]);
  async function signInWithApple() {
    if (!client) return;
    setBusy(true); setError(null);
    try { if (client.canRetryApple()) await client.retryApple(); else await client.loginApple(authorizeApple); }
    catch (failure) {
      const code = failure instanceof Error && 'code' in failure ? String(failure.code) : 'unavailable';
      if (code !== 'cancelled') setError(code);
    } finally { setBusy(false); }
  }
  if (state.status === 'secure-storage-unavailable') return <AccountPage title={t.secureTitle} nav="close"
    footer={<Button label={t.retry} onPress={() => void client?.bootstrap()} />}>
    <ResultView icon="warning" title={t.secureTitle} body={t.secureBody} />
  </AccountPage>;
  return <AccountPage title={t.entryTitle} lead={t.entryLead} nav="close" testID="account-entry"
    footer={<>
      {apple ? <AppleSignInButton disabled={busy} onPress={() => void signInWithApple()} /> : null}
      {email ? <Button label={t.emailSignIn} variant="tonal" disabled={busy} onPress={() => router.push('/account/sign-in' as never)} testID="account-email-entry" /> : null}
      {email ? <Button label={t.createAccount} variant="text" disabled={busy} onPress={() => router.push('/account/sign-up' as never)} /> : null}
      {!email && !apple ? <Button label={t.retry} onPress={() => void client?.bootstrap()} /> : null}
    </>}>
    {receipt ? <Banner kind="info" title={t.progressBanner} action={<Button label={t.progressBanner} variant="text" onPress={() => router.push('/account/delete/progress' as never)} />} /> : null}
    {state.status === 'reauth-required' ? <Banner kind="warn" body={t.expiredSession} /> : null}
    {error ? <Banner kind="error" body={authErrorText(locale, error)} /> : null}
    <Banner kind="info" body={t.entryLocal} />
  </AccountPage>;
}
