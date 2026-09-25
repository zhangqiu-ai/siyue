import {useState} from 'react';
import {Text} from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {useWorkspace} from '../../../src/account/workspace-provider';
import {Stack,useRouter} from 'expo-router';
import {Button,View} from 'react-native';
import {useLocale} from '../../../src/i18n';
import {useThemePreference} from '../../../src/ui/theme';
import {qaVault} from '../qa-auth';
export default function QA(){const {host,state}=useWorkspace();const [inspection,setInspection]=useState(''),[vaultStatus,setVaultStatus]=useState('');
 async function inspect(){if(!host)return;const session=Crypto.randomUUID(),board=host.board(session);try{const reply=JSON.parse(await board.request(JSON.stringify({version:1,session,requestId:Crypto.randomUUID(),op:'load'})));if(!reply.ok)throw Error(reply.error);const value=reply.value.board;setInspection(JSON.stringify({inspectionId:Crypto.randomUUID(),scope:state.scope?.kind,namespace:state.scope?.kind==='account'?state.scope.namespace:'local',elements:value?.pages.flatMap((p:{elements:{id:string;type:string}[]})=>p.elements.map(({id,type})=>({id,type})))??[],elementDigest:await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,JSON.stringify(value?.pages.map((p:{elements:unknown[]})=>p.elements)??[])),fileDigest:await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,JSON.stringify(value?.files??{}))}));}catch{setInspection('inspection_failed');}finally{board.dispose();}}
 const router=useRouter(),{setLocale}=useLocale(),{setMode}=useThemePreference();return <View style={{padding:24,gap:20}}>
  <Stack.Screen options={{title:'Account QA'}}/>
  <Button title="QA 中文明色" onPress={()=>{setLocale('zh-CN');setMode('light');router.push('/account');}}/>
  <Button title="QA English dark" onPress={()=>{setLocale('en');setMode('dark');router.push('/account');}}/>
  <Button title="QA Whiteboard" onPress={()=>router.push('/whiteboard')}/>
  <Button title="QA Plan Draft" onPress={()=>router.push('/plan-create')}/>
  <Button title="QA 中文计划草稿" onPress={()=>{setLocale('zh-CN');setMode('light');router.push('/plan-create');}}/>
  <Button title="QA English Plan Draft" onPress={()=>{setLocale('en');setMode('dark');router.push('/plan-create');}}/>
  <Button title="QA 中文空间草稿" onPress={()=>{setLocale('zh-CN');setMode('light');router.push('/draft-scope' as never);}}/>
  <Button title="QA English Space Draft" onPress={()=>{setLocale('en');setMode('dark');router.push('/draft-scope' as never);}}/>
  <Button title="QA Inspect saved board" onPress={()=>void inspect()}/>
  <Button title="QA Reset deletion fixture" onPress={()=>void (async()=>{
    for(const scope of ['test','test.deletion-receipt'])await SecureStore.deleteItemAsync(`siyue.auth.v1.${scope}`,{keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,keychainService:`com.siyue.auth.${scope}`});
    const db=await SQLite.openDatabaseAsync('siyue-auth-vault-state.db');
    await db.execAsync('CREATE TABLE IF NOT EXISTS auth_vault_state (environment TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL, initialized INTEGER NOT NULL)');
    await db.runAsync('DELETE FROM auth_vault_state WHERE environment IN (?,?)',['test','test.deletion-receipt']);
    setVaultStatus('QA deletion fixture reset');
  })()}/>
  <Button title="QA Remove initialized auth vault" onPress={()=>void (async()=>{await qaVault.write('{}');await SecureStore.deleteItemAsync('siyue.auth.v1.test',{keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,keychainService:'com.siyue.auth.test'});setVaultStatus('QA vault item removed');})()}/>
  <Text accessibilityLabel={`QA vault status ${vaultStatus}`}>{vaultStatus}</Text>
  <Text testID="qa-board-inspection" accessibilityLabel={`QA Board ${inspection}`}>{inspection}</Text>
</View>;}
