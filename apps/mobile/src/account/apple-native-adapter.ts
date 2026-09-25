import {AuthClientError,type AppleAuthorize} from '@siyue/adapters';
import {appleFullNameSchema} from '@siyue/contracts';
type NativeCredential={identityToken:string|null;authorizationCode:string|null;state:string|null;fullName?:Partial<Record<'givenName'|'familyName'|'middleName'|'nickname'|'namePrefix'|'nameSuffix',string|null>>|null};
export function createNativeAppleAuthorizer(sdk:{available:()=>Promise<boolean>;signIn:(input:{nonce:string;state:string})=>Promise<NativeCredential>}):AppleAuthorize{
 return async({nonce,state,signal})=>{
  const check=()=>{if(signal.aborted)throw new AuthClientError('cancelled');};
  check();
  try{
   if(!await sdk.available())throw new AuthClientError('unavailable');check();
   const credential=await sdk.signIn({nonce,state});check();
   if(!credential.identityToken||!credential.authorizationCode||credential.state!==state)throw new AuthClientError('apple_restart_required');
   const values:Record<string,string>={};
   for(const field of ['givenName','familyName','middleName','nickname','namePrefix','nameSuffix'] as const){
    const value=credential.fullName?.[field];if(value!==null&&value!==undefined&&value!=='')values[field]=value;
   }
   const parsed=appleFullNameSchema.safeParse(values);if(!parsed.success)throw new AuthClientError('apple_restart_required');
   return {identityToken:credential.identityToken,authorizationCode:credential.authorizationCode,state:credential.state,...Object.keys(parsed.data).length?{fullName:parsed.data}:{}};
  }catch(error){
   check();if(error instanceof AuthClientError)throw error;
   if(error&&typeof error==='object'&&'code' in error&&error.code==='ERR_REQUEST_CANCELED')throw new AuthClientError('cancelled');
   throw new AuthClientError('unavailable');
  }
 };
}
