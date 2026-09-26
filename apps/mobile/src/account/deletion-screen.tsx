import {useEffect,useMemo,useState} from 'react';
import {Alert,Image,KeyboardAvoidingView,Platform,Pressable,ScrollView,StyleSheet,Text,TextInput,View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Stack} from 'expo-router';
import {usePreventRemove} from 'expo-router/react-navigation';
import {createAccountDeletionFlow,type AccountDeletionFlow,type AuthController} from '@siyue/adapters';
import {useLocale} from '../i18n';
import {useTheme,type Theme} from '../ui/theme';
import AppleSignInButton from './apple-button';
import {authorizeApple} from './apple-native';
import {authErrorText} from './auth-messages';
import {deletionText,fill} from './deletion-messages';
import {mobileDeletionRecipients,recipientSelectable,type DeletionRecipient,type DeletionRecipientRead,type DeletionRecipientSource} from './deletion-recipients';
import {backAllowed,choicesSettled,confirmRows,exitLabel,familySection,introRows,progressSection,recipientSection} from './deletion-view';

interface DeletionRowView {readonly key:string;readonly title:string;readonly detail:string;readonly tone:'default'|'muted'|'error';}

/** The mobile account-deletion entry.
 *
 * It owns one shared deletion flow for as long as it is mounted, renders only that flow's frozen
 * non-secret state plus recipient data it was given, and keeps every credential (password, bearer,
 * single-use grant, receipt secret) inside the controller and the attempt that already holds it.
 */
