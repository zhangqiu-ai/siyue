import {useEffect,useRef,useState} from 'react';
import {createEmailRegistration,emailRegistrationActions,type EmailRegistrationState} from '@siyue/adapters';
import {rendererAuth} from './auth-client';
import {authText,authErrorText} from './auth-messages';
import type {Locale} from './i18n';

/** The email registration entry.
 *
 * It owns one in-memory registration flow: read the released terms/privacy versions, request a code,
 * then confirm with the versions the server itself published. Only non-secret state is rendered — the
 * code, the password and the challenge proof stay in the flow, which is disposed when the panel
 * closes, so returning to sign in leaves no half-filled credential behind.
 */
export function Registration({client,locale,onBusyChange,onExit}:{
  client:ReturnType<typeof rendererAuth>;locale:Locale;onBusyChange:(busy:boolean)=>void;onExit:()=>void;
}) {
  const t=authText(locale),apiLocale=locale==='en'?'en-US':'zh-CN';
  const [flow]=useState(()=>createEmailRegistration(emailRegistrationActions(client,'desktop'),()=>crypto.randomUUID()));
  const [form,setForm]=useState<EmailRegistrationState>(()=>flow.getState()),[now,setNow]=useState(Date.now);
  // A refusal the released documents decided is reported on the address step, where consent is given.
  const [notice,setNotice]=useState<string|null>(null);
  const report=useRef(onBusyChange);report.current=onBusyChange;
  const code=useRef<HTMLInputElement>(null);
  useEffect(()=>{
    const unsubscribe=flow.subscribe(()=>setForm(flow.getState())),timer=setInterval(()=>setNow(Date.now()),1000);
    return()=>{unsubscribe();clearInterval(timer);flow.dispose();};
  },[flow]);
  // The released documents are read whenever they are unknown: on entry, and again after a refusal that
  // dropped them because they changed under the attempt.
  useEffect(()=>{if(!form.policy&&!form.loadingPolicy&&!form.policyError)void flow.loadPolicy();},[flow,form.policy,form.loadingPolicy,form.policyError]);
  // A pair that changed under an in-flight confirmation, or a deployment that closed sign-up, cannot be
  // retried with the same versions: the panel returns to the address step so the current documents are
  // read and agreed to before anything is requested again.
  useEffect(()=>{
    const code=form.error;
    if(form.step!=='verify'||form.busy||form.retryPending||(code!=='policy_changed'&&code!=='registration_closed'))return;
    if(flow.back())setNotice(code);
  },[flow,form.step,form.busy,form.retryPending,form.error]);
  useEffect(()=>{report.current(form.busy);},[form.busy]);
  useEffect(()=>()=>report.current(false),[]);
  useEffect(()=>{if(form.step==='verify')code.current?.focus();},[form.step]);
  // A pending retry repeats the operation its own key already covers; it never starts a second one.
  function submit(){if(form.step==='email')setNotice(null);return form.retryPending?flow.retry():form.step==='verify'?flow.confirm():flow.sendCode(apiLocale);}
  // A field, a link and a way back stay frozen while the same operation is still outstanding; only an
  // in-flight request locks the primary action, because repeating that one operation is exactly what
  // the pending key is for.
  const locked=form.busy||form.retryPending;
  const wait=Math.max(0,Math.ceil((form.retryAt-now)/1000)),resendWait=Math.max(0,Math.ceil((form.resendAt-now)/1000));
  // A half published policy carries no versions to agree to, so it reads exactly like a closed one.
  const released=form.policy?.enabled&&form.policy.terms&&form.policy.privacy?form.policy:null;
  // The session replaces this panel as soon as the account exists; the status keeps the last frame
  // from falling back to an empty request form while that happens.
  if(form.step==='complete')return <p role="status">{t.restoring}</p>;
  if(form.step==='verify')return <form noValidate onSubmit={event=>{event.preventDefault();void submit();}}>
    <h3>{t.register}</h3>
    <p className="hint">{t.codeSent.replace('{email}',form.email)}</p>
    <label htmlFor="register-code">{t.code}</label>
    <input ref={code} id="register-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={form.code} disabled={locked} onChange={event=>flow.set('code',event.target.value)} />
    <label htmlFor="register-password">{t.password}</label>
    <input id="register-password" type="password" autoComplete="new-password" maxLength={256} value={form.password} disabled={locked} onChange={event=>flow.set('password',event.target.value)} aria-describedby="register-password-hint" />
    <p id="register-password-hint" className="hint">{t.passwordHint}</p>
    <label htmlFor="register-repeat">{t.repeatPassword}</label>
    <input id="register-repeat" type="password" autoComplete="new-password" maxLength={256} value={form.repeatPassword} disabled={locked} onChange={event=>flow.set('repeatPassword',event.target.value)} />
    {form.error&&<p role="alert" className="error">{authErrorText(locale,form.error)}</p>}
    {form.retryPending&&<p role="status" className="hint">{t.uncertain}</p>}
    <button className="primary" type="submit" disabled={form.busy||wait>0}>{form.busy?t.busy:wait>0?`${t.wait} (${wait})`:form.retryPending?t.retryOperation:t.createAccount}</button>
    <div className="actions">
      <button type="button" disabled={locked} onClick={()=>flow.back()}>{t.changeEmail}</button>
      <button type="button" disabled={locked||wait>0||resendWait>0} onClick={()=>void flow.resend(apiLocale)}>{t.resend}{resendWait>0?` (${resendWait})`:''}</button>
      <button type="button" disabled={locked} onClick={onExit}>{t.backLogin}</button>
    </div>
  </form>;
  const primary=form.busy?t.busy:form.retryPending?t.retryOperation:t.sendCode;
  return <form noValidate onSubmit={event=>{event.preventDefault();void submit();}}>
    <h3>{t.register}</h3>
    {form.policy&&!released&&<p role="status" className="hint">{t.registerUnavailable}</p>}
    <label htmlFor="register-email">{t.email}</label>
    <input id="register-email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} value={form.email} disabled={locked} onChange={event=>flow.set('email',event.target.value)} />
    <div className="consent">
      <input id="register-consent" type="checkbox" checked={form.accepted} disabled={locked} aria-describedby="register-consent-hint" onChange={event=>flow.setConsent(event.target.checked)} />
      <label htmlFor="register-consent">{t.consentPrefix}
        {released?.terms&&<> <a href={released.terms.url} target="_blank" rel="noreferrer noopener">{t.terms}</a></>}
        {released&&<> {t.consentJoin} </>}
        {released?.privacy&&<a href={released.privacy.url} target="_blank" rel="noreferrer noopener">{t.privacy}</a>}
      </label>
    </div>
    <p id="register-consent-hint" className="hint">{t.consentHint}</p>
    {notice&&<p role="alert" className="error">{authErrorText(locale,notice)}</p>}
    {form.policyError&&<p role="alert" className="error">{authErrorText(locale,form.policyError)}</p>}
    {form.error&&<p role="alert" className="error">{authErrorText(locale,form.error)}</p>}
    {form.retryPending&&<p role="status" className="hint">{t.uncertain}</p>}
    {form.loadingPolicy&&!form.policy&&!form.policyError&&<p role="status" className="hint">{t.busy}</p>}
    <button className="primary" type="submit" disabled={form.busy||wait>0||!released||!form.accepted}>{wait>0?`${t.wait} (${wait})`:primary}</button>
    <div className="actions">
      {form.policyError&&<button type="button" disabled={locked} onClick={()=>void flow.loadPolicy()}>{t.retry}</button>}
      <button type="button" disabled={locked} onClick={onExit}>{t.backLogin}</button>
    </div>
  </form>;
}
