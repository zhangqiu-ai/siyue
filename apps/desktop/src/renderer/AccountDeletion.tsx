import { useEffect,useState,useSyncExternalStore } from 'react';
import { createAccountDeletionFlow,type AccountDeletionFlow,type AccountDeletionFlowState } from '@siyue/adapters';
import { useLocale } from './i18n';
import { authText } from './auth-messages';
import { deletionText,deletionErrorText } from './account-deletion-messages';
import type { rendererAuth } from './auth-client';
import './account-deletion.css';

// The desktop deletion surface (design 13.2 pages: before you delete, one family at a time, recipient,
// acceptance, verify and confirm, progress, frozen). It reads the real impact, declares one handling per
// affected family and drives the shared flow, which owns the single-use grant, the request key and the
// local receipt. Nothing here re-implements the flow: the panel only renders frozen state and calls it.
//
// Families use bounded identifiers; only the deleting owner can read eligible adult labels and current
// acceptance states. Desktop has no native Apple re-verification, so Apple-only accounts use mobile.

type DeletionAuth=ReturnType<typeof rendererAuth>;
type FlowState=AccountDeletionFlowState;
type Family=FlowState['families'][number];
type EndKind='leave'|'freeze'|'dissolve';

const totalSteps=4;
const fill=(template:string,params:Record<string,string>) =>
  template.replace(/\{(\w+)\}/g,(_,name:string) => params[name] ?? `{${name}}`);
const familyNumber=(familyId:string) => familyId.slice(0,8);

/** What ending this caller's own access does, exactly as the acceptance transaction branches on it. */
function endKind(family:Family):EndKind {
  if(family.role!=='owner')return 'leave';
  return family.otherActiveAdultCount+family.otherActiveChildCount===0?'dissolve':'freeze';
}
function guardianshipScope(family:Family) {
  return {children:family.guardianships.length,
    sole:family.guardianships.filter(entry => entry.soleGuardian).length,
    devices:family.guardianships.reduce((total,entry) => total+entry.activeChildDeviceCount,0)};
}

