import * as AppleAuthentication from 'expo-apple-authentication';
import {View} from 'react-native';
import {useTheme} from '../ui/theme';
export default function AppleSignInButton({disabled,onPress}:{disabled:boolean;onPress:()=>void}){
 const theme=useTheme();
 return <View pointerEvents={disabled?'none':'auto'} accessibilityState={{disabled}}>
  <AppleAuthentication.AppleAuthenticationButton buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
   buttonStyle={theme.mode==='dark'?AppleAuthentication.AppleAuthenticationButtonStyle.WHITE:AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
   cornerRadius={12} style={{width:'100%',height:48}} onPress={()=>{if(!disabled)onPress();}}/>
 </View>;
}
