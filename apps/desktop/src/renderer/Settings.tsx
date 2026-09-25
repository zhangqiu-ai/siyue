import { useEffect,useRef,useState } from 'react';
import { useLocale } from './i18n';
import { Account } from './Account';
import { authText } from './auth-messages';

// Account navigation survives the workspace subtree remount caused by a login or logout.
let settingsOpen=false,accountPanelOpen=false;
export function Settings() {
  const { locale, setLocale, failed, t } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [account,setAccount]=useState(accountPanelOpen),[busy,setBusy]=useState(false);
  useEffect(()=>{if(settingsOpen)dialog.current?.showModal();},[]);
  return <>
    <button ref={trigger} className="icon-button settings-trigger" aria-label={t('settings')} title={t('settings')} onClick={() => {settingsOpen=true;dialog.current?.showModal();}}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-1 1-3 3-1 1-3-2-2 1-3-3-2-3 1-2-2Z"/><circle cx="12" cy="11" r="3"/></svg>
    </button>
    <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={event=>{if(busy)event.preventDefault();else{settingsOpen=false;accountPanelOpen=false;}}} onClose={() => {trigger.current?.focus();}}>
      <div className="section-heading"><h2 id="settings-title">{account?authText(locale).account:t('settings')}</h2><button disabled={busy} className="icon-button" aria-label={t('close')} onClick={() => {settingsOpen=false;accountPanelOpen=false;setAccount(false);dialog.current?.close();}}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
      {account?<Account onBusyChange={setBusy}/>:<>
      <button className="account-entry" onClick={()=>{accountPanelOpen=true;setAccount(true);}}>{authText(locale).account}</button>
      <fieldset><legend>{t('language')}</legend><div className="language-options">{(['zh-CN', 'en'] as const).map((option) => <button key={option} aria-pressed={locale === option} className={locale === option ? 'primary' : ''} onClick={() => setLocale(option)} lang={option}>{t(option === 'zh-CN' ? 'chinese' : 'english')}</button>)}</div></fieldset>
      {failed && <p role="alert" className="error">{t('localeFailure')}</p>}
      </>}
    </dialog>
  </>;
}
