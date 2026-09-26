import { useEffect, useState, useSyncExternalStore } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { createEmailRegistration, emailRegistrationActions } from '@siyue/adapters';
import { AccountPage } from '../account-nav';
import { accountText } from '../account-messages';
import { authErrorText } from '../auth-messages';
import { useAccountAuth } from '../auth-provider';
import { useAccountBusyGuard } from '../hooks/use-busy-guard';
import { useLocale } from '../../i18n';
import { useTheme } from '../../ui/theme';
import { Button } from '../../ui/button';
import { TextField, PasswordField } from '../../ui/text-field';
import { OtpField } from '../../ui/otp-field';
import { PasswordRules } from '../../ui/password-rules';
import { Checkbox } from '../../ui/choice';
import { StepHeader } from '../../ui/step-header';
import { Banner } from '../../ui/banner';
import { router } from 'expo-router';

export default function SignUpScreen() {
  const { locale } = useLocale(); const t = accountText(locale); const theme = useTheme();
  const { client, state } = useAccountAuth();
  const [flow] = useState(() => client ? createEmailRegistration(emailRegistrationActions(client, Platform.OS === 'ios' ? 'ios' : 'android'), Crypto.randomUUID) : null);
  const form = useSyncExternalStore(flow?.subscribe ?? (() => () => {}), flow?.getState ?? (() => null), flow?.getState ?? (() => null));
  const [passwordStep, setPasswordStep] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (flow) void flow.loadPolicy();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); flow?.dispose(); };
  }, [flow]);
  useEffect(() => { if (form?.error === 'challenge_invalid' || form?.error === 'code_invalid') setPasswordStep(false); }, [form?.error]);
  useEffect(() => { if (form?.error === 'policy_changed' || form?.error === 'registration_closed') { flow?.back(); setPasswordStep(false); void flow?.loadPolicy(); } }, [form?.error, flow]);
  useEffect(() => { if (state.status === 'authenticated') router.replace('/account'); }, [state.status]);
  useAccountBusyGuard(Boolean(form?.busy || form?.retryPending), t.registrationTitle, t.busy);
  if (!form || !flow) return <AccountPage title={t.registrationTitle}><Banner kind="error" body={t.unavailable} /></AccountPage>;
  const released = form.policy?.enabled && form.policy.terms && form.policy.privacy ? form.policy : null;
  const wait = Math.max(0, Math.ceil((form.retryAt - now) / 1000));
  const resend = Math.max(0, Math.ceil((form.resendAt - now) / 1000));
  const locked = form.busy || form.retryPending;
  const step = form.step === 'email' ? 1 : passwordStep ? 3 : 2;
  const error = form.error ? authErrorText(locale, form.error) : null;
  const apiLocale = locale === 'en' ? 'en-US' : 'zh-CN';
  const send = () => void (form.retryPending ? flow.retry() : flow.sendCode(apiLocale));
  const confirm = () => void (form.retryPending ? flow.retry() : flow.confirm());
  const document = (label: string, url: string) => <Pressable key={label} accessibilityRole="link" accessibilityLabel={label}
    disabled={locked} onPress={() => { if (url.startsWith('https://')) void Linking.openURL(url).catch(() => {}); }}>
    <Text style={{ color: theme.color.accent }}>{label}</Text>
  </Pressable>;
  if (form.step === 'complete') return <AccountPage title={t.registrationTitle}><Banner kind="info" body={t.busy} /></AccountPage>;
  return <AccountPage title={t.registrationTitle}
    lead={step === 1 ? t.registrationEmailLead : step === 2 ? t.registrationCodeLead.replace('{email}', form.email) : t.registrationPasswordLead}
    testID="account-sign-up"
    footer={<>
      {step === 1 ? <Button label={wait ? t.retryIn.replace('{count}', String(wait)) : t.sendCode}
        loading={form.busy} disabled={!released || !form.accepted || wait > 0} onPress={send} testID="account-register-send" /> : null}
      {step === 2 ? <Button label={t.next} disabled={form.code.length !== 6} onPress={() => setPasswordStep(true)} testID="account-register-code-next" /> : null}
      {step === 3 ? <Button label={wait ? t.retryIn.replace('{count}', String(wait)) : t.registerSubmit}
        loading={form.busy} disabled={wait > 0 || (!form.retryPending && (form.password.length < 6 || form.password.length > 20 || form.password !== form.repeatPassword))}
        onPress={confirm} testID="account-register-confirm" /> : null}
      {step > 1 ? <Button label={resend ? t.retryIn.replace('{count}', String(resend)) : t.resendCode} variant="text"
        disabled={locked || resend > 0} onPress={() => void flow.resend(apiLocale)} /> : null}
    </>}>
    <StepHeader caption={t.registrationTitle} step={step} total={3} />
    {step === 1 ? <>
      <TextField label={t.email} value={form.email} onChangeText={value => flow.set('email', value)}
        keyboardType="email-address" autoComplete="email" maxLength={254} error={form.error === 'email_invalid' ? error : null} testID="account-register-email" />
      <Checkbox label={t.termsConsent} checked={form.accepted} onChange={value => flow.setConsent(value)} disabled={locked} />
      {released ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16, paddingHorizontal: 4 }}>
        {document(t.terms, released.terms!.url)}<Text>{t.and}</Text>{document(t.privacy, released.privacy!.url)}
      </View> : <Banner kind="warn" body={t.registrationUnavailable} action={<Button label={t.retry} variant="text" onPress={() => void flow.loadPolicy()} />} />}
    </> : null}
    {step === 2 ? <>
      <OtpField value={form.code} onChangeText={value => { flow.set('code', value); if (value.length === 6) setPasswordStep(true); }} accessibilityLabel={t.code} />
      <Button label={t.changeEmail} variant="text" disabled={locked} onPress={() => { if (flow.back()) setPasswordStep(false); }} />
    </> : null}
    {step === 3 ? <>
      <PasswordField label={t.setPassword} value={form.password} onChangeText={value => flow.set('password', value)}
        editable={!locked} showLabel={t.showPassword} hideLabel={t.hidePassword} autoComplete="new-password" maxLength={256} testID="account-register-password" />
      <PasswordField label={t.confirmPassword} value={form.repeatPassword} onChangeText={value => flow.set('repeatPassword', value)}
        editable={!locked} showLabel={t.showPassword} hideLabel={t.hidePassword} autoComplete="new-password" maxLength={256} />
      <PasswordRules value={form.password} confirm={form.repeatPassword} lengthLabel={form.password.length < 6 ?
        t.passwordTooShort.replace('{count}', String(6 - form.password.length)) : t.lengthRule} matchLabel={t.matchRule}
        overLabel={n => t.overLength.replace('{count}', String(n - 20))} />
    </> : null}
    {form.retryPending ? <Banner kind="warn" body={t.uncertainBody} /> : null}
    {form.policyError ? <Banner kind="error" body={authErrorText(locale, form.policyError)} /> : null}
    {error && form.error !== 'email_invalid' ? <Banner kind="error" body={form.error === 'challenge_invalid' ? t.codeRejected : error} /> : null}
  </AccountPage>;
}
