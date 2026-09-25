import * as AppleAuthentication from 'expo-apple-authentication';
import {createNativeAppleAuthorizer} from './apple-native-adapter';
export const isAppleAvailable=()=>AppleAuthentication.isAvailableAsync();
export const authorizeApple=createNativeAppleAuthorizer({
 available:isAppleAvailable,
 signIn:({nonce,state})=>AppleAuthentication.signInAsync({nonce,state,requestedScopes:[AppleAuthentication.AppleAuthenticationScope.FULL_NAME]}),
});
