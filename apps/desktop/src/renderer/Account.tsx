import {FamilyResponsibilities} from './FamilyResponsibilities';
import {workspaceState,subscribeWorkspace,workspaceCommand} from './workspace';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createEmailEntry,type EmailEntryState} from '@siyue/adapters';
import {rendererAuth} from './auth-client';
import {authText,authErrorText} from './auth-messages';
import {AccountDeletion} from './AccountDeletion';
import {Registration} from './Registration';
import {deletionText} from './account-deletion-messages';
import {useLocale} from './i18n';
import type {AccountDeviceSession} from '@siyue/contracts';

export function Account({onBusyChange}:{onBusyChange:(busy:boolean)=>void}) {
  const workspace=useSyncExternalStore(subscribeWorkspace,workspaceState);
  const {locale}=useLocale(),t=authText(locale);
  const [client]=useState(rendererAuth),[auth,setAuth]=useState(client.getState);
  const [flow,setFlow]=useState<ReturnType<typeof createEmailEntry>|null>(null),[form,setForm]=useState<EmailEntryState|null>(null);
  const [enabled,setEnabled]=useState<boolean|null>(null),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<'logoutDone'|'logoutPending'|'passwordChanged'|'deviceRevoked'|'devicesRevoked'|null>(null);
  const [currentPassword,setCurrentPassword]=useState(''),[nextPassword,setNextPassword]=useState(''),[repeatNext,setRepeatNext]=useState(''),[changeKey,setChangeKey]=useState(''),[changeRetry,setChangeRetry]=useState(false);
  const [devices,setDevices]=useState<AccountDeviceSession[]>([]),[devicesOpen,setDevicesOpen]=useState(false),[devicePassword,setDevicePassword]=useState(''),[nextDeviceCursor,setNextDeviceCursor]=useState<string|null>(null);
  const [working,setWorking]=useState(false),[now,setNow]=useState(Date.now),mounted=useRef(false),code=useRef<HTMLInputElement>(null);
  const previousSubject=useRef<string|null>(null);
  const [deletionOpen,setDeletionOpen]=useState(false);
  const [registerOpen,setRegisterOpen]=useState(false);
  const [receipt,setReceipt]=useState<'checking'|'none'|'present'|'unreadable'>('checking');
  const apiLocale=locale==='en'?'en-US':'zh-CN';
  async function load(){setEnabled(null);setError(null);try{await client.initialize();const providers=await client.providers();if(mounted.current)setEnabled(providers.emailPassword.enabled);}catch{if(mounted.current){setError('unavailable');setEnabled(false);}}}
  useEffect(()=>{
    mounted.current=true;const entry=createEmailEntry(client,()=>crypto.randomUUID());setFlow(entry);setForm(entry.getState());
    const unsubscribe=entry.subscribe(()=>setForm(entry.getState())),stop=client.subscribe(()=>{const next=client.getState();setAuth(next);setChangeRetry(next.passwordChangePending===true);});
    setChangeRetry(client.hasPendingPasswordChange());
    void load();const timer=setInterval(()=>setNow(Date.now()),1000);
    return()=>{mounted.current=false;unsubscribe();stop();entry.dispose();clearInterval(timer);};
  },[client]);
  const busy=working||!!form?.busy||['bootstrapping','authenticating','refreshing','logging-out'].includes(auth.status);
  useEffect(()=>{if(deletionOpen||registerOpen)return;onBusyChange(busy);return()=>onBusyChange(false);},[busy,onBusyChange,deletionOpen,registerOpen]);
  useEffect(()=>{
    const subject=auth.account?.subjectId??null;
    if(!busy&&flow&&subject!==previousSubject.current){previousSubject.current=subject;flow.navigate('login');flow.set('email','');setDevices([]);setDevicesOpen(false);setNextDeviceCursor(null);setDevicePassword('');setRegisterOpen(false);}
  },[auth.account?.subjectId,busy,flow]);
  useEffect(()=>{if(form?.mode==='reset-confirm')code.current?.focus();},[form?.mode]);
  async function action(kind:'bootstrap'|'logout'){
    setWorking(true);setError(null);setNotice(null);
    try{if(kind==='logout'){const result=await client.logout();if(mounted.current)setNotice(result.server==='pending'?'logoutPending':'logoutDone');}else await client.bootstrap();}
    catch(failure){if(mounted.current)setError(failure instanceof Error&&'code' in failure?String(failure.code):'unavailable');}
    finally{if(mounted.current)setWorking(false);}
  }
  async function changePassword(){
    setWorking(true);setError(null);setNotice(null);
    try {
      if(changeRetry)await client.retryPasswordChange();else {
        if([...nextPassword].length<6||[...nextPassword].length>20)throw Object.assign(new Error(),{code:'password_policy'});
        if(nextPassword!==repeatNext)throw Object.assign(new Error(),{code:'password_mismatch'});
        const key=changeKey||crypto.randomUUID();if(!changeKey)setChangeKey(key);
        await client.changePassword(currentPassword,nextPassword,key);
      }
      setCurrentPassword('');setNextPassword('');setRepeatNext('');setChangeKey('');setChangeRetry(false);setNotice('passwordChanged');
    }catch(failure){const code=failure instanceof Error&&'code' in failure?String(failure.code):'unavailable';setError(code);setChangeRetry(['network','timeout','unavailable'].includes(code));}
    finally{if(mounted.current)setWorking(false);}
  }
  async function loadDevices(cursor?:string){
    setWorking(true);setError(null);try{const page=await client.deviceSessions(cursor);if(mounted.current){setDevices(old=>cursor?[...old,...page.items.filter(item=>!old.some(existing=>existing.sessionId===item.sessionId))]:page.items);setNextDeviceCursor(page.nextCursor);setDevicesOpen(true);}}
    catch(failure){if(mounted.current)setError(failure instanceof Error&&'code' in failure?String(failure.code):'unavailable');}
    finally{if(mounted.current)setWorking(false);}
  }
  async function revokeDevice(device:AccountDeviceSession){
    if(!device.current&&!devicePassword){setError('invalid_request');return;}
    if(!window.confirm(t.confirmRevokeDevice))return;
    setWorking(true);setError(null);setNotice(null);
    try{await client.revokeDeviceSession(device.sessionId,device.current?undefined:devicePassword);setDevicePassword('');setDevices(value=>value.filter(item=>item.sessionId!==device.sessionId));setNotice('deviceRevoked');}
    catch(failure){const code=failure instanceof Error&&'code' in failure?String(failure.code):'unavailable';setError(['network','timeout','unavailable'].includes(code)?'deviceOperationUnknown':code);}
    finally{if(mounted.current)setWorking(false);}
  }
  async function revokeAllDevices(){
    if(!devicePassword){setError('invalid_request');return;}if(!window.confirm(t.confirmRevokeAll))return;
    setWorking(true);setError(null);setNotice(null);
    try{await client.revokeAllDeviceSessions(devicePassword);setDevicePassword('');setDevices([]);setNotice('devicesRevoked');}
    catch(failure){const code=failure instanceof Error&&'code' in failure?String(failure.code):'unavailable';setError(['network','timeout','unavailable'].includes(code)?'deviceOperationUnknown':code);}
    finally{if(mounted.current)setWorking(false);}
  }
  const hasAccount=auth.account!==null&&(auth.status!=='reauth-required'||changeRetry)||changeRetry,secure=auth.status==='secure-storage-unavailable'&&!changeRetry;
  const wait=Math.max(0,Math.ceil(((form?.retryAt??0)-now)/1000)),resendWait=Math.max(0,Math.ceil(((form?.resendAt??0)-now)/1000));
  const locked=busy||!!form?.retryPending;
  // An accepted deletion clears the local session, so the receipt that proves it is read next to the
  // sign-in form. While no receipt is stored this read stays local and contacts no server; a superseded
  // read is retried on the next generation instead of being shown as an unreadable receipt.
  useEffect(()=>{
    if(hasAccount||auth.status!=='anonymous')return;
    let live=true;
    void (async()=>{
      try {const progress=await client.deletionStatus();if(live)setReceipt(progress?'present':'none');}
      catch(failure) {
        if(!live)return;
        setReceipt(failure instanceof Error&&'code' in failure&&failure.code==='cancelled'?'checking':'unreadable');
      }
    })();
    return()=>{live=false;};
  },[client,hasAccount,auth.status,auth.generation]);
  if(deletionOpen)return <AccountDeletion client={client} authenticated={auth.status==='authenticated'}
    onBusyChange={onBusyChange} onExit={()=>setDeletionOpen(false)}/>;
  return <section className="account-form" aria-label={t.account}>
    <p className="hint">{t.local}</p>
    <p className="hint">{workspace.scope?.kind==='account'?(locale==='en'?'Current space: account space (on this device)':'当前空间：账号空间（仅本机）'):(locale==='en'?'Current space: original local space':'当前空间：原本机空间')}</p>
    {notice&&<p role="status">{t[notice]}</p>}
    {error&&<p role="alert" className="error">{authErrorText(locale,error)}</p>}
    {!hasAccount&&(receipt==='present'||receipt==='unreadable')&&<button disabled={busy} onClick={()=>setDeletionOpen(true)}>{deletionText(locale).entryProgress}</button>}
    {secure?<><p role="alert" className="error">{t.secureError}</p>{changeRetry&&<button disabled={busy} onClick={()=>void changePassword()}>{t.retryOperation}</button>}<button disabled={busy} onClick={()=>void action('bootstrap')}>{t.retry}</button></>:
    hasAccount?<><p role="status">{t[auth.status==='authenticated'?'authenticated':'offline']}</p>
      {auth.status==='authenticated'&&auth.session?.subjectKind==='adult'&&<FamilyResponsibilities key={auth.generation} client={client}/>}
      {auth.status!=='authenticated'&&<button disabled={busy} onClick={()=>void action('bootstrap')}>{t.retry}</button>}
      {workspace.canCreate&&<><p className="hint">{locale==='en'?'Create a separate account space on this device. Existing local content stays in the local space and is not uploaded.':'在本机创建独立的账号空间。现有本机内容保留在原空间，不会上传。'}</p><button disabled={busy} onClick={()=>{setWorking(true);void workspaceCommand('create',auth.generation).catch(()=>setError('unavailable')).finally(()=>setWorking(false));}}>{locale==='en'?'Create an account space on this device':'在本机创建账号空间'}</button></>}
      {(auth.status==='authenticated'||changeRetry)&&<form noValidate onSubmit={event=>{event.preventDefault();void changePassword();}}>
        <h3>{t.changePassword}</h3>
        <label htmlFor="account-current-password">{t.currentPassword}</label><input id="account-current-password" type="password" autoComplete="current-password" maxLength={256} value={currentPassword} disabled={busy||changeRetry} onChange={e=>setCurrentPassword(e.target.value)} />
        <label htmlFor="account-new-password">{t.newPassword}</label><input id="account-new-password" type="password" autoComplete="new-password" maxLength={256} value={nextPassword} disabled={busy||changeRetry} onChange={e=>setNextPassword(e.target.value)} />
        <label htmlFor="account-confirm-password">{t.confirmPassword}</label><input id="account-confirm-password" type="password" autoComplete="new-password" maxLength={256} value={repeatNext} disabled={busy||changeRetry} onChange={e=>setRepeatNext(e.target.value)} />
        {changeRetry&&<p role="status" className="hint">{t.uncertain}</p>}
        <button className="primary" type="submit" disabled={busy||(!changeRetry&&(!currentPassword||!nextPassword||!repeatNext))}>{busy?t.busy:changeRetry?t.retryOperation:t.changePassword}</button>
      </form>}
      {auth.status==='authenticated'&&<section className="device-sessions" aria-label={t.devices}>
        <h3>{t.devices}</h3><p className="hint">{t.devicesReauthHint}</p>
        {!devicesOpen?<button disabled={busy} onClick={()=>void loadDevices()}>{t.manageDevices}</button>:<>
          <button disabled={busy} onClick={()=>void loadDevices()}>{t.refreshDevices}</button>
          <label htmlFor="device-reauth-password">{t.deviceReauthPassword}</label><input id="device-reauth-password" type="password" autoComplete="current-password" maxLength={256} value={devicePassword} disabled={busy} onChange={event=>setDevicePassword(event.target.value)} />
          <ul aria-label={t.devices} className="device-list">{devices.map(device=><li key={device.sessionId} className="device-row">
            <div><strong>{device.deviceLabel||t.deviceUnlabelled}</strong><span>{device.current?t.deviceCurrent:t.deviceOther} · {device.platform??t.devicePlatform}</span><span>{t.deviceLastActive}: {new Date(device.lastSeenAt).toLocaleString(locale==='en'?'en-US':'zh-CN')}</span></div>
            <button disabled={busy||(!device.current&&!devicePassword)} onClick={()=>void revokeDevice(device)}>{device.current?t.revokeCurrentDevice:t.revokeDevice}</button>
          </li>)}</ul>
          {nextDeviceCursor&&<button disabled={busy} onClick={()=>void loadDevices(nextDeviceCursor)}>{t.loadMoreDevices}</button>}
          <button className="primary" disabled={busy||!devices.length||!devicePassword} onClick={()=>void revokeAllDevices()}>{t.revokeAllDevices}</button>
        </>}
      </section>}
      {auth.status==='authenticated'&&<button disabled={busy} onClick={()=>setDeletionOpen(true)}>{deletionText(locale).entryDelete}</button>}
      <button disabled={busy} onClick={()=>void action('logout')}>{busy?t.busy:t.logout}</button></>:
    auth.status==='bootstrapping'?<p role="status">{t.restoring}</p>:
    !enabled?<>{(enabled===null||!error)&&<p role="status">{enabled===null?t.busy:t.unavailable}</p>}{enabled===false&&<button onClick={()=>void load()}>{t.retry}</button>}</>:
    registerOpen&&!hasAccount?<Registration client={client} locale={locale} onBusyChange={onBusyChange} onExit={()=>setRegisterOpen(false)}/>:
    form&&flow?<>
      {auth.status==='reauth-required'&&<p role="status">{t.reauth}</p>}
      {form.mode==='reset-complete'?<><p role="status">{t.resetDone}</p><button className="primary" onClick={()=>flow.navigate('login')}>{t.backLogin}</button></>:
      <form noValidate onSubmit={event=>{event.preventDefault();setNotice(null);void flow.submit(apiLocale);}}>
        <h3>{form.mode==='login'?t.login:t.reset}</h3>
        {form.mode==='reset-confirm'&&<p className="hint">{t.resetSent}</p>}
        <label htmlFor="account-email">{t.email}</label><input id="account-email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} value={form.email} disabled={locked||form.mode==='reset-confirm'} onChange={e=>flow.set('email',e.target.value)} />
        {form.mode==='reset-confirm'&&<><label htmlFor="account-code">{t.code}</label><input ref={code} id="account-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={form.code} disabled={locked} onChange={e=>flow.set('code',e.target.value)} /></>}
        {form.mode!=='reset-request'&&<><label htmlFor="account-password">{form.mode==='login'?t.password:t.newPassword}</label><input id="account-password" type="password" autoComplete={form.mode==='login'?'current-password':'new-password'} maxLength={256} value={form.password} disabled={locked} onChange={e=>flow.set('password',e.target.value)} aria-describedby="account-password-hint"/><p id="account-password-hint" className="hint">{t.passwordHint}</p></>}
        {form.mode==='reset-confirm'&&<><label htmlFor="account-repeat">{t.repeatPassword}</label><input id="account-repeat" type="password" autoComplete="new-password" maxLength={256} value={form.repeatPassword} disabled={locked} onChange={e=>flow.set('repeatPassword',e.target.value)}/></>}
        {form.error&&<p role="alert" className="error">{authErrorText(locale,form.error)}</p>}
        {form.retryPending&&<p role="status" className="hint">{t.uncertain}</p>}
        <button className="primary" type="submit" disabled={busy||wait>0}>{busy?t.busy:wait>0?`${t.wait} (${wait})`:form.retryPending?t.retryOperation:form.mode==='login'?t.login:form.mode==='reset-request'?t.sendCode:t.savePassword}</button>
        <div className="actions">
          <button type="button" disabled={busy} onClick={()=>flow.navigate(form.mode==='login'?'reset-request':'login')}>{form.mode==='login'?t.forgot:t.backLogin}</button>
          {form.mode==='login'&&<button type="button" disabled={busy} onClick={()=>setRegisterOpen(true)}>{t.register}</button>}
          {form.mode==='reset-confirm'&&<button type="button" disabled={locked||wait>0||resendWait>0} onClick={()=>void flow.resend(apiLocale)}>{t.resend}{resendWait>0?` (${resendWait})`:''}</button>}
        </div>
      </form>}
    </>:null}
  </section>;
}