export function AccountDeletion({client,authenticated,onBusyChange,onExit}:{
  client:DeletionAuth; authenticated:boolean;
  onBusyChange:(busy:boolean)=>void; onExit:()=>void;
}) {
  const {locale}=useLocale();
  const t=deletionText(locale),base=authText(locale);
  const [flow]=useState<AccountDeletionFlow>(() => createAccountDeletionFlow(client,{auth:client}));
  const state=useSyncExternalStore(flow.subscribe,flow.getState);
  const [probing,setProbing]=useState(true);
  const [password,setPassword]=useState('');
  const [candidates,setCandidates]=useState<Record<string,Awaited<ReturnType<DeletionAuth['deletionRecipients']>>>>({});
  const [candidateError,setCandidateError]=useState<string|null>(null);
  const [candidateLoading,setCandidateLoading]=useState<string|null>(null);
  const [confirmed,setConfirmed]=useState(false);
  // Platform capability, read from the account's own login methods: the desktop renderer can only
  // re-verify with a password, so an account without one cannot be deleted from here.
  const [methods,setMethods]=useState<'idle'|'loading'|'ready'|'failed'>('idle');
  const [verification,setVerification]=useState<{mask:string|null}|null>(null);
  const [reload,setReload]=useState(0);
  const busy=probing||state.busy;
  const step=state.step;

  useEffect(() => {onBusyChange(busy);return() => onBusyChange(false);},[busy,onBusyChange]);
  // A receipt outlives the process that accepted it: this is the cold-start entry. A missing or expired
  // receipt leaves the step alone, and the account is then still signed in, so the impact page is next.
  useEffect(() => {
    let live=true;
    void (async() => {
      try {await flow.resumeProgress();} catch { /* The flow publishes the reason as state.error. */ }
      finally {if(live)setProbing(false);}
    })();
    return() => {live=false;flow.dispose();};
  },[flow]);
  // Keyed on the step and an explicit reload, never on the state this effect writes: a state write in
  // its own dependencies would invalidate the read that produced it and leave the panel waiting.
  useEffect(() => {
    if(step!=='confirm')return;
    let live=true;setMethods('loading');
    void (async() => {
      try {
        const page=await client.loginMethods();
        const mail=page.items.find(item => item.kind==='email_password');
        if(live){setVerification(mail&&mail.kind==='email_password'?{mask:mail.emailMask}:null);setMethods('ready');}
      } catch {if(live)setMethods('failed');}
    })();
    return() => {live=false;};
  },[step,client,reload]);
  // A new attempt must be re-confirmed and re-verified; returning from a failure the flow kept does not
  // repeat that, because that submission is the caller's own earlier declaration.
  useEffect(() => {if(step==='confirm'){setConfirmed(false);setPassword('');}},[step]);

  const run=(work:() => Promise<unknown>) => {void work().catch(() => { /* state.error carries it */ });};
  const chooseEnd=(family:Family) => {
    try {flow.chooseDisposition({familyId:family.familyId,kind:'end-family-access'});}
    catch { /* A stale or unparsable choice is refused; the previous one stays. */ }
  };
  const endCopy=(kind:EndKind) => kind==='leave'
    ? {label:t.choiceLeave,detail:t.choiceLeaveDetail}
    : kind==='freeze'?{label:t.choiceFreeze,detail:t.choiceFreezeDetail}
    : {label:t.choiceDissolve,detail:t.choiceDissolveDetail};
  const summaryOf=(family:Family) => {
    if(family.choice?.kind==='transfer')return t.summaryTransfer;
    const kind=endKind(family);
    return kind==='leave'?t.summaryLeave:kind==='freeze'?t.summaryFreeze:t.summaryDissolve;
  };
  const roleOf=(family:Family) => family.role==='owner'?t.roleOwner:family.role==='admin'?t.roleAdmin:t.roleMember;

  function impactView() {
    return <>
      <h4>{t.impactTitle}</h4>
      <p className="hint">{t.impactServer}</p>
      <p className="hint">{t.impactLocal}</p>
      <p className="hint">{t.impactFamilies}</p>
      <button className="primary" disabled={busy} onClick={() => run(() => flow.loadImpact())}>{t.impactAction}</button>
    </>;
  }

  function familiesView() {
    return <>
      <h4>{t.familiesTitle}</h4>
      <p className="hint">{t.familiesHint}</p>
      {state.families.map(family => {
        const scope=guardianshipScope(family),end=endCopy(endKind(family));
        const label=fill(t.familyLabel,{id:familyNumber(family.familyId)});
        return <section className="deletion-family" key={family.familyId} aria-label={label}>
          <div className="deletion-family-head"><h4>{label}</h4><span className="deletion-role">{roleOf(family)}</span></div>
          {family.role==='owner'&&family.soleActiveOwner&&<p className="hint">{t.soleOwner}</p>}
          <p className="hint">{fill(t.otherAdults,{count:String(family.otherActiveAdultCount)})} · {fill(t.otherChildren,{count:String(family.otherActiveChildCount)})}</p>
          {scope.children>0&&<p className="hint">{fill(t.guardianship,{children:String(scope.children),sole:String(scope.sole),devices:String(scope.devices)})}</p>}
          <div className="deletion-choices">
            {family.role==='owner'&&<div className="deletion-choice-block">
              <button type="button" className="deletion-choice" aria-pressed={family.choice?.kind==='transfer'} disabled={busy||candidateLoading!==null} onClick={()=>{
                setCandidateLoading(family.familyId);setCandidateError(null);
                void client.deletionRecipients(family.familyId).then(rows=>setCandidates(old=>({...old,[family.familyId]:rows})))
                  .catch(()=>setCandidateError(family.familyId)).finally(()=>setCandidateLoading(null));
              }}>{t.choiceTransfer}</button>
              <p className="hint">{t.choiceTransferDetail}</p>
              {candidateError===family.familyId&&<p role="alert">{t.transferUnavailable}</p>}
              {candidates[family.familyId]?.map(person=><button type="button" key={person.subjectId}
                disabled={busy||(person.management!=='accepted'||person.guardianship==='pending')} aria-pressed={family.choice?.kind==='transfer'&&family.choice.recipientSubjectId===person.subjectId}
                onClick={()=>flow.chooseDisposition({familyId:family.familyId,kind:'transfer',recipientSubjectId:person.subjectId})}>
                {person.label} · {person.management==='accepted'?(locale==='en'?'Accepted':'已接受'):(locale==='en'?'Awaiting acceptance':'等待本人接受')}</button>)}
              {candidates[family.familyId]?.length===0&&<p>{locale==='en'?'No eligible adults':'暂无符合条件的成人成员'}</p>}
            </div>}
            <div className="deletion-choice-block">
              <button type="button" className="deletion-choice" aria-pressed={family.choice?.kind==='end-family-access'} disabled={busy}
                onClick={() => chooseEnd(family)}>{end.label}</button>
              <p className="hint">{end.detail}</p>
            </div>
          </div>
        </section>;
      })}
      <p className="hint">{t.familyIdHint}</p>
      <div className="actions">
        <button className="primary" disabled={busy||!state.dispositionReady} onClick={() => {flow.continue();}}>{t.continue}</button>
      </div>
    </>;
  }

  function confirmView() {
    const locked=state.locked||state.retryPending;
    return <>
      <h4>{t.confirmTitle}</h4>
      <p className="hint">{t.confirmHint}</p>
      <h4>{t.summaryTitle}</h4>
      {state.families.length===0&&<p className="hint">{locale==='en'?'No affected families or child devices.':'没有受影响的家庭或儿童设备。'}</p>}
      <ul className="deletion-summary">
        {state.families.map(family => <li key={family.familyId}>
          <span>{fill(t.familyLabel,{id:familyNumber(family.familyId)})}</span><span>{summaryOf(family)}</span></li>)}
      </ul>
      <h4>{t.verifyTitle}</h4>
      {locked?<div className="deletion-lock" role="status">
        <strong>{t.lockedTitle}</strong><p>{t.lockedBody}</p>
        <button className="primary" disabled={busy} onClick={() => run(() => flow.retry())}>{t.retryOriginal}</button>
      </div>
      :methods==='failed'?<>
        <p role="alert" className="error">{base.unavailable}</p>
        <button disabled={busy} onClick={() => setReload(value => value+1)}>{base.retry}</button>
      </>
      :methods!=='ready'?<p role="status" className="hint">{base.busy}</p>
      :!verification?<>
        <p className="hint">{t.appleUnsupported}</p>
        <p role="alert" className="error">{t.appleOnly}</p>
      </>
      :<form noValidate onSubmit={event => {event.preventDefault();if(busy||!confirmed||!password)return;const proof=password;setPassword('');run(() => flow.submitWithPassword(proof));}}>
        <label htmlFor="deletion-password">{verification.mask?fill(t.verifyWith,{mask:verification.mask}):t.verifyPassword}</label>
        <input id="deletion-password" type="password" autoComplete="current-password" maxLength={256}
          value={password} disabled={busy} onChange={event => setPassword(event.target.value)} />
        <p className="hint">{t.appleUnsupported}</p>
        <label className="deletion-check" htmlFor="deletion-confirm-check">
          <input id="deletion-confirm-check" type="checkbox" checked={confirmed} disabled={busy}
            onChange={event => setConfirmed(event.target.checked)} />
          <span>{t.confirmCheck}</span>
        </label>
        <button className="primary" type="submit" disabled={busy||!confirmed||!password}>{busy?base.busy:t.submit}</button>
      </form>}
      {state.families.length>0&&!locked&&
        <button type="button" className="text-button" disabled={busy} onClick={() => {flow.backToFamilies();}}>{t.backToFamilies}</button>}
    </>;
  }

  function progressView() {
    const status=state.status;
    return <>
      <h4>{t.progressTitle}</h4>
      {state.completed&&<p role="status" className="success">{t.progressDone}</p>}
      {!status?<p role="status" className="hint">{busy?base.busy:t.noReceipt}</p>:<dl className="deletion-progress">
        <div><dt>{t.progressServer}</dt><dd>{status.serverDataDeleted?t.progressServerDone:t.progressServerPending}</dd></div>
        <div><dt>{t.progressProvider}</dt><dd>{status.providerRevocationPending?t.progressProviderPending:t.progressProviderNone}</dd></div>
        <div><dt>{t.progressCompleted}</dt><dd>{status.completedAt?new Date(status.completedAt).toLocaleString(locale==='en'?'en-US':'zh-CN'):t.progressRunning}</dd></div>
      </dl>}
      {status?.lastErrorCode&&<p className="hint">{status.lastErrorCode==='apple_credential_missing'
        ?t.appleCredentialMissing:(locale==='en'?'Some records still need review before deletion can finish.':'部分资料仍待核对，处理完成前不会显示全部删除。')}</p>}
      {state.families.length>0&&<h4>{t.progressFamilies}</h4>}
      {state.families.length>0&&<>
        <p className="hint">{t.progressFamiliesDeclared}</p>
        <ul className="deletion-summary">
          {state.families.map(family => <li key={family.familyId}>
            <span>{fill(t.familyLabel,{id:familyNumber(family.familyId)})}</span><span>{summaryOf(family)}</span></li>)}
        </ul>
      </>}
      {!state.completed&&status?.lastErrorCode&&<p className="hint">{t.progressFamiliesNote}</p>}
      <p className="hint">{t.progressLocal}</p>
      <button disabled={busy} onClick={() => run(() => flow.loadProgress())}>{t.progressRefresh}</button>
    </>;
  }

  function owedView() {
    return <>
      <h4>{t.oweTitle}</h4>
      <p className="hint">{t.oweBody}</p>
      <button className="primary" disabled={busy} onClick={() => run(() => flow.retry())}>{t.retryOriginal}</button>
    </>;
  }

  function receiptView() {
    return <>
      <p className="hint">{t.receiptUnreadable}</p>
      <button disabled={busy} onClick={() => run(() => flow.resumeProgress())}>{t.progressRefresh}</button>
    </>;
  }

  const body=probing?<p role="status" className="hint">{base.busy}</p>
    :step==='progress'?progressView()
    :step==='submitting'?<><p role="status" className="hint">{t.submitting}</p><p className="hint">{t.lockedBody}</p></>
    :step==='confirm'?confirmView()
    :step==='families'?familiesView()
    :state.retryPending&&state.locked?owedView()
    :!authenticated?receiptView()
    :impactView();
  return <section className="deletion" aria-label={t.title}>
    <div className="deletion-head">
      <h3>{t.title}</h3>
      <button type="button" className="text-button" disabled={busy} onClick={onExit}>{t.back}</button>
    </div>
    {step!=='progress'&&<p className="hint deletion-step">{fill(t.step,{step:String(step==='submitting'?3:step==='confirm'?3:step==='families'?2:1),total:String(totalSteps)})}</p>}
    {state.error&&<p role="alert" className="error">{deletionErrorText(locale,state.error)}</p>}
    {body}
  </section>;
}