export default function AccountDeletionScreen({client,appleEnabled,onExit,recipients}:{
  client:AuthController;appleEnabled:boolean;onExit:()=>void;recipients?:DeletionRecipientSource;
}) {
  const {locale,t:general}=useLocale(),t=deletionText(locale),theme=useTheme(),styles=useMemo(()=>makeStyles(theme),[theme]);
  const source=useMemo(()=>recipients??mobileDeletionRecipients(client),[recipients,client]);
  const [flow]=useState<AccountDeletionFlow>(()=>createAccountDeletionFlow(client,{auth:client}));
  const [state,setState]=useState(()=>flow.getState());
  // A submission the controller still holds is not part of a freshly created flow's state, so the entry
  // point asks the controller itself; the only honest offer afterwards is repeating that same request.
  const [owed]=useState(()=>{try{return client.hasPendingDeletion();}catch{return false;}});
  const [target,setTarget]=useState<string|null>(null);
  const [read,setRead]=useState<DeletionRecipientRead|null>(null);
  const [reading,setReading]=useState(false);
  const [picked,setPicked]=useState<Record<string,DeletionRecipient|undefined>>({});
  const [password,setPassword]=useState('');
  const [localError,setLocalError]=useState<string|null>(null);

  useEffect(()=>{
    const unsubscribe=flow.subscribe(()=>setState(flow.getState()));
    // A receipt outlives the process that accepted it: a flow opened after a restart reads it back and
    // enters progress instead of asking for a password it no longer needs.
    void flow.resumeProgress().catch(()=>{});
    return()=>{unsubscribe();flow.dispose();};
  },[flow]);

  const names=useMemo(()=>{
    const values:Record<string,string>={};
    for(const [familyId,recipient] of Object.entries(picked))if(recipient)values[familyId]=recipient.label;
    return values;
  },[picked]);
  const families=familySection(state,t,names),progress=progressSection(state,t),recipient=recipientSection(read,t);
  const locked=owed||(state.locked&&state.retryPending);
  const busy=state.busy||reading;

  function failureCode(value:unknown){return value instanceof Error&&'code' in value?String(value.code):'unavailable';}
  async function run(work:()=>Promise<unknown>){setLocalError(null);try{await work();}catch(failure){setLocalError(failureCode(failure));}}

  async function readRecipients(familyId:string){
    setReading(true);setLocalError(null);setRead(null);
    try{setRead(await source.read(familyId));}
    catch{setRead({kind:'unavailable'});}
    finally{setReading(false);}
  }

  function chooseEnd(familyId:string){
    setLocalError(null);
    try{flow.chooseDisposition({familyId,kind:'end-family-access'});setPicked(current=>({...current,[familyId]:undefined}));}
    catch(failure){setLocalError(failureCode(failure));}
  }

  function chooseRecipient(familyId:string,chosen:DeletionRecipient){
    if(!recipientSelectable(chosen))return;
    setLocalError(null);
    try{flow.chooseDisposition({familyId,kind:'transfer',recipientSubjectId:chosen.subjectId});
      setPicked(current=>({...current,[familyId]:chosen}));setTarget(null);setRead(null);}
    catch(failure){setLocalError(failureCode(failure));}
  }

  /** Leaving the family step with choices already made discards a decision about other people, so it is
   *  confirmed instead of being dropped silently. */
  function leaveFamilyStep(next:()=>void){
    if(!state.families.some(row=>row.choice!==null)){setPicked({});next();return;}
    Alert.alert(t.entry,t.discardChoices,[{text:t.keepEditing,style:'cancel'},
      {text:t.discard,style:'destructive',onPress:()=>{setPicked({});setLocalError(null);next();}}]);
  }

  function goBack(){
    if(target){setTarget(null);setRead(null);return;}
    if(state.step==='confirm'){flow.backToFamilies();return;}
    if(state.step==='families'){leaveFamilyStep(()=>{flow.cancel();});return;}
    onExit();
  }

  /** Back never silently abandons a locked request: the declaration stays locked, and leaving is offered
   *  only as an explicit choice that keeps it repeatable from this screen's entry point. */
  function requestBack(){
    if(state.step==='progress'){onExit();return;}
    if(state.locked&&!state.busy){
      Alert.alert(t.entry,t.lockedNote,[{text:t.keepEditing,style:'cancel'},
        {text:t.leaveAnyway,style:'destructive',onPress:onExit}]);return;
    }
    if(!backAllowed(state)){Alert.alert(t.entry,t.leavingBusy);return;}
    goBack();
  }

  usePreventRemove(true,()=>requestBack());

  const title=target?t.titleRecipient:state.step==='families'?t.titleFamilies:
    state.step==='confirm'||state.step==='submitting'?t.titleConfirm:state.step==='progress'?t.titleProgress:t.titleImpact;

  function button(label:string,onPress:()=>void,options:{primary?:boolean;disabled?:boolean;aria?:string}={}){
    const disabled=options.disabled===true;
    return <Pressable accessibilityRole="button" accessibilityLabel={options.aria??label} accessibilityState={{disabled}}
      disabled={disabled} onPress={onPress}
      style={({pressed})=>[styles.button,options.primary&&styles.primary,
        pressed&&!disabled&&{backgroundColor:options.primary?theme.color.accentPressed:theme.color.subtle},disabled&&styles.disabled]}>
      <Text style={[styles.buttonText,options.primary&&styles.primaryText]}>{label}</Text></Pressable>;
  }

  function card(rows:readonly DeletionRowView[]){
    return <View style={styles.card}>{rows.map((row,index)=><View key={row.key} style={[styles.row,index>0&&styles.rowDivider]}>
      <Text style={styles.rowTitle}>{row.title}</Text><Text style={styles.rowDetail}>{row.detail}</Text></View>)}</View>;
  }

  function errorLine(violation:string|null|undefined){
    return violation?<Text accessibilityRole="alert" style={styles.error}>{authErrorText(locale,violation)}</Text>:null;
  }

  /** A request this device cannot finish is never shown as a fresh start: the declaration stays locked
   *  and the only action is repeating that same request. */
  function lockedActions(){
    return <>{errorLine(localError??state.error)}
      {button(busy?t.submitting:t.retryOriginal,()=>void run(()=>flow.retry()),{primary:true,disabled:busy})}</>;
  }

  function recipientStep(familyId:string){
    const row=families.families.find(item=>item.familyId===familyId);
    return <>
      <Text style={styles.lead}>{t.recipientLead}</Text>
      {reading?<Text style={styles.hint}>{t.recipientLoading}</Text>:
        recipient.status==='unavailable'?<Text style={styles.hint}>{t.recipientUnavailable}</Text>:
        recipient.status==='empty'?<Text style={styles.hint}>{t.recipientEmpty}</Text>:
        card(recipient.rows.map(item=>({key:item.subjectId,title:item.title,detail:item.detail,tone:'default' as const})))}
      {!reading&&recipient.status==='ready'&&<View style={styles.options}>{recipient.rows.map(item=>button(item.title,()=>{
        const candidate=read?.kind==='ready'?read.recipients.find(value=>value.subjectId===item.subjectId):undefined;
        if(candidate)chooseRecipient(familyId,candidate);
      },{disabled:busy||!item.selectable,aria:`${row?.title??t.titleRecipient} · ${item.title}`,primary:picked[familyId]?.subjectId===item.subjectId}))}</View>}
      <Text style={styles.hint}>{t.recipientNote}</Text>
      {errorLine(localError)}
      {button(t.refreshRecipients,()=>void readRecipients(familyId),{primary:true,disabled:reading})}
      {button(t.backToFamilies,()=>{setTarget(null);setRead(null);},{disabled:busy})}
    </>;
  }

  function impactStep(){
    return <>
      <Text style={styles.lead}>{t.introLead}</Text>
      {card(introRows(t))}
      <Text style={styles.hint}>{t.impactNote}</Text>
      {locked?lockedActions():<>{errorLine(localError??state.error)}
        {button(busy?t.busy:t.viewFamilies,()=>void run(()=>flow.loadImpact()),{primary:true,disabled:busy})}
        {button(t.cancel,onExit,{disabled:busy})}</>}
    </>;
  }

  function familiesStep(){
    return <>
      <Text style={styles.lead}>{t.familiesLead}</Text>
      <View style={styles.card}>{families.families.map((item,index)=><View key={item.familyId} style={[styles.row,index>0&&styles.rowDivider]}>
        <Text style={styles.rowTitle}>{item.title}</Text>
        <Text style={styles.rowDetail}>{item.detail}</Text>
        <View style={styles.options}>{item.options.map(option=>button(
          option.kind==='transfer'&&names[item.familyId]?fill(t.chosenTransfer,{name:names[item.familyId],status:t.confirmAccepted}):option.label,
          ()=>{if(option.kind==='end-family-access')chooseEnd(item.familyId);else{setTarget(item.familyId);void readRecipients(item.familyId);}},
          {disabled:busy,aria:`${item.title} · ${option.label}`,primary:item.choice?.kind===option.kind}))}</View>
        <Text style={styles.optionDetail}>{item.choiceDetail??t.familyChoicePending}</Text>
      </View>)}
        <View style={[styles.row,styles.rowDivider]}><Text style={styles.rowTitle}>{t.deviceRow}</Text>
          <Text style={styles.rowDetail}>{families.childDeviceCount>0?t.deviceRowPending:t.deviceRowNone}</Text></View>
      </View>
      <Text style={styles.hint}>{t.familiesNote}</Text>
      {locked?lockedActions():<>{errorLine(localError??state.error)}
        {button(t.reviewChoices,()=>void run(async()=>{flow.continue();}),{primary:true,disabled:busy||!choicesSettled(state,picked)})}
        {button(t.modifyChoices,()=>leaveFamilyStep(()=>{flow.cancel();}),{disabled:busy})}</>}
    </>;
  }

  function confirmStep(){
    return <>
      <Text style={styles.lead}>{t.confirmLead}</Text>
      {card(confirmRows(state,t,names))}
      <Text style={styles.hint}>{state.locked&&state.retryPending?t.lockedNote:t.confirmNote}</Text>
      {errorLine(localError??state.error)}
      {state.locked&&state.retryPending?button(busy?t.submitting:t.retryOriginal,()=>void run(()=>flow.retry()),{primary:true,disabled:busy}):<>
        <View style={styles.field}><Text style={styles.label}>{t.password}</Text>
          <TextInput accessibilityLabel={t.password} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false}
            autoComplete="current-password" maxLength={256} editable={!busy} style={[styles.input,busy&&styles.disabled]}/></View>
        {button(busy?t.submitting:t.confirmSubmit,()=>void run(async()=>{
          if(password===''){setLocalError('invalid_request');return;}
          const proof=password;setPassword('');await flow.submitWithPassword(proof);
        }),{primary:true,disabled:busy||password===''})}
        {appleEnabled&&<AppleSignInButton disabled={busy} onPress={()=>void run(()=>flow.submitWithApple(authorizeApple))}/>}
        {button(t.backToCheck,()=>flow.backToFamilies(),{disabled:busy})}
      </>}
    </>;
  }

  function progressStep(){
    return <>
      <Text style={styles.lead}>{t.progressLead}</Text>
      {progress.rows.length>0&&card(progress.rows)}
      {progress.receiptMissing?<Text style={styles.hint}>{t.progressMissing}</Text>:!state.completed&&state.status?.lastErrorCode?<Text style={styles.hint}>{t.progressFamilyNote}</Text>:null}
      <Text style={styles.hint}>{t.progressNote}</Text>
      {errorLine(localError??state.error)}
      {button(busy?t.busy:t.refreshProgress,()=>void run(()=>flow.loadProgress()),{primary:true,disabled:busy})}
      {button(exitLabel(state.step,t),onExit,{disabled:busy})}
    </>;
  }

  return <SafeAreaView style={styles.page} edges={['bottom']}>
    <Stack.Screen options={{headerShown:true,title:'',headerBackTitle:general('common.back'),headerBackButtonDisplayMode:'minimal',
      headerShadowVisible:false,headerTintColor:theme.color.ink,headerStyle:{backgroundColor:theme.color.background}}}/>
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS==='ios'?'padding':'height'} keyboardVerticalOffset={Platform.OS==='ios'?96:0}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={styles.heading}><View style={styles.headingIcon}><Image source={require('../../assets/account/deletion-lock.png')} style={{width:22,height:22,tintColor:theme.color.muted}} accessible={false}/></View>
          <Text accessibilityRole="header" style={styles.headingText}>{title}</Text></View>
        {target?recipientStep(target):state.step==='impact'?impactStep():state.step==='families'?familiesStep():
          state.step==='progress'?progressStep():confirmStep()}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const makeStyles=(theme:Theme)=>StyleSheet.create({
  page:{flex:1,backgroundColor:theme.color.background},
  content:{width:'100%',maxWidth:560,alignSelf:'center',padding:24,paddingBottom:32,gap:20},
  heading:{flexDirection:'row',alignItems:'center',gap:12},
  headingIcon:{width:40,height:40,borderRadius:14,alignItems:'center',justifyContent:'center',backgroundColor:theme.color.subtle},
  headingText:{flex:1,fontSize:26,fontWeight:'600',color:theme.color.ink},
  lead:{fontSize:16,lineHeight:24,color:theme.color.ink},
  hint:{fontSize:14,lineHeight:22,color:theme.color.muted},
  optionDetail:{fontSize:14,lineHeight:22,color:theme.color.muted},
  card:{backgroundColor:theme.color.surface,borderRadius:theme.radius.card,overflow:'hidden'},
  row:{gap:8,padding:16},
  rowDivider:{borderTopWidth:1,borderTopColor:theme.color.border},
  rowTitle:{fontSize:16,lineHeight:24,fontWeight:'600',color:theme.color.ink},
  rowDetail:{fontSize:14,lineHeight:22,color:theme.color.muted},
  options:{gap:8},
  field:{gap:8},
  label:{fontSize:16,lineHeight:24,color:theme.color.ink},
  input:{minHeight:52,padding:12,fontSize:17,color:theme.color.ink,backgroundColor:theme.color.surface,borderColor:theme.color.controlBorder,borderWidth:1,borderRadius:theme.radius.field},
  button:{minHeight:48,justifyContent:'center',alignItems:'center',padding:12,borderRadius:theme.radius.field,backgroundColor:theme.color.surface,borderWidth:1,borderColor:theme.color.controlBorder},
  buttonText:{fontSize:16,lineHeight:24,textAlign:'center',color:theme.color.ink},
  primary:{backgroundColor:theme.color.accent,borderColor:theme.color.accent},
  primaryText:{color:theme.color.onAccent},
  disabled:{opacity:.5},
  error:{fontSize:16,lineHeight:24,color:theme.color.error},
});
