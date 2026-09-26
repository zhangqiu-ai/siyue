import { useEffect } from 'react';
import { Pressable, Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { AccountPage } from '../account-nav';
import { accountText } from '../account-messages';
import { authErrorText } from '../auth-messages';
import { useEmailEntry } from '../hooks/use-email-entry';
import { useAccountBusyGuard } from '../hooks/use-busy-guard';
import { useLocale } from '../../i18n';
import { Button } from '../../ui/button';
import { TextField, PasswordField } from '../../ui/text-field';
import { Banner } from '../../ui/banner';
import { useTheme } from '../../ui/theme';

export default function SignInScreen() {
  const { locale } = useLocale(); const t = accountText(locale); const theme = useTheme();
  const { email } = useLocalSearchParams<{ email?: string }>();
  const { flow, form, now, state } = useEmailEntry('login');
  useEffect(() => { if (flow && typeof email === 'string' && form?.email === '') flow.set('email', email); }, [email, flow]);
  useEffect(() => { if (state.status === 'authenticated') router.replace('/account'); }, [state.status]);
  useAccountBusyGuard(Boolean(form?.busy), t.signInTitle, t.busy);
  if (!form || !flow) return <AccountPage title={t.signInTitle}><Banner kind="error" body={t.unavailable} /></AccountPage>;
  const wait = Math.max(0, Math.ceil((form.retryAt - now) / 1000));
  const error = form.error ? authErrorText(locale, form.error) : null;
  return <AccountPage title={t.signInTitle} testID="account-sign-in"
    footer={<Button label={wait ? t.retryIn.replace('{count}', String(wait)) : t.signInAction}
      loading={form.busy} disabled={wait > 0 || !form.email || !form.password}
      onPress={() => void flow.submit(locale === 'en' ? 'en-US' : 'zh-CN')} testID="account-sign-in-submit" />}>
    <TextField label={t.email} value={form.email} onChangeText={value => flow.set('email', value)}
      keyboardType="email-address" autoComplete="email" maxLength={254}
      error={form.error === 'email_invalid' ? error : null} testID="account-email" />
    <PasswordField label={t.password} value={form.password} onChangeText={value => flow.set('password', value)}
      showLabel={t.showPassword} hideLabel={t.hidePassword} autoComplete="current-password" maxLength={256}
      error={form.error && form.error !== 'email_invalid' && form.error !== 'rate_limited' ? error : null}
      trailing={<Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/account/reset', params: { email: form.email } } as never)}><Text style={{ color: theme.color.accent }}>{t.forgotPassword}</Text></Pressable>}
      testID="account-password" />
    {form.error === 'rate_limited' ? <Banner kind="warn" body={error ?? undefined} /> : null}
  </AccountPage>;
}
