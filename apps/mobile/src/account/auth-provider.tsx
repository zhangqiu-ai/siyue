import { createContext,useContext,useEffect,useState,type ReactNode } from 'react';
import { AppState } from 'react-native';
import type { AuthClientState } from '@siyue/contracts';
import type { AuthController } from '@siyue/adapters';
import { mobileAuthService } from './auth-service';
import { resumeAccountAuth } from './foreground-auth';

type AccountAuth={client:AuthController|null;state:AuthClientState};
const unavailable:AuthClientState={status:'service-unavailable',generation:0,session:null,account:null,error:'invalid_config',pendingRevocations:0};
const Context=createContext<AccountAuth>({client:null,state:unavailable});
export function AccountAuthProvider({children,service}:{children:ReactNode;service?:AuthController}) {
  const [client]=useState(()=>{try{return service??mobileAuthService();}catch{return null;}});
  const [state,setState]=useState(()=>client?.getState()??unavailable);
  useEffect(()=>{
    if(!client)return;
    const unsubscribe=client.subscribe(()=>setState(client.getState()));
    void client.bootstrap().catch(()=>{});
    const listener=AppState.addEventListener('change',next=>{
      if(next==='active')void resumeAccountAuth(client).catch(()=>{});
    });
    return ()=>{unsubscribe();listener.remove();};
  },[client]);
  return <Context.Provider value={{client,state}}>{children}</Context.Provider>;
}
export const useAccountAuth=()=>useContext(Context);
