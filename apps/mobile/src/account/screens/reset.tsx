import { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { AccountPage } from '../account-nav';
import { accountText } from '../account-messages';
import { authErrorText } from '../auth-messages';
import { useEmailEntry } from '../hooks/use-email-entry';
import { useAccountBusyGuard } from '../hooks/use-busy-guard';
import { useLocale } from '../../i18n';
import { Button } from '../../ui/button';
import { TextField, PasswordField } from '../../ui/text-field';
import { OtpField } from '../../ui/otp-field';
import { PasswordRules } from '../../ui/password-rules';
import { StepHeader } from '../../ui/step-header';
import { Banner } from '../../ui/banner';
import { ResultView } from '../../ui/result-view';

export default function ResetScreen() {
  const { locale } = useLocale(); const t = accountText(locale);
  const { email } = useLocalSearchParams<{ email?: string }>();
  const { flow, form, now } = useEmailEntry('reset-request');
  useEffect(() => { if (flow && typeof email === 'string' && form?.email === '') flow.set('email', email); }, [email, flow]);
  useAccountBusyGuard(Boolean(form?.busy || form?.retryPending), t.resetTitle, t.busy);
  if (!flow || !form) return <AccountPage title={t.resetTitle}><Banner kind="error" body={t.unavailable} /></AccountPage>;
  const wait = Math.max(0, Math.ceil((form.retryAt - now) / 1000));
  const resend = Math.max(0, Math.ceil((form.resendAt - now) / 1000));
  const locked = form.busy || form.retryPending;
  const error = form.error ? authErrorText(locale, form.error) : null;
  const submit = () => void flow.submit(locale === 'en' ? 'en-US' : 'zh-CN');
  const goLogin = () => router.replace({ pathname: '/account/sign-in', params: { email: form.email } } as never);
  if (form.mode === 'reset-complete') return <AccountPage nav="none" testID="account-reset-complete"
    footer={<Button label={t.goSignIn} onPress={goLogin} />}>
    <ResultView title={t.resetDoneTitle} />
  </AccountPage>;
  const confirm = form.mode === 'reset-confirm';
  return <AccountPage title={t.resetTitle} lead={confirm ? t.resetCodeLead : t.resetEmailLead} testID="account-reset"
    footer={<>
      <Button label={wait ? t.retryIn.replace('{count}', String(wait)) : confirm ? t.setPassword : t.sendCode}
        loading={form.busy} disabled={wait > 0 || (confirm && (!/^\d{6}$/.test(form.code) || !form.password || form.password !== form.repeatPassword))}
        onPress={submit} testID="account-reset-submit" />
      {confirm ? <Button label={resend ? t.retryIn.replace('{count}', String(resend)) : t.resendCode}
        variant="text" disabled={locked || resend > 0} onPress={() => void flow.resend(locale === 'en' ? 'en-US' : 'zh-CN')} /> : null}
    </>}>
    <StepHeader caption={t.resetTitle} step={confirm ? 2 : 1} total={2} />
    <TextField label={t.email} value={form.email} onChangeText={value => flow.set('email', value)}
      editable={!locked && !confirm} keyboardType="email-address" autoComplete="email" maxLength={254}
      error={form.error === 'email_invalid' ? error : null} testID="account-reset-email" />
    {confirm ? <>
      <OtpField value={form.code} onChangeText={value => flow.set('code', value)} accessibilityLabel={t.code} />
      <PasswordField label={t.setPassword} value={form.password} onChangeText={value => flow.set('password', value)}
        editable={!locked} showLabel={t.showPassword} hideLabel={t.hidePassword} autoComplete="new-password" maxLength={256} />
      <PasswordField label={t.confirmPassword} value={form.repeatPassword} onChangeText={value => flow.set('repeatPassword', value)}
        editable={!locked} showLabel={t.showPassword} hideLabel={t.hidePassword} autoComplete="new-password" maxLength={256} />
      <PasswordRules value={form.password} confirm={form.repeatPassword} lengthLabel={t.lengthRule} matchLabel={t.matchRule} />
      <Button label={t.changeEmail} variant="text" disabled={locked} onPress={() => flow.navigate('reset-request')} />
    </> : null}
    {form.retryPending ? <Banner kind="warn" body={t.uncertainBody} /> : null}
    {error && form.error !== 'email_invalid' ? <Banner kind="error" body={error} /> : null}
  </AccountPage>;
}
