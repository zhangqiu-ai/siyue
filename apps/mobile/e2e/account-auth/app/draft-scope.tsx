import {useState} from 'react';
import {Button,Text,View} from 'react-native';
import {useAccountAuth} from '../../../src/account/auth-provider';
import {useWorkspace} from '../../../src/account/workspace-provider';
import {useLocale} from '../../../src/i18n';
import PlanCreateScreen from '../../../src/screens/plan-create-screen';

export default function DraftScopeQA(){
 const {client}=useAccountAuth(),{host,state:workspace}=useWorkspace(),{locale}=useLocale();
 const [busy,setBusy]=useState(false),[failure,setFailure]=useState('');
 async function select(email:string|null){
  if(!client||!host||busy){setFailure(`qa_dependencies_missing:${!!client}:${!!host}:${busy}`);return;}setBusy(true);setFailure(`qa_selecting:${email??'local'}`);
  try{
   if(client.getState().account)await client.logout();
   if(email){
    await client.login({email,password:'siyue-native-test-password',platform:'android'});
    for(let i=0;i<100;i++){
     const next=host.getState();if(next.status==='ready'&&(next.scope?.kind==='account'||next.canCreate))break;
     await new Promise(resolve=>setTimeout(resolve,100));
    }
    const next=host.getState();if(next.status!=='ready')throw Error('workspace_not_ready');
    if(next.canCreate)await host.createAccountSpace(client.getState().generation);
   }
   setFailure(`qa_selected:${email??'local'}`);
  }catch(error){setFailure(error instanceof Error?error.message:'qa_failed');}
  finally{setBusy(false);}
 }
 const en=locale==='en';
 return <View style={{flex:1}}>
  <View style={{paddingHorizontal:8,paddingVertical:4,paddingTop:80,flexDirection:'row',justifyContent:'space-between'}}>
   <Button title={busy?'…':'QA Scope A'} disabled={busy} onPress={()=>void select('native-zh@example.test')}/>
   <Button title={busy?'…':'QA Scope B'} disabled={busy} onPress={()=>void select('native-en@example.test')}/>
   <Button title={busy?'…':'QA Local'} disabled={busy} onPress={()=>void select(null)}/>
  </View>
  <Text accessibilityLabel={`QA Scope ready ${workspace.scope?.kind??workspace.status}`} style={{paddingHorizontal:12}}>{failure||`QA Scope ready ${workspace.scope?.kind??workspace.status}`}</Text>
  <View style={{flex:1}}><PlanCreateScreen/></View>
  <Text accessibilityLabel={busy?'QA scope switching':'QA scope stable'} style={{height:1}}>{en?'Test controls':'测试控件'}</Text>
 </View>;
}
