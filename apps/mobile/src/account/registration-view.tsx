import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {Linking,Platform,Pressable,StyleSheet,Text,TextInput,View} from 'react-native';
import * as Crypto from 'expo-crypto';
import {createEmailRegistration,emailRegistrationActions,type AuthController} from '@siyue/adapters';
import {useLocale} from '../i18n';
import {AppIcon} from '../ui/icon';
import {useTheme,type Theme} from '../ui/theme';
import {authText,authErrorText} from './auth-messages';

/** The mobile email registration step.
 *
 * It owns one in-memory registration flow: read the released terms/privacy versions, request a code,
 * then confirm with the versions the server itself published. Only non-secret state is rendered — the
 * code, the password and the challenge proof stay in the flow, which is disposed when the step closes,
 * so returning to sign in leaves no half-filled credential behind.
 */
export default function RegistrationView({client,onBusyChange,onExit}:{
  client:AuthController;onBusyChange?:(busy:boolean)=>void;onExit:()=>void;
}) {
  const {locale}=useLocale(),t=authText(locale),theme=useTheme(),styles=useMemo(()=>makeStyles(theme),[theme]);
  const apiLocale=locale==='en'?'en-US':'zh-CN';
  const [flow]=useState(()=>createEmailRegistration(emailRegistrationActions(client,Platform.OS==='ios'?'ios':'android'),Crypto.randomUUID));
  // TextInput is controlled by this non-React flow. A synchronous external-store snapshot keeps each
  // native edit and its selection paired with the exact value React renders back to the field.
  const form=useSyncExternalStore(flow.subscribe,flow.getState,flow.getState),[now,setNow]=useState(Date.now);
  // A refusal the released documents decided is reported on the address step, where consent is given.
  const [refusal,setRefusal]=useState<string|null>(null);
  const report=useRef(onBusyChange);report.current=onBusyChange;
  const code=useRef<TextInput>(null);
  useEffect(()=>{
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return()=>{clearInterval(timer);flow.dispose();};
  },[flow]);
  // The released documents are read whenever they are unknown: on entry, and again after a refusal that
  // dropped them because they changed under the attempt.
  useEffect(()=>{if(!form.policy&&!form.loadingPolicy&&!form.policyError)void flow.loadPolicy();},[flow,form.policy,form.loadingPolicy,form.policyError]);
  // A pair that changed under an in-flight confirmation, or a deployment that closed sign-up, cannot be
  // retried with the same versions: the step returns to the address so the current documents are read and
  // agreed to before anything is requested again.
  useEffect(()=>{
    const code=form.error;
    if(form.step!=='verify'||form.busy||form.retryPending||(code!=='policy_changed'&&code!=='registration_closed'))return;
    if(flow.back())setRefusal(code);
  },[flow,form.step,form.busy,form.retryPending,form.error]);
  useEffect(()=>{report.current?.(form.busy);},[form.busy]);
  useEffect(()=>()=>report.current?.(false),[]);
  useEffect(()=>{if(form.step==='verify')code.current?.focus();},[form.step]);
  // A pending retry repeats the operation its own key already covers; it never starts a second one.
  function submit(){if(form.step==='email')setRefusal(null);return form.retryPending?flow.retry():form.step==='verify'?flow.confirm():flow.sendCode(apiLocale);}
  // A field, a link and a way back stay frozen while the same operation is still outstanding; only an
  // in-flight request locks the primary action, because repeating that one operation is exactly what
  // the pending key is for.
  const locked=form.busy||form.retryPending;
  const wait=Math.max(0,Math.ceil((form.retryAt-now)/1000)),resendWait=Math.max(0,Math.ceil((form.resendAt-now)/1000));
  // A half published policy carries no versions to agree to, so it reads exactly like a closed one.
  const released=form.policy?.enabled&&form.policy.terms&&form.policy.privacy?form.policy:null;
  function button(label:string,onPress:()=>void,disabled=false,primary=false){return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled}} disabled={disabled} onPress={onPress}
    style={({pressed})=>[styles.button,primary&&styles.primary,pressed&&!disabled&&{backgroundColor:primary?theme.color.accentPressed:theme.color.subtle},disabled&&styles.disabled]}><Text style={[styles.buttonText,primary&&styles.primaryText]}>{label}</Text></Pressable>;}
  // The released documents are the only pages this step opens, and they open outside the app.
  function document(label:string,url:string){return <Pressable accessibilityRole="link" accessibilityLabel={label} accessibilityState={{disabled:locked}} disabled={locked} onPress={()=>void openDocument(url)} style={styles.document}><Text style={styles.link}>{label}</Text></Pressable>;}
  function field(label:string,key:'email'|'code'|'password'|'repeatPassword'){const password=key==='password'||key==='repeatPassword';return <View style={styles.field}><Text style={styles.label}>{label}</Text>
    <TextInput ref={key==='code'?code:undefined} accessibilityLabel={label} value={form[key]} editable={!locked} onChangeText={value=>flow.set(key,value)} secureTextEntry={password} autoCapitalize="none" autoCorrect={false}
      keyboardType={key==='email'?'email-address':key==='code'?'number-pad':'default'} autoComplete={key==='email'?'email':key==='code'?'one-time-code':'new-password'} maxLength={key==='email'?254:key==='code'?6:256} style={[styles.input,locked&&styles.disabled]}/></View>;}
  const notice=<>{form.error&&<Text accessibilityRole="alert" style={styles.error}>{authErrorText(locale,form.error)}</Text>}
    {form.retryPending&&<Text accessibilityLiveRegion="polite" style={styles.hint}>{t.uncertain}</Text>}</>;
  // The session replaces this step as soon as the account exists; the status keeps the last frame from
  // falling back to an empty request form while that happens.
  if(form.step==='complete')return <View style={styles.form}><Text accessibilityLiveRegion="polite" style={styles.text}>{t.restoring}</Text></View>;
  if(form.step==='verify')return <View style={styles.form}>
    <Text accessibilityRole="header" style={styles.title}>{t.register}</Text>
    <Text style={styles.hint}>{t.codeSent.replace('{email}',form.email)}</Text>
    {field(t.code,'code')}
    {field(t.password,'password')}<Text style={styles.hint}>{t.passwordHint}</Text>
    {field(t.repeatPassword,'repeatPassword')}
    {notice}
    {button(form.busy?t.busy:wait>0?`${t.wait} (${wait})`:form.retryPending?t.retryOperation:t.createAccount,()=>void submit(),form.busy||wait>0,true)}
    {button(t.changeEmail,()=>void flow.back(),locked)}
    {button(t.resend+(resendWait>0?` (${resendWait})`:''),()=>void flow.resend(apiLocale),locked||wait>0||resendWait>0)}
    {button(t.backLogin,onExit,locked)}
  </View>;
  return <View style={styles.form}>
    <Text accessibilityRole="header" style={styles.title}>{t.register}</Text>
    {form.policy&&!released&&<Text accessibilityLiveRegion="polite" style={styles.hint}>{t.registerUnavailable}</Text>}
    {field(t.email,'email')}
    <Pressable accessibilityRole="checkbox" accessibilityLabel={t.consentPrefix} accessibilityState={{checked:form.accepted,disabled:locked}} disabled={locked} onPress={()=>flow.setConsent(!form.accepted)} style={styles.consent}>
      <View style={[styles.checkbox,form.accepted&&styles.checkboxChecked]}>{form.accepted&&<AppIcon name="check" size={18} color={theme.color.onAccent}/>}</View>
      <Text style={styles.consentText}>{t.consentPrefix}</Text>
    </Pressable>
    {released&&<View style={styles.documents}>
      {released.terms&&document(t.terms,released.terms.url)}
      <Text style={styles.consentText}>{t.consentJoin}</Text>
      {released.privacy&&document(t.privacy,released.privacy.url)}
    </View>}
    <Text style={styles.hint}>{t.consentHint}</Text>
    {form.policyError&&<Text accessibilityRole="alert" style={styles.error}>{authErrorText(locale,form.policyError)}</Text>}
    {refusal&&<Text accessibilityRole="alert" style={styles.error}>{authErrorText(locale,refusal)}</Text>}
    {form.loadingPolicy&&!form.policy&&!form.policyError&&<Text accessibilityLiveRegion="polite" style={styles.hint}>{t.busy}</Text>}
    {notice}
    {button(form.busy?t.busy:wait>0?`${t.wait} (${wait})`:form.retryPending?t.retryOperation:t.sendCode,()=>void submit(),form.busy||wait>0||!released||!form.accepted,true)}
    {form.policyError&&button(t.retry,()=>void flow.loadPolicy(),locked)}
    {button(t.backLogin,onExit,locked)}
  </View>;
}

