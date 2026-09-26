import { AuthClientError,type AuthVault } from '@siyue/adapters';

interface SecureStoreAdapter {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY:number;
  isAvailableAsync():Promise<boolean>;
  getItemAsync(key:string,options:{keychainAccessible:number;keychainService:string}):Promise<string|null>;
  setItemAsync(key:string,value:string,options:{keychainAccessible:number;keychainService:string}):Promise<void>;
}
export interface AuthVaultInitializationMarker {
  isInitialized(environment:string):Promise<boolean>;
  markInitialized(environment:string):Promise<void>;
}
/** Pure injection seam for native adapter tests; no plaintext implementation is shipped. */
export function createMobileAuthVault(storage:SecureStoreAdapter,environment:string,marker:AuthVaultInitializationMarker,purpose:'session'|'deletion-receipt'='session'):AuthVault {
  if(!['production','staging','development','test'].includes(environment))throw new AuthClientError('invalid_config');
  if(!['session','deletion-receipt'].includes(purpose))throw new AuthClientError('invalid_config');
  const scope=purpose==='session'?environment:`${environment}.deletion-receipt`;
  const key=`siyue.auth.v1.${scope}`;
  const options={keychainAccessible:storage.WHEN_UNLOCKED_THIS_DEVICE_ONLY,keychainService:`com.siyue.auth.${scope}`};
  async function available(){if(!await storage.isAvailableAsync())throw new AuthClientError('storage_unavailable');}
  return {
    async read(){
      await available();const value=await storage.getItemAsync(key,options),initialized=await marker.isInitialized(scope);
      if(value===null&&initialized)throw new AuthClientError('storage_corrupt');
      if(value!==null&&!initialized)await marker.markInitialized(scope);
      return value;
    },
    async write(value){
      await available();if(new TextEncoder().encode(value).length>2048)throw new AuthClientError('storage_unavailable');
      await storage.setItemAsync(key,value,options);await marker.markInitialized(scope);
    },
  };
}
