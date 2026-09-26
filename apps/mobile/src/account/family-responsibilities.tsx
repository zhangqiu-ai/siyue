import {useState} from 'react';
import {View,Text,Pressable} from 'react-native';
import type {AuthController} from '@siyue/adapters';
import type {FamilyManagementAcceptancePreview,FrozenFamilyReviewScope} from '@siyue/contracts';
import {useLocale} from '../i18n';
import {useTheme} from '../ui/theme';

type Scope=FamilyManagementAcceptancePreview|FrozenFamilyReviewScope;
export default function FamilyResponsibilities({client}:{client:AuthController}){
  const {locale}=useLocale(),en=locale==='en',theme=useTheme();
  const [families,setFamilies]=useState<{familyId:string;status:'active'|'frozen'}[]|null>(null);
  const [scope,setScope]=useState<Scope|null>(null),[frozen,setFrozen]=useState(false);
  const [management,setManagement]=useState(false),[guardianship,setGuardianship]=useState(false);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const text={color:theme.color.ink,fontSize:16};
  const button=(label:string,press:()=>void,disabled=busy)=><Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{disabled}} disabled={disabled} onPress={press} style={{minHeight:48,justifyContent:'center',padding:12,borderRadius:12,backgroundColor:theme.color.subtle,opacity:disabled?0.5:1}}><Text style={text}>{label}</Text></Pressable>;
  const checkbox=(label:string,value:boolean,set:(value:boolean)=>void)=><Pressable accessibilityRole="checkbox" accessibilityLabel={label}
    accessibilityState={{checked:value,disabled:busy}} disabled={busy} onPress={()=>set(!value)} style={{minHeight:48,padding:12,flexDirection:'row',alignItems:'center',gap:8}}>
    <Text style={text}>{value?'☑':'☐'}</Text><Text style={[text,{flex:1}]}>{label}</Text></Pressable>;
  async function run(work:()=>Promise<void>){setBusy(true);setMessage('');try{await work();}catch{setScope(null);setMessage(en?'Could not complete. Refresh and try again.':'操作未完成，请刷新后重试。');}finally{setBusy(false);}}
  return <View style={{gap:12,padding:16,borderRadius:16,backgroundColor:theme.color.surface}}>
    <Text accessibilityRole="header" style={[text,{fontWeight:'600'}]}>{en?'Family responsibilities':'家庭责任'}</Text>
    {button(en?'View family responsibilities':'查看家庭责任',()=>void run(async()=>{setScope(null);setFamilies(await client.familyResponsibilities());}))}
    {families?.length===0&&<Text style={text}>{en?'No family responsibilities to accept':'暂无待接受的家庭责任'}</Text>}
    {families?.map(f=><View key={f.familyId}><Text style={text}>{en?'Family':'家庭'} {f.familyId.slice(0,8)} · {f.status==='frozen'?(en?'Frozen · operations review required':'已冻结 · 等待运营复核'):(en?'Active':'使用中')}</Text>
      {button(en?'Review responsibility':'查看责任范围',()=>void run(async()=>{setScope(null);setManagement(false);setGuardianship(false);setFrozen(f.status==='frozen');
        setScope(f.status==='frozen'?await client.frozenFamilyPreview(f.familyId):await client.familyManagementPreview(f.familyId));}))}</View>)}
    {scope&&<View style={{gap:8}}>
      <Text style={text}>{en?`Accept management of family ${scope.familyId.slice(0,8)} and applicable guardianship for ${scope.childCount} children.`:`接受家庭 ${scope.familyId.slice(0,8)} 的管理及 ${scope.childCount} 名儿童的适用监护责任。`}</Text>
      <Text style={text}>{frozen?(en?'Acceptance does not unfreeze this family. Operations must complete the review.':'接受后仍保持冻结，由运营完成复核。'):(en?'Acceptance does not transfer ownership. The current manager must confirm the handover.':'接受不会立即转交家庭，仍需当前管理者确认转交。')}</Text>
      {checkbox(en?'I accept family management':'我接受家庭管理责任',management,setManagement)}
      {checkbox(en?'I accept applicable guardianship responsibilities':'我接受适用的监护责任',guardianship,setGuardianship)}
      {button(en?'Confirm responsibility':'确认接受责任',()=>void run(async()=>{
        const input={expectedFamilyVersion:scope.familyVersion,expectedMembershipVersion:scope.membershipVersion,
          expectedOwnerMembershipVersion:scope.ownerMembershipVersion,expectedChildScopeDigest:scope.childScopeDigest,
          acceptance:{familyManagement:true as const,guardianship:true as const}};
        if(frozen)await client.acceptFrozenFamily(scope.familyId,input);else await client.acceptFamilyManagement(scope.familyId,input);
        setScope(null);setMessage(en?'Your acceptance has been recorded.':'已记录你的接受确认。');
      }),busy||!management||!guardianship)}
      {button(en?'Cancel':'取消',()=>setScope(null))}
    </View>}
    {message&&<Text accessibilityLiveRegion="polite" style={text}>{message}</Text>}
  </View>;
}