/** Only a released document the server published over HTTPS reaches the system browser. */
async function openDocument(url:string){if(!url.startsWith('https://'))return;try{await Linking.openURL(url);}catch{/* No other surface may open an unreleased policy. */}}

const makeStyles=(theme:Theme)=>StyleSheet.create({
  form:{width:'100%',maxWidth:460,alignSelf:'center',gap:16},field:{gap:8},title:{fontSize:24,lineHeight:32,fontWeight:'600',color:theme.color.ink},
  text:{fontSize:16,lineHeight:24,color:theme.color.ink},label:{fontSize:16,lineHeight:24,color:theme.color.ink},hint:{fontSize:14,lineHeight:22,color:theme.color.muted},
  input:{minHeight:52,padding:12,fontSize:17,color:theme.color.ink,backgroundColor:theme.color.surface,borderColor:theme.color.controlBorder,borderWidth:1,borderRadius:theme.radius.field},
  button:{minHeight:48,justifyContent:'center',alignItems:'center',padding:12,borderRadius:theme.radius.field,backgroundColor:theme.color.surface,borderWidth:1,borderColor:theme.color.controlBorder},
  buttonText:{fontSize:16,lineHeight:24,textAlign:'center',color:theme.color.ink},primary:{backgroundColor:theme.color.accent,borderColor:theme.color.accent},primaryText:{color:theme.color.onAccent},disabled:{opacity:.5},
  error:{fontSize:16,lineHeight:24,color:theme.color.error},
  consent:{minHeight:48,flexDirection:'row',alignItems:'center',gap:8},consentText:{flex:1,fontSize:15,lineHeight:24,color:theme.color.ink},
  checkbox:{width:24,height:24,borderRadius:7,borderWidth:1,borderColor:theme.color.controlBorder,backgroundColor:theme.color.surface,alignItems:'center',justifyContent:'center'},
  checkboxChecked:{borderColor:theme.color.accent,backgroundColor:theme.color.accent},
  documents:{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:8},document:{minHeight:48,justifyContent:'center'},
  link:{color:theme.color.accent,fontSize:15,lineHeight:24},
});
