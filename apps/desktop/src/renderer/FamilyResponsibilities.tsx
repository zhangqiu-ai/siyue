import {useState} from 'react';
import type {FamilyManagementAcceptancePreview,FrozenFamilyReviewScope} from '@siyue/contracts';
import type {rendererAuth} from './auth-client';
import {useLocale} from './i18n';

type Scope=FamilyManagementAcceptancePreview|FrozenFamilyReviewScope;
export function FamilyResponsibilities({client}:{client:ReturnType<typeof rendererAuth>}){
  const {locale}=useLocale(),en=locale==='en';
  const [families,setFamilies]=useState<{familyId:string;status:'active'|'frozen'}[]|null>(null);
  const [scope,setScope]=useState<Scope|null>(null),[frozen,setFrozen]=useState(false);
  const [management,setManagement]=useState(false),[guardianship,setGuardianship]=useState(false);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  async function run(work:()=>Promise<void>){setBusy(true);setMessage('');try{await work();}catch{setScope(null);setMessage(en?'Could not complete. Refresh and try again.':'操作未完成，请刷新后重试。');}finally{setBusy(false);}}
  return <section className="account-form" aria-label={en?'Family responsibilities':'家庭责任'}>
    <h4>{en?'Family responsibilities':'家庭责任'}</h4>
    <button disabled={busy} onClick={()=>void run(async()=>{setScope(null);setFamilies(await client.familyResponsibilities());})}>{en?'View family responsibilities':'查看家庭责任'}</button>
    {families?.length===0&&<p>{en?'No family responsibilities to accept':'暂无待接受的家庭责任'}</p>}
    {families?.map(f=><div key={f.familyId}><span>{en?'Family':'家庭'} {f.familyId.slice(0,8)} · {f.status==='frozen'?(en?'Frozen · operations review required':'已冻结 · 等待运营复核'):(en?'Active':'使用中')}</span>
      <button disabled={busy} onClick={()=>void run(async()=>{setScope(null);setManagement(false);setGuardianship(false);setFrozen(f.status==='frozen');
        setScope(f.status==='frozen'?await client.frozenFamilyPreview(f.familyId):await client.familyManagementPreview(f.familyId));})}>{en?'Review responsibility':'查看责任范围'}</button></div>)}
    {scope&&<div>
      <p>{en?`Accept management of family ${scope.familyId.slice(0,8)} and applicable guardianship for ${scope.childCount} children.`:`接受家庭 ${scope.familyId.slice(0,8)} 的管理及 ${scope.childCount} 名儿童的适用监护责任。`}</p>
      <p>{frozen?(en?'Acceptance does not unfreeze this family. Operations must complete the review.':'接受后仍保持冻结，由运营完成复核。'):(en?'Acceptance does not transfer ownership. The current manager must confirm the handover.':'接受不会立即转交家庭，仍需当前管理者确认转交。')}</p>
      <label><input type="checkbox" checked={management} disabled={busy} onChange={e=>setManagement(e.target.checked)}/>{en?'I accept family management':'我接受家庭管理责任'}</label>
      <label><input type="checkbox" checked={guardianship} disabled={busy} onChange={e=>setGuardianship(e.target.checked)}/>{en?'I accept applicable guardianship responsibilities':'我接受适用的监护责任'}</label>
      <button disabled={busy||!management||!guardianship} onClick={()=>void run(async()=>{
        const input={expectedFamilyVersion:scope.familyVersion,expectedMembershipVersion:scope.membershipVersion,
          expectedOwnerMembershipVersion:scope.ownerMembershipVersion,expectedChildScopeDigest:scope.childScopeDigest,
          acceptance:{familyManagement:true as const,guardianship:true as const}};
        if(frozen)await client.acceptFrozenFamily(scope.familyId,input);else await client.acceptFamilyManagement(scope.familyId,input);
        setScope(null);setMessage(en?'Your acceptance has been recorded.':'已记录你的接受确认。');
      })}>{en?'Confirm responsibility':'确认接受责任'}</button>
      <button disabled={busy} onClick={()=>setScope(null)}>{en?'Cancel':'取消'}</button>
    </div>}
    {message&&<p role="status">{message}</p>}
  </section>;
}
