import { authHostRequestSchema } from '@siyue/contracts';
import { AuthClientError } from '@siyue/adapters';
import { isTrustedSender } from './ipc.mjs';

export function createAuthIpcDispatcher({auth,webContents,rendererUrl}) {
  let closed=false;let active=0;let readers=0;
  const unsubscribe=auth.subscribe(()=>{
    if(!closed&&!webContents.isDestroyed()&&webContents.getURL()===rendererUrl)webContents.send('siyue:auth-state',auth.getState());
  });
  return {
    async handle(event,input) {
      const error=(code,requestId='')=>({version:1,requestId,ok:false,error:code});
      if(closed||!isTrustedSender(event,webContents,rendererUrl))return error('forbidden');
      const parsed=authHostRequestSchema.safeParse(input);if(!parsed.success)return error('invalid_request');
      const {requestId,generation,operation,payload}=parsed.data;
      // The released registration policy is a public read like `providers` and `session`:
      // it is generation scoped, claims no write slot and changes no session state.
      const sharedRead=operation==='session'||operation==='device-sessions'||operation==='login-methods'||operation==='registration-policy';
      if(sharedRead?readers>=16:active>=4)return error('busy',requestId);
      if(operation!=='state'&&generation!==auth.getState().generation)return error('cancelled',requestId);
      if(sharedRead)readers++;else active++;
      try {
        let data;
        switch(operation) {
          case 'state':data=auth.getState();break;
          case 'restore':await auth.bootstrap();data=auth.getState();break;
          case 'providers':data=await auth.providers();break;
          case 'registration-policy':data=await auth.registrationPolicy();break;
          case 'session':data=await auth.session();break;
          case 'login-methods':data=await auth.loginMethods();break;
          case 'deletion-recipients':data=await auth.deletionRecipients(payload.familyId);break;
          case 'family-responsibilities':data=await auth.familyResponsibilities();break;
          case 'frozen-family-preview':data=await auth.frozenFamilyPreview(payload.familyId);break;
          case 'accept-frozen-family':data=await auth.acceptFrozenFamily(payload.familyId,payload.input);break;
          case 'family-management-preview':data=await auth.familyManagementPreview(payload.familyId);break;
          case 'accept-family-management':data=await auth.acceptFamilyManagement(payload.familyId,payload.input);break;
          case 'deletion-impact':data=await auth.deletionImpact();break;
          case 'deletion-status':data=await auth.deletionStatus();break;
          case 'submit-deletion':await auth.submitDeletionWithPassword(payload.currentPassword,payload.dependencyDisposition);data=auth.getState();break;
          case 'retry-deletion':await auth.retryDeletion();data=auth.getState();break;
          case 'logout':data=await auth.logout();break;
          case 'login':await auth.login({...payload,platform:'desktop'});data=auth.getState();break;
          case 'register':await auth.register({...payload.input,platform:'desktop'},payload.key);data=auth.getState();break;
          case 'request-registration':data=await auth.requestRegistration(payload.input,payload.key);break;
          case 'request-reset':data=await auth.requestReset(payload.input,payload.key);break;
          case 'confirm-reset':await auth.confirmReset(payload.input,payload.key);data=null;break;
          case 'change-password':await auth.changePassword(payload.currentPassword,payload.newPassword,payload.key);data=auth.getState();break;
          case 'retry-password-change':await auth.retryPasswordChange();data=auth.getState();break;
          case 'device-sessions':data=await auth.deviceSessions(payload.cursor);break;
          case 'revoke-device-session':await auth.revokeDeviceSession(payload.sessionId,payload.currentPassword);data=auth.getState();break;
          case 'revoke-all-device-sessions':await auth.revokeAllDeviceSessions(payload.currentPassword);data=auth.getState();break;
          case 'unlink-identity':await auth.unlinkIdentity(payload.identityId,payload.currentPassword);data=auth.getState();break;

          // Every operation the strict request schema admits is handled above. Anything else is
          // refused here rather than answered with `ok: true` and no data.
          default:return error('invalid_request',requestId);
        }
        if(closed||!isTrustedSender(event,webContents,rendererUrl))return error('cancelled',requestId);
        return {version:1,requestId,ok:true,data,generation:auth.getState().generation};
      } catch(failure) {return {...error(failure instanceof AuthClientError?failure.code:'unavailable',requestId),retryAfterSeconds:failure instanceof AuthClientError?failure.retryAfterSeconds:0};}
      finally {if(sharedRead)readers--;else active--;}
    },
    dispose(){closed=true;unsubscribe();},
  };
}
