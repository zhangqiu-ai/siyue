import FamilyResponsibilities from '../account/family-responsibilities';
import AppleSignInButton from '../account/apple-button';
import {authorizeApple,isAppleAvailable} from '../account/apple-native';
import AccountDeletionScreen from '../account/deletion-screen';
import RegistrationView from '../account/registration-view';
import {useWorkspace} from '../account/workspace-provider';
import {useEffect,useRef,useState} from 'react';
import {Stack} from 'expo-router';
import {usePreventRemove} from 'expo-router/react-navigation';
import {Alert,KeyboardAvoidingView,Platform,Pressable,ScrollView,StyleSheet,Text,TextInput,View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import {createEmailEntry,type EmailEntryState} from '@siyue/adapters';
import type {AccountDeviceSession} from '@siyue/contracts';
import {useAccountAuth} from '../account/auth-provider';
import {authText,authErrorText} from '../account/auth-messages';
import {deletionText} from '../account/deletion-messages';
import {useLocale} from '../i18n';
import {useTheme,type Theme} from '../ui/theme';

export default function AccountScreen() {
  const {locale,t:general}=useLocale(),t=authText(locale),theme=useTheme(),styles=makeStyles(theme);
  const deletionCopy=deletionText(locale);
  const {host:workspace,state:space}=useWorkspace();
  const {client,state:auth}=useAccountAuth();
  const [flow,setFlow]=useState<ReturnType<typeof createEmailEntry>|null>(null),[form,setForm]=useState<EmailEntryState|null>(null);
  const [appleEnabled,setAppleEnabled]=useState(false);
  const [enabled,setEnabled]=useState<boolean|null>(null),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<'logoutDone'|'logoutPending'|'passwordChanged'|'deviceRevoked'|'devicesRevoked'|null>(null);
  const [currentPassword,setCurrentPassword]=useState(''),[nextPassword,setNextPassword]=useState(''),[repeatNext,setRepeatNext]=useState(''),[changeKey,setChangeKey]=useState(''),[changeRetry,setChangeRetry]=useState(false);
  const [devices,setDevices]=useState<AccountDeviceSession[]>([]),[devicesOpen,setDevicesOpen]=useState(false),[devicePassword,setDevicePassword]=useState(''),[nextDeviceCursor,setNextDeviceCursor]=useState<string|null>(null);
  const [working,setWorking]=useState(false),[now,setNow]=useState(Date.now),mounted=useRef(false),code=useRef<TextInput>(null);
  const [deletion,setDeletion]=useState<null|'flow'|'progress'>(null),[receipt,setReceipt]=useState(false);
  const [registration,setRegistration]=useState(false),[registrationBusy,setRegistrationBusy]=useState(false);
  const previousSubject=useRef<string|null>(null);
  useEffect(()=>setChangeRetry(auth.passwordChangePending===true),[auth.passwordChangePending]);
  const apiLocale=locale==='en'?'en-US':'zh-CN';
  async function load(){setEnabled(null);setAppleEnabled(false);setError(null);try{if(!client)throw Error();const providers=await client.providers();const apple=providers.apple.enabled&&providers.apple.platforms.includes('ios')&&await isAppleAvailable();if(mounted.current){setEnabled(providers.emailPassword.enabled);setAppleEnabled(apple);}}catch{if(mounted.current){setError('unavailable');setEnabled(false);}}}
  useEffect(()=>{
    mounted.current=true;
    if(!client){setEnabled(false);return()=>{mounted.current=false;};}
    const entry=createEmailEntry({login:input=>client.login({...input,platform:Platform.OS==='ios'?'ios':'android'}),requestReset:client.requestReset,confirmReset:client.confirmReset},Crypto.randomUUID);
    setFlow(entry);setForm(entry.getState());const unsubscribe=entry.subscribe(()=>setForm(entry.getState()));
    void load();const timer=setInterval(()=>setNow(Date.now()),1000);
    return()=>{mounted.current=false;unsubscribe();entry.dispose();clearInterval(timer);};
  },[client]);
  const busy=working||!!form?.busy||registrationBusy||['bootstrapping','authenticating','refreshing','logging-out'].includes(auth.status);
  usePreventRemove((busy||changeRetry)&&deletion===null,()=>Alert.alert(t.account,changeRetry?t.uncertain:t.leavingBusy));
  // Only a stored receipt can report an accepted deletion, and this device may read it without a
  // session. A read that fails hides the entry instead of promising a record that cannot be opened.
  useEffect(()=>{
    if(!client||auth.status==='bootstrapping')return;
    if(auth.status==='authenticated'){setReceipt(false);return;}
    let live=true;
    void client.deletionStatus().then(progress=>{if(live)setReceipt(progress!==null);}).catch(()=>{if(live)setReceipt(false);});
    return()=>{live=false;};
  },[client,auth.status]);
  useEffect(()=>{
    const subject=auth.account?.subjectId??null;
    if(!busy&&flow&&subject!==previousSubject.current){previousSubject.current=subject;flow.navigate('login');flow.set('email','');setDevices([]);setDevicesOpen(false);setNextDeviceCursor(null);setDevicePassword('');setRegistration(false);}
  },[auth.account?.subjectId,busy,flow]);
  useEffect(()=>{if(form?.mode==='reset-confirm')code.current?.focus();},[form?.mode]);
  async function action(kind:'bootstrap'|'logout'){
    if(!client)return;setWorking(true);setError(null);setNotice(null);
    try{if(kind==='logout'){const result=await client.logout();if(mounted.current)setNotice(result.server==='pending'?'logoutPending':'logoutDone');}else await client.bootstrap();}
    catch(failure){if(mounted.current)setError(failure instanceof Error&&'code' in failure?String(failure.code):'unavailable');}
    finally{if(mounted.current)setWorking(false);}
  }
  async function appleLogin(retry=false){
    if(!client||busy)return;setWorking(true);setError(null);setNotice(null);
    try{if(retry)await client.retryApple();else await client.loginApple(authorizeApple);}
    catch(failure){if(mounted.current&&!(failure instanceof Error&&'code' in failure&&failure.code==='cancelled'))setError(failure instanceof Error&&'code' in failure?String(failure.code):'unavailable');}
    finally{if(mounted.current)setWorking(false);}
  }
  async function changePassword(){
    if(!client)return;setWorking(true);setError(null);setNotice(null);
    try {
      if(changeRetry)await client.retryPasswordChange();else {
        if([...nextPassword].length<15||[...nextPassword].length>128)throw Object.assign(new Error(),{code:'password_policy'});
        if(nextPassword!==repeatNext)throw Object.assign(new Error(),{code:'password_mismatch'});
        const key=changeKey||Crypto.randomUUID();if(!changeKey)setChangeKey(key);
        await client.changePassword(currentPassword,nextPassword,key);
      }
      setCurrentPassword('');setNextPassword('');setRepeatNext('');setChangeKey('');setChangeRetry(false);setNotice('passwordChanged');
    }catch(failure){const code=failure instanceof Error&&'code' in failure?String(failure.code):'unavailable';setError(code);setChangeRetry(['network','timeout','unavailable'].includes(code));}
    finally{if(mounted.current)setWorking(false);}
  }
  async function loadDevices(cursor?:string){
    if(!client)return;setWorking(true);setError(null);
    try{const page=await client.deviceSessions(cursor);if(mounted.current){setDevices(old=>cursor?[...old,...page.items.filter(item=>!old.some(existing=>existing.sessionId===item.sessionId))]:page.items);setNextDeviceCursor(page.nextCursor);setDevicesOpen(true);}}
    catch(failure){if(mounted.current)setError(failure instanceof Error&&'code' in failure?String(failure.code):'unavailable');}
    finally{if(mounted.current)setWorking(false);}
  }
  async function revokeDevice(device:AccountDeviceSession){
    if(!client)return;if(!device.current&&!devicePassword){setError('invalid_request');return;}
    setWorking(true);setError(null);setNotice(null);
    try{await client.revokeDeviceSession(device.sessionId,device.current?undefined:devicePassword);if(mounted.current){setDevicePassword('');setDevices(value=>value.filter(item=>item.sessionId!==device.sessionId));setNotice('deviceRevoked');}}
    catch(failure){if(mounted.current){const code=failure instanceof Error&&'code' in failure?String(failure.code):'unavailable';setError(['network','timeout','unavailable'].includes(code)?'deviceOperationUnknown':code);}}
    finally{if(mounted.current)setWorking(false);}
  }
  async function revokeAllDevices(){
    if(!client)return;if(!devicePassword){setError('invalid_request');return;}
    setWorking(true);setError(null);setNotice(null);
    try{await client.revokeAllDeviceSessions(devicePassword);if(mounted.current){setDevicePassword('');setDevices([]);setNextDeviceCursor(null);setNotice('devicesRevoked');}}
    catch(failure){if(mounted.current){const code=failure instanceof Error&&'code' in failure?String(failure.code):'unavailable';setError(['network','timeout','unavailable'].includes(code)?'deviceOperationUnknown':code);}}
    finally{if(mounted.current)setWorking(false);}
  }
  const hasAccount=auth.account!==null&&(auth.status!=='reauth-required'||changeRetry)||changeRetry,secure=auth.status==='secure-storage-unavailable'&&!changeRetry;
  const wait=Math.max(0,Math.ceil(((form?.retryAt??0)-now)/1000)),resendWait=Math.max(0,Math.ceil(((form?.resendAt??0)-now)/1000));
  const locked=busy||!!form?.retryPending;
  function button(label:string,onPress:()=>void,disabled=false,primary=false){return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled}} disabled={disabled} onPress={onPress} style={({pressed})=>[styles.button,primary&&styles.primary,pressed&&!disabled&&{backgroundColor:primary?theme.color.accentPressed:theme.color.subtle},disabled&&styles.disabled]}><Text style={[styles.buttonText,primary&&styles.primaryText]}>{label}</Text></Pressable>;}
  function field(label:string,name:'email'|'password'|'repeatPassword'|'code',password=false){
    if(!form||!flow)return null;
    return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput ref={name==='code'?code:undefined} accessibilityLabel={label} value={form[name]} editable={!locked&&!(name==='email'&&form.mode==='reset-confirm')} onChangeText={value=>flow.set(name,value)} secureTextEntry={password} autoCapitalize="none" autoCorrect={false} keyboardType={name==='email'?'email-address':name==='code'?'number-pad':'default'} autoComplete={name==='email'?'email':name==='code'?'one-time-code':form.mode==='login'?'current-password':'new-password'} maxLength={name==='email'?254:name==='code'?6:256} style={[styles.input,locked&&styles.disabled]} /></View>;
  }
  if(deletion&&client)return <AccountDeletionScreen client={client} appleEnabled={appleEnabled} onExit={()=>setDeletion(null)}/>;
  return <SafeAreaView style={styles.page} edges={['bottom']}>
    <Stack.Screen options={{headerShown:true,title:t.account,headerBackTitle:general('common.back'),headerBackButtonDisplayMode:'minimal',headerShadowVisible:false,headerTintColor:theme.color.ink,headerStyle:{backgroundColor:theme.color.background}}}/>
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS==='ios'?'padding':'height'} keyboardVerticalOffset={Platform.OS==='ios'?96:0}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Text style={styles.hint}>{t.local}</Text>
        {workspace&&<Text style={styles.hint}>{space.scope?.kind==='account'?(locale==='en'?'Current space: account space (on this device)':'当前空间：账号空间（仅本机）'):(locale==='en'?'Current space: original local space':'当前空间：原本机空间')}</Text>}
        {notice&&<Text accessibilityLiveRegion="polite" style={styles.text}>{t[notice]}</Text>}
        {error&&<Text accessibilityRole="alert" style={styles.error}>{authErrorText(locale,error)}</Text>}
        {!hasAccount&&receipt&&<View style={styles.form}>
          <Text accessibilityRole="header" style={styles.title}>{deletionCopy.viewProgress}</Text>
          <Text style={styles.hint}>{deletionCopy.viewProgressDetail}</Text>
          {button(deletionCopy.viewProgress,()=>setDeletion('progress'),busy,true)}
        </View>}
        {!secure&&!hasAccount&&appleEnabled&&auth.status==='authenticating'&&<Text accessibilityLiveRegion="polite" style={styles.text}>{t.busy}</Text>}
        {!secure&&!hasAccount&&appleEnabled&&auth.status==='anonymous'&&(!form||form.mode==='login')&&<View style={styles.form}>
          {client?.canRetryApple()?<><Text style={styles.hint}>{t.uncertain}</Text>{button(t.retryOperation,()=>void appleLogin(true),busy,true)}</>:
          <AppleSignInButton disabled={busy||!!form?.retryPending} onPress={()=>void appleLogin()}/>}
        </View>}
        {secure?<><Text accessibilityRole="alert" style={styles.error}>{authErrorText(locale,auth.error??'storage_unavailable')}</Text>{changeRetry&&button(t.retryOperation,()=>void changePassword(),busy,true)}{button(t.retry,()=>void action('bootstrap'),busy)}</>:
        hasAccount?<><Text accessibilityLiveRegion="polite" style={styles.title}>{t[auth.status==='authenticated'?'authenticated':'offline']}</Text>
          {workspace&&space.canCreate&&<><Text style={styles.hint}>{locale==='en'?'Create a separate account space on this device. Existing local content is preserved and is not uploaded.':'在本机创建独立账号空间，原本机内容保留，不会上传。'}</Text>{button(locale==='en'?'Create an account space on this device':'在本机创建账号空间',()=>{setWorking(true);void workspace.createAccountSpace(auth.generation).catch(()=>{if(mounted.current)setError('unavailable');}).finally(()=>{if(mounted.current)setWorking(false);});},busy)}</>}
          {(auth.status==='authenticated'||changeRetry)&&<View style={styles.form}>
            <Text accessibilityRole="header" style={styles.title}>{t.changePassword}</Text>
            <View style={styles.field}><Text style={styles.label}>{t.currentPassword}</Text><TextInput accessibilityLabel={t.currentPassword} value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" maxLength={256} editable={!busy&&!changeRetry} style={[styles.input,changeRetry&&styles.disabled]}/></View>
            <View style={styles.field}><Text style={styles.label}>{t.newPassword}</Text><TextInput accessibilityLabel={t.newPassword} value={nextPassword} onChangeText={setNextPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" maxLength={256} editable={!busy&&!changeRetry} style={[styles.input,changeRetry&&styles.disabled]}/></View>
            <Text style={styles.hint}>{t.passwordHint}</Text>
            <View style={styles.field}><Text style={styles.label}>{t.confirmPassword}</Text><TextInput accessibilityLabel={t.confirmPassword} value={repeatNext} onChangeText={setRepeatNext} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" maxLength={256} editable={!busy&&!changeRetry} style={[styles.input,changeRetry&&styles.disabled]}/></View>
            {changeRetry&&<Text accessibilityLiveRegion="polite" style={styles.hint}>{t.uncertain}</Text>}
            {button(busy?t.busy:changeRetry?t.retryOperation:t.changePassword,()=>void changePassword(),busy||(!changeRetry&&(!currentPassword||!nextPassword||!repeatNext)),true)}
          </View>}
          {auth.status==='authenticated'&&<View style={styles.form} accessibilityLabel={t.devices}>
            <Text accessibilityRole="header" style={styles.title}>{t.devices}</Text><Text style={styles.hint}>{t.devicesReauthHint}</Text>
            {!devicesOpen?button(t.manageDevices,()=>void loadDevices(),busy):<>
              {button(t.refreshDevices,()=>void loadDevices(),busy)}
              <View style={styles.field}><Text style={styles.label}>{t.deviceReauthPassword}</Text><TextInput accessibilityLabel={t.deviceReauthPassword} value={devicePassword} onChangeText={setDevicePassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" maxLength={256} editable={!busy} style={styles.input}/></View>
              {devices.map(device=><View key={device.sessionId} style={styles.deviceRow}>
                <Text style={styles.label}>{device.deviceLabel||t.deviceUnlabelled} · {device.current?t.deviceCurrent:t.deviceOther}</Text>
                <Text style={styles.hint}>{device.platform??t.devicePlatform} · {t.deviceLastActive}: {new Date(device.lastSeenAt).toLocaleString(locale==='en'?'en-US':'zh-CN')}</Text>
                {button(device.current?t.revokeCurrentDevice:t.revokeDevice,()=>Alert.alert(t.account,t.confirmRevokeDevice,[{text:general('common.cancel'),style:'cancel'},{text:device.current?t.revokeCurrentDevice:t.revokeDevice,style:'destructive',onPress:()=>void revokeDevice(device)}]),busy||(!device.current&&!devicePassword))}
              </View>)}
              {nextDeviceCursor&&button(t.loadMoreDevices,()=>void loadDevices(nextDeviceCursor),busy)}
              {button(t.revokeAllDevices,()=>Alert.alert(t.account,t.confirmRevokeAll,[{text:general('common.cancel'),style:'cancel'},{text:t.revokeAllDevices,style:'destructive',onPress:()=>void revokeAllDevices()}]),busy||!devices.length||!devicePassword,true)}
            </>}
          </View>}
          {auth.status==='authenticated'&&<View style={styles.form} accessibilityLabel={deletionCopy.entry}>
            <Text accessibilityRole="header" style={styles.title}>{deletionCopy.entry}</Text>
            <Text style={styles.hint}>{deletionCopy.entryDetail}</Text>
            {button(deletionCopy.entry,()=>setDeletion('flow'),busy)}
          </View>}
          {auth.status==='authenticated'&&auth.session?.subjectKind==='adult'&&client&&<FamilyResponsibilities key={auth.generation} client={client}/>}
          {auth.status!=='authenticated'&&button(t.retry,()=>void action('bootstrap'),busy)}{button(busy?t.busy:t.logout,()=>void action('logout'),busy)}</>:
        auth.status==='bootstrapping'?<Text style={styles.text}>{t.restoring}</Text>:
        auth.status==='reauth-required'&&!hasAccount?<View style={styles.form}><Text style={styles.text}>{t.reauth}</Text>{button(t.logout,()=>void action('logout'),busy,true)}</View>:
        !enabled&&!appleEnabled?<>{(enabled===null||!error)&&<Text style={styles.text}>{enabled===null?t.busy:t.unavailable}</Text>}{enabled===false&&button(t.retry,()=>void load())}</>:
        client&&registration?<RegistrationView client={client} onBusyChange={setRegistrationBusy} onExit={()=>setRegistration(false)}/>:
        enabled&&form&&flow?<>
          {auth.status==='reauth-required'&&<Text style={styles.text}>{t.reauth}</Text>}
          {form.mode==='reset-complete'?<><Text accessibilityLiveRegion="polite" style={styles.text}>{t.resetDone}</Text>{button(t.backLogin,()=>flow.navigate('login'),false,true)}</>:
          <View style={styles.form}>
            <Text accessibilityRole="header" style={styles.title}>{form.mode==='login'?t.login:t.reset}</Text>
            {form.mode==='reset-confirm'&&<Text style={styles.hint}>{t.resetSent}</Text>}
            {field(t.email,'email')}
            {form.mode==='reset-confirm'&&field(t.code,'code')}
            {form.mode!=='reset-request'&&<>{field(form.mode==='login'?t.password:t.newPassword,'password',true)}<Text style={styles.hint}>{t.passwordHint}</Text></>}
            {form.mode==='reset-confirm'&&field(t.repeatPassword,'repeatPassword',true)}
            {form.error&&<Text accessibilityRole="alert" style={styles.error}>{authErrorText(locale,form.error)}</Text>}
            {form.retryPending&&<Text accessibilityLiveRegion="polite" style={styles.hint}>{t.uncertain}</Text>}
            {button(busy?t.busy:wait>0?`${t.wait} (${wait})`:form.retryPending?t.retryOperation:form.mode==='login'?t.login:form.mode==='reset-request'?t.sendCode:t.savePassword,()=>{setNotice(null);void flow.submit(apiLocale);},busy||wait>0,true)}
            {button(form.mode==='login'?t.forgot:t.backLogin,()=>flow.navigate(form.mode==='login'?'reset-request':'login'),busy)}
            {form.mode==='login'&&button(t.register,()=>setRegistration(true),busy)}
            {form.mode==='reset-confirm'&&button(t.resend+(resendWait>0?` (${resendWait})`:''),()=>void flow.resend(apiLocale),locked||wait>0||resendWait>0)}
          </View>}
        </>:null}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
const makeStyles=(theme:Theme)=>StyleSheet.create({
  page:{flex:1,backgroundColor:theme.color.background},content:{width:'100%',maxWidth:560,alignSelf:'center',padding:20,paddingBottom:32,gap:20},
  form:{gap:16},field:{gap:8},title:{fontSize:24,lineHeight:32,fontWeight:'600',color:theme.color.ink},
  text:{fontSize:16,lineHeight:24,color:theme.color.ink},label:{fontSize:16,lineHeight:24,color:theme.color.ink},hint:{fontSize:14,lineHeight:22,color:theme.color.muted},
  input:{minHeight:52,padding:12,fontSize:17,color:theme.color.ink,backgroundColor:theme.color.surface,borderColor:theme.color.controlBorder,borderWidth:1,borderRadius:theme.radius.field},
  button:{minHeight:48,justifyContent:'center',alignItems:'center',padding:12,borderRadius:theme.radius.field,backgroundColor:theme.color.surface,borderWidth:1,borderColor:theme.color.controlBorder},
  buttonText:{fontSize:16,lineHeight:24,textAlign:'center',color:theme.color.ink},primary:{backgroundColor:theme.color.accent,borderColor:theme.color.accent},primaryText:{color:theme.color.onAccent},disabled:{opacity:.5},
  error:{fontSize:16,lineHeight:24,color:theme.color.error},
  deviceRow:{gap:8,paddingVertical:12,borderTopWidth:1,borderTopColor:theme.color.controlBorder},
});
